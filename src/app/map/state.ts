// The land itself, statewide (public/data/state, from scripts/build-state.ts): pixel hillshade and towns, and lakes,
// rivers and big roads thinned for each zoom. Fetched for what's in view, after the first map frame.
// Everything is in the region map's coordinates; close views take world-meter copies of the near tiles.
import type { XY } from '../../geo/geo.ts';
import { regionPt, worldPt } from './region.ts';

type Box = [number, number, number, number];
export interface Lake { rings: XY[][]; box: Box }
export interface Line { pts: XY[]; box: Box; cls: number }
/** one zoom tier's lakes, rivers and roads (cls 5 motorway, 4 trunk, 3 primary, 2 secondary) */
export interface Layer { lakes: Lake[]; rivers: Line[]; roads: Line[] }
/** world meters: x, y pairs; rings or lines split at `ranges` (start, end vertex pairs) */
export interface Part { pts: Float32Array; ranges: number[]; box: Box; cls: number }
export interface WorldLayer { lakes: Part[]; rivers: Part[]; roads: Part[] }

interface Index { v: number; states: string[]; cell: number; tile: number; levels: number; shades: number; covers: number; terrain: Record<string, string[]>; near: string[] }
interface Raw { v: number; lakes: number[][][]; rivers: number[][]; roads: number[][] }

/** region map m per art px where each tier takes over: far from FAR_MPP up, near under NEAR_MPP */
export const FAR_MPP = 800, NEAR_MPP = 100;
/** land cover in a terrain cell, and how many shades each comes in (the renderer's colors are made for these) */
export const LAND = 0, TOWN = 1, HIGH = 2, COVERS = 3, SHADES = 6;
const MAX_LOADS = 4;
// near tiles kept, with their world copies
const KEEP_NEAR = 24;

/** A terrain cell's code (0 none, else 1 + shade + shades * cover) from its PNG gray, which is 8 times it. */
export const cellOf = (gray: number): number => (gray + 4) >> 3;

function ring(d: number[]): XY[] {
  const out: XY[] = [];
  let x = 0, y = 0;
  for (let k = 0; k + 1 < d.length; k += 2) out.push([(x += d[k]), (y += d[k + 1])]);
  return out;
}

function boxOf(rs: readonly (readonly XY[])[]): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rs) for (const [x, y] of r) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

/** a tier file as drawable shapes; null unless it is one */
export function readLayer(j: unknown): Layer | null {
  const f = j as Partial<Raw> | null;
  if (!f || f.v !== 1 || !Array.isArray(f.lakes) || !Array.isArray(f.rivers) || !Array.isArray(f.roads)) return null;
  const line = (pts: XY[], cls: number): Line => ({ pts, box: boxOf([pts]), cls });
  return {
    lakes: f.lakes.map((rs) => { const rings = rs.map(ring); return { rings, box: boxOf(rings) }; }),
    rivers: f.rivers.map((d) => line(ring(d), 0)),
    roads: f.roads.map(([cls, ...d]) => line(ring(d), cls)),
  };
}

/** Terrain PNG to cell codes. */
async function cells(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  // exact grays: no color management or alpha on the way
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).catch(() => createImageBitmap(blob));
  const cv = document.createElement('canvas');
  [cv.width, cv.height] = [bmp.width, bmp.height];
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data, out = new Uint8Array(cv.width * cv.height);
  for (let k = 0; k < out.length; k++) out[k] = cellOf(d[4 * k]);
  return out;
}

export class StateMap {
  private index: Index | null = null;
  private asked = false;
  /** per level: tiles that exist */
  private have: Set<number>[] = [];
  private nearHave = new Set<string>();
  /** terrain tiles by key(L, tx, ty) */
  private readonly tiles = new Map<number, Uint8Array>();
  private readonly layers = new Map<string, Layer>();
  private readonly worlds = new Map<string, WorldLayer>();
  private readonly busy = new Set<string>();
  private readonly failed = new Map<string, number>();
  private lastKey = NaN;
  private lastTile: Uint8Array | undefined;
  private readonly base: string;
  /** states the terrain covers, by region.json id */
  states = new Set<string>();
  /** cell size in m per level */
  size: number[] = [];

