// Real buildings, land cover and roads (built by scripts/basemap), fetched in 2 km tiles near the camera.
import { hash } from './noise.ts';

export const COVER_FOREST = 1, COVER_PARK = 2, COVER_GRASS = 3, COVER_WATER = 4, COVER_SEA = 5;
// every tile in view is kept; out of view, the most recent stay while they fit in KEEP_BYTES (and MAX_TILES)
const KEEP_BYTES = 40 << 20;
const MAX_TILES = 96;
// a very wide view on a very big screen stops here
const MAX_VIEW = 1500;
const MAX_LOADS = 6;

export interface Area {
  /** world x, y pairs; one ring per [start, end) pair in `ranges`, in vertices */
  pts: Float32Array;
  ranges: number[];
  box: [number, number, number, number];
}
export interface Cover extends Area {
  cls: number;
  /** OSM name of a water area, '' if none or the tile doesn't say */
  name: string;
}
export interface Road {
  major: boolean;
  /** 1 local, 2 tertiary, 3 secondary, 4 primary, 5 trunk or motorway; 0 if the tile doesn't say */
  cls: number;
  /** OSM name or route number, '' if none */
  name: string;
  /** route number, like "SR 410", '' if none */
  ref: string;
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
  /** loaded for a far view: no buildings */
  lite: boolean;
  /** about how much memory it holds */
  bytes: number;
}

interface Raw { b: number[]; c: [number, ...number[][]][]; r: number[][]; rn?: number[]; n?: string[]; cn?: number[]; rc?: number[]; rf?: number[] }

export class Basemap {
  private size = 2000;
  private unit = 0.5;
  private index: Set<string> | null = null;
  private indexAsked = false;
  private readonly tiles = new Map<string, BaseTile>();
  private readonly loading = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly base: string;
  /** tiles in the last view asked for, which are never dropped */
  private inView = new Set<string>();
  private bytes = 0;

  constructor(base = 'data/basemap/') {
    this.base = base;
  }

