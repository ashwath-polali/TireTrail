// Stop spots: lights and stop signs where the driver usually comes to a full stop, learned from saved drives.
// Stops within 40 m, going about the same way, are one spot. A spot needs 2 or more stops on 2 or more drives.
import { dist, localProjection, type LngLat, type XY } from '../../geo/geo.ts';
import type { DriveReport } from '../analyze.ts';
import { turnBetween } from '../limits.ts';
import type { StopPoint } from '../summary.ts';

const P = localProjection();
/** stops this close are one spot, meters */
export const STOP_SPOT_M = 40;
/** and going within this many degrees of each other */
const SAME_WAY = 45;

export interface StopSpot {
  /** stays the same while the spot's stops don't change */
  id: string;
  lngLat: LngLat;
  /** degrees from north the car was going as it stopped, null if unknown */
  heading: number | null;
  /** stops here */
  count: number;
  /** drives with a stop here */
  drives: number;
  /** of them, hard stops */
  hard: number;
  /** ms, the latest stop here */
  last: number;
  /** street, '' if unknown */
  name: string;
  /** from one drive, to show what a reminder looks like; never saved */
  example: boolean;
}

/** what stop spots need from a saved drive */
export interface StopDrive {
  at: number;
  stopPts?: readonly StopPoint[];
}

interface Group { pts: { p: StopPoint; at: number; xy: XY }[]; xy: XY; heading: number | null }

const sameWay = (a: number | null, b: number | null) => a == null || b == null || turnBetween(a, b) <= SAME_WAY;

/** circular mean of headings, null with none */
export function meanHeading(hs: readonly number[]): number | null {
  if (!hs.length) return null;
  const x = hs.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0), y = hs.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
  return Math.hypot(x, y) < 1e-9 ? null : ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function group(drives: readonly StopDrive[]): Group[] {
  const pts = drives.flatMap((d) => (d.stopPts ?? []).map((p) => ({ p, at: d.at, xy: P.toXY([p.lon, p.lat]) }))).sort((a, b) => a.p.t - b.p.t);
  const groups: Group[] = [];
  for (const q of pts) {
    let best: Group | null = null, bd = STOP_SPOT_M;
    for (const g of groups) {
      const d = dist(g.xy, q.xy);
      if (d <= bd && sameWay(g.heading, q.p.heading)) [best, bd] = [g, d];
    }
    if (!best) groups.push((best = { pts: [], xy: q.xy, heading: null }));
    best.pts.push(q);
    const n = best.pts.length;
    best.xy = [best.pts.reduce((s, x) => s + x.xy[0], 0) / n, best.pts.reduce((s, x) => s + x.xy[1], 0) / n];
    best.heading = meanHeading(best.pts.flatMap((x) => (x.p.heading == null ? [] : [x.p.heading])));
  }
  return groups;
}

function spotOf(g: Group, example: boolean): StopSpot {
  const ll = P.toLngLat(g.xy), lngLat: LngLat = [Math.round(ll[0] * 1e6) / 1e6, Math.round(ll[1] * 1e6) / 1e6];
  const named = [...g.pts].reverse().find((x) => x.p.name);
  return {
    id: `stop:${lngLat[0].toFixed(4)},${lngLat[1].toFixed(4)},${g.pts.length}`,
    lngLat,
    heading: g.heading == null ? null : Math.round(g.heading),
    count: g.pts.length,
    drives: new Set(g.pts.map((x) => x.at)).size,
    hard: g.pts.filter((x) => x.p.hard).length,
    last: Math.max(...g.pts.map((x) => x.p.t)),
    name: named?.p.name ?? '',
    example,
  };
}

/** Stop spots from saved drives, most stops first. Drives saved before the coach have no stops and add nothing. */
export function stopSpotsFrom(drives: readonly StopDrive[]): StopSpot[] {
  return group(drives)
    .map((g) => spotOf(g, false))
    .filter((s) => s.count >= 2 && s.drives >= 2)
    .sort((a, b) => b.count - a.count || b.last - a.last);
}

/** One drive's stops as example spots, so a sample run can show "we'd say coast here". */
export function exampleStopSpots(report: Pick<DriveReport, 'stops'>): StopSpot[] {
  const pts: StopPoint[] = report.stops.map((s) => ({ t: s.t, lat: s.lngLat[1], lon: s.lngLat[0], heading: s.heading, hard: s.hard, usd: 0, name: '' }));
  return group([{ at: 0, stopPts: pts }]).map((g) => spotOf(g, true)).sort((a, b) => a.last - b.last);
}
