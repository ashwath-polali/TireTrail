// Salmon streams statewide (public/data/salmon, from scripts/build-salmon.ts), in the region map's coordinates
// (meters, y down; src/app/map/region.ts). t/<x>_<y>.json per TILE square: streams, road crossings, roads beside one;
// far.json and mid.json: the whole state's lines, thinned. Fetched by area, kept a while.
import type { XY } from '../geo/geo.ts';

/** tile side, m */
export const TILE = 25_600;
/** lines are cut into pieces no longer than this, m, so a view only needs the tiles it meets plus this much */
export const CHUNK_M = 1500;
/** a road within this of a stream runs beside it, m */
export const BESIDE_M = 50;
/** Douglas-Peucker tolerance per tier, m */
export const TIERS = { near: 6, mid: 60, far: 300 } as const;

/** a tile's stream: name ('' unnamed), species bits, road crossings statewide */
export type RawStream = [name: string, sp: number, crossings: number];
export interface RawTile {
  v: 1;
  s: RawStream[];
  /** lines: [stream, x, y, dx, dy, ...] */
  l: number[][];
  /** crossings: [x, y, stream, road direction 0-179 degrees from north, species bits here] */
  c: [number, number, number, number, number][];
  /** road stretches beside a stream: [stream, x, y, dx, dy, ...] */
  b: number[][];
}
/** lines: [species bits, x, y, dx, dy, ...] */
export interface RawTier { v: 1; l: number[][] }
export interface RawIndex { v: 1; tile: number; tiles: string[]; streams: number; crossings: number; miles: number; source: string; built: string }

export interface Stream { name: string; sp: number; crossings: number }
export interface Crossing { id: string; at: XY; dir: number; sp: number; stream: Stream }
export interface SLine { pts: XY[]; box: [number, number, number, number]; stream: Stream | null; sp: number }
export interface Tile { key: string; lines: SLine[]; crossings: Crossing[]; beside: SLine[] }

function line(d: readonly number[], from: number): XY[] {
  const out: XY[] = [];
  let x = 0, y = 0;
  for (let k = from; k + 1 < d.length; k += 2) out.push([(x += d[k]), (y += d[k + 1])]);
  return out;
}

