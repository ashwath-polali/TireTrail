// Context data for King + Pierce: streets, waters, coho reaches and jurisdiction polygons, as
// normalized files under <cache>/sources/context/. Raw pages go to raw/ (fetched once; --refresh refetches).
//   node scripts/sources/context.ts [--refresh] [--check]
// Outputs (lon/lat, 6 decimals):
//   streets-king.ndjson, streets-pierce.ndjson  {id, name, class, fc, jurisdiction, coords}
//   waters-king.ndjson, waters-pierce.ndjson    {id, src, kind, name, type, coords | polygons, ...}
//   coho.ndjson                                 {id, llid, name, dist, coho, use, life, counties, coords}
//   boundaries.json                             see lib/boundaries.ts
//   context.json                                counts, sources, credits
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { bboxOf, GridIndex, localProjection, pointAlong, pointInPolygon, polygonsArea, polygonsCentroid, polylineLength, simplify, type Projection, type XY } from '../../src/geo/geo.ts';
import { swifdName } from '../../src/county/waters.ts';
import { boxOf, CONTEXT_DIR, jurisdictionAt, readBoundaries, type Boundaries, type Box, type County, type Jurisdiction, type Polygons } from './lib/boundaries.ts';

const OUT = CONTEXT_DIR;
const RAW = `${OUT}/raw`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TireTrail-context/1.0';
const PER_HOST = 4;

const KC_GIS = 'https://gismaps.kingcounty.gov/arcgis/rest/services';
const KC_AGOL = 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services';
const PC_AGOL = 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services';
const NHD = 'https://gis.ecology.wa.gov/serverext/rest/services/Authoritative/NHD/MapServer';
const SWIFD = 'https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/SWIFD/MapServer/0';

interface LayerSpec {
  url: string;
  /** explicit allowlist: never outFields=* */
  fields: string[];
  where?: string;
  /** query box per county, from the county outline */
  box?: County;
  page: number;
}

const COUNTIES: County[] = ['King', 'Pierce'];

// Boundaries first: the other layers are boxed and clipped by them.
const BOUNDARY_LAYERS = {
  kcCities: { url: `${KC_AGOL}/CITY_AREA_448/FeatureServer/0`, fields: ['JURIS', 'CITYNAME'], page: 20 },
  kcUninc: { url: `${KC_AGOL}/CITY_KC_AREA_446/FeatureServer/0`, fields: ['JURIS', 'CITYNAME'], where: "JURIS = 'KC'", page: 20 },
  pcCities: { url: `${PC_AGOL}/Cities_in_Pierce_County/FeatureServer/0`, fields: ['CITY_ID', 'NAME'], page: 10 },
  pcUninc: { url: `${KC_AGOL}/CITY_3CO_UNINC_AREA_682/FeatureServer/0`, fields: ['NAME', 'UNINC'], where: "NAME = 'Pierce County' AND UNINC = 1", page: 1 },
  pcCounty: { url: `${PC_AGOL}/Pierce_County_Boundary_polygon/FeatureServer/0`, fields: ['JURNM'], page: 1 },
} satisfies Record<string, LayerSpec>;

const swifd = (box: County): LayerSpec => ({ url: SWIFD, fields: ['LLID', 'LLID_STRM_NAME', 'SPECIESRUN', 'DISTTYPE_DESC', 'USETYPE_DESC', 'LIFEHIST_DESC'], where: "SPECIESRUN = 'Coho'", box, page: 500 });
const nhdLines = (box: County): LayerSpec => ({ url: `${NHD}/3`, fields: ['Permanent_Identifier', 'GNIS_Name', 'FType', 'FlowDir', 'StreamOrder', 'From_Node', 'To_Node'], box, page: 500 });
const nhdBodies = (box: County): LayerSpec => ({ url: `${NHD}/6`, fields: ['Permanent_Identifier', 'GNIS_Name', 'FType'], where: 'FType IN (390, 436, 466, 493)', box, page: 500 });
const nhdAreas = (box: County): LayerSpec => ({ url: `${NHD}/5`, fields: ['Permanent_Identifier', 'GNIS_Name', 'FType'], where: 'FType IN (312, 445, 460)', box, page: 100 });
const kcRoads = (layer: number): LayerSpec => ({ url: `${KC_GIS}/Roads/KingCo_Roads/MapServer/${layer}`, fields: ['TLINK_ID', 'FULLNAME_L', 'FULLNAME_R', 'KC_FCC_ID', 'CFCC_ID'], page: 1000 });

