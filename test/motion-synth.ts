// Synthetic drives with both GPS fixes and motion sensor samples, for the hard-brake tests.
// The phone sits in a mount turned some odd way; gravity, engine buzz, bumps and a hand picking it up can be added.
import { analyzeDrive } from '../src/drive/analyze.ts';
import { LiveCoach } from '../src/drive/coach/live.ts';
import { MotionTrack, type MotionSample, type V3 } from '../src/drive/motion.ts';
import type { Fix } from '../src/drive/types.ts';
import { NO_DRAINS, P, T0 } from './engine-helpers.ts';

/** seconds, forward m/s², sideways m/s² */
export type Phase = [number, number, number?];

export interface SynthOptions {
  /** iOS-like: phone speed is the true speed through a lag of this many seconds */
  smoothS?: number;
  /** GPS speed noise, m/s (seeded) */
  noise?: number;
  /** a GPS reading every this many seconds */
  every?: number;
  /** GPS readings dropped (by second) */
  drop?: (k: number) => boolean;
  /** added to GPS reading k's speed */
  glitch?: (k: number) => number;
  /** no motion sensor */
  noMotion?: boolean;
  /** motion samples a second */
  hz?: number;
  /** bumps: [seconds, vertical m/s², sideways jolt m/s²], each 0.12 s */
  bumps?: [number, number, number][];
  /** the phone is picked up at this second for 1.2 s, and put back turned another way */
  pickup?: number;
  seed?: number;
}

const rot = (ax: V3, deg: number): number[][] => {
  const [x, y, z] = ax, c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
};
const mul = (A: number[][], B: number[][]) => A.map((r) => B[0].map((_, j) => r.reduce((s, x, k) => s + x * B[k][j], 0)));
const apply = (R: number[][], v: V3): V3 => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]) as V3;
const unit = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

/** a mount: the phone turned 70° about a slanted axis, then tipped back */
export const MOUNT = mul(rot(unit([0.3, 0.8, 0.5]), 70), rot([1, 0, 0], -25));
const MOUNT2 = mul(rot(unit([0.9, -0.2, 0.4]), 110), rot([0, 0, 1], 40));

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** Drives east from v0 m/s through the phases. */
export function synth(v0: number, phases: Phase[], o: SynthOptions = {}): { fixes: Fix[]; samples: MotionSample[] } {
  const hz = o.hz ?? 60, every = o.every ?? 1, gauss = rng(o.seed ?? 7);
  const fixes: Fix[] = [], samples: MotionSample[] = [];
  let v = v0, x = 0, shown = v0, t = 0, nextFix = 0, nextSample = 0;
  const total = phases.reduce((s, p) => s + p[0], 0);
  const at = (tt: number): [number, number] => {
    let s = 0;
    for (const [d, a, l] of phases) { if (tt < s + d) return [a, l ?? 0]; s += d; }
    return [0, 0];
  };
  const dt = 0.002;
  for (let k = 0; t <= total + 1e-9; k++, t = k * dt) {
    const [a0, lat] = at(t), a = v <= 0 && a0 < 0 ? 0 : a0;
    if (t >= nextFix - 1e-9) {
      const sec = Math.round(t);
      if (!o.drop?.(sec)) {
        const [lon, la] = P.toLngLat([x, 0]);
        const sp = Math.max(0, (o.smoothS ? shown : v) + (o.noise ? gauss() * o.noise : 0) + (o.glitch?.(sec) ?? 0));
        fixes.push({ t: T0 + Math.round(t * 1000), lat: la, lon, speed: sp, heading: 90, accuracy: 5 });
      }
      nextFix += every;
    }
    if (!o.noMotion && t >= nextSample - 1e-9) {
      nextSample += 1 / hz;
      let R = MOUNT, extra: V3 = [0, 0, 0], spin = Math.abs(lat) / Math.max(v, 3) * 57.3;
      for (const [bt, up, side] of o.bumps ?? []) if (t >= bt && t < bt + 0.12) extra = [extra[0] + side, extra[1], extra[2] + up];
      if (o.pickup != null && t >= o.pickup) {
        const p = (t - o.pickup) / 1.2;
        if (p < 1) {
          // lifted, turned and put down: big hand forces, fast turning
          R = mul(rot([1, 0, 0], 80 * Math.sin(Math.PI * p)), MOUNT);
          extra = [4 * Math.sin(2 * Math.PI * p), 3 * Math.cos(2 * Math.PI * p), 2 * Math.sin(4 * Math.PI * p)];
          spin = 160;
        } else R = MOUNT2;
      }
      // car frame: x right, y forward, z up; buzz from the engine
      const buzz = 0.25 * Math.sin(2 * Math.PI * 31 * t);
      const car: V3 = [lat + extra[0] + buzz + gauss() * 0.05, a + extra[1] + buzz + gauss() * 0.05, extra[2] + buzz + gauss() * 0.05];
      const lin = apply(R, car), g = apply(R, [0, 0, 9.81]);
      samples.push({ t: T0 + Math.round(t * 1000), lin, raw: [lin[0] + g[0], lin[1] + g[1], lin[2] + g[2]], rot: spin + Math.abs(gauss()) * 2 });
    }
    x += (v + (a * dt) / 2) * dt;
    v = Math.max(0, v + a * dt);
    if (o.smoothS) shown += ((v - shown) * dt) / o.smoothS;
  }
  return { fixes, samples };
}

/** The motion track for samples. */
export function track(samples: readonly MotionSample[]): MotionTrack {
  const m = new MotionTrack();
  for (const s of samples) m.add(s);
  m.end();
  return m;
}

/** The report's hard brakes and fast starts, with and without the sensor. */
export function report(d: { fixes: Fix[]; samples: MotionSample[] }, sensor = true) {
  const r = analyzeDrive(d.fixes, NO_DRAINS, { motion: sensor ? track(d.samples) : null });
  return r.events.map((e) => ({ kind: e.kind, t: e.t, mph: Math.round(e.mphPerS * 10) / 10, sensor: e.sensor }));
}

/** The live coach's events, fed fixes and samples in time order, as a phone would. */
export function live(d: { fixes: Fix[]; samples: MotionSample[] }, sensor = true) {
  const m = new MotionTrack(), coach = new LiveCoach({ motion: sensor ? m : null });
  let k = 0;
  for (const f of d.fixes) {
    // the phone delivers a fix a moment after its time
    while (sensor && k < d.samples.length && d.samples[k].t <= f.t + 300) m.add(d.samples[k++]);
    coach.update(f);
  }
  while (sensor && k < d.samples.length) m.add(d.samples[k++]);
  m.end();
  return { events: coach.finish().map((e) => ({ kind: e.kind, t: e.peakT, mph: Math.round(e.mphPerS * 10) / 10, sensor: e.sensor })), coach, track: m };
}
