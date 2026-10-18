// Map data in local meters, plus 1 m tile rasters built on demand.
import { bboxOf, dist, GridIndex, localProjection, nearestOnPolyline, pointInPolygon, type BBox, type XY } from '../../geo/geo.ts';
import { decodeCoords } from '../../data/bundle.ts';
import type { TireTrailData } from '../../data/tiretrail.ts';

// index = the bundle's class code; 5 = combined sewer, to a treatment plant
export const CLS = ['creek', 'ground', 'elsewhere', 'unknown', 'none', 'treatment'] as const;
export type Cls = (typeof CLS)[number];
/** Class index for a bundle class code; codes this app doesn't know read as unknown (3). */
export const clsIndex = (code: number): number => (Number.isInteger(code) && code >= 0 && code < CLS.length ? code : 3);
// draw order, bottom first: none, unknown, treatment, other water, ground, creek on top
export const DRAW = [4, 3, 5, 2, 1, 0] as const;
const RANK: number[] = [];
DRAW.forEach((k, i) => { RANK[k] = i; });
// county files flag WDFW coho water; Bonney Lake's flags the whole Fennel Creek system
const NOT_COHO = /lake bonney outflow|bonney lake outflow|debra jane|^bonney lake$/i;
const named = (w: Water | null) => !!w?.name && !/unnamed/i.test(w.name);

export interface Run {
  i: number;
  line: XY[];
  k: number; // index into CLS
  drain: number | null;
  piece: number;
}

export interface Water {
  name: string;
  fennel: boolean;
  line?: XY[];
  ring?: XY[];
}

// ground codes in tile rasters
export const G_GRASS = 0, G_LAKE = 1, G_CREEK = 2, G_ROAD = 20; // road = 20 + class index

const TILE = 128;
const ROAD_R = 6;

export interface Tile {
  ground: Uint8Array;
  pipe: Uint8Array;
}

export class World {
  readonly P = localProjection();
  readonly runs: Run[] = [];
  readonly pieceNames: string[] = [];
  readonly pipes: XY[][] = [];
  readonly waters: Water[] = [];
  readonly drains: XY[] = [];
  readonly ponds: XY[][] = [];
  readonly bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  /** middle of town, weighted by street length */
  readonly center: XY;
  private readonly runIdx = new GridIndex<number>(80);
  private readonly pipeIdx = new GridIndex<number>(80);
  private readonly waterIdx = new GridIndex<number>(200);
  private readonly drainIdx = new GridIndex<number>(60);
  private readonly tiles = new Map<number, Tile>();
  private readonly runBox = new BoxGrid(1000);
  private readonly waterBox = new BoxGrid(2000);
  // how much of the bundle is in so far
  private nAssets = 0;
  private nWaters = 0;
  private nPonds = 0;

  data: TireTrailData;

  constructor(data: TireTrailData) {
    this.data = data;
    this.ingest();
    let sx = 0, sy = 0, sw = 0;
    for (const r of this.runs) for (let k = 1; k < r.line.length; k++) {
      const [a, c] = [r.line[k - 1], r.line[k]], len = dist(a, c);
      [sx, sy, sw] = [sx + ((a[0] + c[0]) / 2) * len, sy + ((a[1] + c[1]) / 2) * len, sw + len];
    }
    this.center = [sx / sw, sy / sw];
  }

  /** Takes in what a bigger bundle (this one with more appended) adds. Returns the first new run. */
  add(data: TireTrailData): number {
    this.data = data;
    const first = this.runs.length, bb = this.ingest();
    // tiles under the new streets and water get drawn again
    for (const key of [...this.tiles.keys()]) {
      const tx = Math.floor(key / 8192) - 4096, ty = (key % 8192) - 4096;
      if (tx * TILE <= bb.x1 + 20 && (tx + 1) * TILE >= bb.x0 - 20 && ty * TILE <= bb.y1 + 20 && (ty + 1) * TILE >= bb.y0 - 20) this.tiles.delete(key);
    }
    this.lastKey = -1;
    this.lastTile = null;
    return first;
  }

