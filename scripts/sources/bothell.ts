// City of Bothell storm drains (King County part) -> <cache>/sources/bothell/{assets.ndjson,meta.json}.
// Lines name their end structures (USStruct -> DSStruct = GISID), which is the flow order. The city spans the
// King/Snohomish line; the boundary is King County's Bothell polygon, so the build keeps only the King part.
// node scripts/sources/bothell.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
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
import { readBoundaries } from './lib/boundaries.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'bothell';
const BASE = 'https://gisweb.bothellwa.gov/hosting1/rest/services/Public/COBMap_Utilities/MapServer';
// Operational or Unknown (Active), and not an abandoned Type
const LIVE = '(Status IN (1, 850) OR Status IS NULL) AND (Type IS NULL OR Type NOT IN (2, 56, 102))';
const LIVE_NT = 'Status IN (1, 850) OR Status IS NULL';

const LINE = ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status', 'USStruct', 'DSStruct', 'USInvert', 'DSInvert'];
const layers = {
  pipes: { name: 'pipes', url: `${BASE}/450`, fields: [...LINE, 'PipeType', 'DiameterHeight', 'Perforated'], where: LIVE },
  culverts: { name: 'culverts', url: `${BASE}/440`, fields: [...LINE, 'DiameterHeight'], where: LIVE },
  ditches: { name: 'ditches', url: `${BASE}/420`, fields: [...LINE, 'DitchType'], where: LIVE },
  trenches: { name: 'trenches', url: `${BASE}/430`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status', 'USStruct', 'DSStruct'], where: LIVE },
  phantomLines: { name: 'phantom-lines', url: `${BASE}/460`, fields: ['OBJECTID', 'GISID', 'Status', 'LineType', 'USStruct', 'DSStruct', 'USInvert', 'DSInvert'], where: LIVE_NT },
  catchBasins: { name: 'catch-basins', url: `${BASE}/310`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status', 'CBType', 'GrateType', 'Bottom'], where: LIVE },
  cleanouts: { name: 'cleanouts', url: `${BASE}/320`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status'], where: LIVE },
  yardDrains: { name: 'yard-drains', url: `${BASE}/330`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/350`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status', 'Discharge'], where: LIVE },
  phantomNodes: { name: 'phantom-nodes', url: `${BASE}/360`, fields: ['OBJECTID', 'GISID', 'Status', 'NodeType'], where: LIVE_NT },
  vaultAccess: { name: 'vault-access', url: `${BASE}/370`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status'], where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/490`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status', 'PondType'], where: LIVE },
  vaults: { name: 'vaults', url: `${BASE}/500`, fields: ['OBJECTID', 'GISID', 'Type', 'OwnedBy', 'Status'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

/** OwnedBy codes: 1 Bothell, 55 WSDOT, 101 Private, 800 Other */
function bothellOwner(v: unknown): SourceAsset['owner'] {
  const n = num(v);
  if (n === 1) return 'public';
  if (n === 101) return 'private';
  return n === 55 || n === 800 ? 'other' : undefined;
}

// GrateType 100 = Solid; CBType 36 = Dry Well
const SOLID = 100;
const DRY_WELL = 36;
/** phantom node types that are water: 974 Waterbody, 977 Wetland */
const WATER_NODES = new Set([974, 977]);
/** 946 Stub (City Exit): the pipe goes on outside the city */
const CITY_EXIT = 946;
/** 902 Pipe/Channel Outlet, 906 Channel End: water leaves the pipe or channel there */
const OUTLETS = new Set([902, 906]);

export async function buildBothell(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`bothell ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const juris = readBoundaries().jurisdictions.find((j) => j.name === 'Bothell');
  if (!juris) throw new Error('no Bothell in the context boundaries');
  const boundary = juris.polygons as LonLat[][][];

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.2, 47.76]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.GISID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: bothellOwner(f.attributes.OwnedBy), ...more });
    inc(`points.${layers[layer].name}.${role}`);
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    const solid = num(a.GrateType) === SOLID;
    const dry = num(a.CBType) === DRY_WELL;
    point('catchBasins', f, solid ? 'junction' : 'drain', dry || num(a.Bottom) === 0 && a.Bottom !== null ? { openBottom: true } : {});
  }
  for (const f of L.yardDrains) point('yardDrains', f, 'drain');
  for (const f of L.cleanouts) point('cleanouts', f, 'junction');
  for (const f of L.vaultAccess) point('vaultAccess', f, 'junction');
  for (const f of L.outfalls) {
    const d = num(f.attributes.Discharge);
    if (d === 100) point('outfalls', f, 'outfall', { endHint: 'water', receivingHint: 'stream' });
    else if (d === 120) point('outfalls', f, 'outfall', { endHint: 'water', receivingHint: 'lake' });
    else if (d === 140) point('outfalls', f, 'discharge', { endHint: 'ground' });
    else point('outfalls', f, 'outfall', { endHint: 'unknown', receivingHint: d === 160 ? 'storm system outside the city' : undefined });
  }
  for (const f of L.phantomNodes) {
    const t = num(f.attributes.NodeType);
    if (WATER_NODES.has(t)) point('phantomNodes', f, 'outfall', { endHint: 'water', receivingHint: t === 977 ? 'wetland' : undefined });
    else if (t === CITY_EXIT) point('phantomNodes', f, 'outfall', { endHint: 'unknown', receivingHint: 'storm system outside the city' });
    else if (OUTLETS.has(t)) point('phantomNodes', f, 'outfall', { endHint: 'unknown' });
    else point('phantomNodes', f, 'junction');
  }
  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return inc('skipped.noGeometry');
    for (const ring of rings) assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none', owner: bothellOwner(f.attributes.OwnedBy) });
    inc(`facilities.${layers[layer].name}`);
  };
  for (const f of L.ponds) polygon('ponds', f, 'facility-hold');
  for (const f of L.vaults) polygon('vaults', f, 'facility-hold');

  // lines, oriented by their structure keys
  const gaps = { n: 0 };
  const keyless: SourceAsset[] = [];
  let keyedAsDrawn = 0;
  let keyedFlipped = 0;
  const inv = { agree: 0, disagree: 0 };
  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    inc(`lines.${layers[layer].name}`);
    const up = str(a.USStruct), down = str(a.DSStruct);
    const ui = num(a.USInvert), di = num(a.DSInvert);
    const base: SourceAsset = {
      role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: bothellOwner(a.OwnedBy),
      upInv: toM(ui, FT), downInv: toM(di, FT), ...more,
    };
    if (ui > 0 && di > 0 && Math.abs(ui - di) >= 0.01) ui > di ? inv.agree++ : inv.disagree++;
    if (up || down) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, coords, up, down, ends);
      if (ends.resolved > before) {
        o.reversed ? keyedFlipped++ : keyedAsDrawn++;
        assets.push({ ...base, coords: o.coords, fromId: o.fromId, toId: o.toId, trust: 'id' });
        return;
      }
      const asset = { ...base, fromId: o.fromId, toId: o.toId };
      assets.push(asset);
      keyless.push(asset);
      return;
    }
    assets.push(base);
    keyless.push(base);
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    // footing drains (PipeType 163) are perforated to take groundwater in from around a foundation, not to let storm water out
    line('pipes', f, 'pipe', { width: toM(num(a.DiameterHeight), IN), perforated: (num(a.Perforated) === 1 && num(a.PipeType) !== 163) || undefined });
  }
  for (const f of L.culverts) line('culverts', f, 'culvert', { width: toM(num(f.attributes.DiameterHeight), IN) });
  for (const f of L.ditches) line('ditches', f, 'ditch');
  for (const f of L.trenches) line('trenches', f, 'pipe', { perforated: true });
  for (const f of L.phantomLines) line('phantomLines', f, 'virtual');

  // lines no key orients: as drawn, if keyed lines are mostly drawn in flow order
  const ground = await openGround(boundaryBox(boundary));
  const g = { kd: 0, ku: 0, nd: 0, nu: 0 };
  for (const a of assets) {
    if (a.coords.length < 2 || a.role.startsWith('facility')) continue;
    const s = groundSign(ground, a.coords);
    if (a.trust === 'id') s > 0 ? g.kd++ : s < 0 ? g.ku++ : 0;
    else s > 0 ? g.nd++ : s < 0 ? g.nu++ : 0;
  }
  const drawnShare = keyedAsDrawn / Math.max(1, keyedAsDrawn + keyedFlipped);
  const ok = keyedAsDrawn + keyedFlipped >= 20 && drawnShare >= DRAWN_OK;
  if (ok) for (const a of keyless) a.trust = 'digitized';
  settleKeys(assets, nodes, extra);
  Object.assign(extra, {
    'keyed.asDrawn': keyedAsDrawn, 'keyed.flipped': keyedFlipped, 'inverts.agreeWithDrawing': inv.agree, 'inverts.disagree': inv.disagree,
    'ground.keyed.downhill': g.kd, 'ground.keyed.uphill': g.ku, 'ground.keyless.downhill': g.nd, 'ground.keyless.uphill': g.nu,
    'lines.keyless': keyless.length, 'lines.pathGaps': gaps.n,
  });
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const notes = [
    `Keyed lines: USStruct -> DSStruct (GISID) is the flow order; ${keyedAsDrawn}/${keyedAsDrawn + keyedFlipped} (${pct(keyedAsDrawn, keyedAsDrawn + keyedFlipped)}) were already drawn that way`,
    `Inverts: USInvert > DSInvert on ${inv.agree}/${inv.agree + inv.disagree} (${pct(inv.agree, inv.agree + inv.disagree)}) lines with both set`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${g.kd}/${g.kd + g.ku} (${pct(g.kd, g.kd + g.ku)}) keyed lines as oriented, and along ${g.nd}/${g.nd + g.nu} (${pct(g.nd, g.nd + g.nu)}) of the ${keyless.length} lines no key orients, as drawn ('${ok ? 'digitized' : 'none'}')`,
    'Lines: storm pipes (Perforated = Yes is perforated, except footing drains, which take groundwater in from around foundations), culverts, ditches, trenches (perforated) and phantom lines (flow paths through vaults and ponds, as virtual lines)',
    "Points: catch basins are drains unless the grate is solid (dry wells and bottomless ones soak in); yard drains are drains; cleanouts, vault access and phantom nodes are junctions, except Waterbody and Wetland nodes (water), and Pipe/Channel Outlet, Channel End and City Exit stub nodes (outfall 'unknown': the walk goes on where the map does)",
    "Outfalls by Discharge: Stream and Lake -> 'water', No Waterbody/Soil -> 'ground', the rest 'unknown' (the walk goes on where the map does)",
    'Only Operational and Unknown (Active) features, not abandoned types. owner: public = Bothell, private = Private, other = WSDOT and Other',
    "Boundary: King County's Bothell polygon (the Snohomish County part is left out). Drainage Complaints and the token-only Staff services are never used; no names or free text are requested",
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Bothell',
    county: 'King',
    credit: 'Storm drain data: City of Bothell GIS, provided as is.',
    disclaimer: 'City of Bothell GIS data, provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildBothell);
