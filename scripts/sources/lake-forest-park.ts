// City of Lake Forest Park storm drains -> <cache>/sources/lake-forest-park/{assets.ndjson,meta.json}.
// The city's public MS4 map (ArcGIS Online, read only). Lines join by geometry and are drawn downstream;
// up/down inverts, a compass flow direction and the ground (USGS 3DEP) check that (lib/orient.ts).
// node scripts/sources/lake-forest-park.ts [--refresh] [--box=w,s,e,n]
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
import { compassOf, orientLines, type DrawnLine } from './lib/orient.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'lake-forest-park';
const BASE = 'https://services7.arcgis.com/LD3i16TenysvoOyS/arcgis/rest/services/MS4_Map_WFL1/FeatureServer';
const GEOID = '5337270';

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/7`, fields: ['OBJECTID', 'Asset_ID', 'Owner', 'Diameter', 'Flowdirect', 'Upstream_IE', 'Downstrea_IE', 'Drive_Culvert'] },
  ditches: { name: 'ditches', url: `${BASE}/6`, fields: ['OBJECTID', 'Asset_ID', 'Owner', 'TrenchDrain', 'Flow_Direction'] },
  catchBasins: { name: 'catch-basins', url: `${BASE}/1`, fields: ['OBJECTID', 'AssetID', 'Owner', 'StructureType', 'InletType'] },
  manholes: { name: 'manholes', url: `${BASE}/5`, fields: ['OBJECTID', 'AssetID', 'Owner'] },
  outfalls: { name: 'outfalls', url: `${BASE}/3`, fields: ['OBJECTID', 'AssetID', 'Owner'] },
  dischargePoints: { name: 'discharge-points', url: `${BASE}/2`, fields: ['OBJECTID', 'AssetID', 'Owner'] },
  interconnections: { name: 'interconnections', url: `${BASE}/4`, fields: ['OBJECTID', 'ID_Number', 'Type'] },
  facilities: { name: 'facilities', url: `${BASE}/10`, fields: ['OBJECTID', 'FacilityID', 'MajorComponent', 'CurrentStatus'], where: "CurrentStatus = 'Active' OR CurrentStatus IS NULL" },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;
const ID: Record<LayerName, string> = {
  pipes: 'Asset_ID', ditches: 'Asset_ID', catchBasins: 'AssetID', manholes: 'AssetID', outfalls: 'AssetID', dischargePoints: 'AssetID', interconnections: 'ID_Number', facilities: 'FacilityID',
};

const owner = (v: unknown): SourceAsset['owner'] => {
  const s = str(v);
  if (s === 'City of Lake Forest Park') return 'public';
  if (s === 'Private') return 'private';
  return s && !/^Unknown|^N\/A/.test(s) ? 'other' : undefined;
};
const SOLID = /Solid/;

export async function buildLakeForestPark(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`lake forest park ${q.name}`);
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
  // catch basins and inlets: a solid cover takes no street water; no inlet type recorded -> a drain
  for (const f of L.catchBasins) point('catchBasins', f, SOLID.test(str(f.attributes.InletType)) ? 'junction' : 'drain');
  for (const f of L.manholes) point('manholes', f, 'junction');
  // receiving waters are not named
  for (const f of L.outfalls) point('outfalls', f, 'outfall', { endHint: 'water' });
  // where the city system hands water to something other than a water body: the walk goes on where the map does
  for (const f of L.dischargePoints) point('dischargePoints', f, 'discharge', { endHint: 'unknown' });
  for (const f of L.interconnections) {
    if (/Infiltration/.test(str(f.attributes.Type))) point('interconnections', f, 'discharge', { endHint: 'ground', receivingHint: 'infiltration facility' });
    else point('interconnections', f, 'junction');
  }
  for (const f of L.facilities) {
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const c = str(f.attributes.MajorComponent);
    // tanks, vaults, ponds and filters hold; a trench or bioretention cell alone soaks in
    const role: Role = /^(Trench|Bioret)/.test(c) ? 'facility-infiltrate' : 'facility-hold';
    for (const ring of rings) assets.push({ role, id: idOf('facilities', f.attributes), src: KEY, coords: ring, trust: 'none' });
    inc(`facilities.${role}`);
  }

  const gaps = { n: 0 };
  const lines: DrawnLine[] = [];
  const line = (layer: LayerName, f: EsriFeature, kind: string, role: Role, compass: unknown, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const asset: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: owner(a.Owner), ...more };
    assets.push(asset);
    lines.push({ asset, kind, up: num(a.Upstream_IE) || undefined, down: num(a.Downstrea_IE) || undefined, compass: compassOf(compass) });
    inc(`lines.${kind}`);
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    const culvert = str(a.Drive_Culvert) === 'Yes';
    const d = num(a.Diameter);
    line('pipes', f, culvert ? 'culvert' : 'pipe', culvert ? 'culvert' : 'pipe', a.Flowdirect, { width: d > 0 ? toM(d, IN) : undefined });
  }
  for (const f of L.ditches) {
    const trench = /^Y/.test(str(f.attributes.TrenchDrain));
    line('ditches', f, trench ? 'trench drain' : 'ditch', trench ? 'pipe' : 'ditch', f.attributes.Flow_Direction);
  }

  const ground = await openGround(boundaryBox(boundary));
  const notes = orientLines(lines, ground, extra);
  extra['lines.pathGaps'] = gaps.n;
  notes.push(
    'Catch basins and inlets are drains unless the cover is solid; manholes and MS4 interconnections are junctions',
    "Outfalls -> 'water' (receiving waters are not named); discharge points -> 'unknown' (the walk goes on where the map does); interconnections into an infiltration facility soak in",
    'Facilities: tanks, vaults, ponds and filters hold water; trenches and bioretention cells soak in',
    'Pipes marked driveway culvert are culverts; ditches marked trench drain are pipes',
    'owner: public = City of Lake Forest Park, private = Private, other = WSDOT, King County, other cities',
    'Dropped: easements, facility names, parcels, addresses, owner names, notes and editor fields (never requested)',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Lake Forest Park',
    county: 'King',
    credit: 'Storm drain data: City of Lake Forest Park GIS, provided as is.',
    disclaimer: 'City of Lake Forest Park GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildLakeForestPark);
