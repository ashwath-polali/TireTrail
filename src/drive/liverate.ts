// The report's rates (rate.ts), one GPS fix at a time, for the live coach.
// Same filters as signal.ts (accurate fixes, in time order, split on long gaps), same medians, same order,
// so a reading decided live has exactly the rate the report gives it later. Decided 3 readings late.
import type { MotionLookup } from './motion.ts';
import { Axis, med3, movingAt, rateAt, type RateContext } from './rate.ts';
import { DEFAULT_SIGNAL_OPTIONS } from './signal.ts';
import type { Fix } from './types.ts';

/** a reading decided live */
export interface LiveRate {
  /** ms */
  T: number;
  /** m/s², positive = speeding up */
  r: number;
  sensor: boolean;
  moving: boolean;
}

/** what live needs from the motion track (motion.ts MotionTrack) */
export interface LiveMotion extends MotionLookup {
  /** ms: every second that starts before this is final */
  readonly through: number;
  /** samples so far */
  readonly count: number;
  /** a quiet sensor's seconds are final by now (ms) */
  tick?(now: number): void;
}

export class LiveRates {
  private readonly motion: LiveMotion | null;
  private readonly ctx: RateContext;
  private t0 = NaN;
  private lastT = -Infinity;
  // the current stretch, trimmed from the front: global index = base + local
  private t: number[] = [];
  private raw: number[] = [];
  private base = 0;
  private n = 0;
  private next = 0;

  constructor(motion: LiveMotion | null = null) {
    this.motion = motion;
    this.ctx = { t0: 0, motion, axis: new Axis() };
  }

  /** Takes a fix; returns the readings it can now decide, oldest first. */
  push(f: Fix): LiveRate[] {
    const okPos = Number.isFinite(f.t) && Number.isFinite(f.lat) && Number.isFinite(f.lon) && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180;
    if (!okPos || (typeof f.accuracy === 'number' && f.accuracy > DEFAULT_SIGNAL_OPTIONS.maxAccuracyM) || f.t <= this.lastT) return [];
    // as signal.ts: a long gap between accurate fixes starts a new stretch
    const gap = (f.t - this.lastT) / 1000 > DEFAULT_SIGNAL_OPTIONS.maxGapS;
    this.lastT = f.t;
    this.motion?.tick?.(f.t);
    if (Number.isNaN(this.t0)) this.t0 = this.ctx.t0 = f.t;
    const out = gap && this.n ? this.flush() : [];
    // phone speed only: speed from positions needs readings ahead
    if (!(typeof f.speed === 'number' && Number.isFinite(f.speed) && f.speed >= 0)) return out;
    this.t.push((f.t - this.t0) / 1000);
    this.raw.push(f.speed);
    this.n++;
    out.push(...this.decide(false));
    return out;
  }

  /** Decides the readings left (the drive ended, or a long gap). */
  flush(): LiveRate[] {
    const out = this.decide(true);
    [this.t, this.raw, this.base, this.n, this.next] = [[], [], 0, 0, 0];
    return out;
  }

  // speed at global index j, through a median of 5 (3 by the ends) or 3, as the whole stretch would have it
  private med(j: number, five: boolean): number {
    const r = (k: number) => this.raw[k - this.base], n = this.n;
    if (j === 0 || j === n - 1) return r(j);
    if (!five || j === 1 || j === n - 2) return med3(r(j - 1), r(j), r(j + 1));
    return [r(j - 2), r(j - 1), r(j), r(j + 1), r(j + 2)].sort((a, b) => a - b)[2];
  }

  private decide(all: boolean): LiveRate[] {
    const out: LiveRate[] = [], m = this.motion;
    for (; this.next < this.n; this.next++) {
      const i = this.next, T = Math.round(this.t0 + this.t[i - this.base] * 1000);
      if (!all && (i + 3 >= this.n || (m && m.count > 0 && m.through < T + 500))) break;
      // the readings rateAt looks at: 2 back to 1 ahead
      const lo = Math.max(0, i - 2), hi = Math.min(this.n - 1, i + 1), idx: number[] = [];
      for (let j = lo; j <= hi; j++) idx.push(j);
      const t = idx.map((j) => this.t[j - this.base]);
      const { r, sensor } = rateAt(t, idx.map((j) => this.med(j, true)), i - lo, this.ctx);
      const v3 = [Math.max(i - 1, 0), i, Math.min(i + 1, this.n - 1)].map((j) => this.med(j, false));
      out.push({ T, r, sensor, moving: movingAt(v3, 1) });
    }
    if (this.next - this.base > 16) {
      const cut = this.next - this.base - 8;
      this.t.splice(0, cut);
      this.raw.splice(0, cut);
      this.base += cut;
    }
    return out;
  }
}
