// Streams, lakes, Puget Sound and coho reaches for the downhill walk (Node only).
// Reads the context source's waters-*.ndjson and coho.ndjson when they exist, else Ecology NHD 24k
// and WDFW SWIFD, which it downloads into <cache>/terrain/raw/.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { swifdName } from '../../src/county/waters.ts';
import { ensureLayer } from './arcgis.ts';
import { CONTEXT_DIR, KING_PIERCE_BOX, RAW_DIR } from './config.ts';

export type WaterKind = 'stream' | 'lake' | 'sound';
export type Coho = 'yes' | 'possible' | 'no';
export type Box = readonly [number, number, number, number];

export interface WaterFeature {
  kind: WaterKind;
  name: string;
  src: string;
  /** line parts as [lon, lat, lon, lat, ...] */
  lines?: Float64Array[];
  /** polygons, each a list of rings as [lon, lat, ...] */
  polygons?: Float64Array[][];
  /** lines are drawn downstream */
  directed: boolean;
  box: [number, number, number, number];
}

export interface CohoReach {
  level: 'yes' | 'possible';
  name: string;
  lines: Float64Array[];
  box: [number, number, number, number];
}

const NHD = 'https://gis.ecology.wa.gov/serverext/rest/services/Authoritative/NHD/MapServer';
const SWIFD = 'https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/SWIFD/MapServer/0';

/** NHD flowline types the walk stops at (no pipelines or underground conduits). */
const STREAM_FTYPES = '460,558,336,334';
const COAST_FTYPE = 566;
/** Lakes, ponds and reservoirs; estuaries count as the Sound. */
const LAKE_FTYPES = new Set([390, 436]);
const ESTUARY_FTYPE = 493;
/** NHD areas: wide rivers, and the foreshore along the Sound. */
const RIVER_AREA_FTYPE = 460;
const FORESHORE_FTYPE = 312;
/** Ponds smaller than this aren't receiving waters (as in src/county/waters.ts). */
export const MIN_LAKE_AREA_M2 = 3000;

export const RAW_FILES = {
  flowlines: `${RAW_DIR}/nhd-flowlines.ndjson`,
  waterbodies: `${RAW_DIR}/nhd-waterbodies.ndjson`,
  areas: `${RAW_DIR}/nhd-areas.ndjson`,
  coho: `${RAW_DIR}/swifd-coho.ndjson`,
};

/** Downloads Ecology NHD and WDFW coho reaches for King and Pierce (skips files already there). */
export async function fetchWaters(log: (s: string) => void = console.log): Promise<void> {
  const box = KING_PIERCE_BOX;
  await ensureLayer('NHD flowlines', { url: `${NHD}/3`, fields: ['GNIS_Name', 'FType', 'FlowDir'], where: `FType IN (${STREAM_FTYPES},${COAST_FTYPE})`, box, page: 1000 }, RAW_FILES.flowlines, log);
  await ensureLayer('NHD waterbodies', { url: `${NHD}/6`, fields: ['GNIS_Name', 'FType', 'AreaSqKm'], where: 'FType IN (390,436,493)', box, page: 500 }, RAW_FILES.waterbodies, log);
  await ensureLayer('NHD areas', { url: `${NHD}/5`, fields: ['GNIS_Name', 'FType', 'AreaSqKm'], where: 'FType IN (460,312)', box, page: 100 }, RAW_FILES.areas, log);
  await ensureLayer('SWIFD coho', { url: SWIFD, fields: ['LLID', 'LLID_STRM_NAME', 'DISTTYPE_DESC'], where: "SPECIESRUN = 'Coho'", box, page: 500 }, RAW_FILES.coho, log);
}

/** Documented and presumed coho (also hatchery or trucked) are 'yes'; modeled, potential, historic... 'possible'. */
export function cohoLevel(dist: string): 'yes' | 'possible' {
  return /documented|presumed/i.test(dist) && !/historic/i.test(dist) ? 'yes' : 'possible';
}

const flat = (pts: number[][]): Float64Array => {
  const out = new Float64Array(pts.length * 2);
  pts.forEach((p, i) => {
    out[2 * i] = p[0];
    out[2 * i + 1] = p[1];
  });
  return out;
};

function boxOf(parts: Float64Array[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of parts) {
    for (let i = 0; i + 1 < a.length; i += 2) {
      if (a[i] < b[0]) b[0] = a[i];
      if (a[i + 1] < b[1]) b[1] = a[i + 1];
      if (a[i] > b[2]) b[2] = a[i];
      if (a[i + 1] > b[3]) b[3] = a[i + 1];
    }
  }
  return b;
}

