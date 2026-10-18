// First-visit coach: three short steps with a spotlight on the map, then the map is theirs.
import type { XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { swatchSVG, type Swatch } from '../map/palette.ts';
import { S } from '../map/render.ts';
import type { Run } from '../map/world.ts';
import { plainWater, tapWord } from './common.ts';
import { cohoWater } from './resolve.ts';

type How = 'skip' | 'show' | 'moved';
interface Step { at: XY; ring2: XY | null; title: string; body: string; legend: boolean; run: Run | null }

/** spotlight radius, CSS px (26 art px) */
const R = 78;

export const coachSeen = (): boolean => { try { return localStorage.getItem('tt-maptut') === '1'; } catch { return false; } };

export class Coach {
  private readonly app: App;
  private readonly steps: Step[];
  private readonly done: (how: How, run?: Run) => void;
  private readonly root: HTMLElement;
  private readonly dim: HTMLElement;
  private readonly rings: HTMLElement[];
  private bubble: HTMLElement | null = null;
  private k = 0;
  private readonly cam: { x: number; y: number; mpp: number };
  private placed = '';

  /** A coach for what's in view, or null when nothing in view can be shown. */
  static make(app: App, done: (how: How, run?: Run) => void): Coach | null {
    const steps = plan(app);
    if (!steps.length) return null;
    try { localStorage.setItem('tt-maptut', '1'); } catch { /* storage blocked */ }
    return new Coach(app, steps, done);
  }

  private constructor(app: App, steps: Step[], done: (how: How, run?: Run) => void) {
    [this.app, this.steps, this.done] = [app, steps, done];
    this.cam = { ...app.camera.cam };
    this.dim = h('div.mu-dim');
    this.rings = [h('div.mu-ring'), h('div.mu-ring')];
    this.root = h('div.mu-coach', { 'aria-hidden': 'true' }, this.dim, ...this.rings);
    app.caption.parentElement?.append(this.root);
    this.draw();
  }

  /** Keeps the spotlight on its street; a drag or zoom hands the map over. */
  frame(): void {
    const c = this.app.camera.cam;
    if (Math.abs(c.mpp - this.cam.mpp) > 1e-6 || Math.hypot(c.x - this.cam.x, c.y - this.cam.y) > c.mpp / 3) { this.done('moved'); return; }
    this.place();
  }

  relayout(): void {
    this.placed = '';
    this.draw();
  }

  end(): void {
    this.root.remove();
    this.bubble?.remove();
  }

  private go(k: number): void {
    this.k = Math.max(0, Math.min(this.steps.length - 1, k));
    this.draw();
  }

  private draw(): void {
    const app = this.app, s = this.steps[this.k], n = this.steps.length, last = this.k === n - 1;
    const body = s.legend && app.layout === 'phone'
      ? h('div.mu-rows', {}, ...legendRows(app))
      : h('p.mu-cbody', {}, s.body);
    const buttons = last && s.run
      ? [h('button.btn.main.mu-btn', { onclick: () => this.done('show', s.run!) }, 'Show me'), h('button.btn.quiet.mu-btn', { onclick: () => this.done('skip') }, "I'll explore")]
      : last
        ? [h('button.btn.main.mu-btn', { onclick: () => this.done('skip') }, 'Got it')]
        : [this.k ? h('button.btn.quiet.mu-btn', { onclick: () => this.go(this.k - 1) }, 'Back') : null, h('button.btn.main.mu-btn', { onclick: () => this.go(this.k + 1) }, 'Next')];
    const words = h('div.mu-cwords', { role: 'dialog', 'aria-label': 'How to read the map' },
      h('div.mu-eyebrow', {}, `HOW TO READ THE MAP · ${this.k + 1} OF ${n}`),
      h('h2.mu-ctitle', { tabindex: '-1' }, s.title),
      body,
      h('div.mu-btns', {}, ...buttons),
      this.k === 0 && !last ? h('button.mu-link', { onclick: () => this.done('skip') }, 'Skip') : null);
    this.bubble?.remove();
    this.bubble = null;
    if (app.layout === 'phone') app.setPanel(h('div.fade.mu-card', {}, words));
    else {
      this.bubble = h('div.mu-bubble.fade', {}, words);
      app.caption.parentElement?.append(this.bubble);
    }
    this.placed = '';
    this.place();
    (words.querySelector('.mu-ctitle') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Puts the spotlight, rings and bubble where the street is now. */
  private place(): void {
    const app = this.app, r = app.renderer, s = this.steps[this.k];
    const wrap = r.canvas.parentElement!;
    // the canvas sits centered in the map, a pixel or two bigger
    const ox = (wrap.clientWidth - r.canvas.offsetWidth) / 2, oy = (wrap.clientHeight - r.canvas.offsetHeight) / 2;
    const at = (p: XY): XY => { const q = r.toScreen(app.camera.cam, p); return [Math.round(q[0] + ox), Math.round(q[1] + oy)]; };
    const [x, y] = at(s.at), two = s.ring2 ? at(s.ring2) : null;
    const key = `${this.k}|${x}|${y}|${two}|${wrap.clientWidth}|${wrap.clientHeight}`;
    if (key === this.placed) return;
    this.placed = key;
    this.dim.style.background = `radial-gradient(circle at ${x}px ${y}px, transparent ${R - 1}px, rgba(6, 9, 7, .42) ${R}px)`;
    const ring = (el: HTMLElement, p: XY | null) => {
      el.style.display = p ? '' : 'none';
      if (p) el.style.transform = `translate(${p[0] - R}px, ${p[1] - R}px)`;
    };
    ring(this.rings[0], [x, y]);
    ring(this.rings[1], two);
    const b = this.bubble;
    if (!b) return;
    // beside the spotlight, never over the card or the caption
    const W = wrap.clientWidth, H = wrap.clientHeight, bw = b.offsetWidth || 300, bh = b.offsetHeight || 160;
    const card = app.panel.childElementCount ? app.panel.offsetWidth + 32 : 16;
    const top = app.caption.offsetTop + app.caption.offsetHeight + 12;
    const spots: XY[] = [[x + R + 16, y - bh / 2], [x - R - 16 - bw, y - bh / 2], [x - bw / 2, y + R + 16], [x - bw / 2, y - R - 16 - bh]];
    const fits = ([bx, by]: XY) => bx >= card && bx + bw <= W - 72 && by >= top && by + bh <= H - 16;
    let [bx, by] = spots.find(fits) ?? spots[0];
    bx = Math.max(card, Math.min(W - 72 - bw, bx));
    by = Math.max(top, Math.min(H - 16 - bh, by));
    b.style.transform = `translate(${Math.round(bx)}px, ${Math.round(by)}px)`;
  }
}

/** The steps, from what's in view: a coho stream, a street to a salmon stream, a soak-in street. */
function plan(app: App): Step[] {
  const w = app.world, r = app.renderer, cam = app.camera.cam, T = tapWord(app);
  const W = r.AW * S, H = r.AH * S, phone = app.layout === 'phone';
  const left = !phone && app.panel.childElementCount ? app.panel.offsetWidth + 32 : 0;
  const top = Math.max(app.caption.offsetTop + app.caption.offsetHeight, (app.focusY * r.AH - app.bandH / 2) * S);
  // on a phone the coach's words take the bottom sheet
  const bot = Math.min((app.focusY * r.AH + app.bandH / 2) * S, phone ? H * .55 : H);
  const cx = (left + W) / 2, cy = (top + bot) / 2;
  const ok = (x: number, y: number) => x >= left + R + 8 && x <= W - R - (phone ? 64 : 80) && y >= top + R * .6 && y <= bot - R * .6;
  const mid = r.toWorld(cam, cx, cy), span = (Math.max(W, H) / S) * cam.mpp;
  // the point of these lines nearest the middle of the open band
  const nearest = <T>(items: { pts: XY[]; ref: T; named: boolean }[]): { at: XY; ref: T } | null => {
    let best: { at: XY; ref: T } | null = null, bd = Infinity;
    for (const it of items) for (let k = 0; k < it.pts.length; k++) {
      const a = it.pts[Math.max(0, k - 1)], b = it.pts[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cam.mpp * 6)));
      for (let q = 1; q <= n; q++) {
        const p: XY = [a[0] + ((b[0] - a[0]) * q) / n, a[1] + ((b[1] - a[1]) * q) / n];
        const [x, y] = r.toScreen(cam, p);
        if (!ok(x, y)) continue;
        // named ones first, so the words can say which
        const d = Math.hypot(x - cx, y - cy) + (it.named ? 0 : 400);
        if (d < bd) [best, bd] = [{ at: p, ref: it.ref }, d];
      }
    }
    return best;
  };
  const named = (s: string) => !!s && !/unnamed/i.test(s);
  const stream = nearest(w.watersNear(mid, span).map((i) => w.waters[i]).filter((wt) => wt.line && cohoWater(w, wt)).map((wt) => ({ pts: wt.line!, ref: wt.name, named: named(wt.name) })));
  const runs = w.runsNear(mid, span).map((i) => w.runs[i]).filter((rn) => rn.drain !== null);
  const pick = (k: number) => nearest(runs.filter((rn) => rn.k === k).map((rn) => ({ pts: rn.line, ref: rn, named: !!w.pieceNames[rn.piece] })));
  const creek = pick(0), ground = pick(1), main = creek ?? ground;
  const steps: Step[] = [];
  if (stream) {
    const nm = stream.ref;
    steps.push({ at: stream.at, ring2: null, title: named(nm) || /tributary/i.test(nm) ? `This blue line is ${plainWater(nm)}.` : 'This blue line is a salmon stream.', body: 'Coho salmon live here. Rain from some streets reaches it through storm pipes.', legend: false, run: null });
  }
  if (main) {
    const name = w.pieceNames[main.ref.piece];
    steps.push({ at: main.at, ring2: creek && ground ? ground.at : null, title: "Colors show where each street's rain goes.", body: 'Orange streets drain to a salmon stream. Green ones soak into the ground. Gray means no answer yet.', legend: true, run: null });
    steps.push({ at: main.at, ring2: null, title: `${T} a street to follow its rain.`, body: name ? `Try ${name}.` : 'Try the street in the circle.', legend: false, run: main.ref });
  }
  return steps;
}

function legendRows(app: App): HTMLElement[] {
  const m = app.camera.cam.mpp, band = m <= 2.6 ? 'town' : m <= 12 ? 'overview' : 'region';
  const row = (sw: Swatch, text: string) => h('div.mu-row', {}, h('span.mu-sw', { html: swatchSVG(sw, band) }), h('span.mu-lab', {}, text));
  return [row('creek', 'Goes to a salmon stream'), row('ground', 'Soaks into the ground'), row('elsewhere', 'Goes to other water, like a lake'), row('none', `No answer yet. ${tapWord(app)} to see why.`)];
}
