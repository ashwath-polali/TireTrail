// City of Bellevue storm drains -> <cache>/sources/bellevue/{assets.ndjson,meta.json}.
// Public and private mains name their end structures (FROMMH/TOMH = FACILITYID), so lines join by key.
// The top half is shared with renton.ts and auburn.ts.
// node scripts/sources/bellevue.ts [--refresh] [--box=w,s,e,n]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GridIndex, localProjection, pointInPolygon, type Projection, type XY } from '../../src/geo/geo.ts';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';

// ---------- shared city adapter helpers ----------

export type LonLat = [number, number];
export type Attrs = Record<string, unknown>;
export interface EsriGeometry {
  x?: number;
  y?: number;
  paths?: number[][][];
  rings?: number[][][];
}
export interface EsriFeature {
  attributes: Attrs;
  geometry?: EsriGeometry | null;
}
export interface LayerQuery {
  /** raw file name */
  name: string;
  url: string;
  fields: string[];
  where?: string;
  /** server page size */
  page?: number;
}
export interface RunOptions {
  refresh: boolean;
  /** lon/lat box w,s,e,n: fetch only this part (output goes to <dir>/box/) */
  box?: number[];
  log: (s: string) => void;
}
export interface Built {
  assets: SourceAsset[];
  meta: SourceMeta;
}

export const cacheRoot = (): string => process.env.TT_CACHE ?? '.cache';
export const sourceDir = (key: string): string => `${cacheRoot()}/sources/${key}`;

export const FT = 0.3048;
export const IN = 0.0254;
/** v units of size u in meters, to the mm; undefined when not positive */
export const toM = (v: number, u: number): number | undefined => (v > 0 ? Math.round(v * u * 1000) / 1000 : undefined);

// Fields that can hold people, addresses or free text. Owner fields pass only as category codes.
const PII = /addr|owner|phone|email|contact|parcel|grantor|taxpayer|user|editor|creator|inspector|staff|locdesc|location|note|comment|sitename|easerecno|project|filecode|drawing|microfilm|photo|link|createdby|editedby|updateby/i;
// coded values only (owner category, Auburn's receiving-water code)
const CATEGORY_FIELDS = new Set(['OWNEDBY', 'OWNER', 'OwnedBy', 'OUTLOCATION', 'OWNERSHIP', 'd_Ownership', 'Owner']);

export function checkFields(q: LayerQuery): void {
  for (const f of q.fields) {
    if (PII.test(f) && !CATEGORY_FIELDS.has(f)) throw new Error(`${q.name}: field ${f} looks like personal data`);
  }
}

// at most 4 requests at a time per host
const slots = new Map<string, { busy: number; wait: (() => void)[] }>();
async function withSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  let s = slots.get(host);
  if (!s) slots.set(host, (s = { busy: 0, wait: [] }));
  const slot = s;
  while (slot.busy >= 4) await new Promise<void>((r) => slot.wait.push(r));
  slot.busy++;
  try {
    return await fn();
  } finally {
    slot.busy--;
    slot.wait.shift()?.();
  }
}

