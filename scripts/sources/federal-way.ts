// City of Federal Way storm drains -> <cache>/sources/federal-way/{assets.ndjson,meta.json}.
// No from/to IDs: lines join by geometry. About 1 in 6 pipes records an upstream and a downstream invert
// (UPS_MD, DWNS_MD), and a few structures a rim; the rest carry no direction. Each line's drawn order is
// checked against the ground (USGS 3DEP at its two ends) and kept where that check passes.
// node scripts/sources/federal-way.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';
import { DEM_DIR } from '../terrain/config.ts';
import { Dem, tilesFor } from '../terrain/dem.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  num,
  outerRings,
  pointOf,
  rawDirFor,
  runCli,
  str,
  summarize,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';

const KEY = 'federal-way';
const BASE = 'https://geoportal.cityoffederalway.com/res/rest/services/FW_SWM';
const GEOID = '5323515';

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/STRMPIPE/FeatureServer/0`, fields: ['OBJECTID', 'ASSETID', 'PMATERIAL', 'PSIZE', 'UPS_MD', 'DWNS_MD', 'MAINTRESP', 'MODS', 'STATUS'] },
  open: { name: 'open-conveyance', url: `${BASE}/STRMLINE/FeatureServer/0`, fields: ['OBJECTID', 'ASSETID', 'CMATERIAL', 'MAINTRESP', 'STATUS'] },
  structures: { name: 'structures', url: `${BASE}/STRMSTRCR/FeatureServer/0`, fields: ['OBJECTID', 'ASSETID', 'LIDTYPE', 'CBTYPE', 'RIM', 'MAINTRESP', 'MODS', 'STATUS'] },
  outfalls: { name: 'outfalls', url: `${BASE}/STRMOUT/FeatureServer/0`, fields: ['OBJECTID', 'ASSETID', 'OUTTYPE', 'STATUS'] },
  facilities: { name: 'facilities', url: `${BASE}/STRMPOLY/FeatureServer/0`, fields: ['OBJECTID', 'ASSETID', 'POLYTYPE', 'RET', 'DET', 'MAINTRESP', 'STATUS'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

export function fwOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v).toUpperCase();
  if (s === 'PUB') return 'public';
  if (s === 'PRI') return 'private';
  return s === 'DOT' ? 'other' : undefined;
}

/** Abandoned or decommissioned: left out. */
export const isGone = (a: Record<string, unknown>): boolean => str(a.MODS).toUpperCase() === 'ABANDON' || /abandon|remove|decom/i.test(str(a.STATUS));

// lids water can't get through: a manhole or a closed box
const SOLID_LIDS = new Set(['RTSL', 'RSL', 'HDL', 'RSHD', 'HHDR']);
/** A catch basin takes street water unless its lid is solid; a structure with no catch basin type is a manhole unless its lid is a grate. */
export function structureRole(cbType: unknown, lid: unknown): Role {
  const t = str(cbType).toUpperCase();
  const l = str(lid).toUpperCase();
  if (SOLID_LIDS.has(l)) return 'junction';
  if (t) return 'drain';
  return l && l !== 'OTHER' ? 'drain' : 'junction';
}

// facility outlines: natural lakes and wetlands come from the water layers, dumpster pads are no facility
const SKIP_FACILITIES = new Set(['LAKE', 'WETLND', 'DUMP']);
const SOAKS = new Set(['DTRNCH', 'CLDEP']);
export function facilityRole(type: unknown, ret: unknown): Role | null {
  const t = str(type).toUpperCase();
  if (SKIP_FACILITIES.has(t)) return null;
  return SOAKS.has(t) || str(ret).toUpperCase() === 'Y' ? 'facility-infiltrate' : 'facility-hold';
}

/** Ground drop (m) from the first to the last end needed before the ground says which way a line runs. */
export const GROUND_DROP_M = 1;

export async function buildFederalWay(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`federal-way ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.33, 47.31]);
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Record<string, unknown>) => str(a.ASSETID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const rim = new Map<string, number>();

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) return void inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: fwOwner(f.attributes.MAINTRESP), ...more });
    return key;
  };

  for (const f of L.structures) {
    const a = f.attributes;
    if (isGone(a)) {
      inc('skipped.abandoned');
      continue;
    }
    const role = structureRole(a.CBTYPE, a.LIDTYPE);
    inc(`structures.${role}`);
    const key = point('structures', f, role);
    if (key && num(a.RIM) > 0) rim.set(key, num(a.RIM) * FT);
  }
  for (const f of L.outfalls) {
    const a = f.attributes;
    if (isGone(a)) {
      inc('skipped.abandoned');
      continue;
    }
    // primary, secondary and private outfalls let out into water; outlet controls into a pond or swale
    const t = str(a.OUTTYPE).toUpperCase();
    point('outfalls', f, 'outfall', t === 'OC' ? { endHint: 'unknown', receivingHint: 'outlet control' } : { endHint: 'water' });
  }
  for (const f of L.facilities) {
    const a = f.attributes;
    const role = facilityRole(a.POLYTYPE, a.RET);
    if (!role || isGone(a)) {
      inc(`skipped.facility.${str(a.POLYTYPE) || 'blank'}`);
      continue;
    }
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const id = idOf('facilities', a);
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: fwOwner(a.MAINTRESP) });
  }

  // lines as drawn; the checks below orient them
  const gaps = { n: 0 };
  interface Line { asset: SourceAsset; ups: number; dwns: number }
  const lines: Line[] = [];
  for (const f of L.pipes) {
    const a = f.attributes;
    if (isGone(a)) {
      inc('skipped.abandoned');
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const size = num(a.PSIZE);
    const asset: SourceAsset = { role: 'pipe', id: idOf('pipes', a), src: KEY, coords, trust: 'none', owner: fwOwner(a.MAINTRESP), width: size > 0 && size < 400 ? Math.round(size * IN * 1000) / 1000 : undefined };
    assets.push(asset);
    lines.push({ asset, ups: num(a.UPS_MD), dwns: num(a.DWNS_MD) });
  }
  for (const f of L.open) {
    const a = f.attributes;
    if (isGone(a)) {
      inc('skipped.abandoned');
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) continue;
    const asset: SourceAsset = { role: 'ditch', id: idOf('open', a), src: KEY, coords, trust: 'none', owner: fwOwner(a.MAINTRESP) };
    assets.push(asset);
    lines.push({ asset, ups: 0, dwns: 0 });
  }

  // the ground at both ends of each line
  const all = lines.flatMap((l) => [l.asset.coords[0], l.asset.coords[l.asset.coords.length - 1]]);
  const box = [Math.min(...all.map((c) => c[0])), Math.min(...all.map((c) => c[1])), Math.max(...all.map((c) => c[0])), Math.max(...all.map((c) => c[1]))] as const;
  const dem = await Dem.open(tilesFor(box), DEM_DIR, { maxBlocks: 1024 });
  const ground = async (c: LonLat): Promise<number> => (await dem.window(Dem.rowOf(c[1]), Dem.colOf(c[0]), 1, 1))[0];

  // structures with a rim at an end (within 2 m)
  const rimAt = (c: LonLat): number | undefined => {
    const n = nodes.nearest(c, 2);
    return n ? rim.get(n.ref.key) : undefined;
  };
  const outfallAt = new Set(assets.filter((a) => a.role === 'outfall').map((a) => a.key!));
  const intoOutfall = (c: LonLat) => {
    const n = nodes.nearest(c, 2);
    return !!n && outfallAt.has(n.ref.key);
  };

  type Say = 'down' | 'up' | undefined;
  interface Check { line: Line; ground: Say; rims: Say; outfall: Say; inverts: boolean; upsAt?: 'first' | 'last' }
  const checks: Check[] = [];
  for (const l of lines) {
    const c = l.asset.coords;
    const first = c[0], last = c[c.length - 1];
    const drop = (await ground(first)) - (await ground(last));
    const r0 = rimAt(first), r1 = rimAt(last);
    const pipe = l.asset.role === 'pipe';
    // a pipe runs into an outfall; a ditch can start at one
    const o0 = pipe && intoOutfall(first), o1 = pipe && intoOutfall(last);
    const inverts = l.ups > 0 && l.dwns > 0 && Math.abs(l.ups - l.dwns) >= 0.01;
    // which end UPS_MD belongs to: the one where both inverts sit below the rims
    let upsAt: Check['upsAt'];
    if (inverts && r0 && r1) {
      const [u, d] = [l.ups * FT, l.dwns * FT];
      const asDrawn = r0 >= u && r1 >= d, swapped = r0 >= d && r1 >= u;
      if (asDrawn !== swapped) upsAt = asDrawn ? 'first' : 'last';
    }
    checks.push({
      line: l,
      ground: Number.isFinite(drop) && Math.abs(drop) >= GROUND_DROP_M ? (drop > 0 ? 'down' : 'up') : undefined,
      rims: r0 && r1 && Math.abs(r0 - r1) >= 0.3 ? (r0 > r1 ? 'down' : 'up') : undefined,
      outfall: o0 !== o1 ? (o1 ? 'down' : 'up') : undefined,
      inverts,
      upsAt,
    });
  }

  // how often each test says the drawn order runs downhill
  const tally = (pick: (c: Check) => Say, only: (c: Check) => boolean = () => true) => {
    let down = 0, up = 0;
    for (const c of checks) {
      if (!only(c)) continue;
      const s = pick(c);
      if (s === 'down') down++;
      else if (s === 'up') up++;
    }
    return { down, up, share: down + up ? down / (down + up) : 0 };
  };
  const isPipe = (c: Check) => c.line.asset.role === 'pipe';
  const isDitch = (c: Check) => c.line.asset.role === 'ditch';
  const groundPipes = tally((c) => c.ground, isPipe);
  const groundDitches = tally((c) => c.ground, isDitch);
  const rimPipes = tally((c) => c.rims, isPipe);
  const outfallPipes = tally((c) => c.outfall, isPipe);
  const upsFirst = tally((c) => (c.upsAt === 'first' ? 'down' : c.upsAt === 'last' ? 'up' : undefined));
  const higher = (c: Check) => c.line.ups > c.line.dwns;
  const invHigher = checks.filter((c) => c.inverts && higher(c)).length;
  const invLower = checks.filter((c) => c.inverts && !higher(c)).length;
  const groundLower = tally((c) => c.ground, (c) => c.inverts && !higher(c));
  const okPipes = groundPipes.down + groundPipes.up >= 20 && groundPipes.share >= DRAWN_OK;
  const okDitches = groundDitches.down + groundDitches.up >= 20 && groundDitches.share >= DRAWN_OK;
  const okUps = upsFirst.down + upsFirst.up >= 20 && upsFirst.share >= DRAWN_OK;

  // Drawn order is flow order where the ground check passes. A pipe into an outfall runs toward it.
  // Rims (ground at the structures) and a lone contrary ground reading agree with the drawing less often
  // than the drawing agrees with the ground, so they never flip a line.
  const used: Record<string, number> = {};
  for (const c of checks) {
    const a = c.line.asset;
    const ok = a.role === 'pipe' ? okPipes : okDitches;
    let say: Say = undefined, trust: Trust = 'none', by = 'drawn';
    if (c.outfall) [say, trust, by] = [c.outfall, 'node-flags', 'outfall'];
    // UPS_MD is the invert at the first vertex: higher there agrees with the drawing
    else if (c.inverts && okUps && higher(c)) [say, trust, by] = ['down', 'inverts', 'inverts'];
    else if (ok) [say, trust, by] = ['down', 'digitized', c.ground === 'up' ? 'drawnOverGround' : c.inverts ? 'drawnOverInverts' : 'drawn'];
    used[by] = (used[by] ?? 0) + 1;
    a.trust = trust;
    if (say === 'up') {
      a.coords = [...a.coords].reverse();
      inc('lines.reversed');
    }
    if (c.inverts && okUps) {
      const [first, last] = say === 'up' ? [c.line.dwns, c.line.ups] : [c.line.ups, c.line.dwns];
      a.upInv = Math.round(first * FT * 1000) / 1000;
      a.downInv = Math.round(last * FT * 1000) / 1000;
    }
  }

  const share = (t: { down: number; up: number; share: number }) => `${t.down}/${t.down + t.up} (${(100 * t.share).toFixed(1)}%)`;
  for (const [k, v] of Object.entries(used)) extra[`orientedBy.${k}`] = v;
  const put = (k: string, t: { down: number; up: number }) => {
    extra[`${k}.down`] = t.down;
    extra[`${k}.up`] = t.up;
  };
  put('ground.pipes', groundPipes);
  put('ground.ditches', groundDitches);
  put('rims.pipes', rimPipes);
  put('outfall.pipes', outfallPipes);
  put('upsAtFirst', upsFirst);
  extra['inverts.upsHigher'] = invHigher;
  extra['inverts.upsLower'] = invLower;
  extra['lines.pathGaps'] = gaps.n;
  const notes = [
    `Ground check (USGS 3DEP 1/3 arc-second at both ends, drops of ${GROUND_DROP_M} m or more): drawn order runs downhill on pipes ${share(groundPipes)}, open conveyance ${share(groundDitches)}`,
    `Rims at both ends say pipes run downhill as drawn on ${share(rimPipes)}, below the ground check, so rims never flip a line. Pipes with an outfall at one end are drawn toward it on ${share(outfallPipes)}`,
    `UPS_MD/DWNS_MD (invert, ft) on ${invHigher + invLower} pipes. UPS_MD is at the first vertex on ${share(upsFirst)} of those with rims that tell. UPS_MD is the higher on ${invHigher} ('inverts'); on the ${invLower} where it is lower the ground still says drawn downhill on ${share(groundLower)}, so they stay as drawn`,
    `Oriented by: ${Object.entries(used).map(([k, v]) => `${k} ${v}`).join(', ')}. Pipes as drawn: ${okPipes ? "'digitized'" : "'none'"}; open conveyance as drawn: ${okDitches ? "'digitized'" : "'none'"}`,
    'Structures: a solid lid -> junction; otherwise a catch basin type or a grate lid -> drain; no type and lid OTHER (mostly private, numbered ids) -> junction. Abandoned (MODS) are left out',
    "Outfalls: primary, secondary and private -> 'water'; outlet controls -> 'unknown'. Facility outlines: lakes, wetlands and dumpster pads left out; dispersal trenches, closed depressions and retention -> infiltrate",
    'owner: public = PUB, private = PRI, other = WSDOT',
    'Dropped: NOTES, LOCATION, CREATOR/EDITOR and the condition and risk scores (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Federal Way',
    county: 'King',
    credit: 'Storm drain data: City of Federal Way GIS, provided as is, without warranty.',
    disclaimer: 'City of Federal Way GIS data is provided on an as is basis without warranty of any kind. Commercial use or sale is prohibited without written authorization from the City of Federal Way.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildFederalWay);
