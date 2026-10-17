// Real buildings, land cover and roads (built by scripts/basemap), fetched in 2 km tiles near the camera.
import { hash } from './noise.ts';

export const COVER_FOREST = 1, COVER_PARK = 2, COVER_GRASS = 3, COVER_WATER = 4;
// tiles kept loaded; more when more are in view, but never past MAX_VIEW
const MAX_TILES = 96;
const MAX_VIEW = 256;
const MAX_LOADS = 4;

export interface Area {
  /** world x, y pairs; one ring per [start, end) pair in `ranges`, in vertices */
  pts: Float32Array;
  ranges: number[];
  box: [number, number, number, number];
}
export interface Cover extends Area { cls: number }
export interface Road {
  major: boolean;
  /** OSM name or route number, '' if none */
  name: string;
  /** a copy of a county street: hide it once the map draws a street within `near` m of `mid`; 0 for others */
  near: number;
  mid: [number, number];
  pts: Float32Array;
  box: [number, number, number, number];
  /** set by the renderer: hidden under a drawn street */
  hide?: boolean;
  ver?: number;
}

export interface BaseTile {
  /** all building vertices, world x, y pairs */
  bv: Float32Array;
  /** building k spans vertices bs[k] .. bs[k + 1] */
  bs: Uint32Array;
  /** x0, y0, x1, y1 per building */
  bb: Float32Array;
  /** roof color index per building; large flat roofs get 8 and up */
  tone: Uint8Array;
  cover: Cover[];
  roads: Road[];
}

interface Raw { b: number[]; c: [number, ...number[][]][]; r: number[][]; rn?: number[]; n?: string[] }

export class Basemap {
  private size = 2000;
  private unit = 0.5;
  private cap = MAX_TILES;
  private index: Set<string> | null = null;
  private indexAsked = false;
  private readonly tiles = new Map<string, BaseTile>();
  private readonly loading = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly base: string;

  constructor(base = 'data/basemap/') {
    this.base = base;
  }

  /** Loaded tiles that may touch the box; asks for missing ones, nearest first. */
  near(x0: number, y0: number, x1: number, y1: number): BaseTile[] {
    if (!this.index) { this.loadIndex(); return []; }
    const S = this.size, out: BaseTile[] = [];
    const want: [string, number, number, number][] = [];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let inView = 0;
    for (let ty = Math.floor(y0 / S); ty <= Math.floor(y1 / S); ty++) for (let tx = Math.floor(x0 / S); tx <= Math.floor(x1 / S); tx++) {
      const k = `${tx}_${ty}`;
      if (!this.index.has(k)) continue;
      inView++;
      const t = this.tiles.get(k);
      if (t) {
        // refresh its place in the eviction order
        this.tiles.delete(k);
        this.tiles.set(k, t);
        out.push(t);
      } else if (!this.loading.has(k) && (this.failed.get(k) ?? 0) < performance.now()) {
        want.push([k, tx, ty, Math.hypot((tx + .5) * S - cx, (ty + .5) * S - cy)]);
      }
    }
    // room for every tile in view, so none is dropped and fetched again; past MAX_VIEW the rest just wait
    this.cap = Math.min(MAX_VIEW, Math.max(MAX_TILES, inView));
    want.sort((a, b) => a[3] - b[3]);
    for (const [k, tx, ty] of want) {
      if (this.loading.size >= MAX_LOADS || out.length + this.loading.size >= this.cap) break;
      this.load(k, tx, ty);
    }
    return out;
  }

  /** Name of the nearest drawn basemap road within r m of world x, y ('' if it has none), or null if none. These roads have no drain data. */
  roadAt(x: number, y: number, r: number): string | null {
    return this.roadNear(x, y, r)?.name ?? null;
  }

  /** The nearest drawn basemap road within r m of world x, y, or null. */
  roadNear(x: number, y: number, r: number): { name: string; d: number; major: boolean; pts: Float32Array } | null {
    const S = this.size;
    let best: Road | null = null, bd = r;
    for (let ty = Math.floor((y - r) / S); ty <= Math.floor((y + r) / S); ty++) for (let tx = Math.floor((x - r) / S); tx <= Math.floor((x + r) / S); tx++) {
      for (const rd of this.tiles.get(`${tx}_${ty}`)?.roads ?? []) {
        if (rd.hide || rd.box[0] > x + r || rd.box[2] < x - r || rd.box[1] > y + r || rd.box[3] < y - r) continue;
        const d = toLine(rd.pts, x, y);
        if (d <= bd) [best, bd] = [rd, d];
      }
    }
    return best ? { name: best.name, d: bd, major: best.major, pts: best.pts } : null;
  }

  /** OSM water under world x, y in a loaded tile, or null. name is '' until tiles carry names. */
  waterAt(x: number, y: number): { name: string } | null {
    const t = this.tiles.get(`${Math.floor(x / this.size)}_${Math.floor(y / this.size)}`);
    for (const c of t?.cover ?? []) {
      if (c.cls !== COVER_WATER || x < c.box[0] || x > c.box[2] || y < c.box[1] || y > c.box[3]) continue;
      // even-odd over every ring, so islands stay dry
      let inside = false;
      for (let q = 0; q < c.ranges.length; q += 2) {
        for (let k = c.ranges[q], p = c.ranges[q + 1] - 1; k < c.ranges[q + 1]; p = k++) {
          const ay = c.pts[2 * k + 1], by = c.pts[2 * p + 1];
          if (ay > y !== by > y && x < ((c.pts[2 * p] - c.pts[2 * k]) * (y - ay)) / (by - ay) + c.pts[2 * k]) inside = !inside;
        }
      }
      if (inside) return { name: '' };
    }
    return null;
  }

