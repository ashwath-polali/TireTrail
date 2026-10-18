// Stop = speed from >= 5 m/s down to <= 1 m/s.
// Hard = slowing 7 mph or more in one second (events.ts). peakDecel (held 3 s) still ranks stops.
import type { LngLat, XY } from '../geo/geo.ts';
import { HARD_MPS2, headingAt, rates, VERY_HARD_MPS2 } from './events.ts';
import { speedAt, type Segment, type Signals } from './signal.ts';

export interface StopOptions {
  movingMps: number;
  stoppedMps: number;
  /** window for sustained decel */
  sustainS: number;
  /** m/s² slowing in one second, at or above = hard stop (7 mph a second) */
  hardDecel: number;
  /** m/s², below this is cruising noise */
  brakingDecel: number;
}

export const DEFAULT_STOP_OPTIONS: StopOptions = { movingMps: 5, stoppedMps: 1, sustainS: 3, hardDecel: HARD_MPS2, brakingDecel: 0.3 };

export interface Stop {
  index: number;
  /** ms, when it came to rest */
  t: number;
  xy: XY;
  lngLat: LngLat;
  /** m/s */
  entrySpeed: number;
  /** m/s², held 3 s. ranks stops. */
  peakDecel: number;
  /** m/s² over the whole braking */
  meanDecel: number;
  brakingM: number;
  /** m/s², the most it slowed in one second while braking */
  drop1s: number;
  /** slowed 7 mph or more in one second */
  hard: boolean;
  /** slowed 10 mph or more in one second */
  veryHard: boolean;
  /** degrees from north it was going as it stopped, null if unknown */
  heading: number | null;
  /** braking sample range, for the wear model */
  segment: number;
  from: number;
  to: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// biggest speed drop over any w-second window, m/s²
function sustainedDecel(s: Segment, from: number, to: number, w: number): number {
  const t0 = s.t[from];
  const t1 = s.t[to];
  if (t1 - t0 <= w) return t1 > t0 ? (speedAt(s, t0) - speedAt(s, t1)) / (t1 - t0) : 0;
  let best = 0;
  // 0.25 s steps so the window isn't pinned to readings
  for (let t = t0; t + w <= t1 + 1e-9; t += 0.25) best = Math.max(best, (speedAt(s, t) - speedAt(s, t + w)) / w);
  return best;
}

export function detectStops(sig: Signals, opts: StopOptions = DEFAULT_STOP_OPTIONS): Stop[] {
  const stops: Stop[] = [];
  sig.segments.forEach((s, segIndex) => {
    const r = rates(s);
    let armed = false; // seen driving speed since the last stop
    let floor = 0; // braking can't reach back past the previous stop
    for (let i = 0; i < s.v.length; i++) {
      if (s.v[i] >= opts.movingMps) armed = true;
      if (!armed || s.v[i] > opts.stoppedMps) continue;
      armed = false;

      // Walk back over near-standstill (position speed can read 1-2 m/s while parked),
      // then while still slowing. A steady crawl ends the walk.
      let k = i;
      while (k > floor && s.v[k - 1] <= opts.stoppedMps + 1) k--;
      while (k > floor && (s.a[k - 1] <= -opts.brakingDecel || s.v[k - 1] > s.v[k] + 0.5)) k--;
      // entry = last reading near top speed (smoothed accel bleeds into the cruise, so k is early)
      let top = k;
      for (let j = k; j <= i; j++) if (s.v[j] > s.v[top]) top = j;
      let entry = top;
      for (let j = top; j <= i; j++) if (s.v[j] >= s.v[top] - 0.3) entry = j;

      // rest point = median while stopped (smooths GPS wobble)
      let end = i;
      while (end + 1 < s.v.length && s.v[end + 1] <= opts.stoppedMps + 0.5) end++;
      const still = s.xy.slice(i, end + 1);
      const xy: XY = [median(still.map((p) => p[0])), median(still.map((p) => p[1]))];

      let brakingM = 0;
      for (let j = entry + 1; j <= i; j++) brakingM += ((s.v[j] + s.v[j - 1]) / 2) * (s.t[j] - s.t[j - 1]);
      const duration = s.t[i] - s.t[entry];
      const peakDecel = sustainedDecel(s, entry, i, opts.sustainS);
      // counted while still moving, as events.ts does
      let drop1s = 0;
      for (let j = Math.max(entry - 1, floor); j <= i; j++) if (speedAt(s, s.t[j] - 1) >= 3) drop1s = Math.max(drop1s, -r[j]);
      stops.push({
        index: stops.length,
        t: sig.t0 + s.t[i] * 1000,
        xy,
        lngLat: sig.projection.toLngLat(xy),
        entrySpeed: s.v[entry],
        peakDecel,
        meanDecel: duration > 0 ? (s.v[entry] - s.v[i]) / duration : 0,
        brakingM,
        drop1s,
        hard: drop1s >= opts.hardDecel,
        veryHard: drop1s >= Math.max(VERY_HARD_MPS2, opts.hardDecel),
        heading: headingAt(s, i),
        segment: segIndex,
        from: entry,
        to: i,
      });
      floor = end;
    }
  });
  return stops;
}
