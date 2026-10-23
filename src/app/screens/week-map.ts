// My drives on a real map, inside the page: the week's routes drawn on the same map as the Map tab, a fish flag on each
// salmon creek you crossed (its own species, gray where a hard brake came near), and the bell on your hard-brake spot.
// The routes draw themselves in when the map comes into view. A route, a flag or the bell opens on the big map.
import type { LngLat, XY } from '../../geo/geo.ts';
import { RouteDraw } from '../anim/route-reveal.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { ROUTE } from '../map/palette.ts';
import { Renderer, ROUTE_MPP, S, type Cam, type Scene } from '../map/render.ts';
import { speciesSVG } from '../../salmon/species.ts';
import { calm, glyph } from '../ui/ui.ts';

export interface WeekRoute { at: number; pts: readonly LngLat[] }
export interface WeekCreek { name: string; ll: LngLat; sp: number; times: number; gentle: number }
export interface WeekSpot { ll: LngLat; name: string }

export interface WeekMapIn {
  routes: readonly WeekRoute[];
  creeks: readonly WeekCreek[];
  spot: WeekSpot | null;
  /** what the map shows, for screen readers */
  label: string;
  /** draw the routes in when it comes into view */
  play: boolean;
  openDrive(at: number): void;
  openCreek(i: number): void;
  openSpot(): void;
}

/** the routes draw in this long, ms */
const DRAW_MS = 1500;
/** the closest the map zooms in, m an art pixel */
const MIN_MPP = 3;
/** a tap this close to a route picks it, css px */
const PICK_PX = 18;
/** after a change, tiles keep arriving for about this long, ms */
const SETTLE_MS = 6000;
const DIM = '#b3995a';

/** the fish a creek shows: coho when there or unknown, else its first species */
const mainFish = (sp: number) => (!sp || sp & 1 ? 1 : sp & -sp);

export class WeekMap {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly c: WeekMapIn;
  private readonly canvas: HTMLCanvasElement;
  private readonly r: Renderer;
  private readonly marks: HTMLElement;
  private readonly flags: HTMLElement[] = [];
  private readonly names: HTMLElement[] = [];
  /** the routes, the creeks and the spot in street meters */
  private readonly paths: XY[][];
  private readonly creekXY: XY[];
  private readonly spotXY: XY | null;
  private readonly draw: RouteDraw;
  private readonly reach: number[];
  private cam: Cam | null = null;
  /** the route lit by a hover or a row, by its drive */
  private hot: number | null = null;
  private t0 = 0;
  private settleUntil = 0;
  private raf = 0;
  private timer = 0;
  private stop: (() => void) | null = null;