  private ingest(): { x0: number; y0: number; x1: number; y1: number } {
    const data = this.data, b = data.bundle;
    // y flipped so north is up on screen
    const xy = (c: [number, number]): XY => { const p = this.P.toXY(c); return [p[0], -p[1]]; };
    const nb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (q: BBox) => {
      if (q.minX < nb.x0) nb.x0 = q.minX;
      if (q.minY < nb.y0) nb.y0 = q.minY;
      if (q.maxX > nb.x1) nb.x1 = q.maxX;
      if (q.maxY > nb.y1) nb.y1 = q.maxY;
    };
    const ps = b.streets.pieces;
    for (let i = this.pieceNames.length; i < ps.length; i++) this.pieceNames.push(ps[i].name);
    const R = b.streets.runs;
    for (let i = this.runs.length; i < R.geom.length; i++) {
      const line = decodeCoords(R.geom[i]).map(xy), d = R.drain[i], q = bboxOf(line);
      this.runs.push({ i, line, k: clsIndex(R.cls[i]), drain: d < 0 ? null : d, piece: R.piece[i] });
      this.runIdx.insert(i, q);
      this.runBox.insert(i, q.minX, q.minY, q.maxX, q.maxY);
      grow(q);
    }
    const A = b.assets;
    for (let i = this.nAssets; i < A.kind.length; i++) {
      const k = A.kind[i];
      if (k !== 5 && k !== 6) continue; // pipes and ditches
      const line = decodeCoords(A.geom[i]).map(xy);
      this.pipeIdx.insert(this.pipes.length, bboxOf(line));
      this.pipes.push(line);
    }
    this.nAssets = A.kind.length;
    for (let i = this.nWaters; i < b.waters.length; i++) {
      const w = b.waters[i];
      for (const l of w.lines) grow(this.addWater({ name: w.name, fennel: w.fennel, line: decodeCoords(l).map(xy) }));
      for (const r of w.rings) grow(this.addWater({ name: w.name, fennel: w.fennel, ring: decodeCoords(r).map(xy) }));
    }
    this.nWaters = b.waters.length;
    for (let i = this.drains.length; i < data.drainCount; i++) {
      const p = xy(data.drain(i).lngLat);
      this.drainIdx.insertPoint(i, p);
      this.drains.push(p);
    }
    for (let i = this.nPonds; i < b.pondShapes.length; i++) this.ponds.push(decodeCoords(b.pondShapes[i][1]).map(xy));
    this.nPonds = b.pondShapes.length;
    const B = this.bounds;
    if (nb.x0 < B.x0) B.x0 = nb.x0;
    if (nb.y0 < B.y0) B.y0 = nb.y0;
    if (nb.x1 > B.x1) B.x1 = nb.x1;
    if (nb.y1 > B.y1) B.y1 = nb.y1;
    return nb;
  }

  private addWater(w: Water): BBox {
    const q = bboxOf(w.line ?? w.ring!);
    this.waterIdx.insert(this.waters.length, q);
    this.waterBox.insert(this.waters.length, q.minX, q.minY, q.maxX, q.maxY);
    this.waters.push(w);
    return q;
  }

  toWorld(lngLat: [number, number]): XY {
    const p = this.P.toXY(lngLat);
    return [p[0], -p[1]];
  }

  runsNear(p: XY, r: number): number[] { return this.runIdx.near(p, r); }
  /** runs whose box meets a world box, for drawing */
  runsIn(x0: number, y0: number, x1: number, y1: number, out?: number[]): number[] { return this.runBox.query(x0, y0, x1, y1, out); }
  watersIn(x0: number, y0: number, x1: number, y1: number, out?: number[]): number[] { return this.waterBox.query(x0, y0, x1, y1, out); }
  drainsNear(p: XY, r: number): number[] { return this.drainIdx.near(p, r); }
  pipesNear(p: XY, r: number): number[] { return this.pipeIdx.near(p, r); }
  watersNear(p: XY, r: number): number[] { return this.waterIdx.near(p, r); }

