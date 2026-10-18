// Hard-brake spots: places a driver keeps braking hard, learned from saved drives, so the app can warn before the next one.
// Hard brakes within 60 m, going about the same way, are one spot. A spot counts with 2 or more hard brakes
// on 2 or more drives, or 1 very hard one (10 mph or more in one second).
import { dist, localProjection, type LngLat, type XY } from '../geo/geo.ts';
import type { DriveReport } from './analyze.ts';
import { bearing, turnBetween } from './limits.ts';
import { brakePoint, type BrakePoint } from './summary.ts';
import type { StopClass } from './tips.ts';
import type { Fix } from './types.ts';

const P = localProjection();
/** brakes this close are one spot, meters */
export const SPOT_M = 60;
/** and going within this many degrees of each other */
const SAME_WAY = 45;
/** warn this many seconds before reaching a spot */
export const AHEAD_S = 10;
/** the car must be heading within this many degrees of the way the hard brakes went */
const AHEAD_TURN = 35;
/** no warnings below this speed, m/s (about 9 mph) */
const MIN_MPS = 4;

export interface Spot {
  /** stays the same while the spot's brakes don't change */
  id: string;
  lngLat: LngLat;
  /** degrees from north the car was going, null if unknown */
  heading: number | null;
  /** hard brakes here */
  count: number;
  /** drives with a hard brake here */
  drives: number;
  /** of them, slowed 10 mph or more in one second */
  veryHard: number;
  /** ms, the latest hard brake here */
  last: number;
  /** street, '' if unknown */
  name: string;
  /** where its rain goes ('creek' = a salmon stream), the most common among its brakes */
  cls: StopClass;
  /** its rain reaches a salmon stream */
  salmon: boolean;
  /** from the sample drive, to show what a reminder looks like; never saved */
  example: boolean;
}

interface Group { pts: { b: BrakePoint; at: number; xy: XY }[]; xy: XY; heading: number | null }

const sameWay = (a: number | null, b: number | null) => a == null || b == null || turnBetween(a, b) <= SAME_WAY;

function meanHeading(hs: number[]): number | null {
  if (!hs.length) return null;
  const x = hs.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0), y = hs.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
  return Math.hypot(x, y) < 1e-9 ? null : ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function group(drives: readonly { at: number; brakes: readonly BrakePoint[] }[]): Group[] {
  const pts = drives.flatMap((d) => d.brakes.map((b) => ({ b, at: d.at, xy: P.toXY([b.lon, b.lat]) }))).sort((p, q) => p.b.t - q.b.t);
  const groups: Group[] = [];
  for (const p of pts) {
    let best: Group | null = null, bd = SPOT_M;
    for (const g of groups) {
      const d = dist(g.xy, p.xy);
      if (d <= bd && sameWay(g.heading, p.b.heading)) [best, bd] = [g, d];
    }
    if (!best) groups.push((best = { pts: [], xy: p.xy, heading: null }));
    best.pts.push(p);
    const n = best.pts.length;
    best.xy = [best.pts.reduce((s, q) => s + q.xy[0], 0) / n, best.pts.reduce((s, q) => s + q.xy[1], 0) / n];
    best.heading = meanHeading(best.pts.flatMap((q) => (q.b.heading == null ? [] : [q.b.heading])));
  }
  return groups;
}

function spotOf(g: Group, example: boolean): Spot {
  const pts = g.pts, ll = P.toLngLat(g.xy);
  const tally = new Map<StopClass, number>();
  for (const p of pts) tally.set(p.b.cls, (tally.get(p.b.cls) ?? 0) + 1);
  const cls = [...tally].sort((a, b) => b[1] - a[1])[0][0];
  const named = [...pts].reverse().find((p) => p.b.name);
  const lngLat: LngLat = [Math.round(ll[0] * 1e6) / 1e6, Math.round(ll[1] * 1e6) / 1e6];
  return {
    id: `${lngLat[0].toFixed(4)},${lngLat[1].toFixed(4)},${pts.length}`,
    lngLat,
    heading: g.heading == null ? null : Math.round(g.heading),
    count: pts.length,
    drives: new Set(pts.map((p) => p.at)).size,
    veryHard: pts.filter((p) => p.b.veryHard).length,
    last: Math.max(...pts.map((p) => p.b.t)),
    name: named?.b.name ?? '',
    cls,
    salmon: pts.some((p) => p.b.cls === 'creek'),
    example,
  };
}

