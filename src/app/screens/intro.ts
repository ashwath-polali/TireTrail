// Opening zoom: the West Coast, Puget Sound, Pierce County, then down into Bonney Lake.
import type { XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cam } from '../map/render.ts';

interface Shot { at: XY; mpp: number; icon: string; say: string; hold: number; fly: number }

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

export class Intro {
  private readonly app: App;
  private readonly done: () => void;
  private shots: Shot[] = [];
  private t0 = 0;
  private skipped: { t: number; from: Cam } | null = null;
  private shown = -1;
  private over = false;

  constructor(app: App, done: () => void) {
    [this.app, this.done] = [app, done];
    this.relayout();
    this.t0 = app.now();
  }

  /** Fits each shot to the current screen. */
  relayout(): void {
    const app = this.app;
    this.panel();
    this.shown = -1;
    const R = app.region!, AW = app.renderer.AW, bandH = app.bandH;
    const fit = (w: number, ht: number) => Math.max(w / (AW * 0.92), ht / (bandH * 0.9));
    const [x0, y0, x1, y1] = R.usBox, [cx0, cy0, cx1, cy1] = R.home!.box;
    // the whole country if it fits; on a narrow phone, keep the West Coast in view
    const usMpp = Math.max((y1 - y0) / (bandH * 0.9), Math.min((x1 - x0) / (AW * 0.92), 26000));
    const usX = (x1 - x0) <= AW * 0.92 * usMpp ? (x0 + x1) / 2 : x0 + 0.36 * AW * usMpp;
    const sound = R.points.find((p) => p.kind === 'water' && p.name === 'Puget Sound')!.at;
    this.shots = [
      { at: [usX, (y0 + y1) / 2], mpp: usMpp, icon: ICON.fish(), say: 'Coho salmon spawn in streams up and down the <b>West Coast</b>.', hold: 2600, fly: 0 },
      { at: sound, mpp: fit(320e3, 300e3), icon: ICON.drop(), say: 'Around <b>Puget Sound</b>, many coho die in city streams right after it rains. The cause is a chemical in tire dust.', hold: 3400, fly: 2000 },
      { at: [(cx0 + cx1) / 2, (cy0 + cy1) / 2], mpp: fit((cx1 - cx0) * 1.1, (cy1 - cy0) * 1.1), icon: ICON.pipe(), say: 'TireTrail follows that rain through real storm pipes. <b>Bonney Lake</b>, in yellow, is traced so far.', hold: 3400, fly: 1800 },
      { at: app.world.center, mpp: 6, icon: ICON.drop(), say: 'Tap any street to see where its rain goes.', hold: 0, fly: 2400 },
    ];
  }

  private panel(): void {
    const app = this.app;
    const skip = () => this.skip();
    if (app.layout === 'phone') {
      app.setPanel(h('div.mini', {}, h('div', {}, h('div.eyebrow', {}, 'TIRETRAIL'), h('div.name', {}, 'Where does the rain go?')), h('div.side', {}, h('button.skip', { onclick: skip }, 'Skip'))), true);
      return;
    }
    const k = (c: string, t: string) => `<span style="--k:${c}">${t}</span>`;
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'TIRETRAIL'),
      h('h2.h', {}, 'Where does the rain on your street go?'),
      h('p.p', {}, 'Rain washes tire dust off roads. Some of it ends up in salmon streams and some soaks into the ground. Only the real storm pipes can tell you which.'),
      h('div.key', { html: k('#f2d27a', 'Pipes traced: Bonney Lake') + k('#93a48d', 'Not traced yet') }),
      h('div.actions', {}, h('button.btn.quiet', { onclick: skip }, 'Skip the intro'))));
  }

  /** Camera that puts p in the middle of the open band. */
  private cam(p: XY, mpp: number): Cam {
    return this.app.camAt(p, mpp);
  }

  // zoom about the target so it glides to the middle instead of swinging past
  private between(a: Cam, to: Shot, e: number): Cam {
    const b0 = this.cam(to.at, a.mpp);
    const ox = (a.x - b0.x) / a.mpp, oy = (a.y - b0.y) / a.mpp;
    const mpp = logLerp(a.mpp, to.mpp, e), b = this.cam(to.at, mpp);
    return { x: b.x + ox * (1 - e) * mpp, y: b.y + oy * (1 - e) * mpp, mpp };
  }

  private show(k: number): void {
    if (k === this.shown) return;
    this.shown = k;
    const s = this.shots[k];
    this.app.setCaption(`intro:${k}`, s.icon, `<span class="say">${s.say}</span>`);
  }

  skip(): void {
    if (!this.skipped && !this.over) this.skipped = { t: this.app.now(), from: { ...this.app.camera.cam } };
  }

  frame(now: number): Cam | null {
    if (this.over) return null;
    const last = this.shots[this.shots.length - 1];
    if (this.app.camera.userMoved) return this.finish(null);
    if (this.skipped) {
      const e = ease(Math.min(1, (now - this.skipped.t) / 1200));
      this.show(this.shots.length - 1);
      return e >= 1 ? this.finish(this.cam(last.at, last.mpp)) : this.between(this.skipped.from, last, e);
    }
    let t = 0, T = now - this.t0;
    for (let k = 0; k < this.shots.length; k++) {
      const s = this.shots[k];
      if (T < t + s.fly) {
        this.show(k);
        const p = this.shots[k - 1];
        return this.between(this.cam(p.at, p.mpp), s, ease((T - t) / s.fly));
      }
      t += s.fly;
      if (T < t + s.hold) {
        this.show(k);
        return this.cam(s.at, s.mpp);
      }
      t += s.hold;
    }
    return this.finish(this.cam(last.at, last.mpp));
  }

  private finish(cam: Cam | null): Cam | null {
    this.over = true;
    try { localStorage.setItem('tt-intro', '1'); } catch { /* storage blocked */ }
    this.done();
    return cam;
  }
}

export function introSeen(): boolean {
  try { return localStorage.getItem('tt-intro') === '1'; } catch { return false; }
}
