// City of Covington storm drains -> <cache>/sources/covington/{assets.ndjson,meta.json}.
// No from/to IDs and no inverts on the lines: lines join by geometry and are kept as drawn where the ground
// (USGS 3DEP) shows each line type is drawn downhill about as often as keyed lines in nearby cities are.
// The city's server sends an incomplete certificate chain: run with NODE_OPTIONS=--use-system-ca.
// node scripts/sources/covington.ts [--refresh] [--box=w,s,e,n]
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
  type RunOptions,
} from './bellevue.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'covington';
const BASE = 'https://maps.covingtonwa.gov/arcgis/rest/services/Covington_Asset_Info/MapServer';
const GEOID = '5315290';
const LIVE = 'STATUS = 0 OR STATUS IS NULL';

const layers = {
  outlets: { name: 'outlets', url: `${BASE}/9`, fields: ['OBJECTID', 'OUTLET_ID', 'OUTFALL_TYPE', 'STATUS', 'OWNRSHP'], where: LIVE },
  inlets: { name: 'inlets', url: `${BASE}/10`, fields: ['OBJECTID', 'INLET_ID', 'INLET_TYPE', 'STATUS', 'OWNRSHP'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${BASE}/11`, fields: ['OBJECTID', 'CB_ID', 'CBTYPE', 'STATUS', 'OWNRSHP'], where: LIVE },
  lines: { name: 'lines', url: `${BASE}/12`, fields: ['OBJECTID', 'LINE_ID', 'LINETYPE', 'DIAMETER', 'STATUS', 'OWNSHP'], where: LIVE },
  privateFacilities: { name: 'private-facilities', url: `${BASE}/13`, fields: ['OBJECTID', 'POLYID', 'POLYTYPE', 'STATUS', 'OWNRSHP'], where: LIVE },
  publicFacilities: { name: 'public-facilities', url: `${BASE}/14`, fields: ['OBJECTID', 'INSPTN_ID', 'POLYTYPE', 'STATUS', 'OWNRSHP'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const owner = (v: unknown): SourceAsset['owner'] => (v === 0 ? 'public' : v === 1 ? 'private' : undefined);
/** DIAMETER codes -> inches */
const DIA: Record<number, number> = { 1: 4, 2: 6, 3: 8, 4: 10, 5: 12, 6: 15, 7: 18, 8: 24, 11: 21, 12: 16 };
/** LINETYPE codes */
const LINE_ROLES: Record<number, { role: Role; label: string; perforated?: boolean; live?: boolean }> = {
  0: { role: 'pipe', label: 'pipe' },
  1: { role: 'ditch', label: 'ditch' },
  2: { role: 'ditch', label: 'swale' },
  3: { role: 'stream', label: 'stream', live: true },
  4: { role: 'culvert', label: 'culvert' },
  5: { role: 'culvert', label: 'driveway culvert' },
  7: { role: 'pipe', label: 'perforated', perforated: true },
};
/** share of lines drawn downhill (where the ground falls 0.5 m or more) needed to keep a line type as drawn */
const GROUND_OK = 0.75;

export async function buildCovington(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`covington ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.1, 47.36]);
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);

  const point = (layer: LayerName, idField: string, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = str(f.attributes[idField]) || `${layers[layer].name}:${str(f.attributes.OBJECTID)}`;
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: owner(f.attributes.OWNRSHP), ...more });
  };

  for (const f of L.catchBasins) point('catchBasins', 'CB_ID', f, 'drain');
  // 1 = curb cut; pipe ends, culvert ends and caps take no street water
  for (const f of L.inlets) point('inlets', 'INLET_ID', f, num(f.attributes.INLET_TYPE) === 1 && f.attributes.INLET_TYPE !== null ? 'drain' : 'junction');
  for (const f of L.outlets) {
    const t = f.attributes.OUTFALL_TYPE;
    // 0 = direct to stream, 4 = to stream from a water quality facility; 6 = cap or plug
    if (t === 0 || t === 4) point('outlets', 'OUTLET_ID', f, 'outfall', { endHint: 'water', receivingHint: 'stream' });
    else if (t === 6) point('outlets', 'OUTLET_ID', f, 'junction');
    else point('outlets', 'OUTLET_ID', f, 'outfall', { endHint: 'unknown', receivingHint: t === 2 ? 'water quality facility' : t === 1 ? 'ditch or swale' : undefined });
  }
  for (const [layer, idField] of [['publicFacilities', 'INSPTN_ID'], ['privateFacilities', 'POLYID']] as const) {
    for (const f of L[layer]) {
      const rings = outerRings(f.geometry);
      if (!rings.length) {
        inc('skipped.noGeometry');
        continue;
      }
      // vaults, ponds and swales: none is marked as soaking water in
      const id = str(f.attributes[idField]) || `${layers[layer].name}:${str(f.attributes.OBJECTID)}`;
      for (const ring of rings) assets.push({ role: 'facility-hold', id, src: KEY, coords: ring, trust: 'none', owner: owner(f.attributes.OWNRSHP) });
    }
  }

  const gaps = { n: 0 };
  const byType = new Map<string, SourceAsset[]>();
  for (const f of L.lines) {
    const a: Attrs = f.attributes;
    const spec = LINE_ROLES[num(a.LINETYPE)];
    if (!spec) {
      inc(`skipped.lineType${str(a.LINETYPE) || 'Blank'}`);
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const dia = DIA[num(a.DIAMETER)] ?? 0;
    const asset: SourceAsset = {
      role: spec.role, id: str(a.LINE_ID) || `lines:${str(a.OBJECTID)}`, src: KEY, coords, trust: 'none', owner: owner(a.OWNSHP),
      width: spec.role === 'pipe' || spec.role === 'culvert' ? toM(dia, IN) : undefined, perforated: spec.perforated || undefined, liveStream: spec.live || undefined,
    };
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
  for (const list of byType.values()) {
    for (const a of list) {
      const s = groundSign(ground, a.coords);
      if (s > 0) allD++;
      else if (s < 0) allU++;
    }
  }
  const allOk = allD + allU >= 20 && allD / (allD + allU) >= GROUND_OK;
  for (const [label, list] of byType) {
    let d = 0;
    let u = 0;
    for (const a of list) {
      const s = groundSign(ground, a.coords);
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
    `Lines carry no from/to IDs or inverts. The ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${allD}/${allD + allU} (${pct(allD, allD + allU)}) of all lines as drawn; keyed lines in Mercer Island and Maple Valley, which are in flow order, show 92% and 83%`,
  );
  notes.push(
    'Catch basins are drains (their grate codes are not published); curb-cut inlets are drains, other inlets junctions',
    "Outlets: Direct To Stream and To Stream from WQ -> outfall 'water'; Cap/Plug -> junction; the rest (ditches, swales, WQ facilities, culverts, natural conveyance) -> outfall 'unknown' (the walk goes on where the map does)",
    'Public and private facility outlines (vaults, ponds, swales) -> facility-hold: none says it infiltrates',
    'owner: public = Public, private = Private',
    'Only In Service features. Dropped: NOTES, created/edited user fields, inspection links and catch basin pipe tables (never requested); RoofFoot lines not used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Covington',
    county: 'King',
    credit: 'Storm drain data: City of Covington GIS, provided as is.',
    disclaimer: 'City of Covington GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildCovington);
