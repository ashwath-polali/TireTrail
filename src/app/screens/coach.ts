// First-visit coach: three short steps with a pixel spotlight on the map, then the map is theirs.
import type { XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { swatchSVG, type Swatch } from '../map/palette.ts';
import { S } from '../map/render.ts';
import type { Run } from '../map/world.ts';
import { button } from '../ui/ui.ts';
import { plainWater, tapWord } from './common.ts';
import { cohoHere, cohoWater } from './resolve.ts';

type How = 'skip' | 'show' | 'moved';
interface Step { at: XY; ring2: XY | null; title: string; body: string; legend: boolean; run: Run | null }

/** spotlight half size, CSS px (26 art px) */
const R = 78;

export const coachSeen = (): boolean => { try { return localStorage.getItem('tt-maptut') === '1'; } catch { return false; } };

/** The lowest edge of what sits on the map's top: the caption, or the search bar. */
function topEdge(app: App): number {
  const c = app.caption, bar = c.parentElement?.querySelector<HTMLElement>('.mu-find:not([hidden]) .mu-findbar');
  const cap = c.offsetHeight ? c.offsetTop + c.offsetHeight : 0;
  const find = bar ? (bar.parentElement as HTMLElement).offsetTop + bar.offsetTop + bar.offsetHeight : 0;
  return Math.max(cap, find);
}

export class Coach {
  private readonly app: App;
  private steps: Step[];
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
    // four pixel corners around the spot, like a game's target
    const corners = () => [h('i.mu-c1'), h('i.mu-c2'), h('i.mu-c3'), h('i.mu-c4')];
    this.rings = [h('div.mu-ring', {}, ...corners()), h('div.mu-ring', {}, ...corners())];
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
    // the open part of the map moved: pick the spots again for the new layout
    const steps = plan(this.app);
    if (steps.length) [this.steps, this.k] = [steps, Math.min(this.k, steps.length - 1)];
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
    // a laptop already shows the key in the corner
    const body = s.legend && app.layout === 'phone'
      ? h('div.mu-legend', { role: 'list' }, ...legendRows(app))
      : h('p.u-body.mu-cbody', {}, s.body);
    const buttons = last && s.run
      ? [button('Show me', { kind: 'primary', icon: 'play', onClick: () => this.done('show', s.run!) }), button("I'll explore", { kind: 'secondary', onClick: () => this.done('skip') })]
      : last
        ? [button('Got it', { kind: 'primary', icon: 'check', onClick: () => this.done('skip') })]
        : [this.k ? button('Back', { kind: 'secondary', icon: 'back', onClick: () => this.go(this.k - 1) }) : button('Skip', { kind: 'secondary', onClick: () => this.done('skip') }), button('Next', { kind: 'primary', icon: 'arrow', onClick: () => this.go(this.k + 1) })];
    // the steps as pixel blocks, lit up to this one
    const blocks = h('span.mu-cblocks', { 'aria-label': `Step ${this.k + 1} of ${n}` }, ...this.steps.map((_, i) => h(i <= this.k ? 'i.u-on' : 'i')));
    const words = h('div.mu-cwords', { role: 'dialog', 'aria-label': 'How to read the map' },
      h('div.mu-ctop', {}, h('p.mu-kicker', { 'data-tone': 'you' }, 'How to read the map'), blocks),
      h('h2.mu-ctitle', { tabindex: '-1' }, s.title),
      body,
      h('div.mu-acts', {}, ...buttons));
    this.bubble?.remove();
    this.bubble = null;
    if (app.layout === 'phone') app.setPanel(h('div.u-sheet.mu-sheet.mu-coachcard', {}, words));
    else {
      this.bubble = h('div.mu-bubble', {}, words);
      app.caption.parentElement?.append(this.bubble);
    }
    this.placed = '';
    this.place();
    (words.querySelector('.mu-ctitle') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Puts the spotlight, corners and bubble where the street is now. */
  private place(): void {
    const app = this.app, r = app.renderer, s = this.steps[this.k];
    const wrap = r.canvas.parentElement!;
    // the canvas sits centered in the map, a pixel or two bigger
    const ox = (wrap.clientWidth - r.canvas.offsetWidth) / 2, oy = (wrap.clientHeight - r.canvas.offsetHeight) / 2;
    // the square stays whole on screen; its spot may sit off its middle
    const top0 = topEdge(app) + 4, cw = wrap.clientWidth, ch = wrap.clientHeight;
    const at = (p: XY): XY => {
      const q = r.toScreen(app.camera.cam, p);
      return [Math.round(Math.max(R + 4, Math.min(cw - R - 4, q[0] + ox))), Math.round(Math.max(top0 + R, Math.min(ch - R - 4, q[1] + oy)))];
    };
    const [x, y] = at(s.at), t2 = s.ring2 ? at(s.ring2) : null;
    // a second square that would overlap the first is left out
    const two = t2 && (Math.abs(t2[0] - x) >= 2 * R + 8 || Math.abs(t2[1] - y) >= 2 * R + 8) ? t2 : null;
    const key = `${this.k}|${x}|${y}|${two}|${wrap.clientWidth}|${wrap.clientHeight}`;
    if (key === this.placed) return;
    this.placed = key;
    // a hard-edged square hole in the dim, snapped to the 4 px grid; each hole goes out from the corner and back
    const sq = (cx: number, cy: number) => { const a = Math.round((cx - R) / 4) * 4, b = Math.round((cy - R) / 4) * 4; return `, ${a}px ${b}px, ${a + 2 * R}px ${b}px, ${a + 2 * R}px ${b + 2 * R}px, ${a}px ${b + 2 * R}px, ${a}px ${b}px, 0 0`; };
    this.dim.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0${sq(x, y)}${two ? sq(two[0], two[1]) : ''})`;
    const ring = (el: HTMLElement, p: XY | null) => {
      el.style.display = p ? '' : 'none';
      if (p) el.style.transform = `translate(${Math.round((p[0] - R) / 4) * 4}px, ${Math.round((p[1] - R) / 4) * 4}px)`;
    };
    ring(this.rings[0], [x, y]);
    ring(this.rings[1], two);
    const b = this.bubble;
    if (!b) return;
    // beside the spotlight, never over the card or the search bar
    const W = wrap.clientWidth, H = wrap.clientHeight, bw = b.offsetWidth || 320, bh = b.offsetHeight || 180;
    const card = app.panel.childElementCount ? app.panel.offsetWidth + 32 : 16;
    const top = topEdge(app) + 12;
    const spots: XY[] = [[x + R + 16, y - bh / 2], [x - R - 16 - bw, y - bh / 2], [x - bw / 2, y + R + 16], [x - bw / 2, y - R - 16 - bh]];
    // clear of the second square too
    const off = ([bx, by]: XY) => !two || bx >= two[0] + R + 8 || bx + bw <= two[0] - R - 8 || by >= two[1] + R + 8 || by + bh <= two[1] - R - 8;
    const fits = ([bx, by]: XY) => bx >= card && bx + bw <= W - 72 && by >= top && by + bh <= H - 16 && off([bx, by]);
    let [bx, by] = spots.find(fits) ?? spots[0];
    bx = Math.max(card, Math.min(W - 72 - bw, bx));
    by = Math.max(top, Math.min(H - 16 - bh, by));
    b.style.transform = `translate(${Math.round(bx / 4) * 4}px, ${Math.round(by / 4) * 4}px)`;
  }
}

/** The steps, from what's in view: a coho stream, a street to a salmon stream, a soak-in street. */
function plan(app: App): Step[] {
  const w = app.world, r = app.renderer, cam = app.camera.cam, T = tapWord(app);
  const W = r.AW * S, H = r.AH * S, phone = app.layout === 'phone';
  const left = !phone && app.panel.childElementCount ? app.panel.offsetWidth + 32 : 0;
  const top = Math.max(topEdge(app), (app.focusY * r.AH - app.bandH / 2) * S);
  // on a phone the coach's words take the bottom sheet
  const bot = Math.min((app.focusY * r.AH + app.bandH / 2) * S, phone ? H * .55 : H);
  const cx = (left + W) / 2, cy = (top + bot) / 2;
  // the whole square in the open part of the map if it can be, else most of it
  const fit = (x: number, y: number, k: number) => x >= left + R + 8 && x <= W - R - (phone ? 64 : 80) && y >= top + R * k && y <= bot - R * k;
  const mid = r.toWorld(cam, cx, cy), span = (Math.max(W, H) / S) * cam.mpp;
  const nearest = <T>(items: { pts: XY[]; ref: T; named: boolean }[]) => pointOf(items, (x, y) => fit(x, y, 1.1)) ?? pointOf(items, (x, y) => fit(x, y, .6));
  // the point of these lines nearest the middle of the open band
  const pointOf = <T>(items: { pts: XY[]; ref: T; named: boolean }[], ok: (x: number, y: number) => boolean): { at: XY; ref: T } | null => {
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
  const stream = nearest(w.watersNear(mid, span).map((i) => w.waters[i]).filter((wt) => wt.line && cohoWater(w, wt)).map((wt) => ({ pts: wt.line!, ref: wt, named: named(wt.name) })));
  const runs = w.runsNear(mid, span).map((i) => w.runs[i]).filter((rn) => rn.drain !== null);
  const pick = (k: number) => nearest(runs.filter((rn) => rn.k === k).map((rn) => ({ pts: rn.line, ref: rn, named: !!w.pieceNames[rn.piece] })));
  const creek = pick(0), ground = pick(1), main = creek ?? ground;
  const steps: Step[] = [];
  if (stream) {
    const nm = stream.ref.name, c = cohoHere(w, stream.ref);
    // what the data says: coho spawn down Fennel Creek; WDFW records them in county streams
    const coho = c === 'spawn' ? 'Coho spawn a few miles downstream.' : c === 'along' ? 'WDFW records coho in parts of it.' : 'WDFW records coho salmon here.';
    steps.push({ at: stream.at, ring2: null, title: named(nm) || /tributary/i.test(nm) ? `This blue line is ${plainWater(nm)}.` : 'This blue line is a salmon stream.', body: `${coho} Some streets drain into it.`, legend: false, run: null });
  }
  if (main) {
    const name = w.pieceNames[main.ref.piece];
    steps.push({ at: main.at, ring2: creek && ground ? ground.at : null, title: "Colors show where each street's rain goes.", body: 'Orange streets drain to a salmon stream. The key is at the bottom left.', legend: true, run: null });
    steps.push({ at: main.at, ring2: null, title: `${T} a street to follow its rain.`, body: name ? `Try ${name}, in the square.` : 'Try the street in the square.', legend: false, run: main.ref });
  }
  return steps;
}

function legendRows(app: App): HTMLElement[] {
  const m = app.camera.cam.mpp, band = m <= 2.6 ? 'town' : m <= 12 ? 'overview' : 'region';
  const row = (sw: Swatch, text: string) => h('div.mu-row', { role: 'listitem' }, h('span.mu-sw', { html: swatchSVG(sw, band) }), h('span.mu-lab', {}, text));
  return [row('creek', 'To a salmon stream'), row('ground', 'Soaks in'), row('elsewhere', 'To other water'), row('none', 'No answer yet')];
}
