// Writes public/data/state/watersheds.json: the HUC-12 watersheds touching Washington, for the tap card where a
// city's pipe map isn't in TireTrail. Run: npm run build:watersheds (after build:salmon, whose files it reads).
// Source: USGS Watershed Boundary Dataset (public domain), hydro.nationalmap.gov wbd MapServer layer 6 (HUC12),
// fetched once into TT_CACHE/watersheds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { Region } from '../src/app/map/region.ts';
import { mainStream, type RawWatersheds } from '../src/app/map/watersheds.ts';
import { pointInPolygon, type LngLat, type XY } from '../src/geo/geo.ts';
import { readTile, type RawIndex } from '../src/salmon/tiles.ts';
import { project } from './lib/lcc.ts';

const CACHE = `${process.env.TT_CACHE ?? '.cache'}/watersheds`;
const OUT = 'public/data/state/watersheds.json';
const SALMON = 'public/data/salmon';
const WBD = 'https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/6/query';
const WHERE = "states LIKE '%WA%'";
const PAGE = 50;
/** borders thinned to this, m (Douglas-Peucker), then stored in steps of Q m */
const TOL = 25;
const Q = 5;
/** over this, only the King and Pierce region */
const MAX_BYTES = 1.5e6;
/** a stream counts as the watershed's when this much of it is inside, m */
const STREAM_M = 200;

/** one watershed as fetched: Web Mercator rings (the service's own coordinates, so shared borders match exactly) */
export interface Fetched { huc12: string; name: string; states: string; rings: number[][][]; loose?: boolean }

async function getJson(url: string, tries = 3): Promise<any> {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j;
    } catch (e) {
      if (k >= tries) throw e;
      await new Promise((r) => setTimeout(r, 3000 * k));
    }
  }
}

/** Every HUC-12 touching Washington, full detail, from the cache or the service. */
export async function fetchAll(): Promise<Fetched[]> {
  mkdirSync(CACHE, { recursive: true });
  const count = (await getJson(`${WBD}?${new URLSearchParams({ where: WHERE, returnCountOnly: 'true', f: 'json' })}`)).count as number;
  const offsets: number[] = [];
  for (let o = 0; o < count; o += PAGE) offsets.push(o);
  let done = 0;
  // the service sometimes fails a page of big coastal shapes, so a failed page comes in smaller ones; the open water
  // of Puget Sound and Hood Canal only comes thinned to 1 m, so those don't share border points with their neighbors
  const some = async (o: number, n: number, thin = false): Promise<Fetched[]> => {
    const q = new URLSearchParams({ where: WHERE, outFields: 'huc12,name,states', returnGeometry: 'true', outSR: '102100',
      orderByFields: 'objectid', resultOffset: String(o), resultRecordCount: String(n), f: 'json', ...(thin ? { maxAllowableOffset: '1' } : {}) });
    try {
      const j = await getJson(`${WBD}?${q}`, n === 1 ? 3 : 1);
      const got: Fetched[] = (j.features ?? []).map((f: any) => ({
        huc12: f.attributes.huc12, name: f.attributes.name ?? '', states: f.attributes.states ?? '', rings: f.geometry?.rings ?? [], ...(thin ? { loose: true } : {}),
      }));
      if (got.length !== n) throw new Error(`page ${o}: ${got.length} of ${n} watersheds`);
      return got;
    } catch (e) {
      if (n === 1) { if (thin) throw e; return some(o, 1, true); }
      const out: Fetched[] = [], step = Math.max(1, Math.floor(n / 5));
      for (let k = 0; k < n; k += step) out.push(...(await some(o + k, Math.min(step, n - k))));
      return out;
    }
  };
  const page = async (o: number): Promise<Fetched[]> => {
    const file = `${CACHE}/huc12-${o}.json`;
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(await some(o, Math.min(PAGE, count - o))));
    process.stdout.write(`\rWBD ${++done}/${offsets.length} pages`);
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  const out: Fetched[] = [];
  for (let k = 0; k < offsets.length; k += 4) for (const p of await Promise.all(offsets.slice(k, k + 4).map(page))) out.push(...p);
  console.log(`, ${out.length} watersheds`);
  if (new Set(out.map((f) => f.huc12)).size !== count) throw new Error('missing or repeated watersheds');
  return out;
}

