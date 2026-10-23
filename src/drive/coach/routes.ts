// Regular trips: drives that start and end within 300 m of each other and follow a similar path.
// Named from known places (labels or the driver's own) when both ends are near one, else from the most driven street.
import { dist, localProjection, nearestOnPolyline, type LngLat, type XY } from '../../geo/geo.ts';
import { hardGasOf, pathPoints, type BrakePoint, type DriveSummary } from '../summary.ts';
import { plural } from './words.ts';

const P = localProjection();
/** start and end within this, meters */
export const ENDS_M = 300;
/** a path point within this of the other path counts as on it, meters */
const ON_PATH_M = 150;
/** share of each path that must be on the other */
const SAME_PATH = 0.7;
/** a place names an end within this, meters */
const PLACE_M = 250;

export interface Place {
  name: string;
  lngLat: LngLat;
}

/** what routes need from a saved drive */
export type RouteDrive = Pick<DriveSummary, 'at' | 'mi' | 'score' | 'hardBrakes' | 'gas' | 'hardGas' | 'brakes' | 'ways' | 'path'> & { fastStarts?: number };

export interface Route {
  /** the first drive's time, stays the same as drives are added */
  id: string;
  /** "Home to Bonney Lake High School", "Your 192nd Ave E trip" */
  name: string;
  /** drive times, oldest first */
  ats: number[];
  drives: number;
  avgScore: number;
  hardBrakesPerDrive: number;
  /** gas from hard starts and stops and from speeding, per drive, typical dollars */
  usdPerDrive: number;
  /** the last two drives: "Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E." */
  compare: string;
  start: LngLat;
  end: LngLat;
}

/** Schools and parks from labels.json as places. */
export function placesFromLabels(labels: { schools?: unknown[]; parks?: unknown[] } | null | undefined): Place[] {
  const out: Place[] = [];
  for (const row of [...(labels?.schools ?? []), ...(labels?.parks ?? [])]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) continue;
    out.push({ name: row[0], lngLat: [row[1] as number, row[2] as number] });
  }
  return out;
}

const xyPath = (d: RouteDrive): XY[] => pathPoints(d.path).map((p) => P.toXY(p));

// share of a's points within ON_PATH_M of b's line
function onShare(a: readonly XY[], b: readonly XY[]): number {
  if (b.length < 2) return 0;
  return a.filter((p) => nearestOnPolyline(p, b).d <= ON_PATH_M).length / a.length;
}

/** Same trip: ends within 300 m, and each path mostly on the other. */
export function sameTrip(a: RouteDrive, b: RouteDrive): boolean {
  const pa = xyPath(a), pb = xyPath(b);
  if (pa.length < 2 || pb.length < 2) return false;
  if (dist(pa[0], pb[0]) > ENDS_M || dist(pa[pa.length - 1], pb[pb.length - 1]) > ENDS_M) return false;
  return onShare(pa, pb) >= SAME_PATH && onShare(pb, pa) >= SAME_PATH;
}

function placeNear(p: LngLat, places: readonly Place[]): string {
  const xy = P.toXY(p);
  let best = '', bd = PLACE_M;
  for (const pl of places) {
    const d = dist(xy, P.toXY(pl.lngLat));
    if (d <= bd) [best, bd] = [pl.name, d];
  }
  return best;
}

/** A trip's name from its ends and streets. */
export function routeName(drives: readonly RouteDrive[], places: readonly Place[] = []): string {
  const pts = pathPoints(drives[0].path);
  const from = pts.length ? placeNear(pts[0], places) : '', to = pts.length ? placeNear(pts[pts.length - 1], places) : '';
  if (from && to && from !== to) return `${from} to ${to}`;
  if (to) return `Your trip to ${to}`;
  if (from) return `Your trip from ${from}`;
  const tally = new Map<string, number>();
  for (const d of drives) (d.ways ?? []).forEach((w, k) => tally.set(w, (tally.get(w) ?? 0) + (5 - Math.min(k, 4))));
  const way = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (way) return `Your ${way} trip`;
  const mi = drives.reduce((s, d) => s + d.mi, 0) / drives.length;
  return `Your ${Math.round(mi * 10) / 10} mile trip`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(d: Date): string {
  const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** Day words for two drives: "Monday" and "Tuesday"; "Mon Oct 5" when the weekday repeats; times on the same day. */
export function dayLabels(a: number, b: number): [string, string] {
  const da = new Date(a), db = new Date(b);
  if (da.toDateString() === db.toDateString()) return [clock(da), clock(db)];
  if (da.getDay() !== db.getDay() && Math.abs(b - a) < 6 * 86_400_000) return [DAYS[da.getDay()], DAYS[db.getDay()]];
  const short = (d: Date) => `${DAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return [short(da), short(db)];
}

// ", all at 192nd Ave E" when the brakes share a street
function where(brakes: readonly BrakePoint[]): string {
  const n = brakes.length;
  if (!n) return '';
  const tally = new Map<string, number>();
  for (const b of brakes) if (b.name) tally.set(b.name, (tally.get(b.name) ?? 0) + 1);
  const [name, k] = [...tally].sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
  if (!name) return '';
  if (k === n) return n === 1 ? ` at ${name}` : n === 2 ? `, both at ${name}` : `, all at ${name}`;
  return k >= 2 ? `, ${k} at ${name}` : '';
}

/** "Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E." Earlier drive first. */
export function compareLine(x: RouteDrive, y: RouteDrive): string {
  const [a, b] = x.at <= y.at ? [x, y] : [y, x];
  const [la, lb] = dayLabels(a.at, b.at);
  return `${la}: ${plural(a.hardBrakes, 'hard brake')}${where(a.brakes)}. ${lb}: ${b.hardBrakes}${where(b.brakes)}.`;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Regular trips (2 or more drives) from saved drives, most driven first. Drives without a saved path are left out. */
export function routesFrom(drives: readonly RouteDrive[], places: readonly Place[] = []): Route[] {
  const groups: RouteDrive[][] = [];
  for (const d of [...drives].filter((x) => pathPoints(x.path).length >= 2).sort((a, b) => a.at - b.at)) {
    const g = groups.find((x) => sameTrip(x[0], d));
    if (g) g.push(d);
    else groups.push([d]);
  }
  return groups.filter((g) => g.length >= 2).map((g): Route => {
    const first = pathPoints(g[0].path), last = g[g.length - 1], prev = g[g.length - 2];
    return {
      id: String(g[0].at),
      name: routeName(g, places),
      ats: g.map((d) => d.at),
      drives: g.length,
      avgScore: Math.round(mean(g.map((d) => d.score))),
      hardBrakesPerDrive: Math.round(mean(g.map((d) => d.hardBrakes)) * 10) / 10,
      usdPerDrive: mean(g.map((d) => hardGasOf(d).typical + d.gas.typical)),
      compare: compareLine(prev, last),
      start: first[0],
      end: first[first.length - 1],
    };
  }).sort((a, b) => b.drives - a.drives || b.ats[b.ats.length - 1] - a.ats[a.ats.length - 1]);
}

/** The regular trip a drive belongs to, or null. */
export function routeOf(drive: RouteDrive, all: readonly RouteDrive[], places: readonly Place[] = []): Route | null {
  return routesFrom(all, places).find((r) => r.ats.includes(drive.at)) ?? null;
}