  private loadIndex(): void {
    if (this.indexAsked) return;
    this.indexAsked = true;
    fetch(`${this.base}index.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { tile: number; unit: number; tiles: string[] }) => {
        [this.size, this.unit] = [j.tile, j.unit];
        this.index = new Set(j.tiles);
      })
      .catch(() => {
        // no basemap: try again in a while
        setTimeout(() => { this.indexAsked = false; }, 15000);
      });
  }

  private load(k: string, tx: number, ty: number): void {
    this.loading.add(k);
    fetch(`${this.base}${k}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw: Raw) => {
        this.tiles.set(k, decode(raw, tx * this.size, ty * this.size, this.unit));
        while (this.tiles.size > this.cap) this.tiles.delete(this.tiles.keys().next().value!);
      })
      .catch(() => this.failed.set(k, performance.now() + 10000))
      .finally(() => this.loading.delete(k));
  }
}

/** Distance from x, y to a polyline of x, y pairs. */
function toLine(p: Float32Array, x: number, y: number): number {
  let best = Infinity;
  for (let k = 2; k + 1 < p.length; k += 2) {
    const ax = p[k - 2], ay = p[k - 1], dx = p[k] - ax, dy = p[k + 1] - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

/** Point halfway along a polyline of x, y pairs. */
function middle(p: Float32Array): [number, number] {
  let total = 0;
  for (let k = 2; k + 1 < p.length; k += 2) total += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  let left = total / 2;
  for (let k = 2; k + 1 < p.length; k += 2) {
    const L = Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
    if (L >= left && L > 0) return [p[k - 2] + ((p[k] - p[k - 2]) * left) / L, p[k - 1] + ((p[k + 1] - p[k - 1]) * left) / L];
    left -= L;
  }
  return [p[0], p[1]];
}

function boxOf(pts: Float32Array): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pts.length; k += 2) {
    if (pts[k] < b[0]) b[0] = pts[k];
    if (pts[k + 1] < b[1]) b[1] = pts[k + 1];
    if (pts[k] > b[2]) b[2] = pts[k];
    if (pts[k + 1] > b[3]) b[3] = pts[k + 1];
  }
  return b;
}

/** Delta-encoded rings in tile units to world meters. */
export function decode(raw: Raw, ox: number, oy: number, u: number): BaseTile {
  const b = raw.b;
  let n = 0, nv = 0;
  for (let k = 0; k < b.length; k += 1 + 2 * b[k]) { n++; nv += b[k]; }
  const bv = new Float32Array(nv * 2), bs = new Uint32Array(n + 1), bb = new Float32Array(n * 4), tone = new Uint8Array(n);
  let k = 0, v = 0, px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const c = b[k++];
    let x = (px += b[k++]), y = (py += b[k++]);
    bs[i] = v;
    const x0 = x, y0 = y;
    let a = 0, lx = x, ly = y;
    let minX = x, minY = y, maxX = x, maxY = y;
    bv[2 * v] = ox + x * u; bv[2 * v + 1] = oy + y * u; v++;
    for (let q = 1; q < c; q++) {
      x += b[k++]; y += b[k++];
      a += (lx - x) * (ly + y);
      [lx, ly] = [x, y];
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      bv[2 * v] = ox + x * u; bv[2 * v + 1] = oy + y * u; v++;
    }
    a += (lx - x0) * (ly + y0);
    bb[4 * i] = ox + minX * u; bb[4 * i + 1] = oy + minY * u; bb[4 * i + 2] = ox + maxX * u; bb[4 * i + 3] = oy + maxY * u;
    // same building, same roof, whichever tile load it came from
    const h = hash(ox / u + x0, oy / u + y0, 11);
    tone[i] = Math.abs(a / 2) * u * u > 700 ? 8 + Math.floor(h * 3) : Math.floor(h * 8);
  }
  bs[n] = v;
  const ring = (d: number[], out: number[]) => {
    let x = 0, y = 0;
    for (let q = 0; q + 1 < d.length; q += 2) { x += d[q]; y += d[q + 1]; out.push(ox + x * u, oy + y * u); }
  };
  const cover: Cover[] = raw.c.map(([cls, ...rings]) => {
    const flat: number[] = [], ranges: number[] = [];
    for (const r of rings) { ranges.push(flat.length / 2); ring(r, flat); ranges.push(flat.length / 2); }
    const pts = new Float32Array(flat);
    return { cls: cls + 1, pts, ranges, box: boxOf(pts) };
  });
  // flags: 1 if major, plus 2 x `near`
  const roads: Road[] = raw.r.map(([f, ...d], i) => {
    const flat: number[] = [];
    ring(d, flat);
    const pts = new Float32Array(flat), near = f >> 1;
    return { major: (f & 1) === 1, name: raw.n?.[(raw.rn?.[i] ?? 0) - 1] ?? '', near, mid: near ? middle(pts) : [0, 0], pts, box: boxOf(pts) };
  });
  return { bv, bs, bb, tone, cover, roads };
}
