// Opening zoom: the West Coast, Puget Sound, the places traced so far, then down into Bonney Lake.
import type { XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { swatchSVG } from '../map/palette.ts';
import type { Cam, Tag } from '../map/render.ts';
import { OPEN_VIEW } from '../map/views.ts';

/** tag: the place the caption names, kept labeled on the map */
interface Shot { at: XY; mpp: number; icon: string; say: string; hold: number; fly: number; tag?: Tag }

/** How long the opening view stays up under reduced motion, ms. */
export const CALM_HOLD = 2000;

/** The four shots' words and timing (ms). tap: "Click" on a laptop without touch. */
export function script(tap: 'Tap' | 'Click'): { say: string; hold: number; fly: number }[] {
  return [
    { say: 'Coho salmon swim up <b>West Coast</b> streams to spawn.', hold: 2300, fly: 0 },
    { say: 'After a rain, many <b>Puget Sound</b> coho die. A chemical from tire dust is the cause.', hold: 2700, fly: 1500 },
    { say: 'TireTrail follows that rain through real storm pipes. The <b>yellow</b> areas are traced so far.', hold: 2700, fly: 1400 },
    { say: `This is <b>Bonney Lake</b>. ${tap} any street to see where its rain goes.`, hold: 0, fly: 1700 },
  ];
}

/** Reduced motion: the opening view at once; watching again, still cuts through all four. */
export function calmScript<T extends { hold: number; fly: number }>(shots: T[], again: boolean): T[] {
  const last = { ...shots[shots.length - 1], fly: 0, hold: CALM_HOLD };
  return again ? [...shots.slice(0, -1).map((s) => ({ ...s, fly: 0 })), last] : [last];
}

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

export class Intro {
  private readonly app: App;
  private readonly done: () => void;
  private shots: Shot[] = [];
  private t0: number | null = null; // set on the first frame, so a background tab doesn't eat the intro
  private skipped: { t: number; from: Cam } | null = null;
  private shown = -1;
  private over = false;
  private readonly calm: boolean;
  private readonly again: boolean;

  constructor(app: App, done: () => void) {
    [this.app, this.done] = [app, done];
    this.calm = app.renderer.calm;
    this.again = introSeen();
    this.relayout();
  }

  /** Fits each shot to the current screen. */
  relayout(): void {
    const app = this.app;
    this.panel();
    this.shown = -1;
    const R = app.region!, AW = app.renderer.AW, bandH = app.bandH;
    const fit = (w: number, ht: number) => Math.max(w / (AW * 0.92), ht / (bandH * 0.9));
    const [x0, y0, x1, y1] = R.usBox;
    // everywhere traced so far, whichever counties that covers
    const [cx0, cy0, cx1, cy1] = R.coverage?.box ?? R.home?.box ?? R.usBox;
    // the whole country if it fits; on a narrow phone, keep the West Coast in view
    const usMpp = Math.max((y1 - y0) / (bandH * 0.9), Math.min((x1 - x0) / (AW * 0.92), 26000));
    const usX = (x1 - x0) <= AW * 0.92 * usMpp ? (x0 + x1) / 2 : x0 + 0.36 * AW * usMpp;
    const traced: XY = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
    const sound = R.points.find((p) => p.kind === 'water' && p.name === 'Puget Sound')?.at ?? traced;
    const open = app.world.toWorld(OPEN_VIEW.lngLat);
    const words = script(app.layout === 'laptop' && !app.touch ? 'Click' : 'Tap');
    const at: [XY, number, string][] = [
      [[usX, (y0 + y1) / 2], usMpp, ICON.fish()],
      [sound, fit(320e3, 300e3), ICON.drop()],
      [traced, fit((cx1 - cx0) * 1.1, (cy1 - cy0) * 1.1), ICON.pipe()],
      [open, app.layout === 'phone' ? OPEN_VIEW.mppPhone : OPEN_VIEW.mppLaptop, ICON.drop()],
    ];
    const shots: Shot[] = at.map(([p, mpp, icon], k) => ({ at: p, mpp, icon, ...words[k] }));
    shots[1].tag = { at: sound, text: 'Puget Sound', tone: 'plain' };
    shots[3].tag = { at: open, text: 'Bonney Lake', tone: 'plain' };
    this.shots = this.calm ? calmScript(shots, this.again) : shots;
  }

  /** The place the caption names, for the map to keep labeled. */
  get tags(): Tag[] | null {
    const t = this.shots[this.shown]?.tag;
    return t ? [t] : null;
  }

  private panel(): void {
    const app = this.app;
    const skip = () => this.skip();
    if (app.layout === 'phone') {
      app.setPanel(h('div.mini', {}, h('div', {}, h('div.eyebrow', {}, 'TIRETRAIL'), h('div.name', {}, 'Where does the rain go?')), h('div.side', {}, h('button.skip', { onclick: skip }, 'Skip'))), true);
      return;
    }
    const k = (svg: string, t: string) => `<span>${svg}${t}</span>`;
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'TIRETRAIL'),
      h('h2.h', {}, 'Where does the rain on your street go?'),
      h('p.p', {}, 'Rain washes tire dust off roads. Some of it ends up in salmon streams and some soaks into the ground. Only the real storm pipes can tell you which.'),
      h('div.st-key', { html: k(swatchSVG('traced', 'region'), 'Traced by TireTrail') + k(swatchSVG('hatch', 'region'), 'Cities not added yet') }),
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
      // reduced motion cuts straight to the end
      const e = this.calm ? 1 : ease(Math.min(1, (now - this.skipped.t) / 1200));
      this.show(this.shots.length - 1);
      return e >= 1 ? this.finish(this.cam(last.at, last.mpp)) : this.between(this.skipped.from, last, e);
    }
    if (this.t0 === null) this.t0 = now;
    let t = 0;
    const T = Math.max(0, now - this.t0);
    for (let k = 0; k < this.shots.length; k++) {
      const s = this.shots[k];
      if (k > 0 && T < t + s.fly) {
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
    this.end();
    this.done();
    return cam;
  }

  /** Stops here (the person left the tab) and returns where the camera belongs. */
  end(): Cam {
    this.over = true;
    try { localStorage.setItem('tt-intro', '1'); } catch { /* storage blocked */ }
    const last = this.shots[this.shots.length - 1];
    return this.cam(last.at, last.mpp);
  }
}

export function introSeen(): boolean {
  try { return localStorage.getItem('tt-intro') === '1'; } catch { return false; }
}