function boxOf(pts: readonly XY[]): SLine['box'] {
  const b: SLine['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

/** A tile file as streams, crossings and stretches; null unless it is one. */
export function readTile(key: string, j: unknown): Tile | null {
  const f = j as Partial<RawTile> | null;
  if (!f || f.v !== 1 || !Array.isArray(f.s) || !Array.isArray(f.l) || !Array.isArray(f.c) || !Array.isArray(f.b)) return null;
  const st: Stream[] = f.s.map(([name, sp, crossings]) => ({ name, sp, crossings }));
  const sl = (d: number[]): SLine => { const pts = line(d, 1), s = st[d[0]] ?? null; return { pts, box: boxOf(pts), stream: s, sp: s?.sp ?? 0 }; };
  return {
    key,
    lines: f.l.map(sl),
    crossings: f.c.map(([x, y, s, dir, sp]) => ({ id: `${x}_${y}`, at: [x, y] as XY, dir, sp, stream: st[s] })),
    beside: f.b.map(sl),
  };
}

/** A far or mid file as lines; null unless it is one. */
export function readTier(j: unknown): SLine[] | null {
  const f = j as Partial<RawTier> | null;
  if (!f || f.v !== 1 || !Array.isArray(f.l)) return null;
  return f.l.map((d) => { const pts = line(d, 1); return { pts, box: boxOf(pts), stream: null, sp: d[0] }; });
}

/** Tile keys over a region box. */
export function tilesIn(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) out.push(`${tx}_${ty}`);
  return out;
}

const KEEP = 30;
const MAX_LOADS = 4;

/** Fetches what's asked for, a few at a time; failures rest 15 s. Callers poll (the map each frame, the coach each fix). */
export class SalmonData {
  private index: RawIndex | null = null;
  private have = new Set<string>();
  private asked = false;
  private readonly tiles = new Map<string, Tile>();
  private readonly tiers = new Map<string, SLine[]>();
  private readonly busy = new Set<string>();
  private readonly failed = new Map<string, number>();
  /** called when something new is in (the map redraws) */
  onLoad: (() => void) | null = null;

  private readonly base: string;
  private readonly get: (url: string) => Promise<unknown>;

  constructor(base = 'data/salmon/', get: (url: string) => Promise<unknown> = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))) {
    [this.base, this.get] = [base, get];
  }

  get ready(): boolean {
    return !!this.index;
  }

  get info(): RawIndex | null {
    return this.index;
  }

  load(): void {
    if (this.asked) return;
    this.asked = true;
    this.get(`${this.base}index.json`)
      .then((j) => {
        const i = j as RawIndex;
        if (i?.v !== 1 || i.tile !== TILE || !Array.isArray(i.tiles)) return;
        [this.index, this.have] = [i, new Set(i.tiles)];
        this.onLoad?.();
      })
      .catch(() => { setTimeout(() => { this.asked = false; }, 20000); });
  }

  private start(name: string): boolean {
    if (this.busy.has(name) || this.busy.size >= MAX_LOADS || (this.failed.get(name) ?? 0) > Date.now()) return false;
    this.busy.add(name);
    return true;
  }

  private readonly pending = new Map<string, Promise<Tile | null>>();

  private fetchTile(k: string, force = false): Promise<Tile | null> | null {
    const p = this.pending.get(k);
    if (p) return p;
    if (!force && !this.start(k)) return null;
    if (force) this.busy.add(k);
    const q = this.get(`${this.base}t/${k}.json`)
      .then((j) => {
        const t = readTile(k, j);
        if (!t) return null;
        this.tiles.set(k, t);
        for (const old of this.tiles.keys()) { if (this.tiles.size <= KEEP) break; if (old !== k) this.tiles.delete(old); }
        this.onLoad?.();
        return t;
      })
      .catch(() => { this.failed.set(k, Date.now() + 15000); return null; })
      .finally(() => { this.busy.delete(k); this.pending.delete(k); });
    this.pending.set(k, q);
    return q;
  }

  /** Waits for the index and these tiles (a drive's report); the ones that can't load are left out. */
  async some(keys: Iterable<string>): Promise<Tile[]> {
    this.load();
    for (let i = 0; i < 100 && !this.index; i++) await new Promise((r) => setTimeout(r, 100));
    if (!this.index) return [];
    const got = await Promise.all([...keys].filter((k) => this.have.has(k)).map((k) => this.tiles.get(k) ?? this.fetchTile(k, true)));
    return got.filter((t): t is Tile => !!t);
  }

  /** The loaded tiles over a region box (asking for the rest). */
  near(x0: number, y0: number, x1: number, y1: number): Tile[] {
    this.load();
    if (!this.index) return [];
    const out: Tile[] = [];
    for (const k of tilesIn(x0 - CHUNK_M, y0 - CHUNK_M, x1 + CHUNK_M, y1 + CHUNK_M)) {
      if (!this.have.has(k)) continue;
      const t = this.tiles.get(k);
      if (t) { this.tiles.delete(k); this.tiles.set(k, t); out.push(t); } else this.fetchTile(k);
    }
    return out;
  }

  /** The tiles over a box are all in (or there are none). */
  loaded(x0: number, y0: number, x1: number, y1: number): boolean {
    if (!this.index) return false;
    return tilesIn(x0 - CHUNK_M, y0 - CHUNK_M, x1 + CHUNK_M, y1 + CHUNK_M).every((k) => !this.have.has(k) || this.tiles.has(k));
  }

  /** The far or mid lines (asking for them). */
  tier(name: 'far' | 'mid'): SLine[] | null {
    this.load();
    const t = this.tiers.get(name);
    if (t || !this.index || !this.start(name)) return t ?? null;
    this.get(`${this.base}${name}.json`)
      .then((j) => { const l = readTier(j); if (l) { this.tiers.set(name, l); this.onLoad?.(); } })
      .catch(() => this.failed.set(name, Date.now() + 15000))
      .finally(() => this.busy.delete(name));
    return null;
  }
}
