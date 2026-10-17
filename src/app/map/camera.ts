// Pan, pinch and wheel zoom, taps, and smooth camera flights.
import type { XY } from '../../geo/geo.ts';
import type { Cam, Renderer } from './render.ts';

export const MIN_MPP = 0.8;
export const MAX_MPP = 10;

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraCtl {
  cam: Cam;
  /** Set when the person moves the map, so a playing story stops steering. */
  userMoved = false;
  /** skip animation (screenshots) */
  instant = false;
  /** widest zoom; raised when the region map is loaded */
  maxMpp = MAX_MPP;
  /** the lower 48 in world meters: the map never shows past it */
  limit: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private flight: { from: Cam; to: Cam; t0: number; ms: number } | null = null;
  private readonly pts = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean } | null = null;
  private pinch: { d: number; mpp: number; mid: { x: number; y: number } } | null = null;
  private readonly el: HTMLElement;
  private readonly r: Renderer;
  private readonly bounds: { x0: number; y0: number; x1: number; y1: number };
  private readonly onTap: (p: XY) => void;
  private readonly clock: () => number;

  constructor(el: HTMLElement, r: Renderer, start: Cam, bounds: { x0: number; y0: number; x1: number; y1: number }, onTap: (p: XY) => void, clock = () => performance.now()) {
    [this.el, this.r, this.bounds, this.onTap, this.clock] = [el, r, bounds, onTap, clock];
    this.cam = { ...start };
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  flyTo(to: Partial<Cam>, ms = 700): void {
    if (this.instant) {
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

  /** The +/- buttons: the person takes the camera, as with wheel and pinch. */
  zoomBy(f: number): void {
    this.userMoved = true;
    const mpp = clamp(this.cam.mpp * f, MIN_MPP, this.maxMpp);
    const [x, y] = this.inLimit(this.cam.x, this.cam.y, mpp);
    this.flyTo({ x, y, mpp }, 280);
  }

  /** Where a flight at this zoom may land: the usual wander limit around town. */
  clampTarget(x: number, y: number, mpp: number): XY {
    const b = this.bounds, pad = 300 + mpp * 400;
    return this.inLimit(clamp(x, b.x0 - pad, b.x1 + pad), clamp(y, b.y0 - pad, b.y1 + pad), mpp);
  }

  /** Far out, keep the view over the country instead of out at sea. */
  private inLimit(x: number, y: number, mpp: number): XY {
    const L = this.limit;
    if (!L) return [x, y];
    const hw = (this.r.AW * mpp) / 2, hh = (this.r.AH * mpp) / 2;
    const xs = span(L.x0 + hw, L.x1 - hw), ys = span(L.y0 + hh, L.y1 - hh);
    return [clamp(x, xs[0], xs[1]), clamp(y, ys[0], ys[1])];
  }

  /** Advances any flight; true while moving. */
  tick(now: number): boolean {
    if (!this.flight) return false;
    const { from, to, t0, ms } = this.flight;
    const t = Math.min(1, Math.max(0, (now - t0) / ms));
    const e = ease(t);
    this.cam = {
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      // zoom in log space so it feels even
      mpp: Math.exp(Math.log(from.mpp) + (Math.log(to.mpp) - Math.log(from.mpp)) * e),
    };
    if (t >= 1) this.flight = null;
    return true;
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  // The farther out, the farther you can wander. A camera already outside (a drive out of town)
  // may come back but not drift farther, so the first drag never jumps.
  private clampCam(prev: Cam): void {
    this.cam.mpp = clamp(this.cam.mpp, MIN_MPP, this.maxMpp);
    const b = this.bounds, pad = 300 + this.cam.mpp * 400;
    this.cam.x = clampAxis(this.cam.x, prev.x, b.x0 - pad, b.x1 + pad);
    this.cam.y = clampAxis(this.cam.y, prev.y, b.y0 - pad, b.y1 + pad);
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
    if (this.pts.size === 1) this.down = { ...p, t: performance.now(), moved: false };
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
    if (this.down && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 6) this.down.moved = true;
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
    const tap = this.down && !this.down.moved && this.pts.size === 1 && performance.now() - this.down.t < 450;
    this.pts.delete(e.pointerId);
    if (this.pts.size < 2) this.pinch = null;
    if (this.pts.size === 0) this.down = null;
    if (tap) this.onTap(this.r.toWorld(this.cam, p.x, p.y));
  };

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
