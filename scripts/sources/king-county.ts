// King County MS4 inventory (WLRD Stormwater Services) -> <cache>/sources/kc-ms4/assets.ndjson, meta.json, gaps.geojson.
// Unincorporated King County with Vashon, plus county pieces inside cities.
// Lines name their up/down node by typed key (SNS-, ACC-, INT-, NDE-, PMP-, LNK-, FFP-, ...).
// NDE concept nodes are joined by key alone; their points are never fetched.
// Own pager here: scripts/lib/county-fetch.ts doesn't export one.
// Run: node scripts/sources/king-county.ts [--refresh] [--fetch-only]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';
import { bboxOf, dist, distanceToPolygons, GridIndex, localProjection, nearestOnPolyline, polygonsArea, polygonsCentroid, polylineLength, slicePolyline, type XY } from '../../src/geo/geo.ts';
import { text, type FeatureCollection, type Geometry, type Position } from '../../src/trace/geojson.ts';

const KEY = 'kc-ms4';
const CACHE = process.env.TT_CACHE ?? '.cache';
const DIR = `${CACHE}/sources/${KEY}`;
const RAW = `${DIR}/raw`;
const MS4 = 'https://gismaps.kingcounty.gov/arcgis/rest/services/WLRD/Stormwater_MS4/MapServer';
const AREAS = 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/CITY_KC_AREA_446/FeatureServer/0';

export const CREDIT = 'Storm drain data: King County GIS (WLRD Stormwater Services MS4 inventory). Provided as is; not for resale.';
const DISCLAIMER =
  'King County makes no representations or warranties, express or implied, as to accuracy, completeness, timeliness, or rights to the use of such information. Any sale of this information is prohibited except by written permission of King County.';

type Shape = 'line' | 'point' | 'polygon';

interface Spec {
  name: string;
  url: string;
  fields: string[];
  shape: Shape;
  page: number;
}

const BASE = ['DBAssetID', 'OwnerEntity', 'Jurisdiction', 'CurrentStatus'];
const UPDOWN = ['UpstreamDBAssetID', 'DownstreamDBAssetID'];
const BMP_LINE = [...UPDOWN, 'ComponentType', 'Underdrain', 'Intent'];
const SUMP = ['Component', 'ComponentType', 'CoverStyle'];
const LINK = ['LinkType', 'IntoOut', 'ToFrom', 'ReceivingWaterName', 'RiverName'];

const ms4 = (id: number, name: string, shape: Shape, extra: string[]): Spec => ({
  name,
  url: `${MS4}/${id}`,
  fields: [...BASE, ...extra],
  shape,
  page: shape === 'polygon' ? 500 : 2000,
});

// Never: /47 drainage easements, /67 facility sites, /38 facility mapping, KingCo_Stormwater 1-5 complaints.
export const LAYERS: Spec[] = [
  ms4(15, 'closed', 'line', [...UPDOWN, 'Component', 'ComponentType', 'Diameter', 'Width', 'Height', 'FlowDirection', 'Intent', 'UpstreamElevation', 'DownstreamElevation', 'VerticalDatum']),
  ms4(16, 'ditch', 'line', [...UPDOWN, 'Component', 'DitchWidth', 'FlowDirection', 'Intent']),
  ms4(17, 'curb', 'line', [...UPDOWN, 'Component', 'ComponentType', 'FlowDirection', 'Intent']),
  ms4(18, 'trench-drain', 'line', [...UPDOWN, 'Component', 'ComponentType', 'Diameter', 'FlowDirection', 'Intent']),
  ms4(25, 'swale', 'line', [...UPDOWN, 'SwaleType', 'Width', 'Intent']),
  ms4(26, 'dispersal-trench', 'line', BMP_LINE),
  ms4(27, 'sheet-flow', 'line', BMP_LINE),
  ms4(29, 'bio-swale', 'line', BMP_LINE),
  ms4(30, 'infiltration-trench', 'line', BMP_LINE),
  ms4(31, 'filter-strip', 'line', [...UPDOWN, 'Intent']),
  ms4(32, 'tank', 'line', [...UPDOWN, 'ComponentType', 'Diameter', 'Width', 'Height', 'FlowDirection', 'Intent']),
  ms4(1, 'catch-basin', 'point', SUMP),
  ms4(2, 'sump-other', 'point', SUMP),
  ms4(3, 'no-sump', 'point', SUMP),
  ms4(4, 'manhole', 'point', ['Component']),
  ms4(5, 'riser', 'point', ['Component']),
  ms4(6, 'cleanout', 'point', ['Component']),
  ms4(68, 'other-access', 'point', ['Component']),
  ms4(7, 'pump', 'point', []),
  ms4(8, 'undefined', 'point', []),
  ms4(9, 'fitting', 'point', ['Component', 'ComponentType']),
  ms4(10, 'unknown-buried', 'point', ['Component', 'ComponentType']),
  ms4(12, 'link', 'point', LINK),
  ms4(13, 'unverified-link', 'point', LINK),
  ms4(20, 'dry-well', 'point', ['ComponentType']),
  ms4(21, 'splash-block', 'point', ['ComponentType']),
  ms4(22, 'rock-pad', 'point', ['ComponentType']),
  ms4(23, 'injection-well', 'point', ['ComponentType']),
  ms4(24, 'proprietary', 'point', ['ComponentType']),
  ms4(53, 'weir', 'point', ['ComponentType']),
  ms4(54, 'riprap-pad', 'point', ['FacilityFeatureType']),
  ms4(69, 'gabion', 'point', ['FacilityFeatureType']),
  ms4(33, 'pond-vault', 'polygon', [...UPDOWN, 'ComponentType', 'Cover', 'Intent']),
  ms4(34, 'other-control', 'polygon', ['ComponentType', 'Underdrain']),
  ms4(74, 'proprietary-area', 'polygon', ['ComponentType']),
];

// context only: unmapped areas and roads, and the jurisdiction polygons
export const GAPS: Spec = { name: 'data-gap', url: `${MS4}/40`, fields: ['Status'], shape: 'polygon', page: 200 };
export const ROADS: Spec = { name: 'row-mapping', url: `${MS4}/39`, fields: ['MappingStatus', 'MS4Present', 'CurrentStatus'], shape: 'line', page: 2000 };
export const CITIES: Spec = { name: 'areas', url: AREAS, fields: ['CITYNAME'], shape: 'polygon', page: 20 };

// staff names, contacts, addresses, parcels, notes and links never get requested
const PII = /owner|addr|phone|email|contact|parcel|grantor|taxpayer|user|editor|creator|inspect|staff|by$|assigned|notes|link|location|access|keynumber|tract|business|station|name/i;
const CATEGORY_OK = new Set(['OwnerEntity', 'ReceivingWaterName', 'RiverName', 'CITYNAME', 'LinkType']);

export function checkFields(spec: Spec): void {
  const bad = spec.fields.filter((f) => PII.test(f) && !CATEGORY_OK.has(f));
  if (bad.length) throw new Error(`${spec.name}: refusing personal or free-text fields ${bad.join(', ')}`);
}

// ---------------------------------------------------------------- fetch

const UA = 'tiretrail-data/0.1 (storm drain tracing; build script)';
const PER_HOST = 4;
const busy = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

async function slot(host: string): Promise<() => void> {
  const n = busy.get(host) ?? 0;
  if (n < PER_HOST) busy.set(host, n + 1);
  else await new Promise<void>((r) => waiting.set(host, [...(waiting.get(host) ?? []), r]));
  return () => {
    // hand the slot straight to the next request
    const next = waiting.get(host)?.shift();
    if (next) next();
    else busy.set(host, busy.get(host)! - 1);
  };
}

