// City of Shoreline storm drains -> <cache>/sources/shoreline/{assets.ndjson,meta.json}.
// The city's Cityworks surface water service (read only). Lines join by geometry and are drawn in flow
// order; up/down elevations on some lines and the ground (USGS 3DEP) check that (lib/orient-drawn.ts).
// The server sends an incomplete certificate chain: run with NODE_OPTIONS=--use-system-ca.
// node scripts/sources/shoreline.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  IN,
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
  type RunOptions,
} from './bellevue.ts';
import { openGround } from './lib/downhill.ts';
import { orientLines, streamName, type DrawnLine } from './lib/orient-drawn.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'shoreline';
const BASE = 'https://gis.shorelinewa.gov/server/rest/services/Cityworks/Cityworks_SurfaceWater/MapServer';
const GEOID = '5363960';
const LIVE = "LifeCycle = 'AC' OR LifeCycle IS NULL";

const LINE = ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'UPSELEV', 'DWNELEV'];
const layers = {
  pipes: { name: 'pipes', url: `${BASE}/16`, fields: [...LINE, 'FeatureType', 'PIPEDIAM'], where: LIVE },
  ditches: { name: 'ditches', url: `${BASE}/17`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy'], where: LIVE },
  channels: { name: 'channels', url: `${BASE}/18`, fields: LINE, where: LIVE },
  boxCulverts: { name: 'box-culverts', url: `${BASE}/19`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy'], where: LIVE },
  drains: { name: 'drain-lines', url: `${BASE}/20`, fields: [...LINE, 'FeatureType'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${BASE}/3`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'FeatureType', 'Cover_Type'], where: LIVE },
  manholes: { name: 'manholes', url: `${BASE}/4`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy'], where: LIVE },
  pipeInlets: { name: 'pipe-inlets', url: `${BASE}/6`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/9`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'DISCHARGE'], where: LIVE },
  vaults: { name: 'vaults', url: `${BASE}/32`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'FEATURETYPE'], where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/39`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'FEATURETYPE'], where: LIVE },
  infiltration: { name: 'infiltration', url: `${BASE}/28`, fields: ['OBJECTID', 'AssetID', 'LifeCycle', 'OwnedBy', 'FEATURETYPE'], where: LIVE },
  // the city's stream inventory: small creeks the County and NHD layers leave out
  streams: { name: 'streams', url: 'https://gis.shorelinewa.gov/server/rest/services/Cityworks/Cityworks_CriticalAreas/MapServer/0', fields: ['OBJECTID', 'REACH_ID', 'RegulatoryType', 'Name'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const owner = (v: unknown): SourceAsset['owner'] => {
  const s = str(v);
  if (s === 'CITY' || s === 'CITYO') return 'public';
  if (s === 'PVT') return 'private';
  return s ? 'other' : undefined;
};
/** solid, locking, bolted or gasketed covers take no street water */
const SOLID = new Set(['S', 'LOCK', 'BOLT', 'GASK', 'STMH']);
/** pipe types: VNT (vents) left out */
const PIPE_ROLES: Record<string, { role: Role; perforated?: boolean }> = {
  GRV: { role: 'pipe' }, LTR: { role: 'pipe' }, TNK: { role: 'pipe' }, FRC: { role: 'pipe' }, '': { role: 'pipe' },
  INF: { role: 'pipe', perforated: true },
  CVT: { role: 'culvert' }, BXCVT: { role: 'culvert' },
  SMCVT: { role: 'stream-culvert' },
};
const WATER: Record<string, string> = { STR: 'stream', LAKE: 'lake', PS: 'Puget Sound' };
/** outfalls into another storm structure: the pipe goes on */
const INTO_PIPE = new Set(['PIPE', 'CB', 'MH']);
const INTO_FACILITY: Record<string, string> = { DI: 'ditch', SW: 'swale', P: 'pond', V: 'vault', BIO: 'bioretention', CULV: 'culvert' };

export async function buildShoreline(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`shoreline ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.AssetID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: [at], trust: 'none', owner: owner(f.attributes.OwnedBy), ...more });
    inc(`points.${role}`);
  };
  for (const f of L.catchBasins) {
    const a = f.attributes;
    // downspout drains take roof water only
    point('catchBasins', f, SOLID.has(str(a.Cover_Type)) || str(a.FeatureType) === 'DSD' ? 'junction' : 'drain');
  }
  for (const f of L.manholes) point('manholes', f, 'junction');
  for (const f of L.pipeInlets) point('pipeInlets', f, 'junction');
  for (const f of L.outfalls) {
    const d = str(f.attributes.DISCHARGE);
    if (WATER[d]) point('outfalls', f, 'outfall', { endHint: 'water', receivingHint: WATER[d] });
    else if (INTO_PIPE.has(d)) point('outfalls', f, 'junction');
    else point('outfalls', f, 'outfall', { endHint: 'unknown', receivingHint: INTO_FACILITY[d] });
  }

  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return inc('skipped.noGeometry');
    for (const ring of rings) assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none', owner: owner(f.attributes.OwnedBy) });
    inc(`facilities.${role}`);
  };
  for (const f of L.vaults) polygon('vaults', f, 'facility-hold');
  for (const f of L.ponds) polygon('ponds', f, 'facility-hold');
  // drywells, infiltration beds, trenches and pipes
  for (const f of L.infiltration) polygon('infiltration', f, 'facility-infiltrate');

  const gaps = { n: 0 };
  const lines: DrawnLine[] = [];
  const line = (layer: LayerName, f: EsriFeature, kind: string, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const asset: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: owner(a.OwnedBy), ...more };
    assets.push(asset);
    lines.push({ asset, kind, up: num(a.UPSELEV) || undefined, down: num(a.DWNELEV) || undefined });
    inc(`lines.${kind}`);
  };
  for (const f of L.pipes) {
    const t = str(f.attributes.FeatureType);
    const spec = PIPE_ROLES[t];
    if (!spec) {
      inc(`skipped.pipeType${t}`);
      continue;
    }
    const d = num(f.attributes.PIPEDIAM);
    line('pipes', f, spec.role === 'pipe' ? 'pipe' : 'culvert', spec.role, { width: toM(d, IN), perforated: spec.perforated || undefined, liveStream: spec.role === 'stream-culvert' || undefined });
  }
  for (const f of L.boxCulverts) line('boxCulverts', f, 'culvert', 'culvert');
  for (const f of L.drains) line('drains', f, 'drain line', 'pipe', { perforated: str(f.attributes.FeatureType) === 'TRENCH' ? undefined : true });
  for (const f of L.ditches) line('ditches', f, 'ditch', 'ditch');
  for (const f of L.channels) line('channels', f, 'channel', 'ditch');

  // streams as drawn (direction not recorded): a walk that reaches one ends there; ditch-only reaches left out
  for (const f of L.streams) {
    const coords = lineOf(f.geometry);
    if (!coords || str(f.attributes.RegulatoryType) === 'DO') continue;
    assets.push({ role: 'stream', id: str(f.attributes.REACH_ID) || `streams:${str(f.attributes.OBJECTID)}`, src: KEY, coords, trust: 'none', liveStream: true, waterName: streamName(f.attributes.Name) });
    inc('lines.stream');
  }

  const ground = await openGround(boundaryBox(boundary));
  const notes = orientLines(lines, ground, extra);
  extra['lines.pathGaps'] = gaps.n;
  notes.push(
    'Catch basins, area, yard drains and inlets are drains unless the cover is solid, locking, bolted or gasketed; downspout drains, manholes and pipe inlets are junctions',
    "Outfalls: into a stream, lake or Puget Sound -> 'water'; into a pipe, catch basin or manhole -> junction; into a ditch, swale, pond, vault, bioretention or culvert, or not recorded -> 'unknown' (the walk goes on where the map does)",
    'Facilities: vaults and ponds hold water; drywells and infiltration beds, trenches and pipes soak in',
    'Pipes: gravity, laterals, detention tanks and force mains; infiltration pipes, French and under drains are perforated; stream culverts carry a stream; vents left out',
    'owner: public = City of Shoreline / City (Other), private = Private, other = County, State, Sound Transit, Other',
    "Streams from the city's critical areas inventory (ditch-only reaches left out) are waters too",
    'Only active assets. Dropped: Location, NOTES, names, picture links and editor fields (never requested); proposed and abandoned layers not used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Shoreline',
    county: 'King',
    credit: 'Storm drain data: City of Shoreline GIS, provided as is.',
    disclaimer: 'City of Shoreline GIS data is not official and is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    ownStreams: true,
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildShoreline);
