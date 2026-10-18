// How fast the car speeds up or slows at each GPS reading, in m/s². Live and the report both use this, so they agree.
// GPS: the change across one reading, on speeds put through a median of 5 first, so one or two bad readings can't make an event.
// Motion sensor, when there: its 0.5 s force, which the GPS speed trend has to agree with,
// and the car can never be slowing harder than the phone felt.
import { MOTION, secondsIn, type MotionLookup, type MotionSecond, type V3 } from './motion.ts';

/** faster than a car can brake or speed up: a GPS glitch */
export const GLITCH_MPS2 = 10;
/** one step counts only if readings are this close, s */
export const MAX_STEP_S = 2.5;
/** the GPS speed has to change at least this much for the sensor to count, m/s (about 2 mph) */
export const MIN_DV = 0.8;
/** the sensor reads a little high or low: this much slack over what it felt, m/s² */
export const SLACK = 0.4;
/** the forward direction needs this many readings of clear speeding up or slowing, and this much agreement */
const AXIS_N = 4, AXIS_AGREE = 0.7, AXIS_MIN_A = 0.7, AXIS_KEEP = 0.98;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));

/** Which way is forward in the phone, learned from the GPS speed. Starts over when the phone is moved. */
export class Axis {
  private s: V3 = [0, 0, 0];
  private w = 0;
  private n = 0;

  learn(m: V3, a: number): void {
    if (!(Math.abs(a) >= AXIS_MIN_A)) return;
    for (let k = 0; k < 3; k++) this.s[k] = this.s[k] * AXIS_KEEP + m[k] * a;
    this.w = this.w * AXIS_KEEP + len(m) * Math.abs(a);
    this.n++;
  }

  reset(): void {
    this.s = [0, 0, 0];
    this.w = 0;
    this.n = 0;
  }

  /** forward, as a unit vector in phone axes, or null while unsure */
  dir(): V3 | null {
    const L = len(this.s);
    if (this.n < AXIS_N || !(L > 0) || L < AXIS_AGREE * this.w) return null;
    return [this.s[0] / L, this.s[1] / L, this.s[2] / L];
  }
}

export interface RateContext {
  /** ms of t = 0 */
  t0: number;
  motion: MotionLookup | null;
  axis: Axis;
}

/** m/s² across one reading at i: the bigger of the steps into and out of it. Glitches read 0. */
export function stepRate(t: readonly number[], v: readonly number[], i: number): number {
  let best = 0;
  for (const a of [i - 1, i]) {
    const b = a + 1;
    if (a < 0 || b >= t.length) continue;
    const dt = t[b] - t[a];
    if (!(dt > 0) || dt > MAX_STEP_S) continue;
    const d = (v[b] - v[a]) / dt;
    if (Math.abs(d) <= GLITCH_MPS2 && Math.abs(d) > Math.abs(best)) best = d;
  }
  return best;
}

/** The speed trend around reading i: from up to 2.5 s before to 1.5 s after, m/s. */
export function trendAt(t: readonly number[], v: readonly number[], i: number): number {
  let a = i, b = i;
  while (a > 0 && i - a < 2 && t[i] - t[a - 1] <= 2.5) a--;
  if (i + 1 < t.length && t[i + 1] - t[i] <= 1.5) b = i + 1;
  return v[b] - v[a];
}

/** The seconds the sensor has for reading i: from 1 s before to 0.5 s after (GPS speed runs a little late). */
export function motionFor(m: MotionLookup | null, T: number): MotionSecond[] {
  return m ? secondsIn(m.seconds, T - 1000, T + 500) : [];
}

export interface Rate {
  /** m/s², positive = speeding up */
  r: number;
  /** the motion sensor checked it */
  sensor: boolean;
}

/**
 * The rate at reading i, from speeds v (already median of 5). Needs readings up to i + 1.
 * Call in reading order: it teaches ctx.axis as it goes.
 */
export function rateAt(t: readonly number[], v: readonly number[], i: number, ctx: RateContext): Rate {
  const g = stepRate(t, v, i);
  const T = Math.round(ctx.t0 + t[i] * 1000), secs = motionFor(ctx.motion, T);
  if (!secs.length) return { r: g, sensor: false };
  // picked up or knocked: GPS only, and forward has to be learned again
  if (secs.some((s) => s.bad)) { ctx.axis.reset(); return { r: g, sensor: false }; }
  if (secs.some((s) => s.n < MOTION.minN)) return { r: g, sensor: false };

  let pk = secs[0], n = 0;
  const m: V3 = [0, 0, 0];
  for (const s of secs) {
    if (s.P > pk.P) pk = s;
    for (let k = 0; k < 3; k++) m[k] += s.m[k] * s.n;
    n += s.n;
  }
  for (let k = 0; k < 3; k++) m[k] /= n;
  const H = pk.P, dv = trendAt(t, v, i), f = ctx.axis.dir();

  let est: number;
  if (f) {
    // mostly along the car: its full size; partly sideways (a turn): only the forward part
    const lon = dot(pk.p, f);
    est = Math.abs(lon) >= 0.85 * H ? Math.sign(lon) * H : lon;
  } else est = Math.abs(dv) >= MIN_DV ? Math.sign(dv) * H : g;
  // the sensor can only raise a reading when the GPS speed went the same way
  const agrees = Math.sign(est) === Math.sign(dv) && Math.abs(dv) >= MIN_DV;
  if (Math.abs(est) > Math.abs(g) && !agrees) est = g;
  const r = Math.sign(est) * Math.min(Math.abs(est), H + SLACK);

  // learn forward from the 2 s GPS slope
  const a = Math.max(i - 1, 0), b = Math.min(i + 1, t.length - 1);
  if (b > a && t[b] - t[a] <= 2 * MAX_STEP_S) ctx.axis.learn(m, (v[b] - v[a]) / (t[b] - t[a]));
  return { r, sensor: true };
}

/** median of 3, ends kept */
export function median3(v: readonly number[]): number[] {
  return v.map((x, i) => (i === 0 || i === v.length - 1 ? x : med3(v[i - 1], x, v[i + 1])));
}

export const med3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/** reading i of v through a median of 5 (3 next to the ends, ends kept); needs v up to i + 2 */
export function med5At(v: readonly number[], i: number): number {
  const n = v.length;
  if (i === 0 || i === n - 1) return v[i];
  if (i === 1 || i === n - 2) return med3(v[i - 1], v[i], v[i + 1]);
  const w = [v[i - 2], v[i - 1], v[i], v[i + 1], v[i + 2]].sort((a, b) => a - b);
  return w[2];
}

/** median of 5: keeps steps and steady slowing, drops one- and two-reading spikes */
export function median5(v: readonly number[]): number[] {
  return v.map((_, i) => med5At(v, i));
}

/** an event needs the car moving at least this fast just before or after, m/s (about 7 mph) */
export const MOVING_MPS = 3;

/** The car is moving around reading i (the readings either side), so GPS wobble while parked can't be an event. */
export function movingAt(v: readonly number[], i: number): boolean {
  return Math.max(v[Math.max(i - 1, 0)], v[Math.min(i + 1, v.length - 1)]) >= MOVING_MPS;
}
