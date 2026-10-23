// My drives on a laptop: your hard-brake spot on the real map, about 250 m across, with each hard brake there as a red
// square and a car that drives up, waits at the line and goes on. The whole map opens the spot on the big map.
import type { LngLat, XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { ROUTE } from '../map/palette.ts';
import { Renderer, S, type Cam } from '../map/render.ts';
import { calm } from '../ui/ui.ts';

export interface SpotMapIn {
  ll: LngLat;
  /** degrees from north the car was going when it braked, null if unknown */
  heading: number | null;
  /** this week's drives near the spot */
  routes: readonly LngLat[][];
  /** the hard brakes there */
  brakes: readonly LngLat[];
  /** the street you were on, and the cross street; '' when unknown */
  street: string;
  cross: string;
  label: string;
  open(): void;
}

/** the box the map shows, m */
const BOX_M = 250;
/** map tiles keep arriving for about this long, ms */
const SETTLE_MS = 6000;
const LOOP = 7000, F = 1000 / 12;

let car: HTMLImageElement | null = null;

export class SpotMap {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly c: SpotMapIn;
  private readonly map: HTMLCanvasElement;
  private readonly over: HTMLCanvasElement;
  private readonly r: Renderer;
  private readonly at: XY;
  private readonly paths: XY[][];
  private readonly hits: XY[];
  private cam: Cam | null = null;
  private born = 0;

  constructor(app: App, c: SpotMapIn) {
    this.app = app;
    this.c = c;
    const w = app.world;
    this.at = w.toWorld(c.ll);
    this.paths = c.routes.map((r) => r.map((ll) => w.toWorld(ll)));
    this.hits = c.brakes.map((ll) => w.toWorld(ll));
    this.map = h('canvas.wr-sm-map', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.over = h('canvas.wr-sm-over', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const r = (this.r = new Renderer(this.map, w, app.sprites));
    const big = app.renderer;
    [r.region, r.basemap, r.overview, r.state, r.salmon] = [null, big.basemap, app.overview, big.state, big.salmon];
    this.el = h('button.wr-spotmap', { type: 'button', 'aria-label': c.label, onclick: () => c.open() }, this.map, this.over);
    if (!car && typeof Image !== 'undefined') { car = new Image(); car.src = 'art/anim/car-top.png'; }
  }

  /** One frame: the map while its tiles arrive, the brakes and the car always. */
  tick(now: number): void {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H || !this.el.isConnected) return;
    if (!this.born) this.born = now;
    if (this.r.AW !== Math.ceil(W / S) || this.r.AH !== Math.ceil(H / S)) { this.r.resize(W, H); this.cam = null; }
    this.cam ??= { x: this.at[0], y: this.at[1], mpp: BOX_M / this.r.AH };
    if (now - this.born < SETTLE_MS || calm()) {
      this.r.draw(this.cam, { muted: true, replay: this.paths.map((path) => ({ path, color: ROUTE.fill })), creeks: new Set() }, now);
    }
    this.drawOver(W, H, calm() ? -1 : now - this.born);
  }

  private drawOver(W: number, H: number, t: number): void {
    const cv = this.over, dpr = Math.max(1, Math.round(devicePixelRatio || 1));
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, W, H);
    const cam = this.cam!, scr = (p: XY) => this.r.toScreen(cam, p).map((v) => Math.round(v / 2) * 2) as XY;
    // the brakes come in one by one, a quarter second apart
    const show = t < 0 ? this.hits.length : Math.min(this.hits.length, Math.max(0, Math.floor((t - 600) / 250)));
    g.fillStyle = '#020302';
    for (const p of this.hits.slice(0, show)) { const [x, y] = scr(p); g.fillRect(x - 6, y - 6, 12, 12); }
    g.fillStyle = '#ff7a66';
    for (const p of this.hits.slice(0, show)) { const [x, y] = scr(p); g.fillRect(x - 5, y - 5, 10, 10); }
    const hd = this.c.heading;
    if (hd == null) return;
    const rad = (hd * Math.PI) / 180, ux = Math.sin(rad), uy = -Math.cos(rad);
    // the two street names: yours behind the spot, the cross street off to one side
    g.font = '650 12px Geist, system-ui, sans-serif';
    const tag = (text: string, p: XY) => {
      if (!text) return;
      const w = Math.ceil(g.measureText(text).width) + 12, x = Math.max(4, Math.min(W - w - 4, p[0] - w / 2)), y = Math.max(4, Math.min(H - 22, p[1] - 9));
      g.fillStyle = '#0b0f0d';
      g.fillRect(x, y, w, 18);
      g.fillStyle = '#e9efe8';
      g.fillText(text, x + 6, y + 13);
    };
    const [sx, sy] = scr([this.at[0] - ux * 85, this.at[1] - uy * 85]);
    tag(this.c.street, [sx, sy + 22]);
    tag(this.c.cross, scr([this.at[0] - uy * 90, this.at[1] + ux * 90]));
    // a car comes up the way you were going, waits 1.5 s at the line, goes on: a 7 s loop
    if (t < 0 || !car?.complete || !car.naturalWidth) return;
    const k = Math.floor(t / F) * F % LOOP;
    // meters along the heading from the spot: from 130 back, to the line 15 past, then on out of view
    const m = k < 2500 ? -130 + (k / 2500) * 145 : k < 4000 ? 15 : 15 + ((k - 4000) / 3000) * 160;
    const [x, y] = scr([this.at[0] + ux * m, this.at[1] + uy * m]);
    g.save();
    g.translate(x, y);
    g.rotate(rad);
    g.drawImage(car, -16, -16, 32, 32);
    g.restore();
  }
}