// ---------- shared borders ----------

/** points once each (x, y pairs), arcs between junctions as point numbers, and each shape's rings as arc numbers (~n backward) */
export interface Topo { xy: Float64Array; arcs: Int32Array[]; shapes: number[][][] }

/** Point numbers by exact coordinates, in an open-addressing table. */
class PointIds {
  private readonly mask: number;
  private readonly kx: Float64Array;
  private readonly ky: Float64Array;
  private readonly id: Int32Array;
  private readonly f = new Float64Array(2);
  private readonly u = new Uint32Array(this.f.buffer);
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  constructor(most: number) {
    let cap = 1024;
    while (cap < most * 1.6) cap *= 2;
    [this.mask, this.kx, this.ky, this.id] = [cap - 1, new Float64Array(cap), new Float64Array(cap), new Int32Array(cap).fill(-1)];
  }
  get(x: number, y: number): number {
    [this.f[0], this.f[1]] = [x, y];
    let h = (Math.imul(this.u[0] ^ this.u[1], 0x9e3779b1) ^ Math.imul(this.u[2] ^ this.u[3], 0x85ebca6b)) >>> 0;
    h = (h ^ (h >>> 15)) & this.mask;
    for (; this.id[h] >= 0; h = (h + 1) & this.mask) if (this.kx[h] === x && this.ky[h] === y) return this.id[h];
    [this.kx[h], this.ky[h], this.id[h]] = [x, y, this.xs.length];
    this.xs.push(x);
    this.ys.push(y);
    return this.id[h];
  }
}

/**
 * Cuts the rings where three or more meet (or where a ring stops following its neighbor), so each border is one arc
 * that both sides use. A loose shape's rings stay whole arcs of their own. proj: source x, y to map meters.
 */
export function topology(shapes: { rings: number[][][]; loose?: boolean }[], proj: (x: number, y: number) => XY): Topo {
  const ids = new PointIds(shapes.reduce((n, s) => n + s.rings.reduce((m, r) => m + r.length, 0), 0));
  const rings = shapes.map((s) => s.rings.map((r) => {
    const out: number[] = [];
    for (const p of r) { const i = ids.get(p[0], p[1]); if (out[out.length - 1] !== i) out.push(i); }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  }).filter((r) => r.length >= 3));
  const N = ids.xs.length, n1 = new Int32Array(N).fill(-1), n2 = new Int32Array(N).fill(-1), junction = new Uint8Array(N);
  const meet = (v: number, w: number) => {
    if (n1[v] < 0) n1[v] = w;
    else if (n1[v] !== w) { if (n2[v] < 0) n2[v] = w; else if (n2[v] !== w) junction[v] = 1; }
  };
  rings.forEach((rs, s) => { if (!shapes[s].loose) for (const r of rs) for (let k = 0; k < r.length; k++) { const a = r[k], b = r[(k + 1) % r.length]; meet(a, b); meet(b, a); } });
  // a point with one neighbor is a spike's tip: a junction too, so every arc runs between junctions
  for (let v = 0; v < N; v++) if (n1[v] >= 0 && n2[v] < 0) junction[v] = 1;
  // between junctions the way is forced, so an arc is known by its first two points
  const arcs: Int32Array[] = [], byKey = new Map<string, number>();
  const ref = (a: number[], own = ''): number => {
    const n = a.length - 1, fwd = !!own || a[0] < a[n] || (a[0] === a[n] && a[1] <= a[n - 1]);
    const key = own || (fwd ? `${a[0]},${a[1]}` : `${a[n]},${a[n - 1]}`);
    let i = byKey.get(key);
    if (i === undefined) { byKey.set(key, (i = arcs.length)); arcs.push(Int32Array.from(fwd ? a : [...a].reverse())); }
    return fwd ? i : ~i;
  };
  const out = rings.map((rs, s) => rs.map((r, k) => {
    const L = r.length;
    if (shapes[s].loose) return [ref([...r, r[0]], `loose ${s} ${k}`)];
    let at = r.findIndex((v) => junction[v]);
    // no junction: a loop of its own (or one both sides share), started at its lowest point
    if (at < 0) { at = 0; for (let j = 1; j < L; j++) if (r[j] < r[at]) at = j; }
    const refs: number[] = [];
    let arc = [r[at]];
    for (let j = 1; j <= L; j++) {
      const v = r[(at + j) % L];
      arc.push(v);
      if (junction[v] || j === L) { refs.push(ref(arc)); arc = [v]; }
    }
    return refs;
  }));
  const xy = new Float64Array(2 * N);
  for (let i = 0; i < N; i++) { const p = proj(ids.xs[i], ids.ys[i]); [xy[2 * i], xy[2 * i + 1]] = p; }
  return { xy, arcs, shapes: out };
}

