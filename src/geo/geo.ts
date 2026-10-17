// Flat geometry in local meters (x east, y north of a fixed Bonney Lake origin).

export type LngLat = [lon: number, lat: number];
export type XY = [x: number, y: number];

/** Fixed origin near Bonney Lake center. */
export const ORIGIN: LngLat = [-122.18, 47.17];

export interface Projection {
  toXY(p: LngLat): XY;
  toLngLat(p: XY): LngLat;
  readonly metersPerDegLon: number;
  readonly metersPerDegLat: number;
}

export function localProjection(origin: LngLat = ORIGIN): Projection {
  const phi = (origin[1] * Math.PI) / 180;
  // meters per degree at this latitude (WGS84)
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  return {
    metersPerDegLon: mLon,
    metersPerDegLat: mLat,
    toXY: ([lon, lat]) => [(lon - origin[0]) * mLon, (lat - origin[1]) * mLat],
    toLngLat: ([x, y]) => [origin[0] + x / mLon, origin[1] + y / mLat],
  };
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(line: readonly XY[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += dist(line[i - 1], line[i]);
  return total;
}

/** Closest point on a polyline: distance, distance along, and the point. */
export interface OnLine {
  d: number;
  along: number;
  point: XY;
}

export function nearestOnPolyline(p: XY, line: readonly XY[]): OnLine {
  if (line.length === 1) return { d: dist(p, line[0]), along: 0, point: line[0] };
  let best: OnLine = { d: Infinity, along: 0, point: line[0] };
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    // project p onto segment a-b, clamped
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const q: XY = [a[0] + t * dx, a[1] + t * dy];
    const d = dist(p, q);
    const segLen = Math.sqrt(len2);
    if (d < best.d) best = { d, along: walked + t * segLen, point: q };
    walked += segLen;
  }
  return best;
}

/** Point `along` meters from the start (clamped). */
export function pointAlong(line: readonly XY[], along: number): XY {
  if (along <= 0 || line.length === 1) return line[0];
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = dist(line[i - 1], line[i]);
    if (walked + seg >= along) {
      const t = seg === 0 ? 0 : (along - walked) / seg;
      const a = line[i - 1];
      const b = line[i];
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    walked += seg;
  }
  return line[line.length - 1];
}

/** Part of a polyline between two distances. */
export function slicePolyline(line: readonly XY[], from: number, to: number): XY[] {
  const out: XY[] = [pointAlong(line, from)];
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    walked += dist(line[i - 1], line[i]);
    if (walked > from && walked < to) out.push(line[i]);
  }
  out.push(pointAlong(line, to));
  return out;
}

/** Even-odd test over a polygon's rings (outer + holes). */
export function pointInPolygon(p: XY, rings: readonly (readonly XY[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Distance to polygons: 0 inside, else to the nearest edge. */
export function distanceToPolygons(p: XY, polygons: readonly (readonly (readonly XY[])[])[]): number {
  let best = Infinity;
  for (const rings of polygons) {
    if (pointInPolygon(p, rings)) return 0;
    for (const ring of rings) best = Math.min(best, nearestOnPolyline(p, ring).d);
  }
  return best;
}

/** Area-weighted centroid of outer rings (holes ignored). */
export function polygonsCentroid(polygons: readonly (readonly (readonly XY[])[])[]): XY {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const rings of polygons) {
    const ring = rings[0];
    let a = 0;
    let x = 0;
    let y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += cross;
      x += (ring[j][0] + ring[i][0]) * cross;
      y += (ring[j][1] + ring[i][1]) * cross;
    }
    // ring orientation varies, so weight by absolute area
    const w = Math.abs(a);
    if (w > 0) {
      area += w;
      cx += (x / (3 * a)) * w;
      cy += (y / (3 * a)) * w;
    }
  }
  if (area === 0) return polygons[0][0][0];
  return [cx / area, cy / area];
}

export function polygonsArea(polygons: readonly (readonly (readonly XY[])[])[]): number {
  let total = 0;
  for (const rings of polygons) {
    rings.forEach((ring, k) => {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      total += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total;
}

/** Douglas-Peucker, display only. */
export function simplify(line: readonly XY[], tol: number): XY[] {
  if (line.length < 3) return [...line];
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = nearestOnPolyline(line[i], [line[a], line[b]]).d;
      if (d > worstD) [worst, worstD] = [i, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(points: readonly XY[]): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

/** Uniform grid index. Items go in every cell their bbox touches. */
export class GridIndex<T> {
  private readonly cells = new Map<number, T[]>();
  private readonly cell: number;

  constructor(cellSize: number) {
    this.cell = cellSize;
  }

  // col/row packed into one number (far fewer than 2^20 cells)
  private key(ix: number, iy: number): number {
    return (ix + 524288) * 1048576 + (iy + 524288);
  }

  insert(item: T, b: BBox): void {
    const x0 = Math.floor(b.minX / this.cell);
    const x1 = Math.floor(b.maxX / this.cell);
    const y0 = Math.floor(b.minY / this.cell);
    const y1 = Math.floor(b.maxY / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const k = this.key(ix, iy);
        const list = this.cells.get(k);
        if (list) list.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }

  insertPoint(item: T, p: XY): void {
    this.insert(item, { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] });
  }

  /** Candidates whose bbox may be within r of p. */
  near(p: XY, r: number): T[] {
    const x0 = Math.floor((p[0] - r) / this.cell);
    const x1 = Math.floor((p[0] + r) / this.cell);
    const y0 = Math.floor((p[1] - r) / this.cell);
    const y1 = Math.floor((p[1] + r) / this.cell);
    const seen = new Set<T>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (list) for (const item of list) seen.add(item);
      }
    }
    return [...seen];
  }
}