/** Lines and polygons of a GeoJSON geometry, or of bare coordinate fields. */
function shapes(o: any): { lines: Float64Array[]; polygons: Float64Array[][] } {
  const lines: Float64Array[] = [];
  const polygons: Float64Array[][] = [];
  const g = o?.geometry;
  if (g?.type === 'LineString') lines.push(flat(g.coordinates));
  else if (g?.type === 'MultiLineString') for (const l of g.coordinates) lines.push(flat(l));
  else if (g?.type === 'Polygon') polygons.push(g.coordinates.map(flat));
  else if (g?.type === 'MultiPolygon') for (const p of g.coordinates) polygons.push(p.map(flat));
  else if (!g) {
    const p = o?.properties ?? o ?? {};
    if (Array.isArray(p.lines)) for (const l of p.lines) lines.push(flat(l));
    if (Array.isArray(p.polygons)) for (const poly of p.polygons) polygons.push(poly.map(flat));
    if (Array.isArray(p.rings)) polygons.push(p.rings.map(flat));
    if (Array.isArray(p.coords) && p.coords.length > 1) {
      const c = p.coords;
      const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
      if (closed && /lake|pond|reservoir|waterbody|sound|marine/i.test(String(p.kind ?? p.role ?? ''))) polygons.push([flat(c)]);
      else lines.push(flat(c));
    }
  }
  return { lines: lines.filter((l) => l.length >= 4), polygons: polygons.filter((p) => p.length && p[0].length >= 6) };
}

const pick = (p: any, keys: string[]): string => {
  for (const k of keys) {
    const v = p?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/** Square meters of a polygon (outer ring minus holes), near 47 N. */
function areaM2(rings: Float64Array[]): number {
  let total = 0;
  rings.forEach((r, k) => {
    const [lon0, lat0] = [r[0], r[1]];
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ky = 111132;
    let a = 0;
    for (let i = 0; i + 3 < r.length; i += 2) {
      a += (r[i] - lon0) * kx * ((r[i + 3] - lat0) * ky) - (r[i + 2] - lon0) * kx * ((r[i + 1] - lat0) * ky);
    }
    total += k === 0 ? Math.abs(a / 2) : -Math.abs(a / 2);
  });
  return total;
}

async function readLines(file: string, each: (o: any) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) each(JSON.parse(line));
}

const meets = (a: readonly number[], b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Waters and coho reaches with a coarse grid index for picking what's in a window. */
export class WaterSet {
  readonly features: WaterFeature[] = [];
  readonly coho: CohoReach[] = [];
  readonly notes: string[] = [];
  private readonly grid = new Map<string, number[]>();
  private readonly cohoSegs = new CohoIndex();
  private static readonly CELL = 0.02;

  add(f: WaterFeature): void {
    if (!f.lines?.length && !f.polygons?.length) return;
    const i = this.features.length;
    this.features.push(f);
    const C = WaterSet.CELL;
    for (let gx = Math.floor(f.box[0] / C); gx <= Math.floor(f.box[2] / C); gx++) {
      for (let gy = Math.floor(f.box[1] / C); gy <= Math.floor(f.box[3] / C); gy++) {
        const k = `${gx},${gy}`;
        const list = this.grid.get(k);
        if (list) list.push(i);
        else this.grid.set(k, [i]);
      }
    }
  }

  addCoho(c: CohoReach): void {
    if (!c.lines.length) return;
    this.coho.push(c);
    this.cohoSegs.add(this.coho.length - 1, c.lines);
    // coho reaches are streams too
    this.add({ kind: 'stream', name: c.name, src: 'swifd', lines: c.lines, directed: false, box: c.box });
  }

  /** Features whose box meets the lon/lat box. */
  inBox(b: Box): WaterFeature[] {
    const C = WaterSet.CELL;
    const seen = new Set<number>();
    for (let gx = Math.floor(b[0] / C); gx <= Math.floor(b[2] / C); gx++) {
      for (let gy = Math.floor(b[1] / C); gy <= Math.floor(b[3] / C); gy++) {
        for (const i of this.grid.get(`${gx},${gy}`) ?? []) seen.add(i);
      }
    }
    return [...seen]
      .sort((x, y) => x - y)
      .map((i) => this.features[i])
      .filter((f) => f.box[0] <= b[2] && f.box[2] >= b[0] && f.box[1] <= b[3] && f.box[3] >= b[1]);
  }

  /** Best coho reach within m of a point: 'yes' beats 'possible', then the nearest. */
  cohoNear(lon: number, lat: number, m: number): { level: 'yes' | 'possible'; name: string; d: number } | null {
    const hits = this.cohoSegs.near(lon, lat, m);
    let best: { level: 'yes' | 'possible'; name: string; d: number } | null = null;
    for (const [i, d] of hits) {
      const c = this.coho[i];
      if (!best || (c.level === 'yes' && best.level !== 'yes') || (c.level === best.level && d < best.d)) best = { level: c.level, name: c.name, d };
    }
    return best;
  }
}

/** Coho segments in a 50 m grid (local meters around 47.25 N). */
class CohoIndex {
  private static readonly KX = 111320 * Math.cos((47.25 * Math.PI) / 180);
  private static readonly KY = 111132;
  private static readonly CELL = 50;
  private readonly cells = new Map<string, number[]>();
  private readonly segs: number[] = [];

  add(reach: number, lines: Float64Array[]): void {
    const { KX, KY, CELL } = CohoIndex;
    for (const l of lines) {
      for (let i = 0; i + 3 < l.length; i += 2) {
        const s = this.segs.length / 5;
        const x0 = l[i] * KX;
        const y0 = l[i + 1] * KY;
        const x1 = l[i + 2] * KX;
        const y1 = l[i + 3] * KY;
        this.segs.push(reach, x0, y0, x1, y1);
        for (let gx = Math.floor(Math.min(x0, x1) / CELL); gx <= Math.floor(Math.max(x0, x1) / CELL); gx++) {
          for (let gy = Math.floor(Math.min(y0, y1) / CELL); gy <= Math.floor(Math.max(y0, y1) / CELL); gy++) {
            const k = `${gx},${gy}`;
            const list = this.cells.get(k);
            if (list) list.push(s);
            else this.cells.set(k, [s]);
          }
        }
      }
    }
  }

  /** [reach, distance m] of reaches within m. */
  near(lon: number, lat: number, m: number): [number, number][] {
    const { KX, KY, CELL } = CohoIndex;
    const px = lon * KX;
    const py = lat * KY;
    const best = new Map<number, number>();
    for (let gx = Math.floor((px - m) / CELL); gx <= Math.floor((px + m) / CELL); gx++) {
      for (let gy = Math.floor((py - m) / CELL); gy <= Math.floor((py + m) / CELL); gy++) {
        for (const s of this.cells.get(`${gx},${gy}`) ?? []) {
          const o = s * 5;
          const [r, x0, y0, x1, y1] = [this.segs[o], this.segs[o + 1], this.segs[o + 2], this.segs[o + 3], this.segs[o + 4]];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L)) : 0;
          const d = Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
          if (d <= m && d < (best.get(r) ?? Infinity)) best.set(r, d);
        }
      }
    }
    return [...best].sort((a, b) => a[0] - b[0]);
  }
}