/** Douglas-Peucker on points of xy: the kept point numbers, both ends always. */
export function thin(xy: Float64Array, arc: Int32Array, tol: number): number[] {
  const n = arc.length;
  if (n < 3) return [...arc];
  const keep = new Uint8Array(n), stack = [0, n - 1], t2 = tol * tol;
  keep[0] = keep[n - 1] = 1;
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    const ax = xy[2 * arc[a]], ay = xy[2 * arc[a] + 1], dx = xy[2 * arc[b]] - ax, dy = xy[2 * arc[b] + 1] - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = t2;
    for (let i = a + 1; i < b; i++) {
      const px = xy[2 * arc[i]] - ax, py = xy[2 * arc[i] + 1] - ay;
      const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
      if (d > wd) [worst, wd] = [i, d];
    }
    if (worst >= 0) { keep[worst] = 1; stack.push(a, worst, worst, b); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(arc[i]);
  return out;
}

/** An arc in steps of q m: [x, y, dx, dy, ...], repeats dropped. */
export function encodeArc(pts: readonly XY[], q: number): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  pts.forEach(([px, py], k) => {
    const X = Math.round(px / q), Y = Math.round(py / q);
    if (k && X === x && Y === y) return;
    out.push(X - x, Y - y);
    [x, y] = [X, Y];
  });
  return out;
}

// ---------- salmon in each watershed's stream ----------

/** The app's salmon streams by name (lower case): their species and their lines, from public/data/salmon. */
function salmonStreams(): Map<string, { name: string; sp: number; pts: XY[] }[]> {
  const index = JSON.parse(readFileSync(`${SALMON}/index.json`, 'utf8')) as RawIndex;
  const out = new Map<string, { name: string; sp: number; pts: XY[] }[]>();
  for (const k of index.tiles) {
    const t = readTile(k, JSON.parse(readFileSync(`${SALMON}/t/${k}.json`, 'utf8')));
    for (const l of t?.lines ?? []) {
      if (!l.stream?.name) continue;
      const key = l.stream.name.toLowerCase();
      out.set(key, [...(out.get(key) ?? []), { name: l.stream.name, sp: l.stream.sp, pts: l.pts }]);
    }
  }
  return out;
}

/** The salmon stream a watershed is named for, if WDFW records salmon in it there (STREAM_M of it inside). */
function streamIn(name: string, rings: XY[][], box: number[], streams: ReturnType<typeof salmonStreams>): { stream: string; sp: number } {
  const want = mainStream(name);
  let m = 0, sp = 0, stream = '';
  for (const l of streams.get(want.toLowerCase()) ?? []) {
    let inside = 0;
    for (let k = 1; k < l.pts.length; k++) {
      const a = l.pts[k - 1], b = l.pts[k], mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (mid[0] >= box[0] && mid[0] <= box[2] && mid[1] >= box[1] && mid[1] <= box[3] && pointInPolygon(mid, rings)) inside += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (inside > 0) [m, sp, stream] = [m + inside, sp | l.sp, l.name];
  }
  return m >= STREAM_M ? { stream, sp } : { stream: '', sp: 0 };
}

// ---------- build ----------

const EARTH = 6378137;
/** Web Mercator meters to lon/lat */
const lngLat = (x: number, y: number): LngLat => [(x / EARTH) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / EARTH)) - Math.PI / 2) * (180 / Math.PI)];

