// GPS fixes -> position, speed, acceleration.
// Device Doppler speed is steadier than speed from positions (4 m wobble = several m/s),
// so positions (least-squares fit) are only the fallback, e.g. GPX without speed.
import { dist, localProjection, type Projection, type XY } from '../geo/geo.ts';
import type { MotionLookup } from './motion.ts';
import { Axis, median3, median5, rateAt } from './rate.ts';
import type { Fix } from './types.ts';

export interface SignalOptions {
  /** drop fixes worse than this (iOS gives ~65 m for Wi-Fi/cell) */
  maxAccuracyM: number;
  /** longer gap splits the drive into segments */
  maxGapS: number;
  /** half-window for speed from positions */
  positionWindowS: number;
  /** half-window for accel from speed */
  accelWindowS: number;
}

export const DEFAULT_SIGNAL_OPTIONS: SignalOptions = { maxAccuracyM: 50, maxGapS: 10, positionWindowS: 4, accelWindowS: 2 };

/** t = seconds since first fix */
export interface Segment {
  t: number[];
  xy: XY[];
  /** m/s */
  v: number[];
  /** m/s², positive = speeding up (2 s slope, for wear and stops) */
  a: number[];
  /** m/s² across one reading, checked by the motion sensor when there (rate.ts): hard brakes and fast starts */
  r: number[];
  /** the motion sensor checked r there */
  sensor: boolean[];
}

export interface Signals {
  projection: Projection;
  /** ms of first fix */
  t0: number;
  segments: Segment[];
  speedSource: 'device' | 'positions';
  /** duplicate, out of order, invalid or inaccurate */
  dropped: number;
  /** readings the motion sensor checked */
  sensorReadings: number;
}

const validSpeed = (s: number | null | undefined): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 0;

// least-squares slope of y over x within `half` of x[i]
function localSlope(x: readonly number[], y: readonly number[], i: number, half: number): number {
  let lo = i;
  let hi = i;
  while (lo > 0 && x[i] - x[lo - 1] <= half) lo--;
  while (hi < x.length - 1 && x[hi + 1] - x[i] <= half) hi++;
  if (hi === lo) return 0;
  let sx = 0;
  let sy = 0;
  for (let k = lo; k <= hi; k++) {
    sx += x[k];
    sy += y[k];
  }
  const n = hi - lo + 1;
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let k = lo; k <= hi; k++) {
    num += (x[k] - mx) * (y[k] - my);
    den += (x[k] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** motion: the phone's motion sensor for this drive (motion.ts), if it had one */
export function buildSignals(fixes: readonly Fix[], opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS, motion: MotionLookup | null = null): Signals {
  const projection = localProjection();
  const clean = fixes
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.lat) && Number.isFinite(f.lon) && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180)
    .filter((f) => !(typeof f.accuracy === 'number' && f.accuracy > opts.maxAccuracyM))
    .sort((p, q) => p.t - q.t)
    .filter((f, i, arr) => i === 0 || f.t > arr[i - 1].t);
  const dropped = fixes.length - clean.length;
  const t0 = clean.length ? clean[0].t : 0;
  const withSpeed = clean.filter((f) => validSpeed(f.speed)).length;
  const speedSource = clean.length && withSpeed / clean.length >= 0.8 ? 'device' : 'positions';

  // split on long gaps (screen locked, tunnel)
  const groups: Fix[][] = [];
  for (const f of clean) {
    const last = groups[groups.length - 1];
    if (last && (f.t - last[last.length - 1].t) / 1000 <= opts.maxGapS) last.push(f);
    else groups.push([f]);
  }

  // forward in the phone is learned across the whole drive, in order, as live
  const ctx = { t0, motion: motion?.seconds.length ? motion : null, axis: new Axis() };
  let sensorReadings = 0;
  const segments = groups.map((g): Segment => {
    const t = g.map((f) => (f.t - t0) / 1000);
    const xy = g.map((f) => projection.toXY([f.lon, f.lat]));
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const fromPositions = t.map((_, i) => Math.hypot(localSlope(t, xs, i, opts.positionWindowS), localSlope(t, ys, i, opts.positionWindowS)));
    const raw = speedSource === 'device' ? g.map((f, i) => (validSpeed(f.speed) ? f.speed : fromPositions[i])) : fromPositions;
    // median of 3 drops one-off spikes
    const v = median3(raw);
    const a = t.map((_, i) => localSlope(t, v, i, opts.accelWindowS));
    const v5 = median5(raw), rs = t.map((_, i) => rateAt(t, v5, i, ctx));
    sensorReadings += rs.filter((x) => x.sensor).length;
    return { t, xy, v, a, r: rs.map((x) => x.r), sensor: rs.map((x) => x.sensor) };
  });
  return { projection, t0, segments, speedSource, dropped, sensorReadings };
}

/** speed at t seconds (linear interpolation) */
export function speedAt(s: Segment, t: number): number {
  if (t <= s.t[0]) return s.v[0];
  for (let i = 1; i < s.t.length; i++) {
    if (s.t[i] >= t) {
      const w = (t - s.t[i - 1]) / (s.t[i] - s.t[i - 1]);
      return s.v[i - 1] + w * (s.v[i] - s.v[i - 1]);
    }
  }
  return s.v[s.v.length - 1];
}

// Integrates speed per segment (position wobble would add meters while parked), plus straight line across gaps.
export function distanceM(sig: Signals): number {
  let total = 0;
  sig.segments.forEach((s, k) => {
    for (let i = 1; i < s.t.length; i++) total += ((s.v[i] + s.v[i - 1]) / 2) * (s.t[i] - s.t[i - 1]);
    const next = sig.segments[k + 1];
    if (next) total += dist(s.xy[s.xy.length - 1], next.xy[0]);
  });
  return total;
}
