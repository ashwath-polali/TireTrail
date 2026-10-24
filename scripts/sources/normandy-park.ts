// City of Normandy Park storm drains -> <cache>/sources/normandy-park/{assets.ndjson,meta.json}.
// Lines carry no from/to IDs or inverts and join by geometry. Catch basins record each pipe's compass side and
// whether it flows IN or OUT (P1-P5): a line end at a basin takes the entry on its side. The ground (USGS 3DEP)
// checks those flags and the drawing. The service allows anonymous edits; this only reads it.
// node scripts/sources/normandy-park.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
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
  outerRings,
  pointOf,
  rawDirFor,
  runCli,
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
import { orient, orientNotes, type LineCheck, type Say } from './lib/orient.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'normandy-park';
const BASE = 'https://services7.arcgis.com/5d703jjhemO6FlIW/arcgis/rest/services/Stormwater_Infrastructure/FeatureServer';
const GEOID = '5349415';

const P = [1, 2, 3, 4, 5].flatMap((i) => [`P${i}_Directi`, `P${i}_Flow`]);
const layers = {
  catchBasins: { name: 'catch-basins', url: `${BASE}/6`, fields: ['OBJECTID', 'UniqueID', 'CB_ID', 'CB_Type', 'Frame_Grat', 'owned_by', ...P] },
  drains: { name: 'drains', url: `${BASE}/8`, fields: ['OBJECTID', 'UniqueID', 'Frame_Grat', 'owned_by', ...P] },
  other: { name: 'other-structures', url: `${BASE}/9`, fields: ['OBJECTID', 'UniqueID'] },
  outfalls: { name: 'outfalls', url: `${BASE}/7`, fields: ['OBJECTID', 'Outfall_ID'] },
  pipes: { name: 'pipes', url: `${BASE}/11`, fields: ['OBJECTID', 'uniqueID', 'Diameter', 'owned_by'] },
  culverts: { name: 'culverts', url: `${BASE}/12`, fields: ['OBJECTID', 'UniqueID'] },
  detention: { name: 'detention-pipes', url: `${BASE}/13`, fields: ['OBJECTID', 'uniqueID'] },
  ditches: { name: 'ditches', url: `${BASE}/14`, fields: ['OBJECTID', 'UniqueID'] },
  bioswales: { name: 'bioswales', url: `${BASE}/15`, fields: ['OBJECTID', 'uniqueID'] },
  streams: { name: 'streams', url: `${BASE}/16`, fields: ['OBJECTID', 'UniqueID'] },
  retention: { name: 'retention', url: `${BASE}/17`, fields: ['OBJECTID', 'UniqueID'] },
  vaults: { name: 'vaults', url: `${BASE}/18`, fields: ['OBJECTID', 'uniqueID'] },
  facilities: { name: 'facilities', url: `${BASE}/19`, fields: ['OBJECTID', 'UniqueID'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

export function npOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s) return undefined;
  if (/^(City of )?Normandy Park$/.test(s)) return 'public';
  if (s === 'Private') return 'private';
  return 'other';
}
const SOLID = new Set(['Manhole', 'Locking', 'Solid Grate']);
const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** The flow flag of the basin entry on the side a line leaves toward (compass degrees), if one entry fits. */
export function flagToward(entries: readonly { deg: number; flow: string }[], deg: number): 'IN' | 'OUT' | undefined {
  const diff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const fit = entries.filter((e) => diff(e.deg, deg) <= 35);
  const flows = new Set(fit.map((e) => e.flow));
  return flows.size === 1 ? (fit[0].flow as 'IN' | 'OUT') : undefined;
}

/** Compass bearing (degrees from north) from a to b. */
export function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

export async function buildNormandyPark(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`normandy-park ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.34, 47.44]);
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.CB_ID) || str(a.UniqueID) || str(a.uniqueID) || str(a.Outfall_ID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const flags = new Map<string, { deg: number; flow: string }[]>();
  const outfalls = new Set<string>();

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) return void inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: npOwner(f.attributes.owned_by), ...more });
    inc(`points.${layer}.${role}`);
    return key;
  };
  const pFlags = (a: Attrs) => {
    const out: { deg: number; flow: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const deg = COMPASS[str(a[`P${i}_Directi`]).toUpperCase()];
      const flow = str(a[`P${i}_Flow`]).toUpperCase();
      if (deg !== undefined && (flow === 'IN' || flow === 'OUT')) out.push({ deg, flow });
    }
    return out;
  };
  for (const layer of ['catchBasins', 'drains'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const key = point(layer, f, SOLID.has(str(a.Frame_Grat)) ? 'junction' : 'drain');
      const p = pFlags(a);
      if (key && p.length) flags.set(key, p);
    }
  }
  for (const f of L.other) point('other', f, 'junction');
  for (const f of L.outfalls) {
    const key = point('outfalls', f, 'outfall', { endHint: 'water' });
    if (key) outfalls.add(key);
  }
  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return void inc('skipped.noGeometry');
    for (const ring of rings) assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none', owner: undefined });
    inc(`facilities.${role}`);
  };
  for (const f of L.retention) polygon('retention', f, 'facility-infiltrate');
  for (const f of L.vaults) polygon('vaults', f, 'facility-hold');
  for (const f of L.facilities) polygon('facilities', f, 'facility-hold');

  const gaps = { n: 0 };
  const lines: { asset: SourceAsset; type: string }[] = [];
  const line = (layer: LayerName, f: EsriFeature, role: Role, type: string, more: Partial<SourceAsset> = {}) => {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return void inc('skipped.noGeometry');
    const asset: SourceAsset = { role, id: idOf(layer, f.attributes), src: KEY, coords, trust: 'none', owner: npOwner(f.attributes.owned_by), ...more };
    assets.push(asset);
    lines.push({ asset, type });
  };
  for (const f of L.pipes) line('pipes', f, 'pipe', 'pipe', { width: toM(num(f.attributes.Diameter), IN) });
  for (const f of L.detention) line('detention', f, 'pipe', 'pipe');
  for (const f of L.culverts) line('culverts', f, 'culvert', 'culvert');
  for (const f of L.ditches) line('ditches', f, 'ditch', 'ditch');
  for (const f of L.bioswales) line('bioswales', f, 'ditch', 'ditch');
  for (const f of L.streams) line('streams', f, 'stream', 'stream', { liveStream: true });

  const ground = await openGround(boundaryBox(boundary));
  // the vertex about 5 m along from an end, for the side the line leaves a basin on
  const awayFrom = (c: LonLat[]): LonLat => c.find((p) => approxM(p, c[0]) >= 3) ?? c[c.length - 1];
  const flagAt = (c: LonLat[]): 'IN' | 'OUT' | undefined => {
    const n = nodes.nearest(c[0], 3);
    const p = n && flags.get(n.ref.key);
    return p ? flagToward(p, bearing(n.ref.at, awayFrom(c))) : undefined;
  };
  const checks: LineCheck[] = lines.map(({ asset, type }) => {
    const c = asset.coords;
    const rev = [...c].reverse();
    const g = groundSign(ground, c);
    const f0 = flagAt(c), f1 = flagAt(rev);
    const s0: Say = f0 === 'OUT' ? 'down' : f0 === 'IN' ? 'up' : undefined;
    const s1: Say = f1 === 'IN' ? 'down' : f1 === 'OUT' ? 'up' : undefined;
    if (f0 || f1) inc('flags.lineEndsMatched', (f0 ? 1 : 0) + (f1 ? 1 : 0));
    const own: Say = s0 && s1 ? (s0 === s1 ? s0 : undefined) : (s0 ?? s1);
    if (s0 && s1 && s0 !== s1) inc('flags.conflicting');
    const n0 = nodes.nearest(c[0], 2)?.ref.key, n1 = nodes.nearest(c[c.length - 1], 2)?.ref.key;
    const o0 = !!n0 && outfalls.has(n0), o1 = !!n1 && outfalls.has(n1);
    const outfall: Say = asset.role !== 'stream' && asset.role !== 'ditch' && o0 !== o1 ? (o1 ? 'down' : 'up') : undefined;
    return { asset, type, ground: g > 0 ? 'down' : g < 0 ? 'up' : undefined, own, outfall };
  });
  const r = orient(checks, { ownTrust: 'node-flags', drawnOk: 0.75, ownOk: 0.8 });
  extra['lines.pathGaps'] = gaps.n;
  const notes = [
    ...orientNotes(r, 'Catch basin pipe flags (P1-P5 side and IN/OUT, matched to the side a line leaves a basin within 3 m on, 35 degrees)', extra),
    'Catch basins and drains are drains unless the frame is a manhole, locking or solid lid; other structures are junctions',
    "Outfalls -> 'water'. Retention outlines soak in; vaults and facility outlines hold. Detention pipes are pipes; bioswales are ditches; the city's stream lines are streams",
    'owner: public = Normandy Park, private = Private, other = Burien or Des Moines',
    'Read only. Dropped: comments, descriptions, inspector, creator and editor fields, parcels and other non-storm layers (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Normandy Park',
    county: 'King',
    credit: 'Storm drain data: City of Normandy Park GIS, provided as is.',
    disclaimer: 'City of Normandy Park GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
    // ravine creeks the County layer leaves out
    ownStreams: true,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildNormandyPark);