const LAYERS = {
  kcRoads4: kcRoads(4),
  kcRoads5: kcRoads(5),
  kcRoads6: kcRoads(6),
  // no LCITY/RCITY filter: the layer covers the cities too
  pcRoads: { url: `${PC_AGOL}/Roads/FeatureServer/0`, fields: ['ROADS_ID', 'FULLNAME', 'MAP_CLASS'], page: 2000 },
  kcStreams: { url: `${KC_GIS}/Hydro/KingCo_Hydrographic/MapServer/3`, fields: ['WTR_NAME', 'BASIN_NAME', 'RTE_ID', 'STR_LVL'], page: 1000 },
  kcLakes: { url: `${KC_GIS}/Hydro/KingCo_Hydrographic/MapServer/2`, fields: ['FEATURE_ID', 'NAME', 'FEAT_TYPE'], page: 500 },
  pcStreams: { url: `${PC_AGOL}/Hydro_Centerlines/FeatureServer/0`, fields: ['FeatureName', 'FeatureType', 'StreamTypeNPDES', 'Confidence'], page: 2000 },
  pcLakes: { url: `${PC_AGOL}/Hydro_Waterbodies/FeatureServer/0`, fields: ['FeatureName'], page: 1000 },
  pcSound: { url: `${PC_AGOL}/Hydro_Puget_Sound/FeatureServer/0`, fields: ['FeatureName'], page: 1 },
  nhdLinesKing: nhdLines('King'),
  nhdLinesPierce: nhdLines('Pierce'),
  nhdBodiesKing: nhdBodies('King'),
  nhdBodiesPierce: nhdBodies('Pierce'),
  nhdAreasKing: nhdAreas('King'),
  nhdAreasPierce: nhdAreas('Pierce'),
  swifdKing: swifd('King'),
  swifdPierce: swifd('Pierce'),
} satisfies Record<string, LayerSpec>;

const ALL_LAYERS: Record<string, LayerSpec> = { ...BOUNDARY_LAYERS, ...LAYERS };

const CREDITS = [
  'Streets: King County GIS (KingCo_Roads); Pierce County GIS (Roads). Provided as is.',
  'Streams and lakes: King County GIS (KingCo_Hydrographic); Pierce County GIS (Hydro). Fallback: Washington Department of Ecology NHD (high resolution).',
  'Coho distribution: WDFW SWIFD.',
  'Boundaries: King County GIS (CITY_AREA, CITY_KC_AREA, CITY_3CO_UNINC_AREA); Pierce County GIS (Cities in Pierce County, County Boundary).',
];

// ---------- fetching ----------

const hostQueues = new Map<string, { active: number; waiting: (() => void)[] }>();

async function withHost<T>(url: string, run: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  let q = hostQueues.get(host);
  if (!q) hostQueues.set(host, (q = { active: 0, waiting: [] }));
  if (q.active >= PER_HOST) await new Promise<void>((r) => q.waiting.push(r));
  q.active++;
  try {
    return await run();
  } finally {
    q.active--;
    q.waiting.shift()?.();
  }
}

async function post(url: string, params: Record<string, string>, tries = 6): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await withHost(url, async () => {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params), headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(JSON.stringify(json.error));
        return json;
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt * (0.75 + Math.random() / 2)));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

let boxes: Record<County, Box> | null = null;