  constructor(app: App, c: WeekMapIn) {
    this.app = app;
    this.c = c;
    const w = app.world;
    this.paths = c.routes.map((r) => r.pts.map((ll) => w.toWorld(ll)));
    this.creekXY = c.creeks.map((k) => w.toWorld(k.ll));
    this.spotXY = c.spot ? w.toWorld(c.spot.ll) : null;
    this.draw = new RouteDraw(this.paths.map((path, i) => ({ i, path })));
    this.reach = this.creekXY.map((p) => (this.paths.length ? this.draw.reach(p) : 0));
    this.canvas = h('canvas.my-wm-cv', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    // its own renderer over the app's map data, so the big map is never touched
    const r = (this.r = new Renderer(this.canvas, w, app.sprites));
    const big = app.renderer;
    [r.region, r.basemap, r.overview, r.state, r.salmon] = [null, big.basemap, app.overview, big.state, big.salmon];
    this.marks = h('div.my-wm-marks');
    this.makeFlags();
    this.el = h('figure.my-wm', { role: 'group', 'aria-label': c.label },
      this.canvas, this.marks,
      h('figcaption.my-wm-key', {},
        h('span', {}, h('i.my-wm-sw', { 'aria-hidden': 'true', html: speciesSVG(1, 1) }), 'Crossed gently'),
        c.creeks.some((k) => k.gentle < k.times) ? h('span', {}, h('i.my-wm-sw.my-wm-gray', { 'aria-hidden': 'true', html: speciesSVG(1, 1) }), 'Hard brake near') : null,
        c.spot ? h('span', {}, h('i.my-wm-sw.my-wm-bell', { 'aria-hidden': 'true', html: glyph('bell', 1) }), 'Your hard-brake spot') : null),
      h('span.my-wm-attr', { 'aria-hidden': 'true' }, '© OpenStreetMap, Microsoft'));
    this.canvas.addEventListener('click', (e) => this.onTap(e));
    this.canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') this.onHover(e); });
    this.canvas.addEventListener('pointerleave', () => this.light(null));
    if (!c.play || calm()) this.t0 = -1;
    this.watch();
  }

  /** Lights one drive's route (a row under hover or focus), or none. */
  light(at: number | null): void {
    if (this.hot === at) return;
    this.hot = at;
    this.canvas.style.cursor = at == null ? '' : 'pointer';
    this.kick();
  }

  /** Stops drawing; the page is gone. */
  destroy(): void {
    this.stop?.();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
  }

  // ---------- flags ----------

  private makeFlags(): void {
    const c = this.c;
    c.creeks.forEach((k, i) => {
      const rough = k.gentle < k.times, name = k.name || 'A salmon stream';
      const times = k.times === 1 ? (rough ? 'a hard brake near it' : 'crossed gently') : rough ? `gentle ${k.gentle} of ${k.times} times` : `gentle all ${k.times} times`;
      const flag = h('button.my-mark.my-wm-flag', { type: 'button', 'data-kind': rough ? 'mixed' : 'gentle', 'aria-label': `${name}, ${times}. Open it.`, onclick: () => c.openCreek(i) },
        h('span.my-mark-in', {}, h('span.my-flag', { html: speciesSVG(mainFish(k.sp), 2) }), h('span.my-stem'), h('span.my-dot')));
      const label = h('span.my-wm-name', { 'aria-hidden': 'true' }, name);
      this.flags.push(flag);
      this.names.push(label);
    });
    if (c.spot) {
      this.flags.push(h('button.my-mark.my-wm-flag', { type: 'button', 'data-kind': 'spot', 'aria-label': `Your hard-brake spot${c.spot.name ? `, ${c.spot.name}` : ''}. Open it.`, onclick: () => c.openSpot() },
        h('span.my-mark-in', {}, h('span.my-flag', { html: glyph('bell', 2) }), h('span.my-stem'), h('span.my-dot'))));
    }
    this.marks.replaceChildren(...this.names, ...this.flags);
  }

  // ---------- drawing ----------

  /** Draws while it's on screen: every frame during the draw-in, then now and then while map tiles arrive. */
  private watch(): void {
    const ro = new ResizeObserver(() => { this.cam = null; this.kick(); });
    ro.observe(this.el);
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      // the routes start drawing once half the map is in view
      if (this.t0 === 0) this.t0 = performance.now();
      this.kick();
    }, { threshold: 0.45 });
    io.observe(this.el);
    this.stop = () => { ro.disconnect(); io.disconnect(); };
  }

  private kick(): void {
    this.settleUntil = performance.now() + SETTLE_MS;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (!this.el.isConnected) { this.destroy(); return; }
    this.paint(now);
    if (this.t0 > 0 && now - this.t0 < DRAW_MS) { this.raf = requestAnimationFrame(this.frame); return; }
    // tiles: a few times a second until they settle
    if (performance.now() < this.settleUntil) this.timer = window.setTimeout(() => { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }, 250);
  };

  /** How far the routes have drawn, 0 to 1; 1 once it has played or with less motion. */
  private progress(now: number): number {
    if (this.t0 < 0) return 1;
    if (this.t0 === 0) return 0;
    const k = Math.min(1, (now - this.t0) / DRAW_MS);
    return 1 - (1 - k) ** 2;
  }

  private paint(now: number): void {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return;
    if (this.r.AW !== Math.ceil(W / S) || this.r.AH !== Math.ceil(H / S)) { this.r.resize(W, H); this.cam = null; }
    this.cam ??= this.fit();
    const k = this.progress(now), cut = this.draw.cut(k);
    const replay: NonNullable<Scene['replay']> = [];
    this.paths.forEach((p, i) => {
      const path = cut.get(i);
      if (!path || path.length < 2) return;
      const at = this.c.routes[i].at, lit = this.hot === at;
      replay.push({ path, color: this.hot == null || lit ? ROUTE.fill : DIM, hi: lit });
    });
    // the lit route on top
    replay.sort((a, b) => Number(!!a.hi) - Number(!!b.hi));
    const names = new Set(this.c.creeks.map((c) => c.name).filter(Boolean));
    this.r.draw(this.cam, { muted: true, replay, creeks: names }, now);
    this.place(k);
  }

  /** Every route in view, as close as the street map goes; too spread out, the creeks and the spot. */
  private fit(): Cam {
    const AW = this.r.AW, AH = this.r.AH;
    // flags stand about 12 art px above their points; names run to the right
    const pad = { l: 10, r: 14, t: 18, b: 16 };
    const need = (pts: XY[]) => {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const mpp = Math.max((x1 - x0) / Math.max(10, AW - pad.l - pad.r), (y1 - y0) / Math.max(10, AH - pad.t - pad.b), MIN_MPP);
      // centered in the room left between the pads
      return { mpp, x: (x0 + x1) / 2 + ((pad.r - pad.l) / 2) * mpp, y: (y0 + y1) / 2 - ((pad.t - pad.b) / 2) * mpp };
    };
    const key = [...this.creekXY, ...(this.spotXY ? [this.spotXY] : [])];
    const all = [...this.paths.flat(), ...key];
    if (!all.length) return { x: this.app.home[0], y: this.app.home[1], mpp: 12 };
    let f = need(all);
    if (f.mpp > ROUTE_MPP && key.length) f = need(key);
    return { x: f.x, y: f.y, mpp: Math.min(ROUTE_MPP, f.mpp) };
  }

  /** Flags to their points, each once the route reaches it; a name beside its flag when there's room. */
  private place(k: number): void {
    const cam = this.cam!, r = this.r, W = this.el.clientWidth, H = this.el.clientHeight;
    const at = (p: XY) => r.toScreen(cam, p).map(Math.round) as XY;
    const taken: number[][] = [];
    const hits = (b: number[]) => taken.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    const spotK = this.spotXY ? this.flags.length - 1 : -1;
    this.flags.forEach((f, i) => {
      const p = i === spotK ? this.spotXY! : this.creekXY[i], [x, y] = at(p);
      const shown = (i === spotK ? k >= 1 : k >= this.reach[i]) && x > 4 && x < W - 4 && y > 8 && y < H - 4;
      f.hidden = !shown;
      if (!shown) return;
      if (!f.dataset.in && this.t0 > 0 && k < 1 && !calm()) f.dataset.in = '1';
      f.style.transform = `translate(${x}px,${y}px)`;
      taken.push(i === spotK ? [x - 4, y - 15, x + 32, y + 15] : [x - 22, y - 40, x + 22, y + 4]);
    });
    this.names.forEach((n, i) => {
      const f = this.flags[i];
      if (f.hidden) { n.hidden = true; return; }
      const [x, y] = at(this.creekXY[i]), wd = n.offsetWidth || n.textContent!.length * 7 + 12;
      // right of the flag, else left of it
      let b = [x + 24, y - 38, x + 24 + wd, y - 14];
      if (b[2] > W - 4 || hits(b)) b = [x - 24 - wd, y - 38, x - 24, y - 14];
      if (b[0] < 4 || hits(b)) { n.hidden = true; return; }
      n.hidden = false;
      n.style.transform = `translate(${b[0]}px,${b[1]}px)`;
      taken.push(b);
    });
  }

  // ---------- picking a route ----------

  /** The drive whose route runs closest to a point on the canvas, within PICK_PX. */
  private routeAt(e: MouseEvent): number | null {
    if (!this.cam) return null;
    const box = this.canvas.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
    let best: number | null = null, bd = PICK_PX;
    this.paths.forEach((path, i) => {
      for (let q = 1; q < path.length; q++) {
        const [ax, ay] = this.r.toScreen(this.cam!, path[q - 1]), [bx, by] = this.r.toScreen(this.cam!, path[q]);
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
        const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
        if (d < bd) [bd, best] = [d, this.c.routes[i].at];
      }
    });
    return best;
  }

  private onTap(e: MouseEvent): void {
    const at = this.routeAt(e);
    if (at != null) this.c.openDrive(at);
  }

  private onHover(e: PointerEvent): void {
    this.light(this.routeAt(e));
  }
}
