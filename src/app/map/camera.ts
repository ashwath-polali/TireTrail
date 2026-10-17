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
  private flight: { from: Cam; to: Cam; t0: number; ms: number } | null = null;
  private readonly pts = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean } | null = null;
  private pinch: { d: number; mpp: number } | null = null;
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

  zoomBy(f: number): void {
    this.flyTo({ mpp: clamp(this.cam.mpp * f, MIN_MPP, MAX_MPP) }, 280);
  }

  /** Advances any flight; true while moving. */
  tick(now: number): boolean {
    if (!this.flight) return false;
    const { from, to, t0, ms } = this.flight;
    const t = Math.min(1, (now - t0) / ms);
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

  private clampCam(): void {
    const b = this.bounds, pad = 300;
    this.cam.x = clamp(this.cam.x, b.x0 - pad, b.x1 + pad);
    this.cam.y = clamp(this.cam.y, b.y0 - pad, b.y1 + pad);
    this.cam.mpp = clamp(this.cam.mpp, MIN_MPP, MAX_MPP);
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
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mpp: this.cam.mpp };
      if (this.down) this.down.moved = true;
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    const prev = this.pts.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    if (this.pts.size === 2 && this.pinch) {
      const [a, b] = [...this.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.cam.mpp = clamp(this.pinch.mpp * (this.pinch.d / d), MIN_MPP, MAX_MPP);
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
      this.clampCam();
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
    const before = this.r.toWorld(this.cam, p.x, p.y);
    this.cam.mpp = clamp(this.cam.mpp * Math.pow(1.0018, e.deltaY), MIN_MPP, MAX_MPP);
    // keep the point under the cursor fixed
    const after = this.r.toWorld(this.cam, p.x, p.y);
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
    this.clampCam();
    this.userMoved = true;
    this.flight = null;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