  /** The run drawn under p, within maxM: where streets overlap, the class drawn on top wins. halfW = drawn half width, m. */
  runAtDrawn(p: XY, maxM: number, halfW = ROAD_R): Run | null {
    const near: { r: Run; d: number }[] = [];
    for (const i of this.runIdx.near(p, maxM)) {
      const d = nearestOnPolyline(p, this.runs[i].line).d;
      if (d <= maxM) near.push({ r: this.runs[i], d });
    }
    if (!near.length) return null;
    let first = near[0];
    for (const c of near) if (c.d < first.d) first = c;
    // the spot that counts: under the finger, or the nearest street's closest point
    const q = first.d <= halfW ? null : nearestOnPolyline(p, first.r.line).point;
    let best = first;
    for (const c of near) {
      if (c === first || (q ? nearestOnPolyline(q, c.r.line).d : c.d) > halfW) continue;
      const a = RANK[c.r.k], b = RANK[best.r.k];
      if (a > b || (a === b && c.d < best.d)) best = c;
    }
    return best.r;
  }

  private readonly byPiece = new Map<number, Run[]>();
  private byPieceN = -1;

  /** Every run of this run's street piece with the same answer, in order. */
  stretchOf(run: Run): Run[] {
    if (this.byPieceN !== this.runs.length) {
      this.byPiece.clear();
      for (const r of this.runs) { const l = this.byPiece.get(r.piece); if (l) l.push(r); else this.byPiece.set(r.piece, [r]); }
      this.byPieceN = this.runs.length;
    }
    return (this.byPiece.get(run.piece) ?? [run]).filter((r) => r.k === run.k);
  }

  /** The lake or creek at p, or the nearest within maxM; d = 0 inside a lake. */
  waterAt(p: XY, maxM: number): { w: Water; d: number } | null {
    let best: Water | null = null, bd = Infinity;
    for (const i of this.waterIdx.near(p, maxM)) {
      const w = this.waters[i];
      const d = w.ring ? (pointInPolygon(p, [w.ring]) ? 0 : nearestOnPolyline(p, [...w.ring, w.ring[0]]).d) : nearestOnPolyline(p, w.line!).d;
      if (d > maxM) continue;
      // copies of one lake: the named one
      if (d < bd || (d === bd && named(w) && !named(best))) [best, bd] = [w, d];
    }
    return best ? { w: best, d: bd } : null;
  }

  /** A stream where coho salmon live. */
  isCoho(w: Water): boolean {
    return w.fennel && !!w.line && !NOT_COHO.test(w.name);
  }

  /** A drain's answer as a run class. */
  drainCls(i: number): Cls {
    const b = this.data.bundle;
    return CLS[clsIndex(b.endings[b.drains.ending[i]].cls)];
  }

  /** Street run closest to p, within maxM. */
  nearestRun(p: XY, maxM: number): Run | null {
    let best: Run | null = null;
    let bestD = maxM;
    for (const i of this.runIdx.near(p, maxM)) {
      const d = nearestOnPolyline(p, this.runs[i].line).d;
      if (d < bestD) [best, bestD] = [this.runs[i], d];
    }
    return best;
  }

  /** Ground code at world point (1 m cells). */
  groundAt(x: number, y: number): number {
    const t = this.tileAt(x, y);
    return t.ground[this.cell(x, y)];
  }

  pipeAt(x: number, y: number): number {
    const t = this.tileAt(x, y);
    return t.pipe[this.cell(x, y)];
  }

  private cell(x: number, y: number): number {
    const lx = Math.floor(x) - Math.floor(x / TILE) * TILE;
    const ly = Math.floor(y) - Math.floor(y / TILE) * TILE;
    return ly * TILE + lx;
  }

  private lastKey = -1;
  private lastTile: Tile | null = null;

  private tileAt(x: number, y: number): Tile {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const key = (tx + 4096) * 8192 + (ty + 4096);
    if (key === this.lastKey) return this.lastTile!; // neighboring pixels nearly always share a tile
    let t = this.tiles.get(key);
    if (!t) {
      t = this.buildTile(tx, ty);
      if (this.tiles.size > 400) this.tiles.delete(this.tiles.keys().next().value!);
      this.tiles.set(key, t);
    }
    this.lastKey = key;
    this.lastTile = t;
    return t;
  }