  constructor(base = 'data/state/') {
    this.base = base;
  }

  get ready(): boolean {
    return !!this.index;
  }

  /** Fetches the list of tiles, then the coarse levels and the far tier, which are small. */
  load(): void {
    if (this.asked) return;
    this.asked = true;
    fetch(`${this.base}index.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Index) => {
        if (j.v !== 1 || !j.terrain || !Array.isArray(j.near) || j.shades !== SHADES || j.covers !== COVERS) return;
        this.have = Array.from({ length: j.levels }, (_, L) => new Set((j.terrain[L] ?? []).map((k) => { const [x, y] = k.split('_').map(Number); return key(L, x, y); })));
        this.nearHave = new Set(j.near);
        this.size = Array.from({ length: j.levels }, (_, L) => j.cell * 2 ** L);
        this.states = new Set(j.states);
        this.index = j;
        for (let L = j.levels - 1; L >= j.levels - 2; L--) for (const k of j.terrain[L] ?? []) { const [x, y] = k.split('_').map(Number); this.tile(L, x, y); }
        this.layer('far');
      })
      .catch(() => { setTimeout(() => { this.asked = false; }, 20000); });
  }

  // ---------- terrain ----------

  /** Coarsest level with cells no bigger than mpp (level 0 closer in). */
  levelFor(mpp: number): number {
    let L = 0;
    while (L + 1 < this.size.length && this.size[L + 1] <= mpp) L++;
    return L;
  }

  /**
   * The level to draw a region box with: `want` once its tiles there are in (they're asked for), else the finest
   * coarser one that is; -1 for none.
   */
  pick(x0: number, y0: number, x1: number, y1: number, want: number): number {
    if (!this.index) return -1;
    for (let L = want; L < this.size.length; L++) {
      const t = this.size[L] * this.index.tile;
      let all = true;
      for (let ty = Math.floor(y0 / t); ty <= Math.floor(y1 / t); ty++) for (let tx = Math.floor(x0 / t); tx <= Math.floor(x1 / t); tx++) {
        const k = key(L, tx, ty);
        if (!this.have[L].has(k) || this.tiles.has(k)) continue;
        all = false;
        if (L === want) this.tile(L, tx, ty);
      }
      if (all) return L;
    }
    return -1;
  }

  /** Cell code at a region point on level L: 0 outside the states or not loaded. */
  at(L: number, x: number, y: number): number {
    const s = this.size[L], ci = Math.floor(x / s), cj = Math.floor(y / s), k = (L * 4096 + (ci >> 8) + 2048) * 4096 + (cj >> 8) + 2048;
    if (k !== this.lastKey) {
      this.lastKey = k;
      this.lastTile = this.tiles.get(k);
    }
    return this.lastTile ? this.lastTile[((cj & 255) << 8) | (ci & 255)] : 0;
  }

  /** The loaded tiles of level L in row ty, from column txa to txb (undefined where none). */
  row(L: number, txa: number, txb: number, ty: number, out: (Uint8Array | undefined)[]): (Uint8Array | undefined)[] {
    out.length = 0;
    for (let tx = txa; tx <= txb; tx++) out.push(this.tiles.get(key(L, tx, ty)));
    return out;
  }

  private tile(L: number, tx: number, ty: number): void {
    const name = `t${L}/${tx}_${ty}`;
    if (!this.start(name)) return;
    cells(`${this.base}${name}.png`)
      .then((c) => { this.tiles.set(key(L, tx, ty), c); this.lastKey = NaN; })
      .catch(() => this.failed.set(name, performance.now() + 15000))
      .finally(() => this.busy.delete(name));
  }

  /** True if a fetch may start now (not loading, not resting after a failure, under the limit). */
  private start(name: string): boolean {
    if (this.busy.has(name) || this.busy.size >= MAX_LOADS || (this.failed.get(name) ?? 0) > performance.now()) return false;
    this.busy.add(name);
    return true;
  }

  // ---------- lakes, rivers, roads ----------

  private layer(name: string): void {
    if (this.layers.has(name) || !this.start(name)) return;
    fetch(`${this.base}${name}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => {
        const l = readLayer(j);
        if (!l) return;
        this.layers.set(name, l);
        // near tiles beyond the last few used go, with their world copies
        if (name.startsWith('near/')) for (const k of this.layers.keys()) {
          if (this.layers.size <= KEEP_NEAR + 2) break;
          if (k.startsWith('near/') && k !== name) { this.layers.delete(k); this.worlds.delete(k); }
        }
      })
      .catch(() => this.failed.set(name, performance.now() + 15000))
      .finally(() => this.busy.delete(name));
  }

