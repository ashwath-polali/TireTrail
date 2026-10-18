// Pan, pinch and wheel zoom, taps, and smooth camera flights.
import type { XY } from '../../geo/geo.ts';
import { REGION_MPP, type Cam, type Renderer } from './render.ts';

export const MIN_MPP = 0.8;
export const MAX_MPP = 10;
/** a press counts as a tap if it lasts less than this */
export const TAP_MS = 800;
/** and slides less than this many CSS px (fingers wobble more than a mouse) */
export const SLOP = { touch: 10, mouse: 6 };
/** the browser's click after a map tap, if it lands this close this soon, is not a button press */
export const GHOST = { ms: 400, px: 30 };

export interface Box { x0: number; y0: number; x1: number; y1: number }
/** The part of the map no card covers, in art px: its middle's offset from the canvas middle, and its size. */
export interface Open { cx: number; cy: number; w: number; h: number }

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraCtl {
  cam: Cam;
  /** Set when the person moves the map, so a playing story stops steering. */
  userMoved = false;
  /** skip animation (screenshots) */
  instant = false;
  /** widest zoom; raised when the region map is loaded */
  maxMpp = MAX_MPP;
  /** the lower 48 as the region map draws them: far out, the open part of the map stays inside */
  limit: Box | null = null;
  /** world meters: up close (mpp <= 24) the middle of the view stays inside */
  wander: Box | null = null;
  /** the uncovered part of the map; the whole canvas if not set */
  open: (() => Open) | null = null;
  /** where and when the last tap landed, in client px */
  lastTap: { t: number; x: number; y: number } | null = null;
  private flight: { from: Cam; to: Cam; t0: number; ms: number } | null = null;
  private readonly pts = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean; slop: number } | null = null;
  private pinch: { d: number; mpp: number; mid: { x: number; y: number } } | null = null;
  private readonly el: HTMLElement;
  private readonly r: Renderer;
  private readonly onTap: (p: XY) => void;
  private readonly clock: () => number;
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor(el: HTMLElement, r: Renderer, start: Cam, onTap: (p: XY) => void, clock = () => performance.now()) {
    [this.el, this.r, this.onTap, this.clock] = [el, r, onTap, clock];
    this.cam = { ...start };
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** The viewer asked for less motion: flights jump. */
  get calm(): boolean {
    return !!this.motion?.matches;
  }

  flyTo(to: Partial<Cam>, ms = 700): void {
    if (this.instant || this.calm) {
      this.cam = { ...this.cam, ...to };
      this.flight = null;
      return;
    }
    this.flight = { from: { ...this.cam }, to: { ...this.cam, ...to }, t0: this.clock(), ms };
  }

  /** Hands the camera back to the app (a story or a flight). */
  follow(): void {
    this.flight = null;
    this.userMoved = false;
  }

  /** A flight the person asked for (the Home button): stories stop steering. */
  goTo(to: Cam, ms = 900): void {
    this.userMoved = true;
    this.flyTo(to, ms);
  }

  /** The +/- buttons: the person takes the camera, as with wheel and pinch. */
  zoomBy(f: number): void {
    this.userMoved = true;
    const mpp = clamp(this.cam.mpp * f, MIN_MPP, this.maxMpp);
    const [x, y] = this.inLimit(this.cam.x, this.cam.y, mpp);
    this.flyTo({ x, y, mpp }, 280);
  }

  /** Where a flight at this zoom may land: in the wander box up close (or no farther out than the camera is), over the country far out. */
  clampTarget(x: number, y: number, mpp: number): XY {
    const W = this.wander;
    if (W && mpp <= REGION_MPP) [x, y] = [clampAxis(x, this.cam.x, W.x0, W.x1), clampAxis(y, this.cam.y, W.y0, W.y1)];
    return this.inLimit(x, y, mpp);
  }

  /** Far out, keep the open part of the map over the country instead of out at sea. */
  private inLimit(x: number, y: number, mpp: number): XY {
    const L = this.limit;
    if (!L) return [x, y];
    return inBox(x, y, mpp, L, this.open?.() ?? { cx: 0, cy: 0, w: this.r.AW, h: this.r.AH });
  }

  /** Keeps a still camera inside the limits far out; they move as cards open and close. */
  settle(): void {
    if (this.flight || this.cam.mpp <= REGION_MPP) return;
    const mpp = Math.min(this.cam.mpp, this.maxMpp);
    const [x, y] = this.inLimit(this.cam.x, this.cam.y, mpp);
    if (mpp !== this.cam.mpp || Math.abs(x - this.cam.x) > 1e-6 || Math.abs(y - this.cam.y) > 1e-6) this.cam = { x, y, mpp };
  }

  /** Advances any flight; true while moving. */
  tick(now: number): boolean {
    if (!this.flight) return false;
    const { from, to, t0, ms } = this.flight;
    const t = Math.min(1, Math.max(0, (now - t0) / ms));
    if (t >= 1) {
      // land exactly where asked
      this.cam = { ...to };
      this.flight = null;
      return true;
    }
    const e = ease(t);
    this.cam = {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      // zoom in log space so it feels even
      mpp: Math.exp(Math.log(from.mpp) + (Math.log(to.mpp) - Math.log(from.mpp)) * e),
    };
    return true;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  // Up close the view stays in the wander box; far out, over the country. A camera already outside
  // (a drive out of town) may come back but not drift farther, so the first drag never jumps.
  private clampCam(prev: Cam): void {
    this.cam.mpp = clamp(this.cam.mpp, MIN_MPP, this.maxMpp);
    const W = this.wander;
    if (W && this.cam.mpp <= REGION_MPP) {
      this.cam.x = clampAxis(this.cam.x, prev.x, W.x0, W.x1);
      this.cam.y = clampAxis(this.cam.y, prev.y, W.y0, W.y1);
    }
    [this.cam.x, this.cam.y] = this.inLimit(this.cam.x, this.cam.y, this.cam.mpp);
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rc = this.r.canvas.getBoundingClientRect();
    // the canvas is scaled to fit; convert to its own CSS pixels
    const sx = this.r.canvas.offsetWidth / rc.width;
    return { x: (e.clientX - rc.left) * sx, y: (e.clientY - rc.top) * sx };
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    if (this.pts.size === 1) this.down = { ...p, t: performance.now(), moved: false, slop: e.pointerType === 'mouse' ? SLOP.mouse : SLOP.touch };
    if (this.pts.size === 2) {
      const [a, b] = [...this.pts.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mpp: this.cam.mpp, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (this.down) this.down.moved = true;
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    const prev = this.pts.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    const before = { ...this.cam };
    if (this.pts.size === 2 && this.pinch) {
      // keep the spot between the fingers under them as they spread and move
      const [a, b] = [...this.pts.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const was = this.r.toWorld(this.cam, this.pinch.mid.x, this.pinch.mid.y);
      this.cam.mpp = clamp(this.pinch.mpp * (this.pinch.d / (Math.hypot(a.x - b.x, a.y - b.y) || 1)), MIN_MPP, this.maxMpp);
      const now = this.r.toWorld(this.cam, mid.x, mid.y);
      this.cam.x += was[0] - now[0];
      this.cam.y += was[1] - now[1];
      this.pinch.mid = mid;
      this.clampCam(before);
      this.userMoved = true;
      this.flight = null;
      return;
    }
    if (this.down && Math.hypot(p.x - this.down.x, p.y - this.down.y) > this.down.slop) this.down.moved = true;
    if (this.down?.moved) {
      // drag: move the map with the finger
      const k = this.cam.mpp / 3;
      this.cam.x -= (p.x - prev.x) * k;
      this.cam.y -= (p.y - prev.y) * k;
      this.clampCam(before);
      this.userMoved = true;
      this.flight = null;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    const p = this.local(e);
    const tap = this.down && !this.down.moved && this.pts.size === 1 && e.type === 'pointerup' && performance.now() - this.down.t < TAP_MS;
    this.pts.delete(e.pointerId);
    if (this.pts.size < 2) this.pinch = null;
    if (this.pts.size === 0) this.down = null;
    if (!tap) return;
    this.lastTap = { t: performance.now(), x: e.clientX, y: e.clientY };
    this.onTap(this.r.toWorld(this.cam, p.x, p.y));
  };

  /** True for the browser's follow-up click on a map tap, which can land on a button that just moved under it. */
  ghost(e: MouseEvent): boolean {
    const t = this.lastTap;
    // keyboard clicks have no pointer
    return !!t && e.detail > 0 && performance.now() - t.t < GHOST.ms && Math.hypot(e.clientX - t.x, e.clientY - t.y) < GHOST.px;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const prev = { ...this.cam };
    const before = this.r.toWorld(this.cam, p.x, p.y);
    this.cam.mpp = clamp(this.cam.mpp * Math.pow(1.0018, e.deltaY), MIN_MPP, this.maxMpp);
    // keep the point under the cursor fixed
    const after = this.r.toWorld(this.cam, p.x, p.y);
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
    this.clampCam(prev);
    this.userMoved = true;
    this.flight = null;
  };
}

/** Camera middle that keeps the open part of the view (o, art px) inside box L at this zoom; centered where it is wider. */
export function inBox(x: number, y: number, mpp: number, L: Box, o: Open): XY {
  const fx = x + o.cx * mpp, fy = y + o.cy * mpp;
  const hw = (o.w * mpp) / 2, hh = (o.h * mpp) / 2;
  const xs = span(L.x0 + hw, L.x1 - hw), ys = span(L.y0 + hh, L.y1 - hh);
  return [clamp(fx, xs[0], xs[1]) - o.cx * mpp, clamp(fy, ys[0], ys[1]) - o.cy * mpp];
}

/** Widest zoom that shows the whole box in the open part: on a tall screen its height fills 92% and it pans east and west. */
export function capMpp(L: Box, o: Open): number {
  const W = L.x1 - L.x0, H = L.y1 - L.y0;
  return o.w < o.h ? H / (o.h * 0.92) : Math.max(W / o.w, H / o.h) / 0.92;
}

/** lo..hi, or just its middle when the view is wider than the range */
const span = (lo: number, hi: number): [number, number] => (lo <= hi ? [lo, hi] : [(lo + hi) / 2, (lo + hi) / 2]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Like clamp, but a value already outside may move back in, never farther out. */
function clampAxis(v: number, prev: number, lo: number, hi: number): number {
  if (v < lo) return Math.max(v, Math.min(lo, prev));
  if (v > hi) return Math.min(v, Math.max(hi, prev));
  return v;
}