  private buildTile(tx: number, ty: number): Tile {
    const x0 = tx * TILE, y0 = ty * TILE;
    const ground = new Uint8Array(TILE * TILE);
    const pipe = new Uint8Array(TILE * TILE);
    const c: XY = [x0 + TILE / 2, y0 + TILE / 2];
    const reach = TILE * 0.75 + 12;
    for (const i of this.waterIdx.near(c, reach)) {
      const w = this.waters[i];
      if (w.ring) fillRing(ground, x0, y0, w.ring, G_LAKE);
      else stampLine(ground, x0, y0, w.line!, 2.4, G_CREEK);
    }
    // unmapped first, so creek and ground streets win where roads meet
    const near = this.runIdx.near(c, reach).map((i) => this.runs[i]);
    for (const k of DRAW) for (const r of near) if (r.k === k) stampLine(ground, x0, y0, r.line, ROAD_R, G_ROAD + k);
    for (const i of this.pipeIdx.near(c, reach)) stampLine(pipe, x0, y0, this.pipes[i], 1.6, 1);
    return { ground, pipe };
  }

  /** Is p inside any pond outline? */
  inPond(p: XY): boolean {
    return this.ponds.some((ring) => pointInPolygon(p, [ring]));
  }

  /** Nearest lake or creek cell to p within r meters, or null. */
  nearestWater(p: XY, r: number): XY | null {
    let best: XY | null = null, bestD = Infinity;
    const step = r > 50 ? 2 : 1;
    for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) {
      const d = dx * dx + dy * dy;
      if (d >= bestD || d > r * r) continue;
      const g = this.groundAt(p[0] + dx, p[1] + dy);
      if (g === G_LAKE || g === G_CREEK) [best, bestD] = [[p[0] + dx, p[1] + dy], d];
    }
    return best;
  }

  distance(a: XY, b: XY): number { return dist(a, b); }
}

function stampLine(g: Uint8Array, x0: number, y0: number, pts: XY[], r: number, code: number): void {
  for (let s = 1; s < pts.length; s++) {
    const [ax, ay] = pts[s - 1], [bx, by] = pts[s];
    const minX = Math.max(x0, Math.floor(Math.min(ax, bx) - r)), maxX = Math.min(x0 + TILE - 1, Math.ceil(Math.max(ax, bx) + r));
    const minY = Math.max(y0, Math.floor(Math.min(ay, by) - r)), maxY = Math.min(y0 + TILE - 1, Math.ceil(Math.max(ay, by) + r));
    if (minX > maxX || minY > maxY) continue;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x + .5 - ax) * dx + (y + .5 - ay) * dy) / L2));
      const ex = ax + t * dx - x - .5, ey = ay + t * dy - y - .5;
      if (ex * ex + ey * ey <= r * r) g[(y - y0) * TILE + (x - x0)] = code;
    }
  }
}

function fillRing(g: Uint8Array, x0: number, y0: number, ring: XY[], code: number): void {
  for (let y = y0; y < y0 + TILE; y++) {
    const xs: number[] = [];
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
      const [x1, y1] = ring[k], [x2, y2] = ring[j];
      if ((y1 > y + .5) !== (y2 > y + .5)) xs.push(x1 + ((y + .5 - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(x0, Math.ceil(xs[k] - .5)); x <= Math.min(x0 + TILE - 1, xs[k + 1] - .5); x++) g[(y - y0) * TILE + (x - x0)] = code;
    }
  }
}

/** Coarse grid of boxes for "what's in view": each id once per query, in id order. */
export class BoxGrid {
  private readonly cells = new Map<number, number[]>();
  private boxes = new Float64Array(1024);
  private stamp = new Uint32Array(256);
  private tick = 0;
  private n = 0;
  private readonly cell: number;

  constructor(cell = 1000) {
    this.cell = cell;
  }

  insert(id: number, x0: number, y0: number, x1: number, y1: number): void {
    if (4 * id + 4 > this.boxes.length) { const g = new Float64Array(Math.max(this.boxes.length * 2, 4 * id + 4)); g.set(this.boxes); this.boxes = g; }
    const b = this.boxes, o = 4 * id, c = this.cell;
    b[o] = x0; b[o + 1] = y0; b[o + 2] = x1; b[o + 3] = y1;
    if (id >= this.n) this.n = id + 1;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
      const key = (i + 32768) * 65536 + (j + 32768), l = this.cells.get(key);
      if (l) l.push(id);
      else this.cells.set(key, [id]);
    }
  }

  query(x0: number, y0: number, x1: number, y1: number, out: number[] = []): number[] {
    out.length = 0;
    if (this.stamp.length < this.n) { const g = new Uint32Array(this.n * 2); g.set(this.stamp); this.stamp = g; }
    const t = ++this.tick, st = this.stamp, b = this.boxes, c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
      const l = this.cells.get((i + 32768) * 65536 + (j + 32768));
      if (l) for (const k of l) {
        if (st[k] === t) continue;
        st[k] = t;
        if (b[4 * k + 2] >= x0 && b[4 * k] <= x1 && b[4 * k + 3] >= y0 && b[4 * k + 1] <= y1) out.push(k);
      }
    }
    // a fixed draw order
    return out.sort((p, q) => p - q);
  }
}

