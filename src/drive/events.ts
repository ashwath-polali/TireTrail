// Hard brakes and fast starts: speed changing 7 mph or more in one second, the way insurance driving apps count them.
// The rate at each reading is a straight line fit to GPS speed from about 1 s before to 1 s after
// (3 readings at one a second), on speed that already had one-off spikes removed, so one noisy reading can't make an event.
import { dist, type LngLat, type XY } from '../geo/geo.ts';
import { bearing } from './limits.ts';
import { speedAt, type Segment, type Signals } from './signal.ts';
import type { Stop } from './stops.ts';

const MPH = 0.44704;
/** 7 mph per second, in m/s² (about 3.13) */
export const HARD_MPS2 = 7 * MPH;
/** 10 mph per second, in m/s² (about 4.47) */
export const VERY_HARD_MPS2 = 10 * MPH;
/** faster than a car can brake or speed up: a GPS glitch */
const GLITCH_MPS2 = 10;
/** half the fit window, seconds (a little over 1 so readings 1 s away count) */
const HALF_S = 1.05;
/** with slower readings, the nearest one on each side counts if it is this close */
const MAX_STEP_S = 2.5;
/** an event needs the car moving at least this fast just before or after, m/s (about 7 mph) */
const MOVING_MPS = 3;

// least-squares slope of v over t for readings lo..hi
function slope(t: readonly number[], v: readonly number[], lo: number, hi: number): number {
  let mt = 0, mv = 0;
  for (let k = lo; k <= hi; k++) [mt, mv] = [mt + t[k], mv + v[k]];
  const n = hi - lo + 1;
  [mt, mv] = [mt / n, mv / n];
  let num = 0, den = 0;
  for (let k = lo; k <= hi; k++) [num, den] = [num + (t[k] - mt) * (v[k] - mv), den + (t[k] - mt) ** 2];
  return den === 0 ? 0 : num / den;
}

/** m/s² at each reading, positive = speeding up. Glitches read 0. */
export function rates(s: Segment): number[] {
  const { t, v } = s, n = t.length;
  return t.map((ti, i) => {
    let lo = i, hi = i;
    while (lo > 0 && ti - t[lo - 1] <= HALF_S) lo--;
    while (hi < n - 1 && t[hi + 1] - ti <= HALF_S) hi++;
    if (lo === i && i > 0 && ti - t[i - 1] <= MAX_STEP_S) lo = i - 1;
    if (hi === i && i < n - 1 && t[i + 1] - ti <= MAX_STEP_S) hi = i + 1;
    if (hi === lo) return 0;
    const r = slope(t, v, lo, hi);
    return Math.abs(r) > GLITCH_MPS2 ? 0 : r;
  });
}

/** degrees from north the car was going as it reached reading i (from the last 20 m of positions), or null */
export function headingAt(s: Segment, i: number, backM = 20, maxS = 15): number | null {
  for (let k = i - 1; k >= 0 && s.t[i] - s.t[k] <= maxS; k--) if (dist(s.xy[k], s.xy[i]) >= backM) return bearing(s.xy[k], s.xy[i]);
  // just started: look ahead instead
  for (let k = i + 1; k < s.t.length && s.t[k] - s.t[i] <= maxS; k++) if (dist(s.xy[i], s.xy[k]) >= backM) return bearing(s.xy[i], s.xy[k]);
  return null;
}

export interface SpeedEvent {
  kind: 'brake' | 'start';
  /** ms */
  t: number;
  segment: number;
  /** reading with the biggest change */
  i: number;
  xy: XY;
  lngLat: LngLat;
  /** m/s² at the peak, always positive */
  rate: number;
  /** mph gained or lost in one second at the peak */
  mphPerS: number;
  /** m/s one second before and after the peak */
  fromMps: number;
  toMps: number;
  /** 10 mph or more in one second */
  veryHard: boolean;
  /** degrees from north, null if unknown */
  heading: number | null;
  /** brakes only: index into the drive's stops when this braking ended in that stop, else -1 */
  stop: number;
}

/** Every hard brake and fast start, in time order. One event per burst (readings within 2 s join). */
export function speedEvents(sig: Signals): SpeedEvent[] {
  const out: SpeedEvent[] = [];
  sig.segments.forEach((s, segment) => {
    const r = rates(s);
    for (const kind of ['brake', 'start'] as const) {
      const sign = kind === 'brake' ? -1 : 1;
      let best = -1, lastT = -Infinity;
      const flush = () => {
        if (best < 0) return;
        const t = s.t[best], rate = sign * r[best];
        out.push({
          kind, t: sig.t0 + t * 1000, segment, i: best, xy: s.xy[best], lngLat: sig.projection.toLngLat(s.xy[best]),
          rate, mphPerS: rate / MPH, fromMps: speedAt(s, t - 1), toMps: speedAt(s, t + 1), veryHard: rate >= VERY_HARD_MPS2,
          heading: headingAt(s, best), stop: -1,
        });
        best = -1;
      };
      for (let i = 0; i < s.t.length; i++) {
        // the car must be moving, so a GPS wobble while parked isn't an event
        if (sign * r[i] < HARD_MPS2 || Math.max(speedAt(s, s.t[i] - 1), speedAt(s, s.t[i] + 1)) < MOVING_MPS) continue;
        if (s.t[i] - lastT > 2) flush();
        if (best < 0 || sign * r[i] > sign * r[best]) best = i;
        lastT = s.t[i];
      }
      flush();
    }
  });
  return out.sort((a, b) => a.t - b.t || (a.kind === 'brake' ? -1 : 1));
}

/** Marks each hard brake that ended in a stop with that stop's index (in place). */
export function linkStops(events: SpeedEvent[], stops: readonly Stop[]): SpeedEvent[] {
  for (const e of events) {
    if (e.kind !== 'brake') continue;
    const st = stops.find((s) => s.segment === e.segment && e.i >= s.from - 1 && e.i <= s.to);
    e.stop = st ? st.index : -1;
  }
  return events;
}
