// The reveal's sprites over the map: a coho leaps where a creek was crossed gently, a dust puff where a hard brake was near.
// One canvas over the map, drawn with the map's frame so the sprites stay on their creeks while the camera moves.
import type { XY } from '../../geo/geo.ts';
import { frameAt, onFrame } from './px.ts';
import { SPRITES } from './sprites.ts';
import { LEAP_MS, leapAt } from './route-reveal.ts';

export interface Leap {
  /** css px on the map */
  at: XY;
  gentle: boolean;
  /** when it starts, ms into the reveal */
  start: number;
}

export class MapLeaps {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly map: HTMLCanvasElement;
  private drawn = false;

  /** map: the map's canvas; this one sits just above it, the same size, so map css px line up */
  constructor(map: HTMLCanvasElement) {
    this.map = map;
    this.el = document.createElement('canvas');
    this.el.className = 'rp-leaps';
    this.el.setAttribute('aria-hidden', 'true');
    map.after(this.el);
    this.ctx = this.el.getContext('2d')!;
  }

  /** Draws the leaps under way t ms into the reveal. */
  draw(t: number, leaps: readonly Leap[]): void {
    const live = leaps.filter((l) => t >= l.start && t < l.start + LEAP_MS);
    if (!live.length) { this.clear(); return; }
    const W = this.map.offsetWidth, H = this.map.offsetHeight, dpr = Math.min(2, Math.round(devicePixelRatio || 1));
    if (this.el.width !== W * dpr || this.el.height !== H * dpr) {
      [this.el.width, this.el.height] = [W * dpr, H * dpr];
      Object.assign(this.el.style, { width: `${W}px`, height: `${H}px` });
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, W, H);
    for (const l of live) {
      // pixel steps, 12 a second
      const e = onFrame(t - l.start), u = e / LEAP_MS, [x, y] = [Math.round(l.at[0]), Math.round(l.at[1])];
      if (l.gentle) {
        const f = SPRITES.coho, [dx, dy] = leapAt(u);
        f.draw(c, frameAt(f, e), x + dx - f.w / 2, y + dy - f.h / 2 - 6);
        // a sparkle at the top of the leap
        if (u > 0.35 && u < 0.85) {
          const s = SPRITES.sparkle;
          s.draw(c, frameAt(s, e - 0.35 * LEAP_MS), x + 14 - s.w / 2, y - 40 - s.h / 2);
        }
      } else {
        const f = SPRITES.puff, i = Math.min(f.n - 1, Math.floor(e / (1000 / f.fps)));
        f.draw(c, i, x - f.w / 2, y - f.h + 6);
      }
    }
    this.drawn = true;
  }

  clear(): void {
    if (!this.drawn) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
    this.drawn = false;
  }
}