/** One layer into raw/<name>.ndjson (one GeoJSON feature per line), by objectId chunks. */
async function download(name: string, spec: LayerSpec, log: (s: string) => void): Promise<void> {
  const file = `${RAW}/${name}.ndjson`;
  if (existsSync(file)) return;
  const base: Record<string, string> = { where: spec.where ?? '1=1' };
  if (spec.box) {
    const b = boxes![spec.box];
    Object.assign(base, { geometry: b.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
  }
  const ids: number[] = (await post(`${spec.url}/query`, { ...base, returnIdsOnly: 'true', f: 'json' })).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += spec.page) chunks.push(ids.slice(i, i + spec.page));
  const parts: string[][] = new Array(chunks.length);
  let done = 0;
  await Promise.all(
    chunks.map(async (chunk, k) => {
      const feats = await page(spec, chunk);
      if (feats.length !== chunk.length) throw new Error(`${name}: page ${k} got ${feats.length} of ${chunk.length}`);
      // keep only the allowlisted fields, plus the object id
      parts[k] = feats.map((f, i) => JSON.stringify({ id: f.id ?? chunk[i], geometry: f.geometry, properties: pick(f.properties ?? {}, spec.fields) }));
      if (++done % 20 === 0 || done === chunks.length) log(`  ${name}: ${done}/${chunks.length} pages`);
    }),
  );
  const fd = openSync(`${file}.part`, 'w');
  for (const p of parts) if (p.length) writeSync(fd, p.join('\n') + '\n');
  closeSync(fd);
  renameSync(`${file}.part`, file);
  log(`  ${name}: ${ids.length} features`);
}

/** One page; a page the server keeps failing (HTTP 500 on big geometries) is split in halves. */
async function page(spec: LayerSpec, ids: number[]): Promise<any[]> {
  const params = { objectIds: ids.join(','), outFields: spec.fields.join(','), outSR: '4326', geometryPrecision: '6', f: 'geojson' };
  try {
    return (await post(`${spec.url}/query`, params, ids.length > 1 ? 3 : 6)).features ?? [];
  } catch (e) {
    if (ids.length === 1) throw e;
    const half = Math.ceil(ids.length / 2);
    return [...(await page(spec, ids.slice(0, half))), ...(await page(spec, ids.slice(half)))];
  }
}

function pick(p: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (p[f] !== undefined && p[f] !== null) out[f] = p[f];
  return out;
}

interface RawFeature {
  id: number;
  geometry: { type: string; coordinates: any } | null;
  properties: Record<string, any>;
}

async function* readRaw(name: string): AsyncGenerator<RawFeature> {
  const rl = createInterface({ input: createReadStream(`${RAW}/${name}.ndjson`), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line) as RawFeature;
}

// ---------- geometry ----------

type Line = [number, number][];

function linesOf(g: RawFeature['geometry']): Line[] {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

function polygonsOf(g: RawFeature['geometry']): Polygons {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const round = (l: Line): Line => l.map(([x, y]) => [r6(x), r6(y)]);

/** Midpoint by length (lon scaled by cos lat). */
function midpoint(l: Line): XY {
  const k = Math.cos((l[0][1] * Math.PI) / 180);
  let total = 0;
  for (let i = 1; i < l.length; i++) total += Math.hypot((l[i][0] - l[i - 1][0]) * k, l[i][1] - l[i - 1][1]);
  let walked = 0;
  for (let i = 1; i < l.length; i++) {
    const seg = Math.hypot((l[i][0] - l[i - 1][0]) * k, l[i][1] - l[i - 1][1]);
    if (walked + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - walked) / seg;
      return [l[i - 1][0] + t * (l[i][0] - l[i - 1][0]), l[i - 1][1] + t * (l[i][1] - l[i - 1][1])];
    }
    walked += seg;
  }
  return l[0];
}

/** Coarse raster of a county outline, widened by a halo, for clipping box queries. */
class Mask {
  private readonly cells: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly box: Box;
  private static readonly DX = 0.003;
  private static readonly DY = 0.002;

  constructor(polygons: Polygons, haloCells = 4) {
    const b = boxOf(polygons);
    this.box = [b[0] - 0.05, b[1] - 0.05, b[2] + 0.05, b[3] + 0.05];
    this.cols = Math.ceil((this.box[2] - this.box[0]) / Mask.DX);
    this.rows = Math.ceil((this.box[3] - this.box[1]) / Mask.DY);
    const fill = new Uint8Array(this.cols * this.rows);
    const rings = polygons.flat();
    // even-odd scanline fill at each row's center
    for (let r = 0; r < this.rows; r++) {
      const y = this.box[1] + (r + 0.5) * Mask.DY;
      const xs: number[] = [];
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i];
          const c = ring[j];
          if (a[1] > y !== c[1] > y) xs.push(a[0] + ((y - a[1]) * (c[0] - a[0])) / (c[1] - a[1]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - this.box[0]) / Mask.DX - 0.5));
        const c1 = Math.min(this.cols - 1, Math.floor((xs[k + 1] - this.box[0]) / Mask.DX - 0.5));
        for (let c = c0; c <= c1; c++) fill[r * this.cols + c] = 1;
      }
    }
    // boundary vertices count too (thin slivers between row centers)
    for (const ring of rings) for (const [x, y] of ring) this.set(fill, x, y);
    this.cells = new Uint8Array(fill.length);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (!fill[r * this.cols + c]) continue;
        for (let dr = -haloCells; dr <= haloCells; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= this.rows) continue;
          for (let dc = -haloCells; dc <= haloCells; dc++) {
            const cc = c + dc;
            if (cc >= 0 && cc < this.cols) this.cells[rr * this.cols + cc] = 1;
          }
        }
      }
    }
  }

  private set(a: Uint8Array, x: number, y: number): void {
    const c = Math.floor((x - this.box[0]) / Mask.DX);
    const r = Math.floor((y - this.box[1]) / Mask.DY);
    if (c >= 0 && c < this.cols && r >= 0 && r < this.rows) a[r * this.cols + c] = 1;
  }

  has(x: number, y: number): boolean {
    const c = Math.floor((x - this.box[0]) / Mask.DX);
    const r = Math.floor((y - this.box[1]) / Mask.DY);
    return c >= 0 && c < this.cols && r >= 0 && r < this.rows && this.cells[r * this.cols + c] === 1;
  }

  anyIn(points: readonly (readonly number[])[]): boolean {
    for (const p of points) if (this.has(p[0], p[1])) return true;
    return false;
  }
}

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Line segments in local meters, for "is this near that" tests. */
class SegmentIndex {
  private readonly segs: [XY, XY][] = [];
  private readonly grid = new GridIndex<number>(100);

  add(line: XY[]): void {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      this.grid.insert(this.segs.length, { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) });
      this.segs.push([a, b]);
    }
  }

  near(p: XY, tol: number): boolean {
    for (const i of this.grid.near(p, tol)) if (segDist(p, this.segs[i][0], this.segs[i][1]) <= tol) return true;
    return false;
  }
}

/** Share of points every stepM along a line that lie within tol of the index. */
function shareNear(idx: SegmentIndex, line: XY[], stepM: number, tol: number): number {
  const len = polylineLength(line);
  let near = 0;
  let total = 0;
  for (let s = 0; s <= len; s += stepM) {
    total++;
    if (idx.near(pointAlong(line, s), tol)) near++;
  }
  return total ? near / total : 0;
}

// ---------- writing ----------

class NdjsonWriter {
  private readonly fd: number;
  private buf: string[] = [];
  private readonly file: string;
  count = 0;

  constructor(file: string) {
    this.file = file;
    this.fd = openSync(`${file}.part`, 'w');
  }

