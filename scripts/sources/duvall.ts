// City of Duvall storm drains -> <cache>/sources/duvall/{assets.ndjson,meta.json}.
// Lines carry almost no from/to IDs or inverts: they join by geometry and are kept as drawn where the ground
// (USGS 3DEP) shows each line type is drawn downhill about as often as keyed lines in nearby cities are.
// node scripts/sources/duvall.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  IN,
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
import { readBoundaries } from './lib/boundaries.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'duvall';
const BASE = 'https://services2.arcgis.com/Dd9GPUeSdPGK109w/arcgis/rest/services';
const LIVE = "AssetStatus = 'Active' OR AssetStatus IS NULL";

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/CoD_Storm_Pipe_AMS/FeatureServer/0`, fields: ['OBJECTID', 'Asset_ID', 'Use_Type', 'Size', 'Owner', 'AssetStatus'], where: LIVE },
  channels: { name: 'channels', url: `${BASE}/CoD_Storm_OpenChannel_AMS/FeatureServer/0`, fields: ['OBJECTID', 'Asset_ID', 'Use_Type', 'Owner', 'AssetStatus'], where: LIVE },
  structures: { name: 'structures', url: `${BASE}/CoD_Storm_Structure_AMS/FeatureServer/0`, fields: ['OBJECTID', 'Asset_ID', 'Structure_Type', 'Grate_Type', 'Owner', 'AssetStatus'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/CoD_Storm_Outfall_AMS/FeatureServer/0`, fields: ['OBJECTID', 'Asset_ID', 'Owner', 'AssetStatus'], where: LIVE },
  facilities: { name: 'facilities', url: `${BASE}/CoD_Storm_PublicFacilities_AMS/FeatureServer/0`, fields: ['OBJECTID', 'FacilityID', 'OwnedBy', 'LifeCycleStatus'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function duvallOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (/Duvall$/.test(s)) return 'public';
  if (s === 'Private') return 'private';
  return s ? 'other' : undefined;
}

/** Use_Type -> role; trenches and perforated pipes soak water in */
const PIPE_ROLES: Record<string, { role: Role; label: string; perforated?: boolean }> = {
  Pipe: { role: 'pipe', label: 'pipe' },
  'Detention Pipe': { role: 'pipe', label: 'pipe' },
  'Inlet Pipe': { role: 'pipe', label: 'pipe' },
  InletPipe: { role: 'pipe', label: 'pipe' },
  'Outlet Pipe': { role: 'pipe', label: 'pipe' },
  VaultInlet: { role: 'pipe', label: 'pipe' },
  WallDrain: { role: 'pipe', label: 'pipe' },
  Culvert: { role: 'culvert', label: 'culvert' },
  'Culvert Pipe': { role: 'culvert', label: 'culvert' },
  'Box Culvert': { role: 'culvert', label: 'culvert' },
  'Infiltration Trench': { role: 'pipe', label: 'trench', perforated: true },
  'Dispersion Trench': { role: 'pipe', label: 'trench', perforated: true },
  DispersionTrench: { role: 'pipe', label: 'trench', perforated: true },
  'Level Spreader Trench': { role: 'pipe', label: 'trench', perforated: true },
  LevelSpreaderTrench: { role: 'pipe', label: 'trench', perforated: true },
  'Perf Pipe': { role: 'pipe', label: 'trench', perforated: true },
};
/** share of lines drawn downhill (where the ground falls 0.5 m or more) needed to keep a line type as drawn */
const GROUND_OK = 0.75;

export async function buildDuvall(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`duvall ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const juris = readBoundaries().jurisdictions.find((j) => j.name === 'Duvall');
  if (!juris) throw new Error('no Duvall in the context boundaries');
  const boundary = juris.polygons as LonLat[][][];

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs, field = 'Asset_ID') => str(a[field]) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: [at], trust: 'none', owner: duvallOwner(f.attributes.Owner), ...more });
    inc(`points.${layers[layer].name}.${role}`);
  };
  for (const f of L.structures) {
    const a = f.attributes;
    const t = str(a.Structure_Type);
    const solid = /Solid/i.test(str(a.Grate_Type));
    // catch basins (Type 1 and 2; grate types are almost never recorded) take street water; vault lids, filters and connections don't
    point('structures', f, (t === '1' || t === '2') && !solid ? 'drain' : 'junction');
  }
  for (const f of L.outfalls) point('outfalls', f, 'outfall', { endHint: 'unknown' });
  for (const f of L.facilities) {
    if (str(f.attributes.LifeCycleStatus) && str(f.attributes.LifeCycleStatus) !== 'Active') continue;
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    // facility types are bare codes: none says it soaks in
    const id = idOf('facilities', f.attributes, 'FacilityID');
    for (const ring of rings) assets.push({ role: 'facility-hold', id, src: KEY, coords: ring, trust: 'none', owner: duvallOwner(f.attributes.OwnedBy) });
    inc('facilities');
  }

  const gaps = { n: 0 };
  const byType = new Map<string, SourceAsset[]>();
  const add = (label: string, a: SourceAsset) => {
    assets.push(a);
    const list = byType.get(label) ?? [];
    list.push(a);
    byType.set(label, list);
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    const spec = PIPE_ROLES[str(a.Use_Type)] ?? { role: 'pipe' as Role, label: 'pipe' };
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    add(spec.label, { role: spec.role, id: idOf('pipes', a), src: KEY, coords, trust: 'none', owner: duvallOwner(a.Owner), width: spec.role === 'pipe' || spec.role === 'culvert' ? toM(num(a.Size), IN) : undefined, perforated: spec.perforated || undefined });
  }
  for (const f of L.channels) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    add('ditch', { role: 'ditch', id: idOf('channels', f.attributes), src: KEY, coords, trust: 'none', owner: duvallOwner(f.attributes.Owner) });
  }

  // which way are the lines drawn? the ground at their ends, per line type
  const ground = await openGround(boundaryBox(boundary));
  const notes: string[] = [];
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const sign = new Map<SourceAsset, number>();
  for (const list of byType.values()) for (const a of list) sign.set(a, groundSign(ground, a.coords));
  let allD = 0;
  let allU = 0;
  for (const s of sign.values()) s > 0 ? allD++ : s < 0 ? allU++ : 0;
  const allOk = allD + allU >= 20 && allD / (allD + allU) >= GROUND_OK;
  for (const [label, list] of byType) {
    let d = 0;
    let u = 0;
    for (const a of list) {
      const s = sign.get(a)!;
      if (s > 0) d++;
      else if (s < 0) u++;
    }
    // a type with too few sloped lines to judge goes with the whole map
    const ok = d + u >= 20 ? d / (d + u) >= GROUND_OK : allOk;
    if (ok) for (const a of list) a.trust = 'digitized';
    extra[`ground.${label}.downhill`] = d;
    extra[`ground.${label}.uphill`] = u;
    extra[`lines.${label}`] = list.length;
    notes.push(`${label}: ${list.length} lines; the ground falls along ${d}/${d + u} (${pct(d, d + u)}) as drawn; ${ok ? "'digitized' (kept as drawn)" : "'none'"}`);
  }
  extra['lines.pathGaps'] = gaps.n;
  notes.unshift(
    `Lines carry no usable from/to IDs or inverts (10 and 2 of ${L.pipes.length} pipes). The ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${allD}/${allD + allU} (${pct(allD, allD + allU)}) of all lines as drawn; keyed lines in Mercer Island, Maple Valley, Bothell and Woodinville, which are in flow order, show 92%, 83%, 88% and 91%`,
  );
  notes.push(
    'Structures: Type 1 and Type 2 catch basins are drains (grate types are almost never recorded; a solid one is a junction); vault lids, filters and drain connections are junctions',
    "Outfalls (11) -> 'unknown': the tracer judges them by the water beside them",
    'Public facility outlines -> facility-hold (their type codes are not explained). Yard drain and roof connections (CoD_Storm_Drain_AMS) left out',
    'owner: public = City of Duvall, private = Private, other = King County, WSDOT and the rest',
    'Only Active features. Dropped: addresses and parcels, record links and comments, project, installer and editor fields (never requested); the parcel layers are never used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Duvall',
    county: 'King',
    credit: 'Storm drain data: City of Duvall GIS, provided as is.',
    disclaimer: 'The City of Duvall disclaims any warranty of merchantability or fitness of this data for any particular purpose, and makes no representation or warranty about its accuracy, currency, completeness or quality.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildDuvall);