/**
 * One water from a context line ({kind, name, type, coords | polygons, covered?, npdes?} or GeoJSON).
 * Leaves out NHD copies of county waters (covered), MS4 storm lines, pipes, wetlands and small ponds.
 */
export function contextWater(o: any): WaterFeature | null {
  const p = o?.properties ?? o ?? {};
  if (p.covered === true) return null;
  const kindRaw = String(p.kind ?? p.role ?? '');
  const type = String(p.type ?? p.FeatureType ?? '');
  if (/pipe|wetland|swamp|marsh|ice|glacier/i.test(kindRaw) || /pipe|aqueduct|flume|sewage|swamp|marsh|ice mass/i.test(type)) return null;
  if (String(p.npdes ?? '').trim().toUpperCase() === 'MS4') return null;
  const { lines, polygons } = shapes(o);
  if (!lines.length && !polygons.length) return null;
  const kind: WaterKind = /marine|sound|coast|estuar|ocean|sea\b/i.test(kindRaw)
    ? 'sound'
    : /lake|pond|reservoir|waterbody/i.test(kindRaw) || (!kindRaw && !lines.length)
      ? 'lake'
      : 'stream';
  if (kind === 'lake') {
    const area = Number(p.areaM2) || polygons.reduce((s, r) => s + areaM2(r), 0);
    if (area < MIN_LAKE_AREA_M2) return null;
  }
  const name = kind === 'sound' ? 'Puget Sound' : pick(p, ['name', 'NAME', 'GNIS_Name', 'gnis_name', 'WTR_NAME', 'FeatureName', 'receivingHint', 'LLID_STRM_NAME']);
  const directed = p.src === 'nhd' && Number(p.flowDir) === 1;
  return { kind, name: swifdName(name), src: String(p.src ?? 'context'), lines, polygons, directed, box: boxOf([...lines, ...polygons.flat()]) };
}

