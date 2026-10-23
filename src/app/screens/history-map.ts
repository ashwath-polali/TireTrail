// My drives on the map: a coho flag on each creek crossed, a bell on the spot to watch, framed in the open part of the map.
import type { LngLat, XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { regionPt } from '../map/region.ts';
import { REGION_MPP, type Cam } from '../map/render.ts';
import { speciesSVG } from '../../salmon/species.ts';
import { calm, glyph, salmonSVG } from '../ui/ui.ts';

/** gentle: always crossed gently; mixed: a hard brake near it; sample: the sample drive's, signed out */
export type MarkKind = 'gentle' | 'mixed' | 'sample' | 'spot';
export interface Mark { ll: LngLat; kind: MarkKind; dim?: boolean; /** species bit for a creek's fish; coho when unset */ fish?: number }

/** CSS px a flag stands above its point */
const LIFT = 34;
/** how much taller a flag stands to clear one below it, CSS px */
const STEP = 28;

export class Marks {
  private readonly app: App;
  private readonly el = h('div.my-marks', { 'aria-hidden': 'true' });
  private marks: Mark[] = [];
  private nodes: HTMLElement[] = [];
  private at: string[] = [];
  /** how much taller each flag stands this frame */
  private ups: number[] = [];
  picked = -1;

  constructor(app: App) {
    this.app = app;
  }

  /** New marks; play: drop them in one by one. */
  set(marks: Mark[], play: boolean): void {
    this.marks = marks;
    this.picked = Math.min(this.picked, marks.length - 1);
    const go = play && !calm();
    this.nodes = marks.map((m, i) => h('div.my-mark', { 'data-kind': m.kind },
      h(go ? 'div.my-mark-in.my-drop' : 'div.my-mark-in', { style: go ? `animation-delay:${200 + i * 90}ms` : undefined },
        h('span.my-flag', { html: m.kind === 'spot' ? glyph('bell', 2) : m.fish ? speciesSVG(m.fish, 2) : salmonSVG(2) }),
        h('span.my-stem'), h('span.my-dot'))));
    this.at = [];
    this.ups = [];
    this.el.replaceChildren(...this.nodes);
    this.style();
  }

  /** Dims the marks not in this week, without dropping them in again. */
  dim(dims: boolean[]): void {
    dims.forEach((d, i) => { if (this.marks[i]) this.marks[i].dim = d; });
    this.style();
  }

  pick(i: number): void {
    this.picked = i;
    this.style();
  }

  private style(): void {
    this.nodes.forEach((n, i) => {
      n.classList.toggle('my-dim', !!this.marks[i]?.dim);
      n.classList.toggle('my-picked', i === this.picked);
    });
  }

  /** Into the map, under nothing but the caption and card. */
  show(): void {
    const wrap = this.app.panel.closest('.stage')?.querySelector('.mapwrap');
    if (wrap && this.el.parentElement !== wrap) wrap.append(this.el);
  }

  hide(): void {
    this.el.remove();
  }

  /** A point in the camera's meters: street meters up close, the region map's far out. */
  private pt(ll: LngLat, mpp: number): XY {
    const w = this.app.world.toWorld(ll);
    return this.app.region && mpp > REGION_MPP ? regionPt(w) : w;
  }

  /** Each frame: every mark to its place, in whole pixels. A flag that would cover another stands taller. */
  place(cam: Cam): void {
    const r = this.app.renderer, boxes: number[][] = [];
    const xy = this.marks.map((m) => r.toScreen(cam, this.pt(m.ll, cam.mpp)).map(Math.round));
    const hits = (b: number[]) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    // the spot first, then creeks from the bottom of the screen up
    const order = this.marks.map((_, i) => i).sort((a, b) => Number(this.marks[b].kind === 'spot') - Number(this.marks[a].kind === 'spot') || xy[b][1] - xy[a][1]);
    for (const i of order) {
      const [x, y] = xy[i];
      let up = 0;
      if (this.marks[i].kind === 'spot') boxes.push([x - 4, y - 15, x + 38, y + 15]);
      else {
        while (up < 3 * STEP && hits([x - 22, y - LIFT - 4 - up, x + 22, y - 10 - up])) up += STEP;
        boxes.push([x - 22, y - LIFT - 4 - up, x + 22, y + 4]);
      }
      this.ups[i] = up;
      const t = `translate(${x}px,${y}px)|${up}`;
      if (this.at[i] !== t) {
        this.nodes[i].style.transform = `translate(${x}px,${y}px)`;
        this.nodes[i].style.setProperty('--up', `${up}px`);
        this.at[i] = t;
      }
    }
  }

  /** The mark under a tap (p in the camera's meters), or -1. */
  hit(p: XY): number {
    const cam = this.app.camera.cam, r = this.app.renderer, [px, py] = r.toScreen(cam, p);
    let best = -1, bd = 30;
    this.marks.forEach((m, i) => {
      // creek flags stand above their points; the spot's to the right of its own
      const [x, y] = r.toScreen(cam, this.pt(m.ll, cam.mpp)), d = m.kind === 'spot' ? Math.hypot(px - x - 23, py - y) : Math.hypot(px - x, py - (y - LIFT / 2 - 6 - (this.ups[i] ?? 0)));
      if (d < bd) [best, bd] = [i, d];
    });
    return best;
  }

  /** Flies to show these points in the open part of the map, no closer than min m a pixel. */
  fit(lls: LngLat[], ms = 900, min = 3): void {
    if (!lls.length) return;
    const app = this.app, o = app.openArea(), S = 3;
    const frame = (pts: XY[]) => {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      // flags stand LIFT px above their points and are about 40 px wide
      const need = Math.max((x1 - x0) / Math.max(10, o.w - 48 / S * 2), (y1 - y0) / Math.max(10, o.h - (LIFT + 40) / S));
      return { need, c: [(x0 + x1) / 2, (y0 + y1) / 2] as XY };
    };
    let f = frame(lls.map((ll) => app.world.toWorld(ll))), mpp = Math.min(REGION_MPP, Math.max(min, f.need * 1.15));
    if (f.need * 1.15 > REGION_MPP && app.region) {
      f = frame(lls.map((ll) => regionPt(app.world.toWorld(ll))));
      mpp = Math.max(REGION_MPP * 1.05, f.need * 1.15);
    }
    const c: XY = [f.c[0], f.c[1] - (LIFT / 2 / S) * mpp];
    app.camera.follow();
    app.camera.flyTo(app.camAt(c, mpp), ms);
  }
}