  write(o: unknown): void {
    this.buf.push(JSON.stringify(o));
    this.count++;
    if (this.buf.length >= 2000) this.flush();
  }

  private flush(): void {
    if (this.buf.length) writeSync(this.fd, this.buf.join('\n') + '\n');
    this.buf = [];
  }

  close(): number {
    this.flush();
    closeSync(this.fd);
    renameSync(`${this.file}.part`, this.file);
    return this.count;
  }
}

// ---------- boundaries ----------

async function collectPolygons(name: string, key: (p: Record<string, any>) => string): Promise<Map<string, { polygons: Polygons; props: Record<string, any> }>> {
  const out = new Map<string, { polygons: Polygons; props: Record<string, any> }>();
  for await (const f of readRaw(name)) {
    const k = key(f.properties);
    const e = out.get(k) ?? { polygons: [], props: f.properties };
    e.polygons.push(...polygonsOf(f.geometry).map((poly) => poly.map(round)));
    out.set(k, e);
  }
  return out;
}

async function buildBoundaries(fetchedAt: string): Promise<Boundaries> {
  const kc = await collectPolygons('kcCities', (p) => String(p.CITYNAME));
  const pc = await collectPolygons('pcCities', (p) => String(p.NAME));
  const jurisdictions: Jurisdiction[] = [];
  for (const name of [...new Set([...kc.keys(), ...pc.keys()])].sort()) {
    const k = kc.get(name);
    const p = pc.get(name);
    const polygons: Polygons = [...(k?.polygons ?? []), ...(p?.polygons ?? [])];
    const counties: County[] = [...(k ? ['King' as const] : []), ...(p ? ['Pierce' as const] : [])];
    const code = k ? String(k.props.JURIS) : String(p!.props.CITY_ID);
    jurisdictions.push({ name, kind: 'city', counties, code, bbox: boxOf(polygons), polygons });
  }
  const kcUninc = [...(await collectPolygons('kcUninc', () => 'KC')).values()].flatMap((e) => e.polygons);
  const pcUninc = [...(await collectPolygons('pcUninc', () => 'PC')).values()].flatMap((e) => e.polygons);
  jurisdictions.push({ name: 'Unincorporated King County', kind: 'unincorporated', counties: ['King'], code: 'KC', bbox: boxOf(kcUninc), polygons: kcUninc });
  jurisdictions.push({ name: 'Unincorporated Pierce County', kind: 'unincorporated', counties: ['Pierce'], code: 'PC', bbox: boxOf(pcUninc), polygons: pcUninc });
  const kingAll: Polygons = [...[...kc.values()].flatMap((e) => e.polygons), ...kcUninc];
  const pierceAll = [...(await collectPolygons('pcCounty', () => 'PC')).values()].flatMap((e) => e.polygons);
  return {
    fetchedAt,
    credit: CREDITS[3],
    notes: [
      'Cities from KC CITY_AREA_448 and Pierce Cities_in_Pierce_County; a city in both counties (Auburn, Enumclaw, Milton, Pacific) gets both parts.',
      'Unincorporated King: CITY_KC_AREA_446 JURIS=KC. Unincorporated Pierce: KC CITY_3CO_UNINC_AREA_682 "Pierce County" (another vintage than the Pierce city layer): look up cities first (jurisdictionAt).',
      'King outline: all CITY_KC_AREA_446 polygons. Pierce outline: Pierce_County_Boundary_polygon.',
    ],
    jurisdictions,
    counties: [
      { name: 'King', bbox: boxOf(kingAll), polygons: kingAll },
      { name: 'Pierce', bbox: boxOf(pierceAll), polygons: pierceAll },
    ],
  };
}

// ---------- streets ----------

const normName = (s: unknown): string => (s === null || s === undefined ? '' : String(s)).trim().replace(/\s+/g, ' ').toUpperCase();

function kingClass(fcc: string, cfcc: string): string {
  if (fcc === 'F') return cfcc === 'A63' ? 'ramp' : 'freeway';
  if (fcc === 'P' || fcc === 'M') return 'arterial';
  if (fcc === 'C') return 'collector';
  if (cfcc === 'A73') return 'alley';
  if (cfcc === 'A74') return 'service';
  return 'local';
}

const PIERCE_CLASS: Record<number, string> = { 1: 'freeway', 2: 'ramp', 3: 'highway', 4: 'arterial', 5: 'arterial', 6: 'collector', 8: 'local' };