async function post(url: string, body: URLSearchParams): Promise<any> {
  const host = new URL(url).host;
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const done = await slot(host);
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
    } finally {
      done();
    }
    // 1, 2, 4, 8, 16 s plus jitter
    if (attempt < 5) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
  throw new Error(`${url}: ${String(last)}`);
}

/** All features of a layer, by object id chunks. */
async function download(spec: Spec, log: (s: string) => void): Promise<FeatureCollection> {
  checkFields(spec);
  const ids: number[] = (await post(`${spec.url}/query`, new URLSearchParams({ where: '1=1', returnIdsOnly: 'true', f: 'json' }))).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += spec.page) chunks.push(ids.slice(i, i + spec.page));
  let done = 0;
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      const body = new URLSearchParams({
        objectIds: chunk.join(','),
        outFields: spec.fields.join(','),
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '7',
        f: 'geojson',
      });
      const json = await post(`${spec.url}/query`, body);
      done++;
      if (done % 10 === 0 || done === chunks.length) log(`  ${spec.name}: ${done}/${chunks.length} pages`);
      return (json.features ?? []) as FeatureCollection['features'];
    }),
  );
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${spec.name}: got ${features.length} of ${ids.length} features`);
  return { type: 'FeatureCollection', features };
}

interface FetchLog {
  layers: Record<string, { url: string; fields: string[]; count: number; fetchedAt: string }>;
}

const fetchLogFile = () => `${RAW}/fetch.json`;

export function readFetchLog(): FetchLog {
  return existsSync(fetchLogFile()) ? (JSON.parse(readFileSync(fetchLogFile(), 'utf8')) as FetchLog) : { layers: {} };
}

/** Downloads every layer not already in raw/ (all of them with refresh). */
export async function fetchKingCounty(refresh = false, log: (s: string) => void = console.log): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  const specs = [...LAYERS, GAPS, ROADS, CITIES];
  specs.forEach(checkFields);
  const flog = readFetchLog();
  await Promise.all(
    specs.map(async (spec) => {
      const file = `${RAW}/${spec.name}.geojson`;
      if (!refresh && existsSync(file)) return;
      const fc = await download(spec, log);
      writeFileSync(`${file}.part`, JSON.stringify(fc));
      renameSync(`${file}.part`, file);
      flog.layers[spec.name] = { url: spec.url, fields: spec.fields, count: fc.features.length, fetchedAt: new Date().toISOString() };
      writeFileSync(fetchLogFile(), JSON.stringify(flog, null, 1));
      log(`  ${spec.name}: ${fc.features.length} features`);
    }),
  );
}

export function readLayer(name: string): FeatureCollection {
  return JSON.parse(readFileSync(`${RAW}/${name}.geojson`, 'utf8')) as FeatureCollection;
}

// ---------------------------------------------------------------- build

type LL = [number, number];
type Props = Record<string, unknown>;

/** Distances in meters. */
export const TOL = {
  /** line ends this close mark the same node */
  onNodeM: 1,
  /** one known end: flip when its node is this close to the far end only (as in network.ts) */
  flipM: 5,
  /** a dead end or a start this close to a pond or vault opens into it */
  pondM: 5,
  /** a dead end this close to another line's start or middle joins it */
  touchM: 1.5,
  /** a joint closer than this to a line end joins that end instead */
  endM: 0.5,
  /** with nothing closer, a dead end enters a facility this far off */
  enterM: 8,
  /** ... or steps to an outfall or discharge point no line reaches yet */
  outfallM: 8,
  /** ... or to one a line already reaches */
  fedOutfallM: 3,
  /** a facility with no outlet beside it takes a start this far off */
  outletM: 10,
  /** a riprap pad steps this far to the next ditch, stream or pipe */
  padM: 10,
  /** a jurisdictional link this close to a city hands water to it */
  cityM: 300,
};

const IN = 0.0254;
const FT = 0.3048;
const GONE = new Set(['Retired', 'Abandoned', 'Removed', 'Delete', 'Data entry error']);
const NATURAL = 'Convey natural water body';
const TOWNS: Record<string, string> = { 'Beaux Arts': 'Town of Beaux Arts Village', 'Hunts Point': 'Town of Hunts Point', 'Yarrow Point': 'Town of Yarrow Point', Skykomish: 'Town of Skykomish' };
const COUNTIES = new Set(['Snohomish County', 'Pierce County', 'Chelan County', 'Kittitas County']);
const INFILTRATING = new Set(['Bioretention Cell', 'Bioretention Planter', 'Rain Garden', 'Permeable Pavement (Non Vegetated)', 'Permeable Pavement (Vegetated)', 'Vegetated Flow Path', 'Native Vegetated Flow Path', 'Infiltration']);
const GROUND_POINTS = new Set(['dry-well', 'injection-well', 'rock-pad', 'splash-block']);
const PADS = new Set(['riprap-pad', 'gabion']);
const LINKS = new Set(['link', 'unverified-link']);
const SUMPS = new Set(['catch-basin', 'sump-other', 'no-sump']);
const WATER: Partial<Record<string, 'water' | 'ground' | 'treatment'>> = {
  Stream: 'water',
  Wetland: 'water',
  Lake: 'water',
  Marine: 'water',
  'Potential Stream': 'water',
  'Potential Wetland': 'water',
  Ground: 'ground',
  Groundwater: 'ground',
  'Sanitary Sewer': 'treatment',
};

interface Pt {
  id: string;
  layer: string;
  p: Props;
  xy: XY;
}

interface Ln {
  id: string;
  layer: string;
  p: Props;
  xy: XY[];
  up: string;
  down: string;
  /** piece of a line split at joints */
  part?: 'first' | 'middle' | 'last';
}

interface Fac {
  id: string;
  layer: string;
  p: Props;
  polys: XY[][][];
  ring: XY[];
  center: XY;
  area: number;
  role: Role;
}

const key = (v: unknown) => text(v).toUpperCase();
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number.parseFloat(text(v));
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};
const cm = (x: number) => Math.round(x * 100) / 100;
const first = (l: Ln) => l.xy[0];
const last = (l: Ln) => l.xy[l.xy.length - 1];

function path(g: Geometry | null): Position[] {
  if (g?.type === 'LineString') return g.coordinates;
  if (g?.type === 'MultiLineString') return g.coordinates.flat();
  return [];
}

function parts(g: Geometry | null): Position[][][] {
  if (g?.type === 'Polygon') return [g.coordinates];
  if (g?.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function ownerOf(p: Props): 'public' | 'private' | 'other' {
  const o = text(p.OwnerEntity);
  return o === 'Private' ? 'private' : !o || o === 'TBD' ? 'other' : 'public';
}

const SMALL = new Set(['to', 'of', 'the', 'and', 'a']);
const FIXES: [RegExp, string][] = [
  [/\bwashintgon\b/i, 'Washington'],
  [/\bnewakum\b/i, 'Newaukum'],
  [/\bsnoqulmie\b/i, 'Snoqualmie'],
  [/\bevan's\b/i, 'Evans'],
  [/\bmcdonald\b/i, 'McDonald'],
  [/^15 mile$/i, 'Fifteenmile Creek'],
  [/^duwamish ?- ?green( river)?$/i, 'Duwamish-Green River'],
  [/^s\.? ?f\.? /i, 'South Fork '],
  [/^n\.? fork /i, 'North Fork '],
  [/\btri[bp]\b\.?/i, 'tributary'],
  [/^un-?named|^unknown/i, 'Unnamed'],
  [/ r\.?$/i, ' River'],
  [/ cr\.?$/i, ' Creek'],
];

/** Receiving water as recorded, with spellings evened out; undefined unless it names a water. */
export function waterName(raw: string): string | undefined {
  let s = raw.replace(/\s+/g, ' ').replace(/[?.]+$/, '').trim();
  for (const [re, to] of FIXES) s = s.replace(re, to);
  if (!/creek|river|lake|sound|slough|wetland|pond|bay|canal|outlet|tributary|harbor|waterway|passage/i.test(s)) return undefined;
  if (/^unnamed$/i.test(s)) return undefined;
  // capitalize words typed all lower or all upper case; leave mixed case (McDonald) alone
  const word = (w: string, i: number) => {
    if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
    return w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 2) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
  };
  return s
    .split(' ')
    .map(word)
    .join(' ')
    .replace(/-([a-z])/g, (_, c: string) => `-${c.toUpperCase()}`);
}

function lineRole(layer: string, p: Props): Pick<SourceAsset, 'role' | 'width' | 'perforated' | 'openBottom' | 'liveStream'> {
  const ct = text(p.ComponentType);
  const natural = text(p.Intent) === NATURAL;
  switch (layer) {
    case 'closed': {
      const w = num(p.Diameter) ?? num(p.Width);
      return {
        role: natural ? 'stream-culvert' : text(p.Component) === 'Culvert' ? 'culvert' : 'pipe',
        width: w ? cm(w * IN) : undefined,
        perforated: ct === 'Infiltration Pipe' || ct === 'Perforated- use unknown' || undefined,
        openBottom: ct.startsWith('Bottomless') || undefined,
        liveStream: natural || undefined,
      };
    }
    case 'ditch': {
      const w = num(p.DitchWidth);
      const stream = natural || text(p.Component).startsWith('Stream');
      return { role: stream ? 'stream' : 'ditch', width: w ? cm(w * FT) : undefined, liveStream: stream || undefined };
    }
    case 'swale': {
      const w = num(p.Width);
      return { role: 'ditch', width: w ? cm(w * FT) : undefined };
    }
    case 'trench-drain': {
      const w = num(p.Diameter);
      return { role: 'ditch', width: w ? cm(w * IN) : undefined };
    }
    case 'dispersal-trench':
    case 'sheet-flow':
    case 'infiltration-trench':
      return { role: 'pipe', perforated: true };
    case 'bio-swale':
      return { role: 'ditch', perforated: true };
    case 'tank': {
      const w = num(p.Diameter) ?? num(p.Width);
      return { role: 'pipe', width: w ? cm(w * IN) : undefined, perforated: ct === 'Infiltration' || undefined };
    }
    default:
      return { role: 'ditch' };
  }
}

function facilityRole(layer: string, p: Props): Role {
  const ct = text(p.ComponentType);
  if (layer === 'pond-vault') return ct === 'Infiltration' || ct === 'Combined_infiltration_detention' ? 'facility-infiltrate' : 'facility-hold';
  if (layer === 'other-control') return text(p.Underdrain) !== 'Yes' && INFILTRATING.has(ct) ? 'facility-infiltrate' : 'facility-hold';
  return ct === 'Alt Infiltration System' ? 'facility-infiltrate' : 'facility-hold';
}

/** Keys inside directed cycles, mapped to their cycle (Tarjan, iterative). */
export function cycles(edges: readonly [string, string][]): Map<string, number> {
  const id = new Map<string, number>();
  const node = (k: string) => {
    let n = id.get(k);
    if (n === undefined) id.set(k, (n = id.size));
    return n;
  };
  const adj: number[][] = [];
  for (const [a, b] of edges) {
    const x = node(a);
    (adj[x] ??= []).push(node(b));
  }
  const n = id.size;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const sizes: number[] = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    const work: [number, number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      const nb = adj[v] ?? [];
      if (top[1] < nb.length) {
        const w = nb[top[1]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] !== index[v]) continue;
      let size = 0;
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = 0;
        comp[w] = sizes.length;
        size++;
      } while (w !== v);
      sizes.push(size);
    }
  }
  const out = new Map<string, number>();
  for (const [k, x] of id) if (sizes[comp[x]] > 1) out.set(k, comp[x]);
  return out;
}

/** Inverts in meters, from feet. */
function invert(v: unknown): number | undefined {
  const ft = num(v);
  return ft !== undefined && ft > -100 && ft < 10000 ? cm(ft * FT) : undefined;
}

export interface Built {
  assets: SourceAsset[];
  meta: SourceMeta;
  /** data gaps and roads not mapped yet */
  context: FeatureCollection;
  report: string[];
}

export function buildKingCounty(read: (name: string) => FeatureCollection, fetchedAt: string): Built {
  const proj = localProjection([-122.1, 47.45]);
  const xyOf = (c: Position): XY => proj.toXY([c[0], c[1]]);
  const llOf = (p: XY): LL => {
    const [lon, lat] = proj.toLngLat(p);
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };
  const counts: Record<string, number> = {};
  const add = (k: string, n = 1) => {
    counts[k] = (counts[k] ?? 0) + n;
  };

  // 1. read
  const points = new Map<string, Pt>();
  const lines: Ln[] = [];
  const facs: Fac[] = [];
  for (const spec of LAYERS) {
    for (const f of read(spec.name).features) {
      const p = f.properties ?? {};
      const id = key(p.DBAssetID);
      if (GONE.has(text(p.CurrentStatus))) {
        add('skipped.status');
        continue;
      }
      if (!id) {
        add('skipped.noId');
        continue;
      }
      if (spec.shape === 'point') {
        if (f.geometry?.type !== 'Point') add('skipped.noGeometry');
        else if (points.has(id)) add('skipped.repeatedId');
        else points.set(id, { id, layer: spec.name, p, xy: xyOf(f.geometry.coordinates) });
      } else if (spec.shape === 'line') {
        const pts = path(f.geometry);
        if (pts.length < 2) add('skipped.noGeometry');
        else lines.push({ id, layer: spec.name, p, xy: pts.map(xyOf), up: key(p.UpstreamDBAssetID), down: key(p.DownstreamDBAssetID) });
      } else {
        const polys = parts(f.geometry)
          .map((rings) => rings.filter((r) => r.length >= 4).map((r) => r.map(xyOf)))
          .filter((rings) => rings.length > 0);
        if (!polys.length) {
          add('skipped.noGeometry');
          continue;
        }
        const biggest = polys.reduce((a, b) => (polygonsArea([b]) > polygonsArea([a]) ? b : a));
        facs.push({ id, layer: spec.name, p, polys, ring: biggest[0], center: polygonsCentroid(polys), area: polygonsArea(polys), role: facilityRole(spec.name, p) });
      }
    }
  }

  // 2. node positions: points, else where most lines naming the key have an end
  const pos = new Map<string, XY>();
  for (const [k, pt] of points) pos.set(k, pt.xy);
  const refs = new Map<string, number[]>();
  lines.forEach((l, i) => {
    for (const k of new Set([l.up, l.down])) {
      if (k && !points.has(k)) refs.set(k, [...(refs.get(k) ?? []), i]);
    }
  });
  const near = (a: XY, b: XY) => dist(a, b) <= TOL.onNodeM;
  for (const [k, ls] of refs) {
    if (ls.length < 2) continue;
    let best: XY | null = null;
    let bestN = 1;
    for (const i of ls) {
      const l = lines[i];
      for (const c of l.up === k ? [first(l), last(l)] : [last(l), first(l)]) {
        let n = 0;
        for (const j of ls) if (near(first(lines[j]), c) || near(last(lines[j]), c)) n++;
        if (n > bestN) [best, bestN] = [c, n];
      }
    }
    if (best) pos.set(k, best);
    else add('ends.sharedKeyApart');
  }

  // 3. orient each line from its up node to its down node (the drawing is the fallback)
  const gap = { on: 0, near: 0, far: 0 };
  for (const l of lines) {
    // a line naming one key at both ends keeps it at the end on that node
    if (l.up && l.up === l.down) {
      const n = pos.get(l.up);
      if (n && dist(n, first(l)) <= dist(n, last(l))) l.down = '';
      else l.up = '';
      add('ends.sameKeyBothEnds');
    }
    const A = first(l);
    const B = last(l);
    const F = l.up ? pos.get(l.up) : undefined;
    const T = l.down && l.down !== l.up ? pos.get(l.down) : undefined;
    const close = (n: XY | undefined): n is XY => !!n && Math.min(dist(n, A), dist(n, B)) <= TOL.flipM;
    const cf = close(F);
    const ct = close(T);
    let flip = false;
    if (cf && ct) flip = dist(F, B) + dist(T, A) + 0.5 < dist(F, A) + dist(T, B);
    else if (cf) flip = dist(F, B) < TOL.flipM && dist(F, A) > TOL.flipM;
    else if (ct) flip = dist(T, A) < TOL.flipM && dist(T, B) > TOL.flipM;
    if (cf || ct) {
      add('direction.checked');
      add(flip ? 'direction.againstIds' : 'direction.withIds');
      if (text(l.p.FlowDirection) === 'Flip flow direction') add(flip ? 'direction.flagFlipFlipped' : 'direction.flagFlipKept');
    } else add(F || T ? 'direction.idsFar' : 'direction.unchecked');
    if (flip) l.xy.reverse();
    for (const [n, end] of [
      [F, l.xy[0]],
      [T, l.xy[l.xy.length - 1]],
    ] as const) {
      if (!n) continue;
      const d = dist(n, end);
      if (d <= TOL.onNodeM) gap.on++;
      else if (d <= TOL.flipM) gap.near++;
      else gap.far++;
    }
  }

  // checks that don't lean on the ids: recorded outfalls sit at the downstream end, inverts fall
  const outfallRec = (k: string) => {
    const pt = points.get(k);
    return !!pt && LINKS.has(pt.layer) && text(pt.p.IntoOut).startsWith('Out') && /Outfall|Discharge/.test(text(pt.p.LinkType));
  };
  for (const l of lines) {
    const u = outfallRec(l.up);
    const d = outfallRec(l.down);
    // streams carry on past the outfalls that feed them
    if (u !== d && text(l.p.Intent) !== NATURAL) add(d ? 'direction.towardOutfall' : 'direction.awayFromOutfall');
    const ui = num(l.p.UpstreamElevation);
    const di = num(l.p.DownstreamElevation);
    if (ui !== undefined && di !== undefined) add(ui >= di ? 'direction.invertsFall' : 'direction.invertsRise');
  }

  // 4. what arrives at and leaves each key
  const outOf = new Map<string, number[]>();
  const into = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.up) outOf.set(l.up, [...(outOf.get(l.up) ?? []), i]);
    if (l.down) into.set(l.down, [...(into.get(l.down) ?? []), i]);
  });
  const at = (k: string): XY | undefined => pos.get(k) ?? (into.has(k) ? last(lines[into.get(k)![0]]) : outOf.has(k) ? first(lines[outOf.get(k)![0]]) : undefined);

  // key resolution, per line end
  for (const l of lines) {
    for (const k of [l.up, l.down]) {
      if (!k) add('ends.blank');
      else if (points.has(k)) add('ends.point');
      else if (!k.startsWith('NDE-')) add('ends.missing');
      else if ((refs.get(k)?.length ?? 0) > 1) add('ends.nodeShared');
      else add('ends.nodeLoose');
    }
  }

  // 5. cities, for handoffs
  const areas = read(CITIES.name).features;
  const cityIdx = new GridIndex<number>(5000);
  const cityPolys: { name: string; polys: XY[][][] }[] = [];
  const boundary: LL[][][] = [];
  for (const f of areas) {
    const name = text(f.properties?.CITYNAME);
    const polys = parts(f.geometry);
    if (name === 'King County') {
      for (const rings of polys) boundary.push(rings.map((r) => r.map((c) => [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7] as LL)));
      continue;
    }
    const xy = polys.map((rings) => rings.map((r) => r.map(xyOf)));
    cityIdx.insert(cityPolys.length, bboxOf(xy.flat(2)));
    cityPolys.push({ name, polys: xy });
  }
  const cityNames = new Set(cityPolys.map((c) => c.name));
  const nearestCity = (p: XY): string | undefined => {
    let best: { name: string; d: number } | undefined;
    for (const i of cityIdx.near(p, TOL.cityM)) {
      const d = distanceToPolygons(p, cityPolys[i].polys);
      if (d <= TOL.cityM && (!best || d < best.d)) best = { name: cityPolys[i].name, d };
    }
    return best?.name;
  };
  const agency = (p: Props, xy: XY): string => {
    const j = text(p.Jurisdiction);
    if (TOWNS[j]) return TOWNS[j];
    if (cityNames.has(j)) return `City of ${j}`;
    if (COUNTIES.has(j)) return j;
    if (j === 'State (All entities)') return 'State of Washington';
    const c = nearestCity(xy);
    return c ? (TOWNS[c] ?? `City of ${c}`) : 'another jurisdiction';
  };

  // 6. links: ToFrom says where water goes; what the lines do there says whether it stops
  const linkOut = new Map<string, Pick<SourceAsset, 'role' | 'endHint' | 'receivingHint'>>();
  for (const pt of points.values()) {
    if (!LINKS.has(pt.layer)) continue;
    const p = pt.p;
    const toFrom = text(p.ToFrom);
    const io = text(p.IntoOut);
    const type = text(p.LinkType);
    const way = io.startsWith('Into') ? 'in' : io.startsWith('Out') ? 'out' : type === 'Infall' ? 'in' : type === 'Outfall' || type === 'Discharge Point' ? 'out' : '';
    const hint =
      WATER[toFrom] ??
      (toFrom === 'Jurisdictional' ? `handoff:${agency(p, pt.xy)}` : toFrom === 'Private' ? 'handoff:private' : toFrom === 'Other Public Agency' ? 'handoff:other public agency' : 'unknown');
    const arrives = into.has(pt.id);
    const leaves = outOf.has(pt.id);
    let r: Pick<SourceAsset, 'role' | 'endHint' | 'receivingHint'>;
    if (leaves && (!arrives || way === 'in' || hint === 'unknown' || hint.startsWith('handoff:'))) r = { role: 'junction' };
    else if (way === 'in') r = arrives ? { role: 'discharge', endHint: 'unknown' } : { role: 'junction' };
    else {
      const named = toFrom === 'Marine' ? 'Puget Sound' : (waterName(text(p.ReceivingWaterName)) ?? waterName(text(p.RiverName)));
      r = { role: hint === 'water' ? 'outfall' : 'discharge', endHint: hint, receivingHint: named };
    }
    linkOut.set(pt.id, r);
    const kind = r.role === 'junction' ? 'junction' : r.endHint!.startsWith('handoff:') ? 'handoff' : r.endHint!;
    add(`links.${kind}`);
    if (kind === 'handoff') add(`handoff.${r.endHint!.slice(8)}`);
  }

  // 7. dead ends: water arrives and no line leaves. Nearest evidence first: a pond or vault,
  // another line's start, another line partway, a pond a bit farther, an outfall nearby.
  const facIdx = new GridIndex<number>(100);
  facs.forEach((f, i) => facIdx.insert(i, bboxOf(f.polys.flat(2))));
  const nearestFac = (p: XY, r: number): { i: number; d: number } | undefined => {
    let best: { i: number; d: number } | undefined;
    for (const i of facIdx.near(p, r)) {
      const d = distanceToPolygons(p, facs[i].polys);
      if (d <= r && (!best || d < best.d || (d === best.d && facs[i].area < facs[best.i].area))) best = { i, d };
    }
    return best;
  };
  const endingPoint = (k: string) => {
    const pt = points.get(k);
    if (!pt) return false;
    if (LINKS.has(pt.layer)) return linkOut.get(k)!.role !== 'junction';
    return GROUND_POINTS.has(pt.layer) && !outOf.has(k);
  };
  const deadEnds = [...into.keys()].filter((k) => !outOf.has(k) && !endingPoint(k)).sort();
  const startIdx = new GridIndex<string>(25);
  for (const k of outOf.keys()) startIdx.insertPoint(k, at(k)!);
  const lineIdx = new GridIndex<number>(50);
  lines.forEach((l, i) => lineIdx.insert(i, bboxOf(l.xy)));
  const endIdx = new GridIndex<string>(25);
  for (const pt of points.values()) if (endingPoint(pt.id)) endIdx.insertPoint(pt.id, pt.xy);
  // lines upstream of a key, so a join never loops back
  const upstream = (k: string): Set<number> => {
    const seen = new Set<number>();
    const keys = new Set([k]);
    const stack = [k];
    while (stack.length && seen.size < 500) {
      for (const i of into.get(stack.pop()!) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const u = lines[i].up;
        if (u && !keys.has(u)) {
          keys.add(u);
          stack.push(u);
        }
      }
    }
    return seen;
  };
  // facility outlets: starts nearby with nothing upstream, whose line runs away from it
  const runsAway = (k: string, fi: number, d: number) => outOf.get(k)!.some((i) => distanceToPolygons(last(lines[i]), facs[fi].polys) > d + 1);
  const headOut = new Map<number, string[]>();
  for (const k of [...outOf.keys()].filter((x) => !into.has(x)).sort()) {
    const hit = nearestFac(at(k)!, TOL.pondM);
    if (hit && runsAway(k, hit.i, hit.d)) headOut.set(hit.i, [...(headOut.get(hit.i) ?? []), k]);
  }
  // a dead end below a facility's outlet doesn't flow back into it
  const below = (fi: number, up: Set<number>) => (headOut.get(fi) ?? []).some((h) => outOf.get(h)!.some((i) => up.has(i)));

  const virtual: SourceAsset[] = [];
  const why: string[] = []; // count key of each virtual line
  const link = (id: string, from: string, to: string, coords: XY[], how = '') => {
    virtual.push({ role: 'virtual', id, src: KEY, fromId: from, toId: to, coords: coords.map(llOf), trust: 'id' });
    why.push(how);
  };
  const entering = new Map<number, string[]>();
  const enterHow = new Map<string, string>();
  const upOf = new Map<string, Set<number>>();
  const cuts = new Map<number, { along: number; key: string; q: XY }[]>();
  const padLeft = new Set<string>();
  const left = new Set<string>();
  for (const k of deadEnds) {
    const p = at(k)!;
    const pad = PADS.has(points.get(k)?.layer ?? '');
    const tag = pad ? 'pads' : 'deadEnds';
    const up = upstream(k);
    const enter = (fi: number) => {
      entering.set(fi, [...(entering.get(fi) ?? []), k]);
      enterHow.set(k, `${tag}.intoFacility`);
      upOf.set(k, up);
      add(`${tag}.intoFacility`);
    };
    const fac = nearestFac(p, TOL.pondM);
    if (fac && !below(fac.i, up)) {
      enter(fac.i);
      continue;
    }
    const reach = pad ? TOL.padM : TOL.touchM;
    let s: { k: string; d: number } | undefined;
    for (const h of startIdx.near(p, reach)) {
      if (h === k || outOf.get(h)!.some((i) => up.has(i))) continue;
      const d = dist(p, at(h)!);
      if (d <= reach && (!s || d < s.d || (d === s.d && h < s.k))) s = { k: h, d };
    }
    if (s) {
      link(`${k}:join:${s.k}`, k, s.k, [p, at(s.k)!], `${tag}.toLineStart`);
      add(`${tag}.toLineStart`);
      continue;
    }
    let m: { i: number; d: number; along: number; q: XY } | undefined;
    for (const i of lineIdx.near(p, reach)) {
      if (up.has(i)) continue;
      const on = nearestOnPolyline(p, lines[i].xy);
      if (on.d <= reach && (!m || on.d < m.d || (on.d === m.d && i < m.i))) m = { i, d: on.d, along: on.along, q: on.point };
    }
    if (m) {
      const l = lines[m.i];
      const len = polylineLength(l.xy);
      if (m.along > TOL.endM && m.along < len - TOL.endM) {
        // the dead end becomes a joint partway along the line; a pad farther off gets one of its own
        const j = m.d <= TOL.touchM ? k : `${l.id}@${k}`;
        cuts.set(m.i, [...(cuts.get(m.i) ?? []), { along: m.along, key: j, q: m.q }]);
        if (j !== k) link(`${k}:join:${j}`, k, j, [p, m.q], `${tag}.ontoLine`);
        add(`${tag}.ontoLine`);
        continue;
      }
      const end = m.along <= TOL.endM ? l.up : l.down;
      if (end && end !== k) {
        link(`${k}:join:${end}`, k, end, [p, m.q], `${tag}.toLineEnd`);
        add(`${tag}.toLineEnd`);
        continue;
      }
    }
    if (!pad) {
      const far = nearestFac(p, TOL.enterM);
      if (far && !below(far.i, up)) {
        enter(far.i);
        continue;
      }
    }
    let e: { k: string; d: number } | undefined;
    for (const h of endIdx.near(p, TOL.outfallM)) {
      const d = dist(p, points.get(h)!.xy);
      if (d <= (into.has(h) ? TOL.fedOutfallM : TOL.outfallM) && (!e || d < e.d || (d === e.d && h < e.k))) e = { k: h, d };
    }
    if (e) {
      link(`${k}:join:${e.k}`, k, e.k, [p, points.get(e.k)!.xy], `${tag}.toOutfall`);
      add(`${tag}.toOutfall`);
      continue;
    }
    if (pad) padLeft.add(k);
    else left.add(k);
  }

  // 8. lines split where dead ends join them partway; pieces keep the line's id
  const pieces = new Map<number, Ln[]>();
  for (const [i, list] of cuts) {
    const l = lines[i];
    const len = polylineLength(l.xy);
    list.sort((a, b) => a.along - b.along || (a.key < b.key ? -1 : 1));
    const out: Ln[] = [];
    let from = 0;
    let fromKey = l.up;
    let prev: { along: number; key: string; q: XY } | undefined;
    for (const c of list) {
      if (prev && c.along - prev.along < TOL.endM) {
        // same joint as the cut before
        link(`${c.key}:join:${prev.key}`, c.key, prev.key, [c.q, prev.q]);
        continue;
      }
      out.push({ ...l, xy: slicePolyline(l.xy, from, c.along), up: fromKey, down: c.key, part: out.length ? 'middle' : 'first' });
      from = c.along;
      fromKey = c.key;
      prev = c;
    }
    out.push({ ...l, xy: slicePolyline(l.xy, from, len), up: fromKey, down: l.down, part: 'last' });
    pieces.set(i, out);
    add('lines.split');
    add('lines.pieces', out.length);
  }

  // 9. ponds and vaults: water entering one leaves by the line that starts at it. Starts with
  // nothing upstream first; else the nearest structure that carries on; else a start a bit farther.
  const nearestStart = (fi: number, r: number, ok: (k: string) => boolean): string | undefined => {
    const f = facs[fi];
    const b = bboxOf(f.ring);
    let best: { k: string; d: number } | undefined;
    for (const k of startIdx.near(f.center, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + r)) {
      if (!ok(k)) continue;
      const d = distanceToPolygons(at(k)!, f.polys);
      if (d <= r && runsAway(k, fi, d) && (!best || d < best.d || (d === best.d && k < best.k))) best = { k, d };
    }
    return best?.k;
  };
  facs.forEach((f, i) => {
    const ins = entering.get(i) ?? [];
    const feeds = new Set(ins.flatMap((k) => [...(upOf.get(k) ?? [])]));
    // never an outlet that feeds the facility's own inflow
    const ok = (k: string) => !ins.includes(k) && !outOf.get(k)!.some((x) => feeds.has(x));
    let outs = (headOut.get(i) ?? []).filter(ok);
    if (!outs.length && ins.length && f.role === 'facility-hold') {
      const k = nearestStart(i, TOL.pondM, (x) => into.has(x) && ok(x)) ?? nearestStart(i, TOL.outletM, (x) => !into.has(x) && ok(x));
      if (k) {
        outs = [k];
        add('facilities.outletFallback');
      }
    }
    // the few ponds that carry their own up/down ids
    const up = key(f.p.UpstreamDBAssetID);
    const down = key(f.p.DownstreamDBAssetID);
    for (const k of ins) link(`${f.id}:in:${k}`, k, f.id, [at(k)!, f.center], enterHow.get(k));
    if (up && at(up) && !ins.includes(up)) link(`${f.id}:in:${up}`, up, f.id, [at(up)!, f.center]);
    if (down && at(down) && !outs.includes(down)) outs.push(down);
    if (f.role === 'facility-hold') for (const k of outs) link(`${f.id}:out:${k}`, f.id, k, [f.center, at(k)!]);
    else if (outs.length) add('facilities.infiltrationOutletLeftOut');
  });

  // 10. no adapter link may close a loop: drop virtual lines inside directed cycles, facility inflows first
  const trustOf = (l: Ln): Trust => {
    const flow = text(l.p.FlowDirection);
    return flow === 'Bi-Directional' || flow === 'Backup' || flow === 'Flip flow direction' ? 'none' : l.up || l.down ? 'id' : 'digitized';
  };
  const fixed: [string, string][] = [];
  lines.forEach((l, i) => {
    if (trustOf(l) !== 'none') for (const x of pieces.get(i) ?? [l]) if (x.up && x.down) fixed.push([x.up, x.down]);
  });
  const rank = (j: number) => (virtual[j].id.includes(':in:') ? 0 : virtual[j].id.includes(':join:') ? 1 : 2);
  const dropped = new Set<number>();
  for (let round = 0; round < 100; round++) {
    const live = virtual.map((v, j) => j).filter((j) => !dropped.has(j));
    const comp = cycles([...fixed, ...live.map((j): [string, string] => [virtual[j].fromId!, virtual[j].toId!])]);
    const pick = new Map<number, number>();
    for (const j of live) {
      const c = comp.get(virtual[j].fromId!);
      if (c === undefined || c !== comp.get(virtual[j].toId!)) continue;
      const cur = pick.get(c);
      if (cur === undefined || rank(j) < rank(cur) || (rank(j) === rank(cur) && virtual[j].id < virtual[cur].id)) pick.set(c, j);
    }
    if (!pick.size) break;
    for (const j of pick.values()) {
      dropped.add(j);
      add('virtual.droppedLoop');
      if (!why[j]) continue;
      add(why[j], -1);
      const k = virtual[j].fromId!;
      if (why[j].startsWith('pads.')) padLeft.add(k);
      else left.add(k);
    }
  }
  const kept = virtual.filter((_, j) => !dropped.has(j));
  const reached = new Set(kept.map((v) => v.toId));
  const drained = new Set(kept.map((v) => v.fromId));
  const passed: string[] = [];
  const endsIn: string[] = [];
  for (const f of facs) {
    if (reached.has(f.id) && drained.has(f.id)) passed.push(f.id);
    else if (reached.has(f.id)) endsIn.push(f.id);
    else if (drained.has(f.id)) add('facilities.outletOnly');
  }
  counts['facilities.passThrough'] = passed.length;
  counts['facilities.endHere'] = endsIn.length;
  const taken = new Set(kept.filter((v) => v.id.includes(':in:')).map((v) => v.fromId!));
  counts['facilities.deadEndsTaken'] = taken.size;

  // dead ends nothing could resolve
  const gaps = read(GAPS.name).features.filter((f) => text(f.properties?.Status) !== 'Complete');
  const gapIdx = new GridIndex<number>(500);
  const gapPolys = gaps.map((f) => parts(f.geometry).map((rings) => rings.map((r) => r.map(xyOf))));
  gapPolys.forEach((g, i) => gapIdx.insert(i, bboxOf(g.flat(2))));
  const inGap = (p: XY) => gapIdx.near(p, 0).some((i) => distanceToPolygons(p, gapPolys[i]) === 0);
  for (const k of left) {
    const roles = into.get(k)!.map((i) => lineRole(lines[i].layer, lines[i].p).role);
    add(roles.some((r) => r === 'stream' || r === 'stream-culvert') ? 'deadEnds.left.liveStream' : inGap(at(k)!) ? 'deadEnds.left.dataGap' : `deadEnds.left.${roles[0]}`);
  }
  // unmapped areas and county roads not mapped yet, for "not mapped yet" reasons
  const unmapped = read(ROADS.name).features.filter((f) => {
    const p = f.properties ?? {};
    return text(p.MappingStatus) === 'Not mapped' && !GONE.has(text(p.CurrentStatus)) && text(p.MS4Present) !== 'No';
  });
  const context: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...gaps.map((f) => ({ type: 'Feature' as const, geometry: f.geometry, properties: { kind: 'data-gap', status: text(f.properties?.Status) } })),
      ...unmapped.map((f) => ({ type: 'Feature' as const, geometry: f.geometry, properties: { kind: 'road-not-mapped' } })),
    ],
  };
  counts['context.dataGaps'] = gaps.length;
  counts['context.roadsNotMapped'] = unmapped.length;

  // 11. assets
  const assets: SourceAsset[] = [];
  const juris = (p: Props) => {
    const j = text(p.Jurisdiction);
    add(j === 'King County' ? 'jurisdiction.unincorporated' : cityNames.has(j) || TOWNS[j] ? 'jurisdiction.city' : 'jurisdiction.other');
  };
  for (const pt of points.values()) {
    const p = pt.p;
    let r: Pick<SourceAsset, 'role' | 'endHint' | 'receivingHint'>;
    if (LINKS.has(pt.layer)) r = linkOut.get(pt.id)!;
    else if (PADS.has(pt.layer)) {
      if (!into.has(pt.id) && !outOf.has(pt.id)) {
        add('pads.unused');
        continue;
      }
      if (outOf.has(pt.id)) add('pads.continues');
      r = padLeft.has(pt.id) ? { role: 'outfall', endHint: 'unknown' } : { role: 'junction' };
    } else if (GROUND_POINTS.has(pt.layer)) r = outOf.has(pt.id) ? { role: 'junction' } : { role: 'discharge', endHint: 'ground' };
    else if (SUMPS.has(pt.layer)) r = { role: text(p.CoverStyle) === 'Solid' ? 'junction' : 'drain' };
    else r = { role: 'junction' };
    if (SUMPS.has(pt.layer) && r.role === 'junction') add('sumps.solidLid');
    juris(p);
    assets.push({ role: r.role, id: pt.id, src: KEY, key: pt.id, coords: [llOf(pt.xy)], trust: 'id', owner: ownerOf(p), endHint: r.endHint, receivingHint: r.receivingHint });
  }
  counts['pads.outfall'] = padLeft.size;
  lines.forEach((l, i) => {
    const p = l.p;
    const trust = trustOf(l);
    juris(p);
    for (const x of pieces.get(i) ?? [l]) {
      assets.push({
        ...lineRole(l.layer, p),
        id: l.id,
        src: KEY,
        fromId: x.up || undefined,
        toId: x.down || undefined,
        coords: x.xy.map(llOf),
        trust,
        owner: ownerOf(p),
        upInv: x.part === 'middle' || x.part === 'last' ? undefined : invert(p.UpstreamElevation),
        downInv: x.part === 'middle' || x.part === 'first' ? undefined : invert(p.DownstreamElevation),
      });
    }
  });
  for (const f of facs) {
    juris(f.p);
    assets.push({ role: f.role, id: f.id, src: KEY, key: f.id, coords: f.ring.map(llOf), trust: 'none', owner: ownerOf(f.p) });
  }
  assets.push(...kept);
  for (const a of assets) add(`role.${a.role}`);
  for (const a of kept) add(a.id.includes(':in:') || a.id.includes(':out:') ? 'virtual.facility' : 'virtual.join');
  counts.assets = assets.length;
  counts.lines = lines.length;
  counts['ends.onNode'] = gap.on;
  counts['ends.within5m'] = gap.near;
  counts['ends.farFromNode'] = gap.far;

  // keys after the joins: does each line end reach a node, does each downstream end lead on
  const carried = new Set(assets.filter((a) => a.key).map((a) => a.key!));
  const named = new Map<string, number>();
  const leads = new Set<string>();
  for (const a of assets) {
    if (a.coords.length < 2 || a.role.startsWith('facility')) continue;
    for (const k of [a.fromId, a.toId]) if (k) named.set(k, (named.get(k) ?? 0) + 1);
    if (a.fromId) leads.add(a.fromId);
  }
  const ending = new Set(assets.filter((a) => a.key && (a.role === 'outfall' || a.role === 'discharge' || a.role.startsWith('facility'))).map((a) => a.key!));
  for (const a of assets) {
    if (a.coords.length < 2 || a.role.startsWith('facility') || a.role === 'virtual') continue;
    for (const k of [a.fromId, a.toId]) add(!k ? 'joined.blank' : carried.has(k) || (named.get(k) ?? 0) > 1 ? 'joined.node' : 'joined.loose');
    if (a.toId) add(leads.has(a.toId) || ending.has(a.toId) ? 'downEnds.leadOn' : a.liveStream || a.perforated ? 'downEnds.soakOrStream' : 'downEnds.stop');
    else add('downEnds.blank');
  }

  // 12. report
  const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(2) : '0.00'}%`;
  const c = (k: string) => counts[k] ?? 0;
  const list = (prefix: string) =>
    Object.keys(counts)
      .filter((k) => k.startsWith(prefix))
      .map((k) => `${k.slice(prefix.length)} ${counts[k]}`)
      .join(', ');
  const ends = 2 * lines.length;
  const keyed = ends - c('ends.blank');
  const resolved = c('ends.point') + c('ends.nodeShared');
  const joinedEnds = c('joined.node') + c('joined.loose') + c('joined.blank');
  const downEnds = c('downEnds.leadOn') + c('downEnds.soakOrStream') + c('downEnds.stop') + c('downEnds.blank');
  const checked = c('direction.checked');
  const how = (tag: string) => `into a facility ${c(`${tag}.intoFacility`)}, to a line start ${c(`${tag}.toLineStart`)}, onto a line partway ${c(`${tag}.ontoLine`)}, to a line end ${c(`${tag}.toLineEnd`)}, to an outfall ${c(`${tag}.toOutfall`)}`;
  const report = [
    `kc-ms4: ${assets.length} assets (${list('role.')})`,
    `  line ends: ${ends}; keyed ${pct(keyed, ends)}; key names a mapped point ${c('ends.point')}, an NDE shared by 2+ lines ${c('ends.nodeShared')}, an NDE named once ${c('ends.nodeLoose')}, a point not found ${c('ends.missing')}, blank ${c('ends.blank')}`,
    `  line ends whose key resolves to a node: as published ${pct(resolved, ends)}; after joins ${pct(c('joined.node'), joinedEnds)} (${c('joined.loose')} loose, ${c('joined.blank')} blank)`,
    `  downstream ends that lead on (a line leaves, or an outfall, discharge or facility): ${pct(c('downEnds.leadOn'), downEnds)}; live stream or perforated line ${c('downEnds.soakOrStream')}; stop ${c('downEnds.stop')}; blank ${c('downEnds.blank')}`,
    `  keyed end vs node position: within ${TOL.onNodeM} m ${gap.on}, ${TOL.onNodeM}-${TOL.flipM} m ${gap.near}, farther ${gap.far}; NDE keys whose lines never meet within ${TOL.onNodeM} m ${c('ends.sharedKeyApart')}`,
    `  drawn direction vs ids: checked ${checked} of ${lines.length} lines, agree ${pct(c('direction.withIds'), checked)}, flipped ${c('direction.againstIds')}, ids far from both ends ${c('direction.idsFar')}, no node to check ${c('direction.unchecked')}`,
    `  flow direction, independent of the ids: lines with a recorded outfall at one end point toward it ${pct(c('direction.towardOutfall'), c('direction.towardOutfall') + c('direction.awayFromOutfall'))} (${c('direction.towardOutfall')} of ${c('direction.towardOutfall') + c('direction.awayFromOutfall')}); inverts fall downstream ${pct(c('direction.invertsFall'), c('direction.invertsFall') + c('direction.invertsRise'))} (${c('direction.invertsFall')} of ${c('direction.invertsFall') + c('direction.invertsRise')})`,
    `  links: ${['water', 'ground', 'treatment', 'handoff', 'unknown', 'junction'].map((k) => `${k} ${c(`links.${k}`)}`).join(', ')}`,
    `  handoffs: ${list('handoff.')}`,
    `  dead ends ${deadEnds.length}: ${how('deadEnds')}; pads ${how('pads')}, left as outfalls ${padLeft.size}`,
    `  dead ends left ${left.size}: ${list('deadEnds.left.')}`,
    `  lines split at joints: ${c('lines.split')} into ${c('lines.pieces')} pieces`,
    `  facilities ${facs.length}: pass-through ${passed.length} (outlet by fallback ${c('facilities.outletFallback')}), water ends inside ${endsIn.length}, outlet only ${c('facilities.outletOnly')}, infiltration outlets left out ${c('facilities.infiltrationOutletLeftOut')}; dead ends taken in ${taken.size}`,
    `  adapter links dropped because they closed a loop: ${c('virtual.droppedLoop')}`,
    `  pads: line continues ${c('pads.continues')}, not on any line (dropped) ${c('pads.unused')}`,
    `  jurisdiction: ${list('jurisdiction.')}`,
  ];

  const notes = [
    `Fetched ${fetchedAt.slice(0, 10)} from ${MS4} (layers ${LAYERS.map((s) => s.url.split('/').pop()).join(', ')}; service credit: WLRD Stormwater Services, Roads Services Division, KCGIS Center); boundary from ${AREAS} (CITYNAME 'King County'). Terms: copy, distribute and use allowed; no sale without written agreement; as is.`,
    'The service publishes only Active and Bond assets; both are kept. Includes county-owned pieces inside cities (Jurisdiction is the city there) and a few assets past the county line; clip by the boundary as needed.',
    'Fields requested by allowlist only. Never requested: staff names (LoadedBy, FieldVisitedBy, LastEditBy, MappedBy, ApprovedBy, AssignedTo), Notes, PlanLink, Location, ContactFirst, AccessCode, KeyNumber, parcels, addresses. Layers 47 (easements), 67, 38 and the complaint layers are never touched.',
    'Node keys are DBAssetIDs. Points carry key = their id; lines carry fromId/toId = UpstreamDBAssetID/DownstreamDBAssetID. NDE-* concept nodes have no point here: join every line end that names the same NDE key.',
    `Lines are oriented up node -> down node using point positions and, for NDE keys, the spot where most lines naming the key end (within ${TOL.onNodeM} m); the flip rule matches src/trace/network.ts. FlowDirection Bi-Directional, Backup or 'Flip flow direction' -> trust 'none'.`,
    "Links (LNK-*): ToFrom Stream/Wetland/Lake/Potential -> outfall 'water'; Marine -> 'water' with receivingHint 'Puget Sound'; Ground/Groundwater -> discharge 'ground'; Sanitary Sewer -> 'treatment'; Jurisdictional -> 'handoff:City of <name>' (link Jurisdiction, else the nearest city within 300 m, else 'another jurisdiction'); Private -> 'handoff:private'; Other Public Agency -> 'handoff:other public agency'; anything else 'unknown'. A link where mapped lines carry on is a junction unless it hands water to a stream, wetland, lake, the ground or the sewer. Inflow links (Into ...) are junctions.",
    "Catch basins with a solid lid are junctions, not drains. Dry wells, injection wells, rock pads and splash blocks with no line leaving are discharges 'ground'. Dispersal, infiltration and sheet-flow trenches are perforated pipes; bioretention swales perforated ditches.",
    `Dead ends (lines arrive, none leave, not an outfall) are joined by the adapter, in this order: into a facility within ${TOL.pondM} m; to another line's start within ${TOL.touchM} m ('<key>:join:<key>' virtual line); onto another line partway within ${TOL.touchM} m (that line is split there and the dead-end key becomes the joint; pieces keep the line's id); into a facility within ${TOL.enterM} m; to an outfall or discharge point within ${TOL.outfallM} m (${TOL.fedOutfallM} m if a line already reaches it). Joins never point back upstream. Virtual joins are trust 'id'.`,
    `Facility polygons carry key = their id (place the node at the polygon). Water reaches one by '<facility>:in:<key>' and leaves a holding facility by '<facility>:out:<key>': to line starts within ${TOL.pondM} m with nothing upstream whose line runs away; failing that, the nearest structure within ${TOL.pondM} m that carries on, then a start within ${TOL.outletM} m. A dead end below a facility's outlet is not sent back into it, and no outlet feeds the facility's own inflow. Infiltration facilities are endings; their outlets are left out. Any adapter link that would close a directed loop is dropped (${c('virtual.droppedLoop')} dropped). Pass-throughs resolved (in and out): ${passed.length} facilities: ${passed.join(' ')}`,
    `Facilities where water ends (in, no mapped way out): ${endsIn.length}: ${endsIn.join(' ')}`,
    `Riprap pads and gabions (FFP-*) that end a line take the same steps with ${TOL.padM} m reach (onto a line farther than ${TOL.touchM} m gets joint key '<line>@<pad>'); with none they are outfalls 'unknown'. Pads on no line are dropped.`,
    'Widths: pipe and tank diameters and box widths are inches, ditch and swale widths feet, converted to meters. Inverts are feet (NAVD 88 or the old KCAS datum, as recorded) converted to meters; only about 280 pipes have them.',
    `gaps.geojson beside this file: ${gaps.length} data-gap polygons not marked Complete (Stormwater_MS4/40, kind 'data-gap') and ${unmapped.length} active county road segments marked Not mapped (Stormwater_MS4/39, kind 'road-not-mapped'), for "King County hasn't mapped this road yet" reasons. Unresolved dead ends inside data gaps: ${c('deadEnds.left.dataGap')}.`,
    `Lines also checked without the ids: ${c('direction.towardOutfall')} of ${c('direction.towardOutfall') + c('direction.awayFromOutfall')} lines with a recorded outfall at one end are drawn toward it; inverts fall downstream on ${c('direction.invertsFall')} of ${c('direction.invertsFall') + c('direction.invertsRise')} lines that have both.`,
    `${c('jurisdiction.city')} assets lie inside cities (Jurisdiction = the city: county-owned systems such as the King County airport, Metro bases, parks and county roads). Clipping to the boundary drops them; the border rule (keep the owner's data, drop a neighbor's copy within 2 m) keeps them where the city maps nothing.`,
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'Unincorporated King County (King County WLRD Stormwater Services MS4 inventory)',
    county: 'King',
    credit: CREDIT,
    disclaimer: DISCLAIMER,
    fetchedAt,
    boundary,
    counts,
    notes,
  };
  return { assets, meta, context, report };
}

export function writeKingCounty(b: Built): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/assets.ndjson.part`, b.assets.map((a) => JSON.stringify(a)).join('\n') + '\n');
  renameSync(`${DIR}/assets.ndjson.part`, `${DIR}/assets.ndjson`);
  writeFileSync(`${DIR}/gaps.geojson`, JSON.stringify(b.context));
  const { boundary, ...rest } = b.meta;
  // readable counts and notes, compact boundary
  const json = JSON.stringify({ ...rest, boundary: '@B' }, null, 1).replace('"@B"', JSON.stringify(boundary));
  writeFileSync(`${DIR}/meta.json`, json + '\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await fetchKingCounty(args.includes('--refresh'));
  if (!args.includes('--fetch-only')) {
    const times = Object.values(readFetchLog().layers).map((l) => l.fetchedAt).sort();
    const built = buildKingCounty(readLayer, times[times.length - 1] ?? new Date().toISOString());
    writeKingCounty(built);
    for (const line of built.report) console.log(line);
    console.log(`  wrote ${DIR}/assets.ndjson, meta.json and gaps.geojson`);
  }
}