export async function getJSON(url: string, params: Record<string, string>): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await withSlot(url, async () => {
        const res = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams(params),
          headers: { 'User-Agent': 'tiretrail-data (student project)' },
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(JSON.stringify(json.error));
        return json;
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

function boxParams(box?: number[]): Record<string, string> {
  if (!box) return {};
  return { geometry: box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
}

/** All features of one layer in lon/lat, by object id chunks. Cached under rawDir. */
export async function fetchLayer(q: LayerQuery, rawDir: string, opts: RunOptions): Promise<EsriFeature[]> {
  checkFields(q);
  const file = `${rawDir}/${q.name}.json`;
  const where = q.where ?? '1=1';
  if (!opts.refresh && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    // same query: reuse
    if (cached.where === where && String(cached.fields) === String(q.fields)) return cached.features;
  }
  const idJson = await getJSON(`${q.url}/query`, { where, ...boxParams(opts.box), returnIdsOnly: 'true', f: 'json' });
  const ids: number[] = (idJson.objectIds ?? []).sort((a: number, b: number) => a - b);
  const size = q.page ?? 1000;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  let done = 0;
  const parts = await Promise.all(
    chunks.map(async (chunk) => {
      const json = await getJSON(`${q.url}/query`, {
        objectIds: chunk.join(','),
        outFields: q.fields.join(','),
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '7',
        f: 'json',
      });
      done++;
      if (done % 10 === 0 || done === chunks.length) opts.log(`  ${q.name}: ${done}/${chunks.length} pages`);
      return (json.features ?? []) as EsriFeature[];
    }),
  );
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${q.name}: got ${features.length} of ${ids.length} features`);
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(`${file}.part`, JSON.stringify({ url: q.url, where, fields: q.fields, box: opts.box, fetchedAt: new Date().toISOString(), features }));
  renameSync(`${file}.part`, file);
  opts.log(`  ${q.name}: ${features.length} features`);
  return features;
}

const TIGER_PLACES = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4';

/** City limits (Census TIGERweb incorporated place, current vintage) as lon/lat polygons. */
export async function fetchBoundary(geoid: string, rawDir: string, opts: RunOptions): Promise<LonLat[][][]> {
  const file = `${rawDir}/boundary.json`;
  let fc: any;
  if (!opts.refresh && existsSync(file)) fc = JSON.parse(readFileSync(file, 'utf8'));
  else {
    fc = await getJSON(`${TIGER_PLACES}/query`, { where: `GEOID='${geoid}'`, outFields: 'GEOID,BASENAME', outSR: '4326', f: 'geojson' });
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(file, JSON.stringify(fc));
  }
  const out: LonLat[][][] = [];
  for (const f of fc.features ?? []) {
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of polys) out.push(p.map((r: number[][]) => r.map((c) => [round7(c[0]), round7(c[1])] as LonLat)));
  }
  if (!out.length) throw new Error(`no boundary for ${geoid}`);
  return out;
}

export const round7 = (v: number): number => Math.round(v * 1e7) / 1e7;
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function pointOf(g?: EsriGeometry | null): LonLat | undefined {
  if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' || !Number.isFinite(g.x)) return undefined;
  return [g.x, g.y];
}

/** Paths joined in order, repeated points dropped. gaps counts path joins more than 1 m apart. */
export function lineOf(g: EsriGeometry | null | undefined, gaps?: { n: number }): LonLat[] | undefined {
  if (!g?.paths?.length) return undefined;
  const out: LonLat[] = [];
  for (const path of g.paths) {
    if (out.length && path.length && gaps && approxM(out[out.length - 1], [path[0][0], path[0][1]]) > 1) gaps.n++;
    for (const c of path) {
      const p: LonLat = [c[0], c[1]];
      const prev = out[out.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
    }
  }
  return out.length >= 2 ? out : undefined;
}

/** Outer rings (clockwise in Esri JSON), largest first. */
export function outerRings(g?: EsriGeometry | null): LonLat[][] {
  const rings = (g?.rings ?? []).filter((r) => r.length >= 4).map((r) => r.map((c) => [c[0], c[1]] as LonLat));
  const area = (r: LonLat[]) => {
    let s = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return s / 2;
  };
  // positive = clockwise for this sum
  const outers = rings.filter((r) => area(r) > 0);
  return (outers.length ? outers : rings).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}

const KM_PER_DEG = 111.2;
/** Meters between two lon/lat points (fine at city scale). */
export function approxM(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * KM_PER_DEG * 1000;
}

export interface NodeRef {
  key: string;
  at: LonLat;
}

/** Point nodes by source id; repeated ids get #2, #3 keys, and a line end picks the nearest one. */
export class NodeIndex {
  readonly byId = new Map<string, NodeRef[]>();
  readonly keys = new Set<string>();
  private readonly proj: Projection;
  private readonly grid = new GridIndex<NodeRef>(25);

  constructor(origin: LonLat) {
    this.proj = localProjection(origin);
  }

  add(id: string, at: LonLat): string {
    const list = this.byId.get(id) ?? [];
    const key = list.length ? `${id}#${list.length + 1}` : id;
    const ref = { key, at };
    list.push(ref);
    this.byId.set(id, list);
    this.keys.add(key);
    this.grid.insertPoint(ref, this.proj.toXY(at));
    return key;
  }

  /** Node with this id nearest to either end, and its distance to each end. */
  resolve(id: string, first: LonLat, last: LonLat): { ref: NodeRef; dFirst: number; dLast: number } | undefined {
    const list = this.byId.get(id);
    if (!list) return undefined;
    let best: { ref: NodeRef; dFirst: number; dLast: number } | undefined;
    for (const ref of list) {
      const dFirst = approxM(ref.at, first);
      const dLast = approxM(ref.at, last);
      if (!best || Math.min(dFirst, dLast) < Math.min(best.dFirst, best.dLast)) best = { ref, dFirst, dLast };
    }
    return best;
  }

  /** Nearest node within r meters of p. */
  nearest(p: LonLat, r: number): { ref: NodeRef; d: number } | undefined {
    let best: { ref: NodeRef; d: number } | undefined;
    for (const ref of this.grid.near(this.proj.toXY(p), r)) {
      const d = approxM(ref.at, p);
      if (d <= r && (!best || d < best.d)) best = { ref, d };
    }
    return best;
  }
}

export interface Ends {
  /** keyed ends */
  keyed: number;
  /** keyed ends that name a point of this source */
  resolved: number;
  /** resolved ends within 2 m of the line end */
  near2: number;
  /** keys dropped: the named point is far from the line */
  far: number;
}
export const newEnds = (): Ends => ({ keyed: 0, resolved: 0, near2: 0, far: 0 });

/** Keys farther than this from the line are treated as wrong and dropped. */
export const FAR_KEY_M = 30;

export interface Oriented {
  coords: LonLat[];
  reversed: boolean;
  fromId?: string;
  toId?: string;
}

/**
 * Orients a line so it runs from the node named upId to the node named downId.
 * Unresolved keys are kept as is (lines naming the same missing node still join); far ones are dropped.
 */
export function orientByKeys(nodes: NodeIndex, line: LonLat[], upId: string, downId: string, ends: Ends): Oriented {
  const first = line[0];
  const last = line[line.length - 1];
  let keep = 0;
  let flip = 0;
  const pick = (id: string, isUp: boolean): string | undefined => {
    if (!id) return undefined;
    ends.keyed++;
    const r = nodes.resolve(id, first, last);
    if (!r) return id;
    if (Math.min(r.dFirst, r.dLast) > FAR_KEY_M) {
      ends.far++;
      return undefined;
    }
    ends.resolved++;
    if (Math.min(r.dFirst, r.dLast) <= 2) ends.near2++;
    keep += isUp ? r.dFirst : r.dLast;
    flip += isUp ? r.dLast : r.dFirst;
    return r.ref.key;
  };
  const fromId = pick(upId, true);
  const toId = pick(downId, false);
  const reversed = flip + 0.5 < keep;
  return { coords: reversed ? [...line].reverse() : line, reversed, fromId, toId };
}

/**
 * Keys that name no point: an end within 1.5 m of a point takes that point's key; a key named by
 * one end only is dropped so the end can snap by geometry; the rest stay as shared virtual nodes.
 */
export function settleKeys(assets: SourceAsset[], nodes: NodeIndex, extra: Record<string, number>): void {
  const named = new Map<string, number>();
  for (const a of assets) {
    if (a.fromId && !nodes.keys.has(a.fromId)) named.set(a.fromId, (named.get(a.fromId) ?? 0) + 1);
    if (a.toId && !nodes.keys.has(a.toId)) named.set(a.toId, (named.get(a.toId) ?? 0) + 1);
  }
  let aliased = 0;
  let virtual = 0;
  let dropped = 0;
  const settle = (k: string | undefined, end: LonLat): string | undefined => {
    if (!k || nodes.keys.has(k)) return k;
    const near = nodes.nearest(end, 1.5);
    if (near) {
      aliased++;
      return near.ref.key;
    }
    if ((named.get(k) ?? 0) >= 2) {
      virtual++;
      return k;
    }
    dropped++;
    return undefined;
  };
  for (const a of assets) {
    if (!a.fromId && !a.toId) continue;
    a.fromId = settle(a.fromId, a.coords[0]);
    a.toId = settle(a.toId, a.coords[a.coords.length - 1]);
    if (!a.fromId) delete a.fromId;
    if (!a.toId) delete a.toId;
  }
  extra['keys.unresolvedToNearPoint'] = aliased;
  extra['keys.unresolvedShared'] = virtual;
  extra['keys.unresolvedDropped'] = dropped;
}

/** Invert pair in feet at the first and last vertex: 1 = drawn downhill, -1 = uphill, 0 = unknown or flat. */
export function invertSign(first: number, last: number): number {
  if (!(first > 0) || !(last > 0) || Math.abs(first - last) < 0.01) return 0;
  return first > last ? 1 : -1;
}

/** Drawn-downhill share of lines whose inverts differ: [downhill, uphill]. */
export function drawnShare(signs: number[]): { down: number; up: number; share: number } {
  let down = 0;
  let up = 0;
  for (const s of signs) {
    if (s > 0) down++;
    else if (s < 0) up++;
  }
  return { down, up, share: down + up ? down / (down + up) : 0 };
}

/** Lines are trusted as drawn when at least this share of lines with inverts run downhill as drawn. */
export const DRAWN_OK = 0.85;

export function isMain(url: string): boolean {
  return !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}

export function parseArgs(log: (s: string) => void = console.log): RunOptions {
  const args = process.argv.slice(2);
  const box = args.find((a) => a.startsWith('--box='))?.slice(6).split(',').map(Number);
  if (box && (box.length !== 4 || box.some((v) => !Number.isFinite(v)))) throw new Error('--box=w,s,e,n');
  return { refresh: args.includes('--refresh'), box, log };
}

/** raw/ for a full run, raw/box-<w_s_e_n>/ for a box */
export function rawDirFor(key: string, opts: RunOptions): string {
  return opts.box ? `${sourceDir(key)}/raw/box-${opts.box.join('_')}` : `${sourceDir(key)}/raw`;
}

export function outDirFor(key: string, opts: RunOptions): string {
  return opts.box ? `${sourceDir(key)}/box` : sourceDir(key);
}

function roundCoords(a: SourceAsset): SourceAsset {
  return { ...a, coords: a.coords.map((c) => [round7(c[0]), round7(c[1])] as [number, number]) };
}

export function writeSource(dir: string, built: Built): void {
  mkdirSync(dir, { recursive: true });
  const body = built.assets.map((a) => JSON.stringify(roundCoords(a))).join('\n') + '\n';
  writeFileSync(`${dir}/assets.ndjson.part`, body);
  renameSync(`${dir}/assets.ndjson.part`, `${dir}/assets.ndjson`);
  writeFileSync(`${dir}/meta.json`, JSON.stringify(built.meta, null, 1) + '\n');
}

const LINE_ROLES = new Set<Role>(['pipe', 'ditch', 'culvert', 'stream-culvert', 'virtual', 'stream']);
export const isLine = (a: SourceAsset): boolean => LINE_ROLES.has(a.role);

/** Counts for meta.json: roles, trust, owner, end hints, keyed ends, assets outside the city. */
export function summarize(assets: SourceAsset[], boundary: LonLat[][][], ends: Ends, extra: Record<string, number>): Record<string, number> {
  const c: Record<string, number> = { assets: assets.length };
  const inc = (k: string) => (c[k] = (c[k] ?? 0) + 1);
  const proj = localProjection(boundary[0][0][0]);
  const polys = boundary.map((p) => p.map((r) => r.map((q) => proj.toXY(q))));
  const inside = (p: LonLat) => {
    const xy: XY = proj.toXY(p);
    return polys.some((rings) => pointInPolygon(xy, rings));
  };
  const pointKeys = new Set<string>();
  for (const a of assets) if (a.key) pointKeys.add(a.key);
  let keyedLineEnds = 0;
  let pointLineEnds = 0;
  let lineEnds = 0;
  for (const a of assets) {
    inc(`role.${a.role}`);
    if (isLine(a)) {
      inc(`trust.${a.trust}`);
      lineEnds += 2;
      for (const k of [a.fromId, a.toId]) {
        if (!k) continue;
        keyedLineEnds++;
        if (pointKeys.has(k)) pointLineEnds++;
      }
    }
    if (a.owner) inc(`owner.${a.owner}`);
    if (a.endHint) inc(`endHint.${a.endHint}`);
    if (!inside(a.coords[0])) inc('outsideCity');
  }
  c['lineEnds'] = lineEnds;
  c['lineEnds.withKey'] = keyedLineEnds;
  c['lineEnds.keyIsPoint'] = pointLineEnds;
  c['keys.named'] = ends.keyed;
  c['keys.resolved'] = ends.resolved;
  c['keys.within2m'] = ends.near2;
  c['keys.droppedFar'] = ends.far;
  return { ...c, ...extra };
}

export async function runCli(key: string, build: (opts: RunOptions) => Promise<Built>): Promise<void> {
  const opts = parseArgs();
  const t0 = performance.now();
  const built = await build(opts);
  const dir = outDirFor(key, opts);
  writeSource(dir, built);
  const c = built.meta.counts;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  opts.log(`${key}: ${built.assets.length} assets -> ${dir} (${Math.round(performance.now() - t0)} ms)`);
  opts.log(
    `  roles ${Object.entries(c)
      .filter(([k]) => k.startsWith('role.'))
      .map(([k, v]) => `${k.slice(5)} ${v}`)
      .join(', ')}`,
  );
  opts.log(
    `  trust ${Object.entries(c)
      .filter(([k]) => k.startsWith('trust.'))
      .map(([k, v]) => `${k.slice(6)} ${v}`)
      .join(', ')}`,
  );
  opts.log(`  keys named ${c['keys.named'] ?? 0}, resolved ${pct(c['keys.resolved'] ?? 0, c['keys.named'] ?? 0)}, within 2 m ${pct(c['keys.within2m'] ?? 0, c['keys.resolved'] ?? 0)}`);
  opts.log(`  line ends ${c.lineEnds}: with a key ${pct(c['lineEnds.withKey'], c.lineEnds)}, key names a point ${pct(c['lineEnds.keyIsPoint'], c['lineEnds.withKey'])}`);
  for (const n of built.meta.notes) opts.log(`  - ${n}`);
}

// ---------- Bellevue ----------

const KEY = 'bellevue';
const PUB = 'https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Utilities_Storm_Sewer_System/FeatureServer';
const PVT = 'https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Private_Storm_Sewer_System/FeatureServer';
const GEOID = '5305210';
const OPERATING = "Status = 'Operating' OR Status IS NULL";

const MAIN_FIELDS = ['OBJECTID', 'FACILITYID', 'DIAMETER', 'UPELEV', 'DOWNELEV', 'FROMMH', 'TOMH', 'OWNEDBY', 'STREAMFLAG', 'PIPETYPE', 'Status'];
const layers = {
  mains: { name: 'mains', url: `${PUB}/17`, fields: MAIN_FIELDS, where: OPERATING },
  detentionPipes: { name: 'detention-pipes', url: `${PUB}/6`, fields: MAIN_FIELDS, where: OPERATING },
  culverts: { name: 'culverts', url: `${PUB}/10`, fields: ['OBJECTID', 'FACILITYID', 'DIAMETER', 'UPELEV', 'DOWNELEV', 'STREAMFLAG', 'OWNEDBY', 'Status'], where: OPERATING },
  openDrains: { name: 'open-drains', url: `${PUB}/16`, fields: ['OBJECTID', 'FACILITYID', 'ODTYPE', 'TOPWIDTH', 'UPELEV', 'DOWNELEV', 'OWNEDBY', 'Status'], where: OPERATING },
  structures: { name: 'structures', url: `${PUB}/5`, fields: ['OBJECTID', 'FACILITYID', 'DSTYPE', 'CVTYPE', 'INVERTELEV', 'RIMELEV', 'OWNEDBY', 'Status'], where: OPERATING },
  inlets: { name: 'inlets', url: `${PUB}/12`, fields: ['OBJECTID', 'FACILITYID', 'INLETTYPE', 'OWNEDBY', 'Status'], where: OPERATING },
  discharge: { name: 'discharge', url: `${PUB}/3`, fields: ['OBJECTID', 'FACILITYID', 'DISCHRGTYP', 'OWNEDBY', 'Status'], where: OPERATING },
  network: { name: 'network', url: `${PUB}/14`, fields: ['OBJECTID', 'FACILITYID', 'STRUCTTYPE', 'UNDERDRAIN', 'OWNEDBY', 'Status'], where: OPERATING },
  networkWq: { name: 'network-wq', url: `${PUB}/15`, fields: ['OBJECTID', 'FACILITYID', 'STRUCTTYPE', 'UNDERDRAIN', 'OWNEDBY', 'Status'], where: OPERATING },
  fittings: { name: 'fittings', url: `${PUB}/4`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY'] },
  access: { name: 'access', url: `${PUB}/0`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY'] },
  cleanouts: { name: 'cleanouts', url: `${PUB}/8`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY', 'Status'], where: OPERATING },
  weirs: { name: 'weirs', url: `${PUB}/19`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY'] },
  outlines: { name: 'outlines', url: `${PUB}/2`, fields: ['OBJECTID', 'FACILITYID', 'DETENTIONTYPE', 'OWNEDBY'] },
  pMains: { name: 'private-mains', url: `${PVT}/27`, fields: MAIN_FIELDS, where: OPERATING },
  pDetentionPipes: { name: 'private-detention-pipes', url: `${PVT}/30`, fields: MAIN_FIELDS, where: OPERATING },
  pOpenDrains: { name: 'private-open-drains', url: `${PVT}/25`, fields: ['OBJECTID', 'FACILITYID', 'ODTYPE', 'TOPWIDTH', 'UPELEV', 'DOWNELEV', 'OWNEDBY', 'Status'], where: OPERATING },
  pLaterals: { name: 'private-laterals', url: `${PVT}/28`, fields: ['OBJECTID', 'FACILITYID', 'DIAMETER', 'UPELEV', 'DOWNELEV', 'OWNEDBY'] },
  pStructures: { name: 'private-structures', url: `${PVT}/26`, fields: ['OBJECTID', 'FACILITYID', 'DSTYPE', 'CVTYPE', 'INVERTELEV', 'RIMELEV', 'OWNEDBY', 'Status'], where: OPERATING },
  pInlets: { name: 'private-inlets', url: `${PVT}/23`, fields: ['OBJECTID', 'FACILITYID', 'INLETTYPE', 'OWNEDBY', 'Status'], where: OPERATING },
  pDischarge: { name: 'private-discharge', url: `${PVT}/20`, fields: ['OBJECTID', 'FACILITYID', 'DISCHRGTYP', 'OWNEDBY', 'Status'], where: OPERATING },
  pNetwork: { name: 'private-network', url: `${PVT}/24`, fields: ['OBJECTID', 'FACILITYID', 'STRUCTTYPE', 'UNDERDRAIN', 'OWNEDBY', 'Status'], where: OPERATING },
  pCleanouts: { name: 'private-cleanouts', url: `${PVT}/21`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY', 'Status'], where: OPERATING },
  pAccess: { name: 'private-access', url: `${PVT}/22`, fields: ['OBJECTID', 'FACILITYID', 'OWNEDBY'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const CITY_OWNERS = new Set(['BELLEVUE', 'PARKS']);
function bellevueOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v).toUpperCase();
  if (!s) return undefined;
  if (CITY_OWNERS.has(s)) return 'public';
  if (s === 'PRIVATE') return 'private';
  return 'other';
}

const solidLid = (cv: unknown) => str(cv).startsWith('Solid');
const INFILTRATING_OUTLINES = new Set(['BCEL', 'BPI', 'BPOND', 'DW', 'IT', 'PPS', 'RG']);
const BIORETENTION = new Set(['BCEL', 'RG', 'BPLTR']);
const PERFORATED_TYPES = new Set(['UNDER', 'FOOT']);

export async function buildBellevue(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`bellevue ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.15, 47.6]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.FACILITYID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const seenPoint = new Set<string>();

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    // layers 14 and 15 overlap
    const dupe = `${id}@${at[0]},${at[1]}`;
    if (seenPoint.has(dupe)) return inc('skipped.duplicate');
    seenPoint.add(dupe);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: bellevueOwner(f.attributes.OWNEDBY), ...more });
  };

  // points first, so lines can look up their end keys
  for (const layer of ['structures', 'pStructures'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const t = str(a.DSTYPE);
      const grate = !solidLid(a.CVTYPE);
      if (t === 'CB' || t === 'CB2' || t === 'IN') point(layer, f, grate ? 'drain' : 'junction');
      else if (t === 'UIC') point(layer, f, grate ? 'drain' : 'junction', { openBottom: true });
      else point(layer, f, 'junction');
    }
  }
  for (const layer of ['inlets', 'pInlets'] as const) {
    for (const f of L[layer]) {
      const t = str(f.attributes.INLETTYPE);
      // trash-rack, energy-dissipator and overflow inlets take ditch or pond water, not street water
      point(layer, f, t === 'Inlet with Trash Rack' || t === 'Inlet with Energy Dissipator' || t === 'Overflow' ? 'junction' : 'drain');
    }
  }
  for (const layer of ['discharge', 'pDischarge'] as const) {
    for (const f of L[layer]) {
      const t = str(f.attributes.DISCHRGTYP);
      if (t === 'Outfall to Stream') point(layer, f, 'outfall', { endHint: 'water', receivingHint: 'stream' });
      else if (t === 'Outfall to Lake') point(layer, f, 'outfall', { endHint: 'water', receivingHint: 'lake' });
      else if (t === 'Outfall to Pond') point(layer, f, 'outfall', { endHint: 'unknown', receivingHint: 'pond' });
      else point(layer, f, 'outfall', { endHint: 'unknown' });
    }
  }
  for (const layer of ['network', 'networkWq', 'pNetwork'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const t = str(a.STRUCTTYPE);
      if (BIORETENTION.has(t)) point(layer, f, str(a.UNDERDRAIN) === 'Yes' ? 'facility-hold' : 'facility-infiltrate');
      else if (t === 'DP' || t === 'DV') point(layer, f, 'facility-hold');
      else point(layer, f, 'junction');
    }
  }
  for (const layer of ['fittings', 'access', 'cleanouts', 'weirs', 'pCleanouts', 'pAccess'] as const) {
    for (const f of L[layer]) point(layer, f, 'junction');
  }
  for (const f of L.outlines) {
    const a = f.attributes;
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const role: Role = INFILTRATING_OUTLINES.has(str(a.DETENTIONTYPE)) ? 'facility-infiltrate' : 'facility-hold';
    for (const ring of rings) assets.push({ role, id: idOf('outlines', a), src: KEY, coords: ring, trust: 'none', owner: bellevueOwner(a.OWNEDBY) });
  }

  // lines
  const gaps = { n: 0 };
  // per layer: drawn-downhill signs of lines that have inverts, to judge the ones that don't
  // keyed mains show that inverts against the drawing are mostly wrong values (see keyed.invertsDisagree)
  const pending: { layer: string; asset: SourceAsset; contrary: boolean }[] = [];
  const signs = new Map<string, number[]>();
  // keyed mains: does the key order agree with the inverts?
  let idInvAgree = 0;
  let idInvDisagree = 0;

  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset>) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const up = num(a.UPELEV);
    const down = num(a.DOWNELEV);
    const base: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: bellevueOwner(a.OWNEDBY), ...more };
    const fromMh = str(a.FROMMH);
    const toMh = str(a.TOMH);
    if (fromMh || toMh) {
      const o = orientByKeys(nodes, coords, fromMh, toMh, ends);
      if (o.reversed) inc('lines.reversedToKeys');
      const s = invertSign(up, down);
      if (s > 0) idInvAgree++;
      else if (s < 0) idInvDisagree++;
      assets.push({ ...base, coords: o.coords, fromId: o.fromId, toId: o.toId, trust: 'id', ...invs(up, down) });
      return;
    }
    // UPELEV/DOWNELEV taken as the inverts at the first/last vertex
    const s = invertSign(up, down);
    const list = signs.get(layer) ?? [];
    list.push(s);
    signs.set(layer, list);
    if (s > 0) {
      assets.push({ ...base, trust: 'inverts', ...invs(up, down) });
      return;
    }
    // no inverts, or inverts against the drawing: decided per layer below
    const asset = { ...base, ...invs(up, down) };
    assets.push(asset);
    pending.push({ layer, asset, contrary: s < 0 });
  };

  for (const layer of ['mains', 'pMains', 'detentionPipes', 'pDetentionPipes'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const stream = str(a.STREAMFLAG) === 'Yes';
      line(layer, f, stream ? 'stream-culvert' : 'pipe', {
        width: toM(num(a.DIAMETER), IN),
        perforated: PERFORATED_TYPES.has(str(a.PIPETYPE)) || undefined,
        liveStream: stream || undefined,
      });
    }
  }
  for (const f of L.culverts) {
    const a = f.attributes;
    const stream = str(a.STREAMFLAG) === 'Yes';
    line('culverts', f, stream ? 'stream-culvert' : 'culvert', { width: toM(num(a.DIAMETER), IN), liveStream: stream || undefined });
  }
  for (const layer of ['openDrains', 'pOpenDrains'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const stream = str(a.ODTYPE) === 'STREAM';
      line(layer, f, stream ? 'stream' : 'ditch', { width: toM(num(a.TOPWIDTH), FT), liveStream: stream || undefined });
    }
  }
  for (const f of L.pLaterals) line('pLaterals', f, 'pipe', { width: toM(num(f.attributes.DIAMETER), IN) });

  // lines without keys or inverts: trust the drawn order where the layer's inverts mostly agree with it
  const notes: string[] = [];
  for (const [layer, list] of signs) {
    const d = drawnShare(list);
    const ok = d.down + d.up >= 20 && d.share >= DRAWN_OK;
    extra[`drawn.${layer}.downhill`] = d.down;
    extra[`drawn.${layer}.uphill`] = d.up;
    notes.push(
      `${layer}: ${d.down}/${d.down + d.up} lines with inverts drawn downhill (${(100 * d.share).toFixed(1)}%); the ${list.filter((s) => s === 0).length} without are ${ok ? "'digitized'" : "'none'"}, the ${d.up} drawn uphill are ${ok ? "kept as drawn ('digitized')" : "reversed ('inverts')"}`,
    );
    for (const p of pending) {
      if (p.layer !== layer) continue;
      const a = p.asset;
      if (ok) a.trust = 'digitized';
      else if (p.contrary) {
        a.coords = [...a.coords].reverse();
        [a.upInv, a.downInv] = [a.downInv, a.upInv];
        a.trust = 'inverts';
        inc('lines.reversedToInverts');
      }
    }
  }
  settleKeys(assets, nodes, extra);
  extra['keyed.invertsAgree'] = idInvAgree;
  extra['keyed.invertsDisagree'] = idInvDisagree;
  extra['lines.pathGaps'] = gaps.n;
  notes.unshift(
    `Keyed mains: FROMMH -> TOMH is the flow order; inverts agree on ${idInvAgree} and disagree on ${idInvDisagree} (kept as keyed)`,
    'owner: public = City of Bellevue (incl. Parks), private = PRIVATE, other = WSDOT, King County, neighboring cities and districts',
    'Dropped: SITEADDRESS, ADDR, LOCDESC, EASERECNO, staff and free-text fields (never requested); pressure mains, casings and Drainage Sites not used',
    "Discharge points other than 'Outfall to Stream/Lake' are outfalls with endHint 'unknown' (pond, standard outlet, overflow, unset)",
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Bellevue',
    county: 'King',
    credit: 'Storm drain data: City of Bellevue GIS, provided as is.',
    disclaimer: 'City of Bellevue data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

function invs(up: number, down: number): Pick<SourceAsset, 'upInv' | 'downInv'> {
  const out: Pick<SourceAsset, 'upInv' | 'downInv'> = {};
  if (up > 0) out.upInv = Math.round(up * FT * 1000) / 1000;
  if (down > 0) out.downInv = Math.round(down * FT * 1000) / 1000;
  return out;
}

/** Oldest raw download time in a raw folder. */
export function fetchedAt(rawDir: string): string {
  let oldest = '';
  for (const f of existsSync(rawDir) ? readdirSync(rawDir) : []) {
    if (!f.endsWith('.json') || f === 'boundary.json') continue;
    const head = readFileSync(`${rawDir}/${f}`, 'utf8').slice(0, 4000);
    const m = /"fetchedAt":"([^"]+)"/.exec(head);
    if (m && (!oldest || m[1] < oldest)) oldest = m[1];
  }
  return oldest || new Date().toISOString();
}

if (isMain(import.meta.url)) await runCli(KEY, buildBellevue);
