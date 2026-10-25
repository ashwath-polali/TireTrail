// Small geometry and naming helpers for scripts/build-salmon.ts, here so tests can reach them.
import type { XY } from '../geo/geo.ts';

/** Where segments ab and cd cross, as t along ab (0 to 1), or -1. */
export function crossT(a: XY, b: XY, c: XY, d: XY): number {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qx = c[0] - a[0], qy = c[1] - a[1], t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance from p to segment ab. */
export function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** A plain stream name from SWIFD's, or '' for its unnamed ones ("Unnamed stream [1225128478056]"). */
export function cleanName(n: string): string {
  const s = n.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^unnamed/i.test(s) || /^(trib|tributary)\b/i.test(s) || /^\d/.test(s)) return '';
  return s;
}

/** A segment's direction, 0 to 179 degrees from north (region meters, y down). */
export function segDir(a: XY, b: XY): number {
  return ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 180;
}

/** Degrees between two directions either way along them, 0 to 90. */
export function dirGap(a: number, b: number): number {
  const d = (((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** where an OpenStreetMap waterway crosses a drivable road: the spot and the road's direction there */
export interface OsmCross { at: XY; dir: number }
/** a bridge piece of a drivable road */
export interface BridgeSeg { a: XY; b: XY; dir: number }

export const QUALITY = {
  /** an OSM crossing this close on the same road confirms it, m */
  sureM: 60,
  /** a bridge of the same road this close confirms it, m */
  bridgeM: 40,
  /** an OSM crossing this close makes it likely, m */
  likelyM: 150,
  /** the same road: its direction within this many degrees, and the OSM spot this close to its line, m */
  sameDeg: 35,
  sideM: 15,
  /** a named stream crossing the road at least this steeply is likely, degrees */
  steepDeg: 30,
};

/**
 * How sure a crossing is: 2 confirmed by OpenStreetMap (a waterway crosses the same road within 60 m, or a bridge of it within 40 m),
 * 1 likely (an OSM crossing within 150 m, or a named stream that cuts the road at 30 degrees or more), 0 doubtful (a stream line
 * beside the road, an unnamed ditch or buried stream). at: the OSM spot when it confirms, for better timing.
 * dir: the road's direction at the crossing; angle: between the stream and the road there, degrees.
 */
export function classifyCrossing(at: XY, dir: number, xs: readonly OsmCross[], bridges: readonly BridgeSeg[], angle: number, named: boolean): { q: 0 | 1 | 2; at: XY | null } {
  const Q = QUALITY, rad = (dir * Math.PI) / 180, ux = Math.sin(rad), uy = -Math.cos(rad);
  let sure: XY | null = null, sd = Q.sureM, likely = false;
  for (const x of xs) {
    const dx = x.at[0] - at[0], dy = x.at[1] - at[1], d = Math.hypot(dx, dy);
    if (d <= Q.likelyM) likely = true;
    // on the same road: running the same way, and on its line rather than a road beside it
    if (d <= sd && dirGap(x.dir, dir) <= Q.sameDeg && Math.abs(dx * uy - dy * ux) <= Q.sideM) [sure, sd] = [x.at, d];
  }
  if (sure) return { q: 2, at: sure };
  if (bridges.some((b) => dirGap(b.dir, dir) <= Q.sameDeg && segDist(at, b.a, b.b) <= Q.bridgeM)) return { q: 2, at: null };
  return { q: likely || (named && angle >= Q.steepDeg) ? 1 : 0, at: null };
}

/**
 * Where a stream line that stops short of a road really crosses it: the OSM crossing nearest the line's end e, within 50 m,
 * of a waterway with the same name (unnamed: e within 45 m of it). Never invents one: null unless OSM has it.
 */
export function endSnap<T extends OsmCross & { name: string }>(e: XY, name: string, xs: readonly T[]): T | null {
  let best: T | null = null, bd = 50;
  const want = name.toLowerCase();
  for (const x of xs) {
    const d = Math.hypot(x.at[0] - e[0], x.at[1] - e[1]);
    if (d > bd) continue;
    if (x.name ? cleanName(x.name).toLowerCase() !== want || !want : d > 45) continue;
    [best, bd] = [x, d];
  }
  return best;
}