async function buildStreets(b: Boundaries, counts: Record<string, number>): Promise<void> {
  const juris = (l: Line): string => jurisdictionAt(b, midpoint(l))?.name ?? '';
  const king = new NdjsonWriter(`${OUT}/streets-king.ndjson`);
  for (const layer of ['kcRoads4', 'kcRoads5', 'kcRoads6']) {
    for await (const f of readRaw(layer)) {
      const p = f.properties;
      const fcc = String(p.KC_FCC_ID ?? '');
      const cfcc = String(p.CFCC_ID ?? '');
      const name = normName(p.FULLNAME_L) || normName(p.FULLNAME_R);
      linesOf(f.geometry).forEach((l, k, all) => {
        if (l.length < 2) return;
        const coords = round(l);
        king.write({ id: `kc:${p.TLINK_ID ?? f.id}${all.length > 1 ? `#${k}` : ''}`, name, class: kingClass(fcc, cfcc), fc: `${fcc}/${cfcc}`, jurisdiction: juris(coords), coords });
      });
    }
  }
  counts['streets-king'] = king.close();
  const pierce = new NdjsonWriter(`${OUT}/streets-pierce.ndjson`);
  let ferries = 0;
  for await (const f of readRaw('pcRoads')) {
    const p = f.properties;
    const mc = Number(p.MAP_CLASS);
    // 7 ferry routes, 9 island labels
    if (mc === 7 || mc === 9) {
      ferries++;
      continue;
    }
    linesOf(f.geometry).forEach((l, k, all) => {
      if (l.length < 2) return;
      const coords = round(l);
      pierce.write({ id: `pc:${p.ROADS_ID ?? f.id}${all.length > 1 ? `#${k}` : ''}`, name: normName(p.FULLNAME), class: PIERCE_CLASS[mc] ?? 'local', fc: String(mc), jurisdiction: juris(coords), coords });
    });
  }
  counts['streets-pierce'] = pierce.close();
  counts['streets-pierce-dropped-ferry-or-label'] = ferries;
}

// ---------- waters ----------

const KC_POLY_KIND: Record<string, string> = {
  'Lake or pond': 'lake',
  Reservoir: 'lake',
  'River or stream': 'river',
  'Bays, estuaries, gulfs, oceans': 'marine',
  'Ditch or channel': 'ditch',
  Flume: 'ditch',
  Aqueduct: 'ditch',
  'Residential or industrial water impoundment': 'pond',
  'Sewage disposal pond': 'pond',
  'Fish hatchery or farm': 'pond',
};
const NHD_LINE: Record<number, [kind: string, type: string]> = {
  460: ['stream', 'StreamRiver'],
  558: ['stream', 'ArtificialPath'],
  334: ['stream', 'Connector'],
  336: ['ditch', 'CanalDitch'],
  428: ['pipe', 'Pipeline'],
  420: ['pipe', 'Underground Conduit'],
  566: ['coastline', 'Coastline'],
};
const NHD_BODY: Record<number, [kind: string, type: string]> = {
  390: ['lake', 'LakePond'],
  436: ['lake', 'Reservoir'],
  466: ['wetland', 'SwampMarsh'],
  493: ['marine', 'Estuary'],
};
const PIERCE_LINE: Record<string, string> = { Stream: 'stream', River: 'stream', Drainage: 'stream', Waterbody: 'stream', Culvert: 'culvert', Pipe: 'pipe' };
const ACRE_M2 = 4046.8564;

interface WaterRec {
  id: string;
  src: 'kc' | 'pierce' | 'nhd';
  kind: string;
  name: string;
  type: string;
  coords?: Line;
  polygons?: Polygons;
  areaM2?: number;
  [k: string]: unknown;
}

async function buildWaters(county: County, mask: Mask, counts: Record<string, number>): Promise<void> {
  const proj: Projection = localProjection(county === 'King' ? [-121.8, 47.45] : [-122.15, 47.05]);
  const xy = (l: Line): XY[] => l.map((p) => proj.toXY(p));
  const area = (polys: Polygons): number => Math.round(polygonsArea(polys.map((poly) => poly.map(xy))));
  const recs: WaterRec[] = [];
  const countyStreams = new SegmentIndex();
  const coast = new SegmentIndex();
  const lakeGrid = new GridIndex<number>(500);
  const lakePolys: XY[][][] = [];
  const addLake = (polys: Polygons): void => {
    for (const poly of polys) {
      const rings = poly.map(xy);
      lakeGrid.insert(lakePolys.length, bboxOf(rings[0]));
      lakePolys.push(rings);
    }
  };

  // county hydro first
  if (county === 'King') {
    for await (const f of readRaw('kcStreams')) {
      const p = f.properties;
      linesOf(f.geometry).forEach((l, k, all) => {
        if (l.length < 2) return;
        const coords = round(l);
        countyStreams.add(xy(coords));
        recs.push({ id: `kc:s${f.id}${all.length > 1 ? `#${k}` : ''}`, src: 'kc', kind: 'stream', name: cleanName(p.WTR_NAME), type: 'stream', basin: p.BASIN_NAME ?? '', level: p.STR_LVL, coords });
      });
    }
    for await (const f of readRaw('kcLakes')) {
      const p = f.properties;
      const kind = KC_POLY_KIND[String(p.FEAT_TYPE)] ?? 'lake';
      const polygons = polygonsOf(f.geometry).map((poly) => poly.map(round));
      if (!polygons.length) continue;
      if (kind === 'lake' || kind === 'river' || kind === 'pond') addLake(polygons);
      recs.push({ id: `kc:w${p.FEATURE_ID ?? f.id}`, src: 'kc', kind, name: cleanName(p.NAME), type: String(p.FEAT_TYPE ?? ''), polygons, areaM2: area(polygons) });
    }
  } else {
    for await (const f of readRaw('pcStreams')) {
      const p = f.properties;
      const kind = PIERCE_LINE[String(p.FeatureType)] ?? 'stream';
      linesOf(f.geometry).forEach((l, k, all) => {
        if (l.length < 2) return;
        const coords = round(l);
        // MS4 lines are storm pipes and ditches, not receiving waters (same rule as waters.ts)
        if (kind === 'stream' && p.StreamTypeNPDES !== 'MS4') countyStreams.add(xy(coords));
        recs.push({ id: `pc:s${f.id}${all.length > 1 ? `#${k}` : ''}`, src: 'pierce', kind, name: cleanName(p.FeatureName), type: String(p.FeatureType ?? ''), npdes: p.StreamTypeNPDES ?? '', coords });
      });
    }
    for await (const f of readRaw('pcLakes')) {
      const polygons = polygonsOf(f.geometry).map((poly) => poly.map(round));
      if (!polygons.length) continue;
      addLake(polygons);
      recs.push({ id: `pc:w${f.id}`, src: 'pierce', kind: 'lake', name: cleanName(f.properties.FeatureName), type: 'waterbody', polygons, areaM2: area(polygons) });
    }
    for await (const f of readRaw('pcSound')) {
      const polygons = polygonsOf(f.geometry).map((poly) => poly.map(round));
      recs.push({ id: `pc:m${f.id}`, src: 'pierce', kind: 'marine', name: cleanName(f.properties.FeatureName) || 'Puget Sound', type: 'Sound', polygons, areaM2: area(polygons) });
    }
  }
  const nCounty = recs.length;

  // NHD: fallback where the county has no line or lake of its own (covered: true otherwise)
  let covered = 0;
  for await (const f of readRaw(`nhdLines${county}`)) {
    const p = f.properties;
    const [kind, type] = NHD_LINE[Number(p.FType)] ?? ['stream', `FType ${p.FType}`];
    linesOf(f.geometry).forEach((l, k, all) => {
      if (l.length < 2 || !mask.anyIn(l)) return;
      const coords = round(l);
      const line = xy(coords);
      if (kind === 'coastline') coast.add(line);
      const rec: WaterRec = { id: `nhd:${p.Permanent_Identifier ?? f.id}${all.length > 1 ? `#${k}` : ''}`, src: 'nhd', kind, name: cleanName(p.GNIS_Name) || (kind === 'coastline' ? 'Puget Sound' : ''), type, flowDir: p.FlowDir, order: p.StreamOrder, from: p.From_Node, to: p.To_Node, coords };
      if (kind === 'stream' && shareNear(countyStreams, line, 20, 25) >= 0.8) {
        rec.covered = true;
        covered++;
      }
      recs.push(rec);
    });
  }
  const lakeCovered = (polys: Polygons): boolean => {
    const c = polygonsCentroid(polys.map((poly) => poly.map(xy)));
    return lakeGrid.near(c, 1).some((i) => pointInPolygon(c, lakePolys[i]));
  };
  for await (const f of readRaw(`nhdBodies${county}`)) {
    const p = f.properties;
    const kt = NHD_BODY[Number(p.FType)];
    const polygons = polygonsOf(f.geometry).map((poly) => poly.map(round));
    if (!kt || !polygons.length || !mask.anyIn(polygons.flat(2) as any)) continue;
    const rec: WaterRec = { id: `nhd:${p.Permanent_Identifier ?? f.id}`, src: 'nhd', kind: kt[0], name: cleanName(p.GNIS_Name), type: kt[1], polygons, areaM2: area(polygons) };
    if ((kt[0] === 'lake' || kt[0] === 'wetland') && lakeCovered(polygons)) {
      rec.covered = true;
      covered++;
    }
    recs.push(rec);
  }
  for await (const f of readRaw(`nhdAreas${county}`)) {
    const p = f.properties;
    const ft = Number(p.FType);
    const polygons = polygonsOf(f.geometry).map((poly) => poly.map(round));
    if (!polygons.length || !mask.anyIn(polygons.flat(2) as any)) continue;
    // a bay is marine when it touches the coastline (Union Bay, Juanita Bay are lake bays)
    let kind = ft === 460 ? 'river' : 'marine';
    if (ft === 312) {
      const ring = polygons[0][0];
      let touches = false;
      for (let i = 0; i < ring.length && !touches; i += 5) touches = coast.near(proj.toXY(ring[i]), 30);
      kind = touches ? 'marine' : 'lake';
    }
    const rec: WaterRec = { id: `nhd:${p.Permanent_Identifier ?? f.id}`, src: 'nhd', kind, name: cleanName(p.GNIS_Name), type: ft === 312 ? 'BayInlet' : ft === 445 ? 'SeaOcean' : 'StreamRiver', polygons, areaM2: area(polygons) };
    if (kind !== 'marine' && lakeCovered(polygons)) {
      rec.covered = true;
      covered++;
    }
    recs.push(rec);
  }

  // Douglas-Peucker: the sound and coastline carry a vertex every meter or so
  const simp = (l: Line, tol: number, minPts: number): Line => {
    const pts = l.map((p) => proj.toXY(p));
    const kept = new Set(simplify(pts, tol));
    const out = l.filter((_, i) => kept.has(pts[i]));
    return out.length >= minPts ? out : l;
  };
  let before = 0;
  let after = 0;
  for (const r of recs) {
    const tol = r.kind === 'marine' || r.kind === 'coastline' ? 2 : 0.5;
    if (r.coords) {
      before += r.coords.length;
      r.coords = simp(r.coords, tol, 2);
      after += r.coords.length;
    }
    if (r.polygons) {
      r.polygons = r.polygons.map((poly) =>
        poly.map((ring) => {
          before += ring.length;
          const out = simp(ring, tol, 4);
          after += out.length;
          return out;
        }),
      );
    }
  }
  const w = new NdjsonWriter(`${OUT}/waters-${county.toLowerCase()}.ndjson`);
  for (const r of recs) w.write(r);
  counts[`waters-${county.toLowerCase()}-vertices-kept-pct`] = Math.round((100 * after) / before);
  const key = `waters-${county.toLowerCase()}`;
  counts[key] = w.close();
  counts[`${key}-county`] = nCounty;
  counts[`${key}-nhd`] = recs.length - nCounty;
  counts[`${key}-nhd-covered`] = covered;
  for (const r of recs) counts[`${key}-kind-${r.kind}`] = (counts[`${key}-kind-${r.kind}`] ?? 0) + 1;
}

function cleanName(v: unknown): string {
  const s = (v === null || v === undefined ? '' : String(v)).trim().replace(/\s+/g, ' ');
  return /^(unnamed|unk|unknown|none|null)\b/i.test(s) ? '' : s;
}

// ---------- coho ----------

/** Documented/Presumed (and Transported/Artificial ones) count as creek; the rest is possible coho. */
function cohoClass(dist: string): 'documented' | 'possible' {
  if (/historic/i.test(dist)) return 'possible';
  return /documented|presumed/i.test(dist) ? 'documented' : 'possible';
}

async function buildCoho(masks: Record<County, Mask>, counts: Record<string, number>): Promise<void> {
  const seen = new Map<number, { rec: any; counties: Set<County> }>();
  const order: number[] = [];
  for (const county of COUNTIES) {
    for await (const f of readRaw(`swifd${county}`)) {
      const lines = linesOf(f.geometry).filter((l) => l.length >= 2);
      if (!lines.some((l) => masks[county].anyIn(l))) continue;
      const e = seen.get(f.id);
      if (e) {
        e.counties.add(county);
        continue;
      }
      const p = f.properties;
      const dist = String(p.DISTTYPE_DESC ?? '');
      seen.set(f.id, { rec: { f, dist }, counties: new Set([county]) });
      order.push(f.id);
    }
  }
  const w = new NdjsonWriter(`${OUT}/coho.ndjson`);
  for (const id of order) {
    const { rec, counties } = seen.get(id)!;
    const f: RawFeature = rec.f;
    const p = f.properties;
    const cls = cohoClass(rec.dist);
    const lines = linesOf(f.geometry).filter((l) => l.length >= 2);
    lines.forEach((l, k) => {
      w.write({
        id: `swifd:${id}${lines.length > 1 ? `#${k}` : ''}`,
        llid: p.LLID ?? '',
        name: swifdName(String(p.LLID_STRM_NAME ?? '')),
        dist: rec.dist,
        coho: cls,
        use: p.USETYPE_DESC ?? '',
        life: p.LIFEHIST_DESC ?? '',
        counties: [...counties],
        coords: round(l),
      });
    });
    counts[`coho-${cls}`] = (counts[`coho-${cls}`] ?? 0) + 1;
    for (const c of counties) counts[`coho-${c.toLowerCase()}-${cls}`] = (counts[`coho-${c.toLowerCase()}-${cls}`] ?? 0) + 1;
    counts[`coho-dist-${rec.dist}`] = (counts[`coho-dist-${rec.dist}`] ?? 0) + 1;
  }
  counts.coho = w.close();
}

// ---------- check ----------

const SAMPLES: [string, XY][] = [
  ['Seattle, Pioneer Square', [-122.3321, 47.6015]],
  ['Seattle, Lake City', [-122.2925, 47.7195]],
  ['Tacoma, downtown', [-122.4443, 47.2529]],
  ['Bonney Lake', [-122.1866, 47.1773]],
  ['Tehaleh (unincorporated Pierce)', [-122.155, 47.137]],
  ['Bellevue', [-122.2015, 47.6101]],
  ['Auburn, King part', [-122.2284, 47.3073]],
  ['Auburn, Pierce part (Lakeland Hills)', [-122.2226, 47.2560]],
  ['Vashon', [-122.4604, 47.4473]],
];

async function check(): Promise<void> {
  const time = <T>(label: string, run: () => T): T => {
    const t = performance.now();
    const out = run();
    console.log(`  ${label}: ${Math.round(performance.now() - t)} ms`);
    return out;
  };
  const load = (file: string): any[] => {
    const path = `${OUT}/${file}`;
    const mb = (statSync(path).size / 1e6).toFixed(1);
    return time(`load ${file} (${mb} MB)`, () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  };
  const b = time('load boundaries.json', () => readBoundaries());
  console.log(`Boundaries: ${b.jurisdictions.length} jurisdictions`);
  for (const [label, p] of SAMPLES) console.log(`  ${label}: ${jurisdictionAt(b, p)?.name ?? '(none)'}`);
  const near = (rows: any[], p: XY, r: number): any[] =>
    rows.filter((s) => {
      const pts: number[][] = s.coords ?? s.polygons?.flat(2) ?? [];
      return pts.some((q) => Math.abs(q[0] - p[0]) < r / 75000 && Math.abs(q[1] - p[1]) < r / 111000);
    });
  for (const county of ['king', 'pierce']) {
    const streets = load(`streets-${county}.ndjson`);
    const byJ = new Map<string, number>();
    for (const s of streets) byJ.set(s.jurisdiction || '(none)', (byJ.get(s.jurisdiction || '(none)') ?? 0) + 1);
    console.log(`Streets ${county}: ${streets.length}; top jurisdictions ${[...byJ].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const waters = load(`waters-${county}.ndjson`);
    console.log(`Waters ${county}: ${waters.length}`);
    for (const [label, p] of SAMPLES) {
      const s = near(streets, p, 300);
      const w = near(waters, p, 1500);
      if (!s.length && !w.length) continue;
      const names = (rows: any[]) => [...new Set(rows.map((r) => r.name).filter(Boolean))].slice(0, 6).join(', ');
      console.log(`  ${label}: streets ${s.length} (${names(s)}); waters ${w.length} (${names(w)})`);
    }
  }
  const coho = load('coho.ndjson');
  const byClass = new Map<string, number>();
  for (const c of coho) byClass.set(c.coho, (byClass.get(c.coho) ?? 0) + 1);
  console.log(`Coho: ${coho.length} lines; ${[...byClass].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const [label, p] of SAMPLES) {
    const c = near(coho, p, 2000);
    if (c.length) console.log(`  ${label}: ${[...new Set(c.map((r) => `${r.name || 'unnamed'} (${r.coho})`))].slice(0, 5).join(', ')}`);
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--check')) return check();
  const log = (s: string) => console.log(s);
  if (args.has('--refresh')) rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const started = performance.now();

  log('Boundaries');
  await Promise.all(Object.entries(BOUNDARY_LAYERS).map(([n, s]) => download(n, s, log)));
  const b = await buildBoundaries(fetchedAt);
  const bfile = `${OUT}/boundaries.json`;
  const fd = openSync(`${bfile}.part`, 'w');
  writeSync(fd, JSON.stringify(b));
  closeSync(fd);
  renameSync(`${bfile}.part`, bfile);
  const pad = 0.02;
  boxes = Object.fromEntries(b.counties.map((c) => [c.name, [c.bbox[0] - pad, c.bbox[1] - pad, c.bbox[2] + pad, c.bbox[3] + pad]])) as Record<County, Box>;

  log('Layers');
  await Promise.all(Object.entries(LAYERS).map(([n, s]) => download(n, s, log)));
  log(`Downloaded in ${Math.round((performance.now() - started) / 1000)} s`);

  const counts: Record<string, number> = { jurisdictions: b.jurisdictions.length };
  const masks = Object.fromEntries(b.counties.map((c) => [c.name, new Mask(c.polygons)])) as Record<County, Mask>;
  await buildStreets(b, counts);
  for (const c of COUNTIES) await buildWaters(c, masks[c], counts);
  await buildCoho(masks, counts);

  const files = ['boundaries.json', 'streets-king.ndjson', 'streets-pierce.ndjson', 'waters-king.ndjson', 'waters-pierce.ndjson', 'coho.ndjson'];
  const manifest = {
    fetchedAt,
    files: Object.fromEntries(files.map((f) => [f, statSync(`${OUT}/${f}`).size])),
    counts,
    sources: Object.fromEntries(Object.entries(ALL_LAYERS).map(([k, v]) => [k, `${v.url}${v.where ? ` (${v.where})` : ''}${v.box ? ` [${v.box} box]` : ''}`])),
    credits: CREDITS,
    notes: [
      'Street names are trimmed, single-spaced and upper-cased, like the Pierce road_name pieces; show them with streetTitle().',
      'Street jurisdiction is the jurisdiction at the segment midpoint (jurisdictionAt).',
      'Pierce MAP_CLASS 7 (ferries) and 9 (island labels) are dropped, as in build-county.ts.',
      'Waters: county lines and lakes first, then NHD. NHD records with covered: true duplicate a county line (>= 80% within 25 m) or lake (centroid inside); use them only where the county has nothing.',
      'Waters are simplified (Douglas-Peucker 0.5 m; marine and coastline 2 m); streets keep the source vertices.',
      'Pierce stream lines keep npdes (StreamTypeNPDES); MS4 ones are storm conveyance, not receiving waters.',
      'Coho: documented = Documented, Presumed, Transported/Artificial - Documented/Presumed; possible = Gradient Accessible, Modeled, Potential, Historic.',
    ],
  };
  const mfile = `${OUT}/context.json`;
  const mfd = openSync(`${mfile}.part`, 'w');
  writeSync(mfd, JSON.stringify(manifest, null, 1));
  closeSync(mfd);
  renameSync(`${mfile}.part`, mfile);
  log(JSON.stringify(counts, null, 1));
  log(`Done in ${Math.round((performance.now() - started) / 1000)} s`);
}

await main();
