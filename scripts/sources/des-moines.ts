// City of Des Moines storm drains -> <cache>/sources/des-moines/{assets.ndjson,meta.json}.
// No from/to IDs (FromMH/ToMH are plan labels on a few) and almost no line inverts: lines join by geometry.
// Direction: catchment inverts at both ends where recorded, else the ground (USGS 3DEP) per line type.
// node scripts/sources/des-moines.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
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

const KEY = 'des-moines';
const BASE = 'https://gis.desmoineswa.gov/dmgis/rest/services/AssetManagement/Storm/MapServer';
const GEOID = '5317635';
const ACTIVE = 'ActiveFlag = 1';

const layers = {
  discharge: { name: 'discharge', url: `${BASE}/0`, fields: ['OBJECTID', 'AssetID', 'DisChrgType', 'ReceivingEntity', 'OwnedBy'], where: ACTIVE },
  fcwq: { name: 'fcwq-structures', url: `${BASE}/2`, fields: ['OBJECTID', 'AssetID', 'FCWQSubtype', 'OwnedBy'], where: ACTIVE },
  misc: { name: 'misc-structures', url: `${BASE}/3`, fields: ['OBJECTID', 'AssetID', 'StructureSubtype', 'OwnedBy'], where: ACTIVE },
  catchments: { name: 'catchments', url: `${BASE}/4`, fields: ['OBJECTID', 'AssetID', 'CatchmentSubType', 'StructureType', 'RimElev', 'InvertIn', 'InvertOut', 'GrateType', 'SolidLid', 'OwnedBy'], where: ACTIVE },
  pipes: { name: 'pipes', url: `${BASE}/5`, fields: ['OBJECTID', 'AssetID', 'ConveyanceType', 'Diameter', 'Perforated', 'Enabled', 'OwnedBy'], where: ACTIVE },
  open: { name: 'open-conveyance', url: `${BASE}/6`, fields: ['OBJECTID', 'AssetID', 'DrainType', 'OwnedBy'], where: ACTIVE },
  detention: { name: 'detention', url: `${BASE}/9`, fields: ['OBJECTID', 'AssetID', 'DetType', 'OwnedBy'], where: ACTIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const owner = (v: unknown): SourceAsset['owner'] => (v === 1 ? 'public' : v === -1 ? 'private' : v === 2 || v === -2 ? 'other' : undefined);
const SOLID_GRATES = new Set(['SolidCircular', 'SolidRectangular']);
/** catchment subtypes: 1 CB, 2 MH, 3 Basin, 4 Oil Control CB Filter */
export function catchmentRole(a: Attrs): Role {
  const sub = num(a.CatchmentSubType), t = str(a.StructureType);
  if (sub === 2 || sub === 4 || t === 'Access' || t === 'Overflow' || t.startsWith('MH')) return 'junction';
  if (SOLID_GRATES.has(str(a.GrateType)) || str(a.SolidLid) === 'Yes') return 'junction';
  return sub === 1 || sub === 3 ? 'drain' : 'junction';
}
const SOAK_DET = new Set(['Infiltration Pond', 'InfTank', 'InfVlt', 'DryWell', 'PermPvt', 'Rain Garden', 'BioRetCell', 'BioRetStr']);
const OPEN_ROLES: Record<string, { role: Role; type: string; perforated?: boolean; live?: boolean }> = {
  Culvert: { role: 'culvert', type: 'culvert' },
  Watercourse: { role: 'stream', type: 'watercourse', live: true },
  Ditch: { role: 'ditch', type: 'ditch' },
  'Biofiltration Swale': { role: 'ditch', type: 'ditch' },
  'Wet Biofiltration Swale': { role: 'ditch', type: 'ditch' },
  'Other Conveyance': { role: 'ditch', type: 'ditch' },
  'Unknown Conveyance': { role: 'ditch', type: 'ditch' },
  'Infiltration Trench': { role: 'pipe', type: 'trench', perforated: true },
  'Dispersion Trench': { role: 'pipe', type: 'trench', perforated: true },
  'Perforated Pipe': { role: 'pipe', type: 'trench', perforated: true },
};

export async function buildDesMoines(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`des-moines ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 2000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.31, 47.39]);
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.AssetID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  // lowest recorded invert (ft) of a structure: water leaves at its bottom
  const bottom = new Map<string, number>();
  const outfalls = new Set<string>();

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) return void inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: owner(f.attributes.OwnedBy), ...more });
    inc(`points.${role}`);
    return key;
  };

  for (const f of L.catchments) {
    const a = f.attributes;
    const key = point('catchments', f, catchmentRole(a));
    const inv = [num(a.InvertOut), num(a.InvertIn)].filter((v) => v > 0);
    if (key && inv.length) bottom.set(key, Math.min(...inv));
  }
  // 3 infiltration catchment, 6 drywell
  for (const f of L.fcwq) point('fcwq', f, 'junction', [3, 6].includes(num(f.attributes.FCWQSubtype)) ? { openBottom: true } : {});
  for (const f of L.misc) point('misc', f, 'junction');
  for (const f of L.discharge) {
    const a = f.attributes;
    const t = str(a.DisChrgType);
    const recv = str(a.ReceivingEntity) || undefined;
    if (t === 'Outfall') {
      const key = point('discharge', f, 'outfall', { endHint: 'water', receivingHint: recv });
      if (key) outfalls.add(key);
    } else if (t === 'Infiltration') point('discharge', f, 'discharge', { endHint: 'ground' });
    else point('discharge', f, 'outfall', { endHint: 'unknown', receivingHint: recv });
  }
  for (const f of L.detention) {
    const a = f.attributes;
    const t = str(a.DetType);
    // natural wetlands come from the water layers
    if (t === 'Wetland') {
      inc('skipped.facility.Wetland');
      continue;
    }
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const role: Role = SOAK_DET.has(t) ? 'facility-infiltrate' : 'facility-hold';
    for (const ring of rings) assets.push({ role, id: idOf('detention', a), src: KEY, coords: ring, trust: 'none', owner: owner(a.OwnedBy) });
    inc(`facilities.${role}`);
  }

  const gaps = { n: 0 };
  const lines: { asset: SourceAsset; type: string }[] = [];
  for (const f of L.pipes) {
    const a = f.attributes;
    if (num(a.Enabled) === 0 && a.Enabled !== null) {
      inc('skipped.disabled');
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const perforated = str(a.Perforated) === 'Yes';
    const asset: SourceAsset = { role: 'pipe', id: idOf('pipes', a), src: KEY, coords, trust: 'none', owner: owner(a.OwnedBy), width: toM(num(a.Diameter), IN), perforated: perforated || undefined };
    assets.push(asset);
    lines.push({ asset, type: str(a.ConveyanceType) === 'Lateral' ? 'lateral' : 'main' });
  }
  for (const f of L.open) {
    const a = f.attributes;
    const spec = OPEN_ROLES[str(a.DrainType)];
    if (!spec) {
      inc(`skipped.open.${str(a.DrainType) || 'blank'}`);
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const asset: SourceAsset = { role: spec.role, id: idOf('open', a), src: KEY, coords, trust: 'none', owner: owner(a.OwnedBy), perforated: spec.perforated || undefined, liveStream: spec.live || undefined };
    assets.push(asset);
    lines.push({ asset, type: spec.type });
  }

  const ground = await openGround(boundaryBox(boundary));
  const nodeAt = (c: LonLat) => nodes.nearest(c, 2)?.ref.key;
  const checks: LineCheck[] = lines.map(({ asset, type }) => {
    const c = asset.coords;
    const n0 = nodeAt(c[0]), n1 = nodeAt(c[c.length - 1]);
    const g = groundSign(ground, c);
    const b0 = n0 ? bottom.get(n0) : undefined, b1 = n1 ? bottom.get(n1) : undefined;
    const own: Say = b0 !== undefined && b1 !== undefined && Math.abs(b0 - b1) >= 0.1 ? (b0 > b1 ? 'down' : 'up') : undefined;
    const o0 = !!n0 && outfalls.has(n0), o1 = !!n1 && outfalls.has(n1);
    // a pipe runs into an outfall; open channels can start at one
    const outfall: Say = asset.role === 'pipe' && o0 !== o1 ? (o1 ? 'down' : 'up') : undefined;
    return { asset, type, ground: g > 0 ? 'down' : g < 0 ? 'up' : undefined, own, outfall };
  });
  const r = orient(checks, { ownTrust: 'inverts', drawnOk: 0.75, ownOk: 0.8 });
  extra['lines.pathGaps'] = gaps.n;
  const notes = [
    ...orientNotes(r, 'Catchment inverts (the lowest of InvertIn/InvertOut at each end, 0.1 ft or more apart)', extra),
    'Catchments: catch basins, basins, curb inlets, yard and slot drains are drains unless the lid is solid; manholes, access, overflow and oil control structures are junctions. FCWQ and misc structures are junctions (infiltration catchments and drywells soak in)',
    "Discharge points: Outfall -> 'water'; Infiltration -> discharge 'ground'; overflow, standard outlet and other -> 'unknown'. Detention outlines: infiltration types soak in, natural wetlands left out",
    'owner: public = City of Des Moines, private = Private, other = Other Public/Other',
    'Only active features. Dropped: Comments, editor and collector fields, photos, WQ Facility points (names and addresses) and easements (never requested); Storm CMP repeats piped conveyances',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Des Moines',
    county: 'King',
    credit: 'Storm drain data: City of Des Moines GIS, provided as is.',
    disclaimer: 'City of Des Moines GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildDesMoines);
