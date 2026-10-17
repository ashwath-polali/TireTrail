// The water story: zoom to a drain, rain falls, the ground opens, one drop runs the real pipes to its end.
import type { XY } from '../../geo/geo.ts';
import type { Cam, Ending, Scene } from './render.ts';
import type { World } from './world.ts';

export interface StoryInput {
  path: XY[]; // world points from the drain to the end
  street: XY[] | null; // the street that was tapped, if any
  cls: string;
  code: string; // ending code, e.g. pond-to-creek
  focusY: number; // middle of the open band, 0 top .. 1 bottom
  viewW: number; // canvas size in art px
  viewH: number;
  bandH: number; // height of the open band in art px
}

export interface StoryFrame {
  cam: Cam | null; // camera the story wants, or null to leave it alone
  scene: Scene;
  step: number; // 1 rain, 2 drain, 3 pipes, 4 end
  prog: number; // 0..1 along the pipes
  ended: boolean;
}

const ST = 1.0;
const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const out3 = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

export class Story {
  private readonly pts: XY[];
  private readonly inp: StoryInput;
  private readonly from: Cam;
  private t0: number;
  private readonly pond: boolean;
  private readonly water: XY | null; // where the salmon jumps or the ripples spread
  private readonly mode: Ending['kind'];
  private readonly t = { zoom: 1000, rain: 1400, dis: 750, travel: 0, hold: 0, back: 800 };

  constructor(world: World, inp: StoryInput, from: Cam, t0: number) {
    [this.inp, this.from, this.t0] = [inp, from, t0];
    this.pts = densify(inp.path, 0.5);
    this.t.travel = clamp(this.length * 16, 2600, 6500);
    const E = this.pts[this.pts.length - 1];
    this.pond = /pond/.test(inp.code);
    const wet = inp.cls === 'creek' || inp.cls === 'elsewhere';
    // a pond's outlet may be unmapped, so its water can be a field away
    this.water = wet ? world.nearestWater(E, this.pond ? 160 : 40) : null;
    this.mode = inp.cls === 'unknown' ? 'stop' : inp.cls === 'ground' && !this.pond ? 'soak' : inp.cls === 'creek' && this.water ? 'salmon' : 'ripple';
    if (this.mode === 'soak' || this.mode === 'stop') this.t.hold = 1300;
  }

  get length(): number {
    return this.pts.length * 0.5;
  }

  private get arrive(): number {
    const t = this.t;
    return t.zoom + t.rain + t.dis + t.travel;
  }

  /** Jumps to the moment the water arrives. */
  skip(now: number): void {
    this.t0 = Math.min(this.t0, now - this.arrive);
  }

  /** Camera with p in the middle of the open band. */
  private cam(p: XY, mpp: number): Cam {
    return { x: p[0], y: p[1] + (0.5 - this.inp.focusY) * this.inp.viewH * mpp, mpp };
  }

  /** Last shot: the end, plus the water it reaches. */
  private endCam(E: XY): Cam {
    const w = this.mode === 'soak' || this.mode === 'stop' ? null : this.water;
    if (!w) return this.cam(E, ST);
    const mpp = clamp(Math.max(Math.abs(w[0] - E[0]) / (this.inp.viewW * 0.62), Math.abs(w[1] - E[1]) / (this.inp.bandH * 0.55)), ST, 2.4);
    return this.cam([(E[0] + w[0]) / 2, (E[1] + w[1]) / 2], mpp);
  }

  frame(now: number): StoryFrame {
    const T = now - this.t0, t = this.t, S = this.pts[0], E = this.pts[this.pts.length - 1];
    const T1 = t.zoom, T2 = T1 + t.rain, T3 = T2 + t.dis, T4 = T3 + t.travel, T4h = T4 + t.hold, T5 = T4h + t.back;
    const base: Scene = { highlight: this.inp.street, pondAt: this.pond ? E : null, drainMark: S };
    if (T < T1) {
      const z = ease(Math.max(0, T) / t.zoom), to = this.cam(S, ST);
      return {
        cam: { x: this.from.x + (to.x - this.from.x) * z, y: this.from.y + (to.y - this.from.y) * z, mpp: logLerp(this.from.mpp, ST, z) },
        scene: { ...base, flash: T / 1000 }, step: 1, prog: 0, ended: false,
      };
    }
    if (T < T2) {
      const r = (T - T1) / t.rain;
      const drop: XY = [S[0], S[1] - 60 * (1 - out3(Math.min(1, r / .8)))];
      return { cam: this.cam(S, ST), scene: { ...base, rain: r, rainT: T, drop }, step: 1, prog: 0, ended: false };
    }
    if (T < T3) return { cam: this.cam(S, ST), scene: { ...base, highlight: null, dissolve: (T - T2) / t.dis }, step: 2, prog: 0, ended: false };
    const trail = { path: this.pts, prog: 1 };
    if (T < T4) {
      const prog = ease((T - T3) / t.travel);
      const head = this.pts[Math.round(prog * (this.pts.length - 1))];
      // pull back mid-journey so more of the path shows
      const mpp = ST * (1 + 0.5 * Math.sin(Math.PI * prog));
      return { cam: this.cam(head, mpp), scene: { ...base, highlight: null, dissolve: 1, trail: { path: this.pts, prog }, drop: head }, step: 3, prog, ended: false };
    }
    const link = this.pond && this.water ? { from: E, to: this.water } : null;
    const fx = (k: number): Ending => ({ kind: this.mode, at: this.mode === 'salmon' || (this.mode === 'ripple' && this.water) ? this.water! : E, t: k });
    if (T < T4h) {
      return { cam: this.cam(E, ST), scene: { ...base, highlight: null, drainMark: null, dissolve: 1, trail, ending: fx((T - T4) / t.hold) }, step: 4, prog: 1, ended: false };
    }
    if (T < T5) {
      const k = ease((T - T4h) / t.back), a = this.cam(E, ST), b = this.endCam(E);
      return {
        cam: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, mpp: logLerp(a.mpp, b.mpp, k) },
        scene: { ...base, highlight: null, drainMark: null, dissolve: 1 - k, trail, link, ending: this.mode === 'stop' ? fx(1) : null },
        step: 4, prog: 1, ended: false,
      };
    }
    const k = (T - T5) / 1600;
    return { cam: this.endCam(E), scene: { ...base, highlight: null, drainMark: null, dissolve: 0, trail, link, ending: this.mode === 'soak' ? null : fx(this.mode === 'stop' ? 1 : k) }, step: 4, prog: 1, ended: true };
  }
}

function densify(path: XY[], step: number): XY[] {
  const out: XY[] = [];
  for (let k = 1; k < path.length; k++) {
    const [ax, ay] = path[k - 1], [bx, by] = path[k];
    const len = Math.hypot(bx - ax, by - ay);
    for (let d = 0; d < len; d += step) out.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
  }
  out.push(path[path.length - 1]);
  return out;
}
