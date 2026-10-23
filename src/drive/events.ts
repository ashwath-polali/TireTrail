// Hard brakes and fast starts: speed changing 7 mph or more in one second, the same rule Progressive Snapshot uses.
// The rate at each reading comes from rate.ts: one GPS step, checked by the motion sensor when the phone has one.
// Live (coach/live.ts) uses the same rates in the same order, so what it says matches the report.
import { dist, type LngLat, type XY } from '../geo/geo.ts';
import { bearing } from './limits.ts';
import { movingAt } from './rate.ts';
import { speedAt, type Segment, type Signals } from './signal.ts';
import type { Stop } from './stops.ts';

const MPH = 0.44704;
/** 7 mph per second, in m/s² (about 3.13) */
export const HARD_MPS2 = 7 * MPH;
/** 10 mph per second, in m/s² (about 4.47) */
export const VERY_HARD_MPS2 = 10 * MPH;
/** readings this close (s) join one event */
export const BURST_S = 2;

/** m/s² at each reading, positive = speeding up. Glitches read 0. */
export function rates(s: Segment): number[] {
  return s.r;
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
  /** the motion sensor checked it */
  sensor: boolean;
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
          heading: headingAt(s, best), stop: -1, sensor: s.sensor[best],
        });
        best = -1;
      };
      for (let i = 0; i < s.t.length; i++) {
        // the car must be moving, so a GPS wobble while parked isn't an event
        if (sign * r[i] < HARD_MPS2 || !movingAt(s.v, i)) continue;
        if (s.t[i] - lastT > BURST_S) flush();
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
