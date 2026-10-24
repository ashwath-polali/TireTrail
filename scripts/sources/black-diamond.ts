// City of Black Diamond storm drains -> <cache>/sources/black-diamond/{assets.ndjson,meta.json}.
// Storm_Pipes_2014 is the city's 2014 pipe survey plus lines added since. Surveyed pipes name their end catch basins
// (Upstrm_CB -> Dwnstrm_CB is the flow order, '258' = CB258) and carry text inverts ('668.37 feet'); some ends say
// "Inlet from Ditch N" or "Outlet to Creek W" instead, which places that end. Lines with neither run the way the
// network takes them to an outfall (lib/network.ts, USGS 3DEP ground).
// node scripts/sources/black-diamond.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  FT,
  IN,
  NodeIndex,
  approxM,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  num,
  orientByKeys,
  outerRings,
  pointOf,
  rawDirFor,
  runCli,
  settleKeys,
  str,
  summarize,
  toM,
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { networkSays } from './lib/network.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'black-diamond';
const BASE = 'https://services3.arcgis.com/2zN9vve1fziaURNx/arcgis/rest/services';
const GEOID = '5306330';
const ORIGIN: LonLat = [-122.02, 47.32];

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/Storm_Pipes_2014/FeatureServer/24`, fields: ['OBJECTID', 'Asset_Name', 'Pipe_Size', 'Upstrm_CB', 'Upstrm_IE', 'Dwnstrm_CB', 'Dwnstrm_IE'] },
  ditches: { name: 'ditches', url: `${BASE}/Ditches_2014/FeatureServer/25`, fields: ['OBJECTID', 'Asset_Name'] },
  type1: { name: 'catch-basins-type-1', url: `${BASE}/Catch_Basin_Type_1_2019/FeatureServer/19`, fields: ['OBJECTID', 'OBJNAME', 'Asset_Name'] },
  type2: { name: 'catch-basins-type-2', url: `${BASE}/Catch_Basin_Type_2_2019_v2/FeatureServer/20`, fields: ['OBJECTID', 'OBJNAME', 'Asset_Name'] },
  // drawing blocks: SDCBTYPE1, SDCBTYPE2-48, ...; an SL suffix is a solid lid
  typeUnknown: { name: 'catch-basins-2026', url: `${BASE}/Catch_Basin_Type_Unknown_2026/FeatureServer/2`, fields: ['OBJECTID', 'OBJNAME', 'RefName'] },
  inlets: { name: 'concrete-inlets', url: `${BASE}/Concrete_Inlet/FeatureServer/16`, fields: ['OBJECTID', 'OBJNAME', 'Asset_Name'] },
  outfalls: { name: 'outfalls', url: `${BASE}/Outfalls_2018/FeatureServer/12`, fields: ['OBJECTID', 'Outfall', 'Asset_Name'] },
  culvertOutlets: { name: 'culvert-outlets', url: `${BASE}/Culvert_Outlet/FeatureServer/15`, fields: ['OBJECTID', 'Outfall', 'Asset_Name'] },
  dischargePoints: { name: 'discharge-points', url: `${BASE}/Discharge_Points_2018/FeatureServer/14`, fields: ['OBJECTID', 'Outfall', 'Asset_Name'] },
  rainGarden: { name: 'rain-garden', url: `${BASE}/Rain_Garden_2021/FeatureServer/26`, fields: ['OBJECTID', 'Asset_Name'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

/** "CB 258", "CB-258", "CB #8", "Ex. CB-10" -> "CB258", "CB8", "CB10" */
export const cbName = (v: unknown): string => str(v).replace(/^ex\.\s*/i, '').replace(/[\s#]+/g, '').replace(/^CB-/i, 'CB');
/** a pipe's end key: '258' and 'CB-258' name CB258; text like "Inlet from Ditch N" names no structure */
export const pipeKey = (v: unknown): string => {
  const s = str(v);
  if (/^\d+[A-Z]?$/i.test(s)) return `CB${s.toUpperCase()}`;
  return /^CB[\s-]*\d/i.test(s) ? cbName(s) : '';
};
/** "Inlet from Creek E" -> { open: 'inlet', what: 'creek', dir: 'E' } */
export function endText(v: unknown): { open: 'inlet' | 'outlet'; what: string; dir?: string } | undefined {
  const m = /^(inlet|outlet|outfall)\s+(?:from|to)\s+(.+?)(?:,?\s+(N|S|E|W|NE|NW|SE|SW|east|west|north|south))?$/i.exec(str(v));
  if (!m) return undefined;
  const dir = m[3] ? (m[3].length > 2 ? m[3][0] : m[3]).toUpperCase() : undefined;
  return { open: /^inlet/i.test(m[1]) ? 'inlet' : 'outlet', what: m[2].trim().toLowerCase(), dir };
}
const WATER = /creek|lake|wetland|marsh/;
/** inches from '12 inch', '8', '12 invh'; a size in feet is a typo */
const inches = (v: unknown): number => (/f(ee)?t/i.test(str(v)) ? 0 : num(/^\s*(\d+(?:\.\d+)?)/.exec(str(v))?.[1]));
const feetOf = (v: unknown): number => num(/(\d+(?:\.\d+)?)/.exec(str(v))?.[1]);

/**
 * 1 = the compass letters of a pipe's open ends say it is drawn in flow order, -1 = backward, 0 = none or split.
 * An inlet's letter is the side its end is on ("Inlet from Ditch N": the north end), and so is an outlet's.
 */
export function compassSays(line: readonly LonLat[], up: ReturnType<typeof endText>, down: ReturnType<typeof endText>): number {
  const [a, b] = [line[0], line[line.length - 1]];
  const along = [(b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]];
  let v = 0;
  for (const [t, isUp] of [[up, true], [down, false]] as const) {
    if (!t?.dir) continue;
    const dx = (t.dir.includes('E') ? 1 : 0) - (t.dir.includes('W') ? 1 : 0);
    const dy = (t.dir.includes('N') ? 1 : 0) - (t.dir.includes('S') ? 1 : 0);
    const dot = dx * along[0] + dy * along[1];
    // the last vertex lies toward the letter: right for an outlet, backward for an inlet
    if (dot) v += dot > 0 === !isUp ? 1 : -1;
  }
  return Math.sign(v);
}

export async function buildBlackDiamond(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`black-diamond ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex(ORIGIN);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const structures: LonLat[] = [];
  const exits: { at: LonLat; asset: SourceAsset }[] = [];

  const point = (layer: LayerName, f: EsriFeature, role: Role, id: string, more: Partial<SourceAsset> = {}): SourceAsset | undefined => {
    const at = pointOf(f.geometry);
    if (!at) {
      inc('skipped.noGeometry');
      return undefined;
    }
    const a: SourceAsset = { role, id: id || `${layers[layer].name}:${str(f.attributes.OBJECTID)}`, src: KEY, key: '', coords: [at], trust: 'none', ...more };
    a.key = nodes.add(a.id, at);
    assets.push(a);
    structures.push(at);
    inc(`points.${layers[layer].name}`);
    return a;
  };
  for (const layer of ['type1', 'type2', 'inlets'] as const) for (const f of L[layer]) point(layer, f, 'drain', cbName(f.attributes.OBJNAME) || str(f.attributes.Asset_Name));
  for (const f of L.typeUnknown) {
    const solid = /SL$/i.test(str(f.attributes.RefName));
    point('typeUnknown', f, solid ? 'junction' : 'drain', cbName(f.attributes.OBJNAME));
    if (solid) inc('catchBasins2026.solidLid');
  }
  // where pipes leave the system: the descriptor of the pipe ending there says into what (set below)
  for (const layer of ['outfalls', 'culvertOutlets', 'dischargePoints'] as const) {
    for (const f of L[layer]) {
      const a = point(layer, f, 'outfall', str(f.attributes.Outfall) || str(f.attributes.Asset_Name), { endHint: 'unknown' });
      if (a) exits.push({ at: a.coords[0], asset: a });
    }
  }
  for (const f of L.rainGarden) {
    for (const ring of outerRings(f.geometry)) assets.push({ role: 'facility-infiltrate', id: str(f.attributes.Asset_Name) || `rain-garden:${str(f.attributes.OBJECTID)}`, src: KEY, coords: ring, trust: 'none' });
  }

  // lines and their own evidence
  interface Line { asset: SourceAsset; up?: ReturnType<typeof endText>; down?: ReturnType<typeof endText>; inv: [number, number]; how: 'id' | 'compass' | 'network' | 'ground' | 'drawn' }
  const lines: Line[] = [];
  const gaps = { n: 0 };
  for (const f of L.pipes) {
    const a: Attrs = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const up = endText(a.Upstrm_CB), down = endText(a.Dwnstrm_CB);
    // open at both ends: a culvert; one that carries a creek or the lake from end to end is a stream culvert
    const stream = !!up && !!down && WATER.test(up.what) && WATER.test(down.what) && !/wetland|marsh/.test(up.what + down.what);
    const role: Role = stream ? 'stream-culvert' : up && down ? 'culvert' : 'pipe';
    const asset: SourceAsset = {
      role, id: str(a.Asset_Name) || `pipes:${str(a.OBJECTID)}`, src: KEY, coords, trust: 'none', width: toM(inches(a.Pipe_Size), IN),
      liveStream: stream || undefined, receivingHint: stream ? (/sawyer/.test(down!.what) ? 'Lake Sawyer' : down!.what) : undefined,
    };
    const line: Line = { asset, up, down, inv: [feetOf(a.Upstrm_IE), feetOf(a.Dwnstrm_IE)], how: 'drawn' };
    const upId = pipeKey(a.Upstrm_CB), downId = pipeKey(a.Dwnstrm_CB);
    if (upId || downId) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, coords, upId, downId, ends);
      // keys that name no catch basin only stay on lines another key orients
      if (ends.resolved > before) {
        asset.coords = o.coords;
        asset.trust = 'id';
        if (o.fromId) asset.fromId = o.fromId;
        if (o.toId) asset.toId = o.toId;
        line.how = 'id';
        inc(o.reversed ? 'keyed.flipped' : 'keyed.asDrawn');
      } else inc('keyed.nameNoBasin');
    }
    if (line.how === 'drawn') {
      const c = compassSays(coords, up, down);
      if (c) {
        if (c < 0) asset.coords = [...coords].reverse();
        asset.trust = 'compass';
        line.how = 'compass';
        inc(c < 0 ? 'compass.flipped' : 'compass.asDrawn');
      }
    }
    if (line.how !== 'drawn') {
      // inverts go with the named (or lettered) ends, so only on lines those orient
      const [u, d] = line.inv;
      if (u > 0) asset.upInv = toM(u, FT);
      if (d > 0) asset.downInv = toM(d, FT);
    }
    assets.push(asset);
    lines.push(line);
  }
  for (const f of L.ditches) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const asset: SourceAsset = { role: 'ditch', id: str(f.attributes.Asset_Name) || `ditches:${str(f.attributes.OBJECTID)}`, src: KEY, coords, trust: 'none' };
    assets.push(asset);
    lines.push({ asset, inv: [0, 0], how: 'drawn' });
  }

  // the rest run the way the network takes them to an outfall, else downhill where the ground falls 0.5 m, else as drawn
  const ground = await openGround(boundaryBox(boundary));
  const exitAt = exits.map((e) => e.at);
  const net = networkSays(lines.map((l) => ({ coords: l.asset.coords, fixed: l.how !== 'drawn' })), structures, exitAt, ground, ORIGIN);
  lines.forEach((l, i) => {
    if (l.how !== 'drawn') return;
    let s = net.says[i];
    if (s) l.how = 'network';
    else if ((s = groundSign(ground, l.asset.coords))) l.how = 'ground';
    if (s < 0) l.asset.coords = [...l.asset.coords].reverse();
  });
  settleKeys(assets, nodes, extra);

  // outfalls: what the pipe ending there (oriented by its keys or letters) says it runs into
  const hints = new Map<SourceAsset, string>();
  for (const l of lines) {
    if (!l.down || (l.how !== 'id' && l.how !== 'compass')) continue;
    const end = l.asset.coords[l.asset.coords.length - 1];
    let best: { asset: SourceAsset; d: number } | undefined;
    for (const e of exits) {
      const d = approxM(e.at, end);
      if (d <= 3 && (!best || d < best.d)) best = { asset: e.asset, d };
    }
    if (best && !hints.has(best.asset)) hints.set(best.asset, l.down.what);
  }
  for (const [a, what] of hints) {
    a.receivingHint = /sawyer/.test(what) ? 'Lake Sawyer' : what;
    if (WATER.test(what)) a.endHint = 'water';
    inc(`outfalls.into.${WATER.test(what) ? 'water' : 'other'}`);
  }

  // checks: keys against inverts and the ground; letters against keys; the network rule with the keys hidden
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const share = (x: number, y: number) => `${x}/${x + y} (${pct(x, x + y)})`;
  let invOk = 0, invBad = 0;
  const gBy: Record<string, [number, number]> = {};
  for (const l of lines) {
    if (l.how === 'id') {
      const [u, d] = l.inv;
      if (u > 0 && d > 0 && Math.abs(u - d) >= 0.01) u > d ? invOk++ : invBad++;
    }
    const s = groundSign(ground, l.asset.coords);
    const t = (gBy[l.how] ??= [0, 0]);
    if (s > 0) t[0]++;
    else if (s < 0) t[1]++;
  }
  // letters against keys, on lines that have both
  let cOk = 0, cBad = 0;
  for (const l of lines) {
    if (l.how !== 'id') continue;
    const c = compassSays(l.asset.coords, l.up, l.down);
    if (c > 0) cOk++;
    else if (c < 0) cBad++;
  }
  const blind = networkSays(lines.map((l) => ({ coords: l.asset.coords })), structures, exitAt, ground, ORIGIN);
  let nOk = 0, nBad = 0;
  lines.forEach((l, i) => {
    if (l.how !== 'id') return;
    // keyed lines are now in flow order, so the network agrees when it says "as drawn"
    if (blind.says[i] > 0) nOk++;
    else if (blind.says[i] < 0) nBad++;
  });
  const by = (h: string) => lines.filter((l) => l.how === h).length;
  Object.assign(extra, {
    'dir.id': by('id'), 'dir.compass': by('compass'), 'dir.network': by('network'), 'dir.ground': by('ground'), 'dir.drawn': by('drawn'),
    'check.inverts.agree': invOk, 'check.inverts.against': invBad, 'check.compassVsKeys.agree': cOk, 'check.compassVsKeys.against': cBad,
    'check.networkVsKeys.agree': nOk, 'check.networkVsKeys.against': nBad, 'network.pieces': net.pieces, 'network.piecesWithOutfall': net.withOutfall,
    'lines.pathGaps': gaps.n,
  });
  for (const [h, [d, u]] of Object.entries(gBy)) Object.assign(extra, { [`ground.${h}.downhill`]: d, [`ground.${h}.uphill`]: u });
  const gAll = Object.values(gBy).reduce((s, [d, u]) => [s[0] + d, s[1] + u], [0, 0]);
  const notes = [
    `Direction: ${by('id')} pipes by their named end catch basins (Upstrm_CB -> Dwnstrm_CB), ${by('compass')} by the letters of their open ends, ${by('network')} by the network (each piece drains to an outfall, or else its lowest loose end, along the least climb), ${by('ground')} downhill where the ground falls 0.5 m or more, ${by('drawn')} as drawn`,
    `Checks: the inverts fall along ${share(invOk, invBad)} keyed pipes; end letters agree with the keys on ${share(cOk, cBad)}; the network rule run with the keys hidden orients ${share(nOk, nBad)} keyed pipes as their keys do`,
    `Ground (USGS 3DEP, ends 0.5 m or more apart) falls along ${Object.entries(gBy).map(([h, [d, u]]) => `${h} ${share(d, u)}`).join(', ')}; all ${share(gAll[0], gAll[1])}`,
    `Keyed pipes drawn in flow order: ${share(extra['keyed.asDrawn'] ?? 0, extra['keyed.flipped'] ?? 0)}, so the drawing alone is not trusted`,
    `Network: ${net.pieces} connected pieces, ${net.withOutfall} with an outfall`,
    "Catch basins (Type 1 and 2 of 2019, the 2026 layer of unknown type) and concrete inlets are drains; 2026 blocks ending in SL (solid lid) are junctions",
    "Outfalls, culvert outlets and discharge points end the pipes: 'water' where the pipe ending there says it runs into a creek, lake, wetland or marsh, else 'unknown' (ditch, pond, wooded area; the walk goes on where the map does)",
    'Open at both ends (inlet from and outlet to): culvert; creek or lake at both ends: stream culvert. Pipe_Size in inches',
    'The pipe layer is the 2014 survey plus lines added since without names or inverts; the newest development is mapped only in part (catch basins without pipes)',
    'No license terms stated on the items. Dropped: maintenance and inspection fields, CAD drawing fields (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Black Diamond',
    county: 'King',
    credit: 'Storm drain data: City of Black Diamond GIS (a 2014 pipe survey with later additions, so newer development may be missing), provided as is.',
    disclaimer: 'City of Black Diamond GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildBlackDiamond);
