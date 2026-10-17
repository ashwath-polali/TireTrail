// Map data in local meters, plus 1 m tile rasters built on demand.
import { bboxOf, dist, GridIndex, localProjection, nearestOnPolyline, pointInPolygon, type XY } from '../../geo/geo.ts';
import { decodeCoords } from '../../data/bundle.ts';
import type { TireTrailData } from '../../data/tiretrail.ts';

export const CLS = ['creek', 'ground', 'elsewhere', 'unknown', 'none'] as const;
export type Cls = (typeof CLS)[number];

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
  readonly pieceNames: string[];
  readonly pipes: XY[][] = [];
  readonly waters: Water[] = [];
  readonly drains: XY[] = [];
  readonly ponds: XY[][] = [];
  readonly bounds: { x0: number; y0: number; x1: number; y1: number };
  /** middle of town, weighted by street length */
  readonly center: XY;
  private readonly runIdx = new GridIndex<number>(80);
  private readonly pipeIdx = new GridIndex<number>(80);
  private readonly waterIdx = new GridIndex<number>(200);
  private readonly drainIdx = new GridIndex<number>(60);
  private readonly tiles = new Map<number, Tile>();

  readonly data: TireTrailData;

  constructor(data: TireTrailData) {
    this.data = data;
    const b = data.bundle;
    // y flipped so north is up on screen
    const xy = (c: [number, number]): XY => { const p = this.P.toXY(c); return [p[0], -p[1]]; };
    this.pieceNames = b.streets.pieces.map((p) => p.name);
    b.streets.runs.geom.forEach((g, i) => {
      const line = decodeCoords(g).map(xy);
      const d = b.streets.runs.drain[i];
      this.runs.push({ i, line, k: b.streets.runs.cls[i], drain: d < 0 ? null : d, piece: b.streets.runs.piece[i] });
      this.runIdx.insert(i, bboxOf(line));
    });
    b.assets.kind.forEach((k, i) => {
      if (k !== 5 && k !== 6) return; // pipes and ditches
      const line = decodeCoords(b.assets.geom[i]).map(xy);
      this.pipeIdx.insert(this.pipes.length, bboxOf(line));
      this.pipes.push(line);
    });
    for (const w of b.waters) {
      for (const l of w.lines) this.addWater({ name: w.name, fennel: w.fennel, line: decodeCoords(l).map(xy) });
      for (const r of w.rings) this.addWater({ name: w.name, fennel: w.fennel, ring: decodeCoords(r).map(xy) });
    }
    for (let i = 0; i < data.drainCount; i++) {
      const p = xy(data.drain(i).lngLat);
      this.drainIdx.insertPoint(i, p);
      this.drains.push(p);
    }
    for (const [, ring] of b.pondShapes) this.ponds.push(decodeCoords(ring).map(xy));
    let sx = 0, sy = 0, sw = 0;
    for (const r of this.runs) for (let k = 1; k < r.line.length; k++) {
      const [a, c] = [r.line[k - 1], r.line[k]], len = dist(a, c);
      [sx, sy, sw] = [sx + ((a[0] + c[0]) / 2) * len, sy + ((a[1] + c[1]) / 2) * len, sw + len];
    }
    this.center = [sx / sw, sy / sw];
    const all = this.runs.flatMap((r) => r.line);
    const bb = bboxOf(all);
    this.bounds = { x0: bb.minX, y0: bb.minY, x1: bb.maxX, y1: bb.maxY };
  }

  private addWater(w: Water): void {
    const pts = w.line ?? w.ring!;
    this.waterIdx.insert(this.waters.length, bboxOf(pts));
    this.waters.push(w);
  }

  toWorld(lngLat: [number, number]): XY {
    const p = this.P.toXY(lngLat);
    return [p[0], -p[1]];
  }

  runsNear(p: XY, r: number): number[] { return this.runIdx.near(p, r); }
  drainsNear(p: XY, r: number): number[] { return this.drainIdx.near(p, r); }
  pipesNear(p: XY, r: number): number[] { return this.pipeIdx.near(p, r); }

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
    for (const k of [4, 3, 2, 1, 0]) for (const r of near) if (r.k === k) stampLine(ground, x0, y0, r.line, ROAD_R, G_ROAD + k);
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
