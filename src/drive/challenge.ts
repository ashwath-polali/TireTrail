// Weekly challenge and smooth-drive streaks. Weeks run Monday to Sunday, local time.
// The goal comes from drives before this week, so it holds still all week.
import { dist, localProjection, type LngLat } from '../geo/geo.ts';
import { bearing, turnBetween } from './limits.ts';
import { SPOT_M, spotsFrom, type Spot } from './spots.ts';
import type { BrakePoint } from './summary.ts';

const P = localProjection();
/** clean passes needed */
export const NEED = 3;
/** a pass counts going within this many degrees of the spot's way */
const SAME_WAY = 60;

export interface ChallengeDrive {
  at: number;
  hardBrakes: number;
  brakes: readonly BrakePoint[];
  /** the route, when this phone still has it; without it a drive can only fail a spot goal */
  track?: readonly LngLat[] | null;
}

export type ChallengeState = 'open' | 'done' | 'missed';

export interface Challenge {
  kind: 'spot' | 'smooth';
  title: string;
  /** how it is done, one line */
  how: string;
  need: number;
  got: number;
  state: ChallengeState;
  /** the spot, for a spot goal */
  spot: Spot | null;
  /** ms, Monday 00:00 and the next Monday 00:00 */
  from: number;
  to: number;
  /** days left including today */
  daysLeft: number;
  /** smooth drives (no hard brakes) in a row, up to the latest */
  streak: number;
  best: number;
}

/** Monday 00:00 local time of the week holding t. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function nextWeek(start: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** Current and best runs of drives with no hard brakes. */
export function streaks(drives: readonly { at: number; hardBrakes: number }[]): { streak: number; best: number } {
  let run = 0, best = 0;
  for (const d of [...drives].sort((a, b) => a.at - b.at)) {
    run = d.hardBrakes === 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { streak: run, best };
}

const sameWay = (a: number | null, b: number | null, max: number) => a == null || b == null || turnBetween(a, b) <= max;

/** A hard brake at the spot, going its way. */
export function brakedAt(spot: Spot, brakes: readonly BrakePoint[]): boolean {
  const s = P.toXY(spot.lngLat);
  return brakes.some((b) => dist(P.toXY([b.lon, b.lat]), s) <= SPOT_M && sameWay(spot.heading, b.heading, 45));
}

/** The route goes by the spot, going its way. */
export function passes(spot: Spot, track: readonly LngLat[]): boolean {
  const s = P.toXY(spot.lngLat), xy = track.map((p) => P.toXY(p));
  for (let i = 0; i < xy.length; i++) {
    if (dist(xy[i], s) > SPOT_M) continue;
    if (spot.heading == null) return true;
    // heading from the readings around this one
    const a = xy[Math.max(0, i - 1)], b = xy[Math.min(xy.length - 1, i + 1)];
    if (dist(a, b) >= 5 && turnBetween(bearing(a, b), spot.heading) <= SAME_WAY) return true;
  }
  return false;
}

const placeOf = (s: Spot) => s.name || 'your top hard-brake spot';

/** This week's challenge and the streaks, from every saved drive. */
export function challengeOf(drives: readonly ChallengeDrive[], now: number): Challenge {
  const from = weekStart(now), to = nextWeek(from);
  const before = drives.filter((d) => d.at < from);
  const week = drives.filter((d) => d.at >= from && d.at < to).sort((a, b) => a.at - b.at);
  const { streak, best } = streaks(drives);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysLeft = Math.max(0, Math.round((to - today.getTime()) / 86_400_000));
  const spot = spotsFrom(before)[0] ?? null;
  const base = { need: NEED, from, to, daysLeft, streak, best };

  if (spot) {
    let got = 0, state: ChallengeState = 'open';
    for (const d of week) {
      if (brakedAt(spot, d.brakes)) { state = 'missed'; break; }
      if (d.track && passes(spot, d.track) && ++got >= NEED) { state = 'done'; break; }
    }
    return { ...base, kind: 'spot', spot, got, state, title: `No hard stops at ${placeOf(spot)} this week`, how: `Drive past it ${NEED} times with no hard brake there.` };
  }
  const got = Math.min(NEED, week.filter((d) => d.hardBrakes === 0).length);
  const state: ChallengeState = got >= NEED ? 'done' : now >= to ? 'missed' : 'open';
  return { ...base, kind: 'smooth', spot: null, got, state, title: 'Three smooth drives this week', how: 'A smooth drive has no hard brakes.' };
}
