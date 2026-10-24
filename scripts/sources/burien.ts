// City of Burien storm drains -> <cache>/sources/burien/{assets.ndjson,meta.json}.
// No from/to IDs: lines join by geometry. A few lines carry IE_IN/IE_OUT inverts. Two independent checks of the
// drawn order: catch basins whose outlet invert (IE_OUT) matches a line's IE_IN sit at its upstream end, and the
// ground (USGS 3DEP) at the line's two ends. Each line type is kept as drawn where the ground check passes.
// Data: City of Burien GIS, CC BY-NC (attribution, non-commercial), provided as is.
// node scripts/sources/burien.ts [--refresh] [--box=w,s,e,n]
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
import { boundaryBox } from './mercer-island.ts';

const KEY = 'burien';
const AGOL = 'https://services6.arcgis.com/pZ4CUxkTrr0NFJXS/ArcGIS/rest/services';
const CITY = 'https://gis.burienwa.gov/server/rest/services/GeocortexExternal/gcex_Stormwater/MapServer';
const GEOID = '5308850';
const LIVE = 'ACTIVE = 1 OR ACTIVE IS NULL';

const layers = {
  conveyance: { name: 'conveyance', url: `${AGOL}/Conveyance/FeatureServer/0`, fields: ['OBJECTID', 'GM_ID', 'TYPE', 'DIAMETER', 'IE_IN', 'IE_OUT', 'ACTIVE', 'OWNEDBY'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${AGOL}/Catchbasins/FeatureServer/9`, fields: ['OBJECTID', 'CMID', 'TYPE_DOMAIN', 'GRATE', 'IE_OUT', 'ACTIVE', 'OWNEDBY'], where: LIVE },
  discharge: { name: 'discharge', url: `${CITY}/3`, fields: ['OBJECTID', 'DCID', 'TYPE', 'ACTIVE'], where: LIVE },
  headwalls: { name: 'headwalls', url: `${CITY}/4`, fields: ['OBJECTID', 'INLETID', 'TYPE', 'ACTIVE'], where: LIVE },
  vaults: { name: 'vaults', url: `${CITY}/2`, fields: ['OBJECTID', 'VDID', 'V_TYPE', 'ACTIVE'], where: LIVE },
  bmps: { name: 'bmps', url: `${CITY}/12`, fields: ['OBJECTID', 'FAC_ID', 'TYPE', 'OWNEDBY', 'ACTIVE'], where: 'ACTIVE <> 0 OR ACTIVE IS NULL' },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function burienOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v).toUpperCase();
  if (s === 'BURIEN' || s === 'PUBLIC' || s === 'BSC' || s === '1' || s === '3') return 'public';
  if (s === 'PRIVATE' || s === '2') return 'private';
  if (s === 'OTHER' || s === '99') return 'other';
  return undefined;
}

const INLETS = new Set(['CB TYPE 1', 'CB TYPE 1-L', 'CB TYPE 2', 'CB CURB INL', 'YD DR']);
const OPEN_GRATES = new Set(['RECT VAIN', 'CIR VAIN', 'BEEHIVE', 'ROLLED CURB', 'THR CURB', 'DEBRIS CGE S', 'DEBRIS CGE NS', 'HOMEMADE']);
/** catch basins take street water unless the lid is solid; manholes, roof drains and unknowns only with a grate */
export function basinRole(type: string, grate: string): Role {
  if (INLETS.has(type)) return grate.startsWith('SOLID') ? 'junction' : 'drain';
  if (type === 'RF DR' || type.startsWith('MH')) return 'junction';
  return OPEN_GRATES.has(grate) ? 'drain' : 'junction';
}

/** Conveyance TYPE codes */
const LINE_ROLES: Record<number, { role: Role; label: string }> = {
  0: { role: 'pipe', label: 'pipe' },
  1: { role: 'ditch', label: 'ditch' },
  2: { role: 'culvert', label: 'culvert' },
  3: { role: 'stream', label: 'watercourse' },
  4: { role: 'ditch', label: 'swale' },
};
/** share of sloped lines drawn downhill needed to keep a line type as drawn */
const GROUND_OK = 0.8;
/** a catch basin this close to a line end sits on it */
const AT_M = 2;

export async function buildBurien(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`burien ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs, field: string) => str(a[field]) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  // catch basin outlet inverts, for the line check
  const basins = new NodeIndex([-122.34, 47.47]);
  const basinInv = new Map<string, number>();

  const point = (layer: LayerName, field: string, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes, field);
    assets.push({ role, id, src: KEY, coords: [at], trust: 'none', owner: burienOwner(f.attributes.OWNEDBY), ...more });
    inc(`points.${layer}.${role}`);
    if (layer === 'catchBasins' && num(f.attributes.IE_OUT) > 0) basinInv.set(basins.add(id, at), num(f.attributes.IE_OUT));
  };

  for (const f of L.catchBasins) point('catchBasins', 'CMID', f, basinRole(str(f.attributes.TYPE_DOMAIN), str(f.attributes.GRATE)));
  for (const f of L.discharge) {
    const t = str(f.attributes.TYPE);
    if (t === 'INFILT') point('discharge', 'DCID', f, 'discharge', { endHint: 'ground' });
    else point('discharge', 'DCID', f, 'outfall', { endHint: 'water' });
  }
  // headwall outlets let pipes out into ditches and swales: the walk goes on where the map does
  for (const f of L.headwalls) point('headwalls', 'INLETID', f, str(f.attributes.TYPE) === 'OUTLET' ? 'outfall' : 'junction', str(f.attributes.TYPE) === 'OUTLET' ? { endHint: 'unknown' } : {});
  for (const f of L.vaults) point('vaults', 'VDID', f, 'facility-hold');
  for (const f of L.bmps) {
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    // 0 = dispersion/infiltration, 4 = porous pavement
    const t = num(f.attributes.TYPE);
    const role: Role = (t === 0 || t === 4) && f.attributes.TYPE !== null ? 'facility-infiltrate' : 'facility-hold';
    const id = idOf('bmps', f.attributes, 'FAC_ID');
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: burienOwner(f.attributes.OWNEDBY) });
    inc(`facilities.${role}`);
  }

  const gaps = { n: 0 };
  const byType = new Map<string, SourceAsset[]>();
  const inv = { both: 0, inHigher: 0, basinFirst: 0, basinLast: 0 };
  for (const f of L.conveyance) {
    const a = f.attributes;
    const spec = LINE_ROLES[num(a.TYPE)];
    if (!spec || a.TYPE === null) {
      inc(`skipped.lineType${str(a.TYPE) || 'Blank'}`);
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const asset: SourceAsset = {
      role: spec.role, id: idOf('conveyance', a, 'GM_ID'), src: KEY, coords, trust: 'none', owner: burienOwner(a.OWNEDBY),
      width: spec.role === 'pipe' || spec.role === 'culvert' ? toM(num(a.DIAMETER), IN) : undefined, liveStream: spec.role === 'stream' || undefined,
    };
    const ieIn = num(a.IE_IN);
    const ieOut = num(a.IE_OUT);
    if (ieIn > 0 && ieOut > 0 && Math.abs(ieIn - ieOut) >= 0.01) {
      inv.both++;
      if (ieIn > ieOut) inv.inHigher++;
    }
    // the catch basin whose outlet invert is this line's IE_IN is its upstream end
    if (ieIn > 0) {
      const at = (p: LonLat) => {
        const n = basins.nearest(p, AT_M);
        return n && Math.abs((basinInv.get(n.ref.key) ?? -1e9) - ieIn) <= 0.05;
      };
      const first = at(coords[0]);
      const last = at(coords[coords.length - 1]);
      if (first && !last) inv.basinFirst++;
      else if (last && !first) inv.basinLast++;
    }
    assets.push(asset);
    const list = byType.get(spec.label) ?? [];
    list.push(asset);
    byType.set(spec.label, list);
  }

  // which way are the lines drawn? the ground at their ends, per line type
  const ground = await openGround(boundaryBox(boundary));
  const notes: string[] = [];
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  let allD = 0;
  let allU = 0;
  const signs = new Map<SourceAsset, number>();
  for (const list of byType.values()) {
    for (const a of list) {
      const s = groundSign(ground, a.coords);
      signs.set(a, s);
      if (s > 0) allD++;
      else if (s < 0) allU++;
    }
  }
  const allOk = allD + allU >= 20 && allD / (allD + allU) >= GROUND_OK;
  for (const [label, list] of byType) {
    let d = 0;
    let u = 0;
    for (const a of list) {
      const s = signs.get(a) ?? 0;
      if (s > 0) d++;
      else if (s < 0) u++;
    }
    const ok = d + u >= 20 ? d / (d + u) >= GROUND_OK : allOk;
    if (ok) for (const a of list) a.trust = 'digitized';
    extra[`ground.${label}.downhill`] = d;
    extra[`ground.${label}.uphill`] = u;
    extra[`lines.${label}`] = list.length;
    notes.push(`${label}: ${list.length} lines; the ground falls along ${d}/${d + u} (${pct(d, d + u)}) as drawn; ${ok ? "'digitized' (kept as drawn)" : "'none'"}`);
  }
  Object.assign(extra, { 'lines.pathGaps': gaps.n, 'inverts.both': inv.both, 'inverts.inHigher': inv.inHigher, 'inverts.basinAtFirst': inv.basinFirst, 'inverts.basinAtLast': inv.basinLast });
  notes.unshift(
    `Lines carry no from/to IDs. The ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${allD}/${allD + allU} (${pct(allD, allD + allU)}) of all lines as drawn`,
    `A catch basin whose outlet invert matches a line's IE_IN sits at the line's first vertex on ${inv.basinFirst}/${inv.basinFirst + inv.basinLast} (${pct(inv.basinFirst, inv.basinFirst + inv.basinLast)}) lines where one end has it; IE_IN is above IE_OUT on ${inv.inHigher}/${inv.both} lines with both`,
  );
  notes.push(
    'Catch basins: Type 1, 1-L, 2, curb inlets and yard drains are drains unless the lid is solid; manholes and roof drains are junctions; Other and Unknown only with a grate',
    "Discharge points (city server): Outfall -> outfall 'water', Infiltration -> discharge 'ground'. Headwall outlets -> outfall 'unknown' (the walk goes on where the map does), other headwalls -> junction",
    'Facilities: BMP outlines (dispersion/infiltration and porous pavement soak in; ponds, vaults and swales hold), vault points hold',
    "Conveyance: Pipe -> pipe, Ditch and Swale -> ditch, Culvert -> culvert, Watercourse -> stream; Other (5) left out. The city's overland flow lines are not used",
    'owner: public = City of Burien, Public and Burien Source Control, private = Private, other = Other',
    'Only active features. Dropped: ModifiedBy, COMMENT, Location, FACILITY_NM, FAC_NAME and condition fields (never requested). License: CC BY-NC (attribution, non-commercial)',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Burien',
    county: 'King',
    credit: 'Storm drain data: City of Burien GIS (CC BY-NC), provided as is.',
    disclaimer: 'City of Burien data, information and maps are provided as is, without warranty or any representation of accuracy, timeliness or completeness. Used under CC BY-NC: attribution, non-commercial.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildBurien);