  /** A loaded layer, moved to the back of the line for dropping. */
  private used(name: string): Layer | undefined {
    const l = this.layers.get(name);
    if (l) { this.layers.delete(name); this.layers.set(name, l); }
    return l;
  }

  /** near tile names over a region box */
  private nearIn(x0: number, y0: number, x1: number, y1: number): string[] {
    const out: string[] = [], t = this.index ? this.index.cell * this.index.tile : 1;
    for (let ty = Math.floor(y0 / t); ty <= Math.floor(y1 / t); ty++) for (let tx = Math.floor(x0 / t); tx <= Math.floor(x1 / t); tx++) {
      if (this.nearHave.has(`${tx}_${ty}`)) out.push(`near/${tx}_${ty}`);
    }
    return out;
  }

  /** What the region map draws over a region box at this zoom: the tier for it once loaded, else the next coarser one in. */
  lines(x0: number, y0: number, x1: number, y1: number, mpp: number): Layer[] {
    if (!this.index) return [];
    if (mpp < NEAR_MPP) {
      const names = this.nearIn(x0, y0, x1, y1);
      for (const n of names) this.layer(n);
      if (names.every((n) => this.layers.has(n))) return names.map((n) => this.used(n)!);
    }
    if (mpp < FAR_MPP) {
      this.layer('mid');
      const mid = this.layers.get('mid');
      if (mid) return [mid];
    }
    this.layer('far');
    const far = this.layers.get('far');
    return far ? [far] : [];
  }

  /** The near tiles over a world box, in world meters, for views closer than the region map; asks for missing ones. */
  near(wx0: number, wy0: number, wx1: number, wy1: number): WorldLayer[] {
    if (!this.index) return [];
    const a = regionPt([wx0, wy0]), b = regionPt([wx1, wy0]), c = regionPt([wx0, wy1]), d = regionPt([wx1, wy1]);
    const out: WorldLayer[] = [];
    for (const n of this.nearIn(Math.min(a[0], c[0]), Math.min(a[1], b[1]), Math.max(b[0], d[0]), Math.max(c[1], d[1]))) {
      const l = this.used(n);
      if (!l) { this.layer(n); continue; }
      let w = this.worlds.get(n);
      if (!w) this.worlds.set(n, (w = toWorld(l)));
      out.push(w);
    }
    return out;
  }
}

const key = (L: number, tx: number, ty: number) => (L * 4096 + tx + 2048) * 4096 + ty + 2048;

function part(rings: readonly XY[][], cls: number): Part {
  let n = 0;
  for (const r of rings) n += r.length;
  const pts = new Float32Array(2 * n), ranges: number[] = [];
  let o = 0;
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) {
    ranges.push(o);
    for (const p of r) {
      const [x, y] = worldPt(p);
      pts[2 * o] = x; pts[2 * o + 1] = y; o++;
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
    }
    ranges.push(o);
  }
  return { pts, ranges, box, cls };
}

/** A near tile in world meters. */
function toWorld(l: Layer): WorldLayer {
  return {
    lakes: l.lakes.map((q) => part(q.rings, 0)),
    rivers: l.rivers.map((q) => part([q.pts], 0)),
    roads: l.roads.map((q) => part([q.pts], q.cls)),
  };
}