  /** Loaded tiles that may touch the box; asks for missing ones, nearest first. full: buildings are needed. */
  near(x0: number, y0: number, x1: number, y1: number, full = true): BaseTile[] {
    if (!this.index) { this.loadIndex(); return []; }
    const S = this.size, out: BaseTile[] = [];
    const want: [string, number, number, number][] = [];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const view = new Set<string>();
    for (let ty = Math.floor(y0 / S); ty <= Math.floor(y1 / S); ty++) for (let tx = Math.floor(x0 / S); tx <= Math.floor(x1 / S); tx++) {
      const k = `${tx}_${ty}`;
      if (!this.index.has(k)) continue;
      const d = Math.hypot((tx + .5) * S - cx, (ty + .5) * S - cy);
      const t = this.tiles.get(k), ready = !this.loading.has(k) && (this.failed.get(k) ?? 0) < performance.now();
      if (t) {
        view.add(k);
        // refresh its place in the eviction order
        this.tiles.delete(k);
        this.tiles.set(k, t);
        out.push(t);
        // a far view's copy has no buildings: fetch the whole tile again (the browser has it cached)
        if (full && t.lite && ready) want.push([k, tx, ty, d]);
      } else if (ready) want.push([k, tx, ty, d]);
      else view.add(k);
    }
    want.sort((a, b) => a[3] - b[3]);
    for (const [k] of want) if (view.size < MAX_VIEW) view.add(k);
    this.inView = view;
    for (const [k, tx, ty] of want) {
      if (this.loading.size >= MAX_LOADS) break;
      if (view.has(k)) this.load(k, tx, ty, !full);
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

  /** OSM water (or sea) under world x, y in a loaded tile, or null. name is '' until tiles carry names. */
  waterAt(x: number, y: number): { name: string } | null {
    const t = this.tiles.get(`${Math.floor(x / this.size)}_${Math.floor(y / this.size)}`);
    for (const c of t?.cover ?? []) {
      if ((c.cls !== COVER_WATER && c.cls !== COVER_SEA) || x < c.box[0] || x > c.box[2] || y < c.box[1] || y > c.box[3]) continue;
      // even-odd over every ring, so islands stay dry
      let inside = false;
      for (let q = 0; q < c.ranges.length; q += 2) {
        for (let k = c.ranges[q], p = c.ranges[q + 1] - 1; k < c.ranges[q + 1]; p = k++) {
          const ay = c.pts[2 * k + 1], by = c.pts[2 * p + 1];
          if (ay > y !== by > y && x < ((c.pts[2 * p] - c.pts[2 * k]) * (y - ay)) / (by - ay) + c.pts[2 * k]) inside = !inside;
        }
      }
      if (inside) return { name: c.name };
    }
    return null;
  }

  /** Marks (1) the pixels of a view (x0, y0, m per pixel, W x H) that a tile covers. Null until the tile list is in, else whether every pixel is. */
  covered(x0: number, y0: number, m: number, W: number, H: number, out: Uint8Array): boolean | null {
    if (!this.index) { this.loadIndex(); return null; }
    const S = this.size, tx0 = Math.floor(x0 / S), ty0 = Math.floor(y0 / S);
    const nx = Math.floor((x0 + W * m) / S) - tx0 + 1, ny = Math.floor((y0 + H * m) / S) - ty0 + 1, has = new Uint8Array(nx * ny);
    let all = true;
    for (let b = 0; b < ny; b++) for (let a = 0; a < nx; a++) if (this.index.has(`${tx0 + a}_${ty0 + b}`)) has[b * nx + a] = 1; else all = false;
    if (all) { out.fill(1, 0, W * H); return true; }
    const col = new Int32Array(W);
    for (let i = 0; i < W; i++) col[i] = Math.min(nx - 1, Math.floor((x0 + (i + .5) * m) / S) - tx0);
    for (let j = 0; j < H; j++) {
      const row = Math.min(ny - 1, Math.floor((y0 + (j + .5) * m) / S) - ty0) * nx, o = j * W;
      for (let i = 0; i < W; i++) out[o + i] = has[row + col[i]];
    }
    return false;
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

  private load(k: string, tx: number, ty: number, lite: boolean): void {
    this.loading.add(k);
    fetch(`${this.base}${k}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw: Raw) => {
        const t = decode(raw, tx * this.size, ty * this.size, this.unit, lite), old = this.tiles.get(k);
        // a whole tile never gives way to a far view's copy
        if (old && !old.lite) return;
        if (old) { this.tiles.delete(k); this.bytes -= old.bytes; }
        this.tiles.set(k, t);
        this.bytes += t.bytes;
        this.evict();
      })
      .catch(() => this.failed.set(k, performance.now() + 10000))
      .finally(() => this.loading.delete(k));
  }

  /** Drops the tiles seen longest ago, never ones in view, until the rest fit. */
  private evict(): void {
    for (const [k, t] of this.tiles) {
      if (this.bytes <= KEEP_BYTES && this.tiles.size <= this.inView.size + MAX_TILES) break;
      if (this.inView.has(k)) continue;
      this.tiles.delete(k);
      this.bytes -= t.bytes;
    }
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

/** Delta-encoded rings in tile units to world meters. lite leaves the buildings out. */
export function decode(raw: Raw, ox: number, oy: number, u: number, lite = false): BaseTile {
  const b = lite ? [] : raw.b;
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
  // optional names: 1-based indexes into n, 0 for none
  const word = (i: number | undefined) => (i ? raw.n?.[i - 1] ?? '' : '');
  let bytes = bv.byteLength + bs.byteLength + bb.byteLength + tone.byteLength + 200;
  const cover: Cover[] = raw.c.map(([cls, ...rings], i) => {
    const flat: number[] = [], ranges: number[] = [];
    for (const r of rings) { ranges.push(flat.length / 2); ring(r, flat); ranges.push(flat.length / 2); }
    const pts = new Float32Array(flat);
    bytes += pts.byteLength + 8 * ranges.length + 80;
    return { cls: cls + 1, name: word(raw.cn?.[i]), pts, ranges, box: boxOf(pts) };
  });
  // flags: 1 if major, plus 2 x `near`
  const roads: Road[] = raw.r.map(([f, ...d], i) => {
    const flat: number[] = [];
    ring(d, flat);
    const pts = new Float32Array(flat), near = f >> 1;
    bytes += pts.byteLength + 120;
    return { major: (f & 1) === 1, cls: raw.rc?.[i] ?? 0, name: word(raw.rn?.[i]), ref: word(raw.rf?.[i]), near, mid: near ? middle(pts) : [0, 0], pts, box: boxOf(pts) };
  });
  return { bv, bs, bb, tone, cover, roads, lite, bytes };
}
