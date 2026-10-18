// Posted speed limits on big roads, from OpenStreetMap (data/majorroads.json, built by scripts/build-majorroads.ts).
// A GPS point snaps to the nearest road with a known limit within 25 m that runs the same way as the car.
import { decodeCoords } from '../data/bundle.ts';
import { GridIndex, localProjection, type LngLat, type XY } from '../geo/geo.ts';

export interface RoadsFile {
  roads: (number | string)[][];
  /** posted limit per road, mph; 0 = not known */
  mph?: number[];
}

export interface Limit {
  mph: number;
  /** route number, e.g. "SR 410", or '' */
  ref: string;
  name: string;
  /** meters from the road */
  d: number;
}

interface Seg { a: XY; b: XY; road: number; bearing: number }

const P = localProjection();
const CELL = 100;

/** degrees from north, 0 to 360 */
export function bearing(a: XY, b: XY): number {
  return ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/** angle between two headings, 0 to 180 */
export function turnBetween(h1: number, h2: number): number {
  return Math.abs((((h1 - h2) % 360) + 540) % 360 - 180);
}

export class SpeedLimits {
  private readonly grid = new GridIndex<number>(CELL);
  private readonly segs: Seg[] = [];
  private readonly roads: { mph: number; ref: string; name: string }[] = [];

  constructor(file: RoadsFile) {
    file.roads.forEach((r, i) => {
      const mph = file.mph?.[i] ?? 0;
      if (!mph) return;
      const k = this.roads.push({ mph, ref: String(r[1] ?? ''), name: String(r[2] ?? '') }) - 1;
      const pts = decodeCoords(r.slice(3) as number[]).map(P.toXY);
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1], b = pts[j];
        const n = this.segs.push({ a, b, road: k, bearing: bearing(a, b) }) - 1;
        this.grid.insert(n, { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) });
      }
    });
  }

  /** roads with a known limit */
  get size(): number {
    return this.roads.length;
  }

  /**
   * The posted limit where the car is, or null if no road with a known limit is within maxM.
   * heading: degrees from north; a road must run within 40 degrees of it (either way). null skips the check.
   */
  at(p: LngLat, heading: number | null = null, maxM = 25): Limit | null {
    const xy = P.toXY(p);
    let best: Seg | null = null, bd = maxM;
    for (const n of this.grid.near(xy, maxM)) {
      const s = this.segs[n];
      if (heading != null && Math.min(turnBetween(heading, s.bearing), 180 - turnBetween(heading, s.bearing)) > 40) continue;
      const d = segDist(xy, s.a, s.b);
      if (d <= bd) [best, bd] = [s, d];
    }
    if (!best) return null;
    const r = this.roads[best.road];
    return { mph: r.mph, ref: r.ref, name: r.name, d: bd };
  }
}

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

let asked: Promise<SpeedLimits | null> | null = null;

/** Loads the limits once (later calls share it). null if the file can't load; the next call tries again. */
export function loadLimits(url = 'data/majorroads.json'): Promise<SpeedLimits | null> {
  if (!asked) {
    const p = (asked = fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<RoadsFile>) : null))
      .then((j) => (j && Array.isArray(j.roads) ? new SpeedLimits(j) : null))
      .catch(() => null));
    void p.then((l) => { if (!l && asked === p) asked = null; });
  }
  return asked;
}