export function contextCoho(o: any): CohoReach | null {
  const p = o?.properties ?? o ?? {};
  const { lines } = shapes(o);
  if (!lines.length) return null;
  const raw = String(p.coho ?? p.level ?? p.DISTTYPE_DESC ?? p.dist ?? p.distType ?? p.status ?? '').trim();
  const level = /^(yes|true)$/i.test(raw) ? 'yes' : cohoLevel(raw);
  const name = swifdName(pick(p, ['name', 'LLID_STRM_NAME', 'GNIS_Name', 'WTR_NAME']));
  return { level, name, lines, box: boxOf(lines) };
}

/** NHD flowline, waterbody or area as a water (null for types the walk ignores). */
export function nhdWater(o: any, layer: 'flowline' | 'waterbody' | 'area'): WaterFeature | null {
  const p = o?.properties ?? {};
  const ftype = Number(p.FType);
  const { lines, polygons } = shapes(o);
  const name = pick(p, ['GNIS_Name']);
  if (layer === 'flowline') {
    if (!lines.length) return null;
    const kind: WaterKind = ftype === COAST_FTYPE ? 'sound' : 'stream';
    return { kind, name: kind === 'sound' ? 'Puget Sound' : name, src: 'nhd', lines, directed: Number(p.FlowDir) === 1, box: boxOf(lines) };
  }
  if (!polygons.length) return null;
  const box = boxOf(polygons.flat());
  if (layer === 'waterbody') {
    if (ftype === ESTUARY_FTYPE) return { kind: 'sound', name: 'Puget Sound', src: 'nhd', polygons, directed: false, box };
    if (!LAKE_FTYPES.has(ftype)) return null;
    const area = Number(p.AreaSqKm) * 1e6 || polygons.reduce((s, r) => s + areaM2(r), 0);
    if (area < MIN_LAKE_AREA_M2) return null;
    return { kind: 'lake', name, src: 'nhd', polygons, directed: false, box };
  }
  if (ftype === RIVER_AREA_FTYPE) return { kind: 'stream', name, src: 'nhd', polygons, directed: false, box };
  if (ftype === FORESHORE_FTYPE) return { kind: 'sound', name: 'Puget Sound', src: 'nhd', polygons, directed: false, box };
  return null;
}

export function swifdCoho(o: any): CohoReach | null {
  const p = o?.properties ?? {};
  const { lines } = shapes(o);
  if (!lines.length) return null;
  return { level: cohoLevel(String(p.DISTTYPE_DESC ?? '')), name: swifdName(String(p.LLID_STRM_NAME ?? '')), lines, box: boxOf(lines) };
}

/**
 * Waters meeting a box: the context source's when present, else NHD + SWIFD (downloaded if missing).
 * `useContext: false` forces NHD.
 */
export async function loadWaters(box: Box, opts: { useContext?: boolean; log?: (s: string) => void } = {}): Promise<WaterSet> {
  const log = opts.log ?? console.log;
  const set = new WaterSet();
  const useCtx = opts.useContext !== false && existsSync(CONTEXT_DIR);
  const ctx = useCtx ? readdirSync(CONTEXT_DIR).filter((f) => /^waters-.*\.ndjson$/.test(f)).sort() : [];
  const ctxCoho = useCtx && existsSync(`${CONTEXT_DIR}/coho.ndjson`);
  if (!ctx.length || !ctxCoho) await fetchWaters(log);
  const keepCoho = (c: CohoReach | null) => {
    if (c && meets(c.box, box)) set.addCoho(c);
  };
  if (ctxCoho) {
    await readLines(`${CONTEXT_DIR}/coho.ndjson`, (o) => keepCoho(contextCoho(o)));
    set.notes.push(`coho: context coho.ndjson (${set.coho.length} reaches)`);
  } else {
    await readLines(RAW_FILES.coho, (o) => keepCoho(swifdCoho(o)));
    set.notes.push(`coho: WDFW SWIFD (${set.coho.length} coho reaches)`);
  }
  const before = set.features.length;
  const keep = (w: WaterFeature | null) => {
    if (w && meets(w.box, box)) set.add(w);
  };
  if (ctx.length) {
    for (const f of ctx) await readLines(`${CONTEXT_DIR}/${f}`, (o) => keep(contextWater(o)));
    set.notes.push(`waters: context ${ctx.join(', ')} (${set.features.length - before} features)`);
  } else {
    for (const [file, layer] of [
      [RAW_FILES.flowlines, 'flowline'],
      [RAW_FILES.waterbodies, 'waterbody'],
      [RAW_FILES.areas, 'area'],
    ] as const) {
      await readLines(file, (o) => keep(nhdWater(o, layer)));
    }
    set.notes.push(`waters: Ecology NHD 24k flowlines, waterbodies and areas (${set.features.length - before} features)`);
  }
  return set;
}
