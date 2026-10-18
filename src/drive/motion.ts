// The phone's motion sensor, boiled down to one summary a second, plus short full-rate windows around events.
// Gravity comes out first, since the phone can sit any way in its mount. A 0.5 s average drops bumps and buzz.
// A second where the phone itself turned fast or tipped (picked up, knocked) is marked bad and never counts.

export type V3 = [number, number, number];

export interface MotionSample {
  /** ms since epoch */
  t: number;
  /** m/s² without gravity, null if the phone can't split it out */
  lin: V3 | null;
  /** m/s² with gravity */
  raw: V3 | null;
  /** how fast the phone itself turns, deg/s, null without a gyro */
  rot: number | null;
}

export interface MotionSecond {
  /** ms, the start of the second */
  t: number;
  /** samples in it */
  n: number;
  /** mean sideways-or-forward force (gravity removed), phone axes, m/s² */
  m: V3;
  /** the strongest 0.5 s average in this second, and its size */
  p: V3;
  P: number;
  /** fastest the phone itself turned, deg/s */
  rot: number;
  /** the phone itself moved: don't trust this second */
  bad: boolean;
}

/** full-rate samples around an event: [ms after t, x, y, z (m/s², gravity removed, flat to the ground), deg/s] */
export interface MotionWindow {
  t: number;
  s: number[][];
}

/** what the rate logic needs: final seconds, oldest first */
export interface MotionLookup {
  readonly seconds: readonly MotionSecond[];
}

export const MOTION = {
  /** averaging window, ms (the minimum length that counts) */
  avgMs: 500,
  /** the window must hold at least this much time, ms */
  fillMs: 400,
  /** phone turning faster than this is being handled, deg/s */
  handRot: 100,
  /** gravity tipping more than this within a second, degrees */
  tiltDeg: 20,
  /** a second after handling is bad too, ms */
  badHoldMs: 1000,
  /** fewer samples than this in a second: the sensor wasn't really running */
  minN: 8,
  /** event windows: this long either side, ms, and at most this many a drive */
  windowMs: 3000,
  maxWindows: 30,
  /** gravity by slow averaging, for phones that only give the raw reading, ms */
  gravTauMs: 4000,
};

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const ok3 = (a: V3 | null): a is V3 => !!a && a.every((x) => Number.isFinite(x));
const r2 = (x: number) => Math.round(x * 100) / 100 || 0;

interface Bucket { t: number; n: number; sum: V3; p: V3; P: number; rot: number; bad: boolean }

export class MotionTrack implements MotionLookup {
  readonly seconds: MotionSecond[] = [];
  readonly windows: MotionWindow[] = [];
  /** ms: every second that starts before this is final */
  through = 0;
  /** samples taken in all */
  count = 0;
  private cur: Bucket | null = null;
  private avg: { t: number; h: V3 }[] = [];
  private sum: V3 = [0, 0, 0];
  private ring: number[][] = [];
  private grav: V3 | null = null;
  private gHist: { t: number; g: V3 }[] = [];
  private lastT = 0;
  private badUntil = 0;
  private marks: number[] = [];

