// City of Kenmore storm drains -> <cache>/sources/kenmore/{assets.ndjson,meta.json}.
// The read-only Stormwater feature service (never the editing one). Lines join by geometry and are drawn
// downstream; up/down inverts, a compass flow direction and the ground (USGS 3DEP) check that (lib/orient-drawn.ts).
// node scripts/sources/kenmore.ts [--refresh] [--box=w,s,e,n]
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
import { compassOf, orientLines, streamName, type DrawnLine } from './lib/orient-drawn.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'kenmore';
const BASE = 'https://gwa.kenmorewa.gov/arcgis/rest/services/Stormwater/FeatureServer';
const GEOID = '5335170';
const LIVE = "Status = 'Existing' OR Status IS NULL";

const LINE = ['OBJECTID', 'Status', 'Owner', 'FlowDir', 'UP_IE', 'DOWN_IE'];
const FAC = ['OBJECTID', 'Facility_ID', 'Status', 'Owner'];
const layers = {
  enclosed: { name: 'enclosed', url: `${BASE}/28`, fields: [...LINE, 'ECONV_ID', 'Econv_Type', 'Diameter', 'Perforated'], where: LIVE },
  open: { name: 'open', url: `${BASE}/16`, fields: [...LINE, 'OCONV_ID', 'Oconv_Type'], where: LIVE },
  streamCulverts: { name: 'stream-culverts', url: `${BASE}/22`, fields: [...LINE, 'SCUL_ID'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${BASE}/3`, fields: ['OBJECTID', 'CB_ID', 'CB_Type', 'Grate', 'Infiltration', 'Status', 'Owner'], where: LIVE },
  connections: { name: 'connections', url: `${BASE}/4`, fields: ['OBJECTID', 'Conn_ID', 'Conn_Type', 'Outfall', 'Stream', 'Status', 'Owner'], where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/19`, fields: [...FAC, 'Pond_ID', 'Infiltration'], where: LIVE },
  tanks: { name: 'tanks', url: `${BASE}/25`, fields: [...FAC, 'Tank_ID', 'Infiltration'], where: LIVE },
  vaults: { name: 'vaults', url: `${BASE}/26`, fields: [...FAC, 'Vault_ID', 'Infiltration'], where: LIVE },
  drywells: { name: 'drywells', url: `${BASE}/6`, fields: ['OBJECTID', 'DW_ID', 'Owner'] },
  infiltration: { name: 'infiltration', url: `${BASE}/11`, fields: [...FAC, 'INF_ID'], where: LIVE },
  // the city's stream map: small creeks the County and NHD layers leave out
  streams: { name: 'streams', url: 'https://gwa.kenmorewa.gov/arcgis/rest/services/streams_basemap/MapServer/38', fields: ['OBJECTID', 'NAME'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;
const ID: Record<LayerName, string> = {
  enclosed: 'ECONV_ID', open: 'OCONV_ID', streamCulverts: 'SCUL_ID', catchBasins: 'CB_ID', connections: 'Conn_ID',
  ponds: 'Pond_ID', tanks: 'Tank_ID', vaults: 'Vault_ID', drywells: 'DW_ID', infiltration: 'INF_ID', streams: '',
};

const owner = (v: unknown): SourceAsset['owner'] => {
  const s = str(v);
  if (s === 'Kenmore') return 'public';
  if (s.startsWith('Private')) return 'private';
  return s && s !== 'Na' && s !== 'NA' ? 'other' : undefined;
};
const ENCLOSED: Record<string, Role> = {
  Pipe: 'pipe', Tightline: 'pipe', 'Arched Pipe': 'pipe', 'Trench Drain': 'pipe', 'Vault Flow': 'pipe', 'Other (Comment)': 'pipe',
  Culvert: 'culvert', 'Arched Culvert': 'culvert', 'Box Culvert': 'culvert', Ditch: 'ditch', 'Half Pipe': 'ditch',
};
/** open conveyance: non-channel flow, waterbodies and bridges left out */
const OPEN = new Set(['Ditch', 'Eng Swale', 'Half Pipe', 'Gutter']);
const SOLID = new Set(['Solid Rect Lid', 'Solid Circ Lid']);
/** connection types where the pipe goes somewhere the map doesn't show */
const OPEN_END = new Set(['UNKNOWN TO', 'CONVEYANCE END', 'INTERCONNECTION OUT', 'OVERFLOW']);
const inches = (v: unknown) => num(String(v ?? '').replace(/\s*INCH$/i, ''));

export async function buildKenmore(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`kenmore ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a[ID[layer]]) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: [at], trust: 'none', owner: owner(f.attributes.Owner), ...more });
    inc(`points.${role}`);
  };
  for (const f of L.catchBasins) {
    const a = f.attributes;
    const soak = str(a.Infiltration) === 'Yes' || undefined;
    point('catchBasins', f, /^MH/.test(str(a.CB_Type)) || SOLID.has(str(a.Grate)) ? 'junction' : 'drain', { openBottom: soak });
  }
  for (const f of L.connections) {
    const a = f.attributes;
    if (str(a.Outfall) === 'Yes') point('connections', f, 'outfall', { endHint: 'water', receivingHint: str(a.Stream) === 'Yes' ? 'stream' : undefined });
    else if (OPEN_END.has(str(a.Conn_Type))) point('connections', f, 'outfall', { endHint: 'unknown' });
    else point('connections', f, 'junction');
  }

  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return inc('skipped.noGeometry');
    for (const ring of rings) assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none', owner: owner(f.attributes.Owner) });
    inc(`facilities.${role}`);
  };
  const soaks = (f: EsriFeature) => (str(f.attributes.Infiltration) === 'Yes' ? 'facility-infiltrate' : 'facility-hold');
  for (const layer of ['ponds', 'tanks', 'vaults'] as const) for (const f of L[layer]) polygon(layer, f, soaks(f));
  for (const layer of ['drywells', 'infiltration'] as const) for (const f of L[layer]) polygon(layer, f, 'facility-infiltrate');

  const gaps = { n: 0 };
  const lines: DrawnLine[] = [];
  const line = (layer: LayerName, f: EsriFeature, kind: string, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const asset: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: owner(a.Owner), ...more };
    assets.push(asset);
    lines.push({ asset, kind, up: num(a.UP_IE) || undefined, down: num(a.DOWN_IE) || undefined, compass: compassOf(a.FlowDir) });
    inc(`lines.${kind}`);
  };
  for (const f of L.enclosed) {
    const a = f.attributes;
    const role = ENCLOSED[str(a.Econv_Type)];
    if (!role) {
      inc(`skipped.enclosed${str(a.Econv_Type) || 'Blank'}`);
      continue;
    }
    line('enclosed', f, role, role, { width: role === 'ditch' ? undefined : toM(inches(a.Diameter), IN), perforated: str(a.Perforated) === 'Yes' || undefined });
  }
  for (const f of L.open) {
    if (!OPEN.has(str(f.attributes.Oconv_Type))) {
      inc(`skipped.open${str(f.attributes.Oconv_Type) || 'Blank'}`);
      continue;
    }
    line('open', f, 'ditch', 'ditch');
  }
  for (const f of L.streamCulverts) line('streamCulverts', f, 'stream culvert', 'stream-culvert', { liveStream: true });

  // streams as drawn (direction not recorded): a walk that reaches one ends there
  for (const f of L.streams) {
    const coords = lineOf(f.geometry);
    if (!coords) continue;
    assets.push({ role: 'stream', id: idOf('streams', f.attributes), src: KEY, coords, trust: 'none', liveStream: true, waterName: streamName(f.attributes.NAME) });
    inc('lines.stream');
  }

  const ground = await openGround(boundaryBox(boundary));
  const notes = orientLines(lines, ground, extra);
  extra['lines.pathGaps'] = gaps.n;
  notes.push(
    'Catch basins, curb and yard inlets are drains unless the lid is solid; manhole types are junctions; catch basins marked infiltration soak in',
    "Connections: marked outfall -> 'water'; unknown-to, conveyance ends, interconnections out and overflows -> 'unknown' (the walk goes on where the map does); the rest are junctions",
    'Facilities: ponds, tanks and vaults hold water unless marked infiltration; drywells and infiltration BMPs soak in',
    'owner: public = Kenmore, private = Private (all kinds), other = Not In Kenmore',
    "Streams from the city's stream map are waters too",
    'Only existing assets. Dropped: comments, photos, video links, facility owner and contact fields and editor fields (never requested); the editing service is never used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Kenmore',
    county: 'King',
    credit: 'Storm drain data: City of Kenmore GIS, provided as is.',
    disclaimer: 'City of Kenmore GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    ownStreams: true,
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildKenmore);