/** Spots from saved drives (each drive's hard brakes), most hard brakes first. */
export function spotsFrom(drives: readonly { at: number; brakes: readonly BrakePoint[] }[]): Spot[] {
  return group(drives)
    .map((g) => spotOf(g, false))
    .filter((s) => (s.count >= 2 && s.drives >= 2) || s.veryHard >= 1)
    .sort((a, b) => b.count - a.count || b.last - a.last);
}

/** The sample drive's hard brakes as example spots, so a sample run can show "we'd remind you here". */
export function exampleSpots(report: DriveReport): Spot[] {
  return group([{ at: 0, brakes: report.brakes.map(brakePoint) }]).map((g) => spotOf(g, true)).sort((a, b) => a.last - b.last);
}

const speedOf = (f: Fix, prev: Fix | null | undefined) => {
  if (typeof f.speed === 'number' && Number.isFinite(f.speed) && f.speed >= 0) return f.speed;
  if (!prev || f.t <= prev.t) return 0;
  return dist(P.toXY([prev.lon, prev.lat]), P.toXY([f.lon, f.lat])) / ((f.t - prev.t) / 1000);
};

function headingOf(f: Fix, prev: Fix | null | undefined, v: number): number | null {
  if (typeof f.heading === 'number' && Number.isFinite(f.heading) && v >= 2) return ((f.heading % 360) + 360) % 360;
  if (!prev) return null;
  const a = P.toXY([prev.lon, prev.lat]), b = P.toXY([f.lon, f.lat]);
  return dist(a, b) >= 5 ? bearing(a, b) : null;
}

/**
 * The spot the car will reach within about 10 seconds at its current speed, or null.
 * fix: the newest GPS reading; prevFix: the one before, for speed and heading when the phone gives none.
 */
export function ahead(spots: readonly Spot[], fix: Fix, prevFix?: Fix | null): Spot | null {
  const v = speedOf(fix, prevFix);
  if (v < MIN_MPS) return null;
  const h = headingOf(fix, prevFix, v);
  if (h == null) return null;
  const car = P.toXY([fix.lon, fix.lat]), rad = (h * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
  const reach = Math.max(v * AHEAD_S, 40);
  let best: Spot | null = null, bestAlong = Infinity;
  for (const s of spots) {
    if (s.heading != null && turnBetween(s.heading, h) > AHEAD_TURN) continue;
    const p = P.toXY(s.lngLat), dx = p[0] - car[0], dy = p[1] - car[1];
    const along = dx * ux + dy * uy, cross = Math.abs(dx * uy - dy * ux);
    // in front, close to the line the car is on (roads bend a little)
    if (along < 0 || along > reach || cross > Math.max(25, along * 0.45)) continue;
    if (along < bestAlong) [best, bestAlong] = [s, along];
  }
  return best;
}

/** Live warnings: each spot once as the car comes up to it, again only after the car has been 150 m away. */
export class SpotAlarm {
  private readonly spots: readonly Spot[];
  private prev: Fix | null = null;
  private readonly warned = new Map<string, XY>();

  constructor(spots: readonly Spot[]) {
    this.spots = spots;
  }

  /** Call with each new GPS reading. Returns a spot the first time it is coming up, else null. */
  check(fix: Fix): Spot | null {
    const prev = this.prev;
    this.prev = fix;
    const car = P.toXY([fix.lon, fix.lat]);
    for (const [id, xy] of this.warned) if (dist(car, xy) > 150) this.warned.delete(id);
    const s = ahead(this.spots, fix, prev);
    if (!s || this.warned.has(s.id)) return null;
    this.warned.set(s.id, P.toXY(s.lngLat));
    return s;
  }
}