export const OVERVIEW_FORMAT = 'tiretrail-overview';
export const OVERVIEW_SCALE = 1e5;

/** public/data/overview.json, from scripts/build-overview.ts */
export interface OverviewFile {
  format: typeof OVERVIEW_FORMAT;
  version: 1;
  scale: number;
  /** area ids; '' is the built-in Bonney Lake */
  areas: string[];
  /** runs per area, in order */
  per: number[];
  /** one class digit per run */
  cls: string;
  /** points per run */
  n: number[];
  /** [lon, lat] deltas across all runs */
  xy: number[];
}

/** Every traced street, simplified, in world meters. */
export class Overview {
  readonly count: number;
  readonly cls: Uint8Array;
  readonly area: Uint16Array;
  /** run k's points are pts[2*start[k] .. 2*start[k+1]) */
  readonly start: Uint32Array;
  readonly pts: Float32Array;
  readonly areaIds: string[];
  /** 1 once an area's own streets are in the world */
  readonly loaded: Uint8Array;
  readonly grid = new BoxGrid(1000);

  constructor(f: OverviewFile, toWorld: (lngLat: [number, number]) => XY) {
    const n = f.n.length, sc = f.scale;
    let total = 0;
    for (const k of f.n) total += k;
    this.count = n;
    this.cls = new Uint8Array(n);
    for (let k = 0; k < n; k++) this.cls[k] = clsIndex(f.cls.charCodeAt(k) - 48);
    this.area = new Uint16Array(n);
    for (let a = 0, k = 0; a < f.per.length; a++) for (let q = 0; q < f.per[a] && k < n; q++) this.area[k++] = a;
    this.areaIds = f.areas;
    this.loaded = new Uint8Array(f.areas.length);
    this.loaded[0] = 1; // Bonney Lake is built in
    this.start = new Uint32Array(n + 1);
    this.pts = new Float32Array(total * 2);
    let x = 0, y = 0, o = 0;
    for (let k = 0; k < n; k++) {
      this.start[k] = o;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let q = 0; q < f.n[k]; q++, o++) {
        x += f.xy[2 * o];
        y += f.xy[2 * o + 1];
        const p = toWorld([x / sc, y / sc]);
        this.pts[2 * o] = p[0];
        this.pts[2 * o + 1] = p[1];
        if (p[0] < bx0) bx0 = p[0];
        if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1];
        if (p[1] > by1) by1 = p[1];
      }
      this.grid.insert(k, bx0, by0, bx1, by1);
    }
    this.start[n] = o;
  }

  /** null unless it's an overview file this app reads */
  static read(j: unknown, toWorld: (lngLat: [number, number]) => XY): Overview | null {
    const f = j as Partial<OverviewFile> | null;
    if (!f || f.format !== OVERVIEW_FORMAT || f.version !== 1 || !Array.isArray(f.n) || !Array.isArray(f.xy) || !Array.isArray(f.per) || !Array.isArray(f.areas) || typeof f.cls !== 'string') return null;
    if (f.cls.length !== f.n.length || f.xy.length !== 2 * f.n.reduce((s, k) => s + k, 0)) return null;
    return new Overview(f as OverviewFile, toWorld);
  }

  markLoaded(id: string): void {
    const i = this.areaIds.indexOf(id);
    if (i >= 0) this.loaded[i] = 1;
  }

  /** Overview runs in a world box whose area isn't loaded yet. */
  missingIn(x0: number, y0: number, x1: number, y1: number, out: number[] = []): number[] {
    this.grid.query(x0, y0, x1, y1, out);
    let w = 0;
    for (const k of out) if (!this.loaded[this.area[k]]) out[w++] = k;
    out.length = w;
    return out;
  }
}