async function main(): Promise<void> {
  const t0 = Date.now();
  const feats = await fetchAll();
  const topo = topology(feats, (x, y) => project(lngLat(x, y)));
  console.log(`${topo.xy.length / 2} points, ${topo.arcs.length} arcs`);
  const xy = topo.xy, at = (i: number): XY => [xy[2 * i], xy[2 * i + 1]];
  const arcs = topo.arcs.map((a) => thin(xy, a, TOL).map(at));
  const streams = salmonStreams();
  const ringOf = (ids: number[]) => ids.flatMap((i, k) => { const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i]; return k ? a.slice(1) : a; });
  // each watershed's rings from its arcs (rings thinned to a sliver go); the loose open water last, so land wins at its edge
  const sheds = feats.map((f, s) => {
    const kept = topo.shapes[s].map((ids) => ({ ids, ring: ringOf(ids) })).filter((r) => new Set(r.ring.map((p) => `${Math.round(p[0] / Q)},${Math.round(p[1] / Q)}`)).size >= 3);
    const refs = kept.map((r) => r.ids), rings = kept.map((r) => r.ring), box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of rings) for (const [x, y] of r) [box[0], box[1], box[2], box[3]] = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    return { f, refs, rings, box, ...streamIn(f.name, rings, box, streams) };
  }).filter((s) => s.refs.length).sort((a, b) => Number(!!a.f.loose) - Number(!!b.f.loose));
  const write = (list: typeof sheds) => {
    // only the arcs these use, numbered in order
    const used = new Map<number, number>(), keep: number[][] = [];
    const num = (i: number) => {
      const a = i < 0 ? ~i : i;
      let n = used.get(a);
      if (n === undefined) { used.set(a, (n = keep.length)); keep.push(encodeArc(arcs[a], Q)); }
      return i < 0 ? ~n : n;
    };
    const w = list.map((s) => [s.f.huc12, s.f.name, s.stream, s.sp, s.refs.map((ids) => ids.map(num))]);
    const out = { v: 1, q: Q, source: `USGS Watershed Boundary Dataset (public domain), HUC-12, simplified to ${TOL} m`, built: new Date().toISOString().slice(0, 10), arcs: keep, w };
    return JSON.stringify(out);
  };
  let text = write(sheds), scope = 'every watershed touching Washington';
  console.log(`statewide: ${(text.length / 1024).toFixed(0)} KB raw, ${(gzipSync(text).length / 1024).toFixed(0)} KB gzipped`);
  if (text.length > MAX_BYTES) {
    // too big for the whole state: the King and Pierce region, which holds every city on the map without a pipe map
    const reg = new Region(JSON.parse(readFileSync('public/data/region.json', 'utf8')), JSON.parse(readFileSync('public/data/coverage.json', 'utf8')));
    const areas = [...reg.counties.filter((c) => c.name === 'King' || c.name === 'Pierce'), ...reg.places.filter((p) => !reg.isMapped(p))];
    text = write(sheds.filter((s) => areas.some((a) => touches(s.rings, s.box, a))));
    scope = 'watersheds touching King and Pierce counties and the cities without pipe maps';
  }
  mkdirSync(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
  writeFileSync(OUT, text);
  const j = JSON.parse(text) as RawWatersheds;
  console.log(`${OUT}: ${j.w.length} watersheds (${scope}), ${j.w.filter((x) => x[2]).length} with a salmon stream, ${j.arcs.length} arcs,`
    + ` ${(text.length / 1024).toFixed(0)} KB raw, ${(gzipSync(text).length / 1024).toFixed(0)} KB gzipped (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

/** A watershed and an outline share ground: a point of one is inside the other. */
function touches(rings: XY[][], box: number[], sh: { rings: XY[][]; box: [number, number, number, number] }): boolean {
  if (box[0] > sh.box[2] || box[2] < sh.box[0] || box[1] > sh.box[3] || box[3] < sh.box[1]) return false;
  return rings.some((r) => r.some((p) => pointInPolygon(p, sh.rings))) || sh.rings.some((r) => r.some((p) => pointInPolygon(p, rings)));
}

if (import.meta.main) await main();