  add(s: MotionSample): void {
    if (!Number.isFinite(s.t) || s.t <= this.lastT) return;
    const dt = this.lastT ? s.t - this.lastT : 0;
    // a long silence restarts the averages
    if (dt > 1000) { this.avg = []; this.sum = [0, 0, 0]; this.gHist = []; }
    this.lastT = s.t;
    let g: V3, lin: V3;
    if (ok3(s.lin) && ok3(s.raw)) {
      lin = s.lin;
      g = [s.raw[0] - lin[0], s.raw[1] - lin[1], s.raw[2] - lin[2]];
    } else if (ok3(s.raw)) {
      // no split from the phone: gravity is the slow average
      const k = this.grav && dt > 0 ? Math.min(1, dt / MOTION.gravTauMs) : 1, q = this.grav ?? s.raw;
      g = this.grav = [q[0] + (s.raw[0] - q[0]) * k, q[1] + (s.raw[1] - q[1]) * k, q[2] + (s.raw[2] - q[2]) * k];
      lin = [s.raw[0] - g[0], s.raw[1] - g[1], s.raw[2] - g[2]];
    } else return;
    const gl = len(g);
    if (!(gl > 5)) return;
    const u: V3 = [g[0] / gl, g[1] / gl, g[2] / gl], up = dot(lin, u);
    const h: V3 = [lin[0] - up * u[0], lin[1] - up * u[1], lin[2] - up * u[2]];
    this.count++;

    // handled: turning fast, or gravity tipped a lot in the last second
    const rot = typeof s.rot === 'number' && Number.isFinite(s.rot) ? Math.abs(s.rot) : 0;
    this.gHist.push({ t: s.t, g: u });
    while (this.gHist.length > 1 && s.t - this.gHist[0].t > 1000) this.gHist.shift();
    const tilt = (Math.acos(Math.max(-1, Math.min(1, dot(this.gHist[0].g, u)))) * 180) / Math.PI;
    if (rot > MOTION.handRot || tilt > MOTION.tiltDeg) this.badUntil = s.t + MOTION.badHoldMs;

    // the 0.5 s average
    this.avg.push({ t: s.t, h });
    for (let k = 0; k < 3; k++) this.sum[k] += h[k];
    while (s.t - this.avg[0].t > MOTION.avgMs) { const o = this.avg.shift()!.h; for (let k = 0; k < 3; k++) this.sum[k] -= o[k]; }
    const full = s.t - this.avg[0].t >= MOTION.fillMs, n = this.avg.length;
    const mean: V3 = [this.sum[0] / n, this.sum[1] / n, this.sum[2] / n];

    const sec = Math.floor(s.t / 1000) * 1000;
    if (this.cur && this.cur.t !== sec) this.close(sec);
    const b = (this.cur ??= { t: sec, n: 0, sum: [0, 0, 0], p: [0, 0, 0], P: 0, rot: 0, bad: false });
    b.n++;
    for (let k = 0; k < 3; k++) b.sum[k] += h[k];
    const M = len(mean);
    if (full && M > b.P) [b.P, b.p] = [M, mean];
    b.rot = Math.max(b.rot, rot);
    if (s.t < this.badUntil) b.bad = true;

    this.ring.push([s.t, r2(h[0]), r2(h[1]), r2(h[2]), Math.round(rot)]);
    while (this.ring.length && s.t - this.ring[0][0] > 2 * MOTION.windowMs + 2000) this.ring.shift();
    while (this.marks.length && s.t >= this.marks[0] + MOTION.windowMs) this.cut(this.marks.shift()!);
  }

  /** Keeps the full-rate samples within 3 s of t (an event), once they're all in. */
  mark(t: number): void {
    if (this.windows.length + this.marks.length >= MOTION.maxWindows) return;
    if (this.marks.some((m) => Math.abs(m - t) < MOTION.windowMs) || this.windows.some((w) => Math.abs(w.t + MOTION.windowMs - t) < MOTION.windowMs)) return;
    this.marks.push(t);
  }

  /** Closes the open second and any waiting windows (the drive ended). */
  end(): void {
    if (this.cur) this.close(this.cur.t + 1000);
    for (const m of this.marks.splice(0)) this.cut(m);
  }

  private close(next: number): void {
    const b = this.cur!;
    this.cur = null;
    const n = b.n;
    // rounded as kept, so a saved drive reads exactly as it did live
    this.seconds.push({ t: b.t, n, m: [r2(b.sum[0] / n), r2(b.sum[1] / n), r2(b.sum[2] / n)], p: b.p.map(r2) as V3, P: r2(b.P), rot: Math.round(b.rot), bad: b.bad });
    this.through = next;
  }

  private cut(t: number): void {
    const from = t - MOTION.windowMs;
    const s = this.ring.filter((x) => x[0] >= from && x[0] <= t + MOTION.windowMs).map((x) => [x[0] - from, x[1], x[2], x[3], x[4]]);
    if (s.length) this.windows.push({ t: from, s });
  }
}

/** The seconds that start in [from, to), from a list sorted by time. */
export function secondsIn(list: readonly MotionSecond[], from: number, to: number): MotionSecond[] {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < from) lo = mid + 1; else hi = mid; }
  const out: MotionSecond[] = [];
  for (let i = lo; i < list.length && list[i].t < to; i++) out.push(list[i]);
  return out;
}

// ---------- kept with the drive: compact rows ----------

/** t0: ms of the first second; rows: [s after t0, n, mx, my, mz, px, py, pz, P, deg/s, bad] */
export interface PackedSeconds { t0: number; rows: number[][] }

export function packSeconds(list: readonly MotionSecond[]): PackedSeconds {
  const t0 = list[0]?.t ?? 0;
  return { t0, rows: list.map((s) => [Math.round((s.t - t0) / 1000), s.n, ...s.m, ...s.p, s.P, s.rot, s.bad ? 1 : 0]) };
}

export function unpackSeconds(p: PackedSeconds | null | undefined): MotionSecond[] {
  if (!p || !Number.isFinite(p.t0) || !Array.isArray(p.rows)) return [];
  const out: MotionSecond[] = [];
  for (const r of p.rows) {
    if (!Array.isArray(r) || r.length < 11 || !r.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    out.push({ t: p.t0 + r[0] * 1000, n: r[1], m: [r[2], r[3], r[4]], p: [r[5], r[6], r[7]], P: r[8], rot: r[9], bad: r[10] === 1 });
  }
  return out.sort((a, b) => a.t - b.t);
}
