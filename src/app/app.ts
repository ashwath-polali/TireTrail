// App shell: pages and the full map stage, phone or laptop layout, and the draw loop.
import { bboxOf, type XY } from '../geo/geo.ts';
import type { TireTrailData } from '../data/tiretrail.ts';
import { CameraCtl, MIN_MPP } from './map/camera.ts';
import { Labels } from './map/labels.ts';
import { REGION_MPP, Renderer, S, type Cam, type Scene } from './map/render.ts';
import { Sprites } from './map/sprites.ts';
import { World } from './map/world.ts';
import type { Region } from './map/region.ts';
import { h } from './dom.ts';
import { ICON } from './icons.ts';
import { HistoryScreen } from './screens/history.ts';
import { StreetScreen } from './screens/street.ts';
import { DriveScreen } from './screens/drive-screen.ts';
import { FixScreen } from './screens/fix-screen.ts';
import { MapScreen } from './screens/map-screen.ts';
import { Tutorial } from './screens/tutorial.ts';

export type Tab = 'drive' | 'drives' | 'map' | 'street' | 'fix';
export type Layout = 'phone' | 'laptop';

/** Widest a fit-to-points view goes: enough for the Fix list or a drive on a phone. */
const FIT_MAX = 60;

export interface FrameOut {
  scene: Scene;
  cam?: Cam | null;
  hideLabels?: boolean;
}

export interface Screen {
  enter(): void;
  leave(): void;
  /** true if the screen used the tap */
  tap(p: XY): boolean;
  frame(now: number): FrameOut;
  /** the layout switched; redraw for it */
  relayout?(): void;
  /** the phone's back button; true if the screen handled it */
  back?(): boolean;
}

export class App {
  readonly data: TireTrailData;
  readonly region: Region | null;
  readonly world: World;
  readonly sprites: Sprites;
  readonly renderer: Renderer;
  readonly camera: CameraCtl;
  readonly labels: Labels;
  readonly caption: HTMLElement;
  readonly panel: HTMLElement;
  readonly screens: { drive: DriveScreen; drives: HistoryScreen; map: MapScreen; street: StreetScreen; fix: FixScreen };
  readonly tutorial: Tutorial;
  /** Phones and small tablets always get the phone layout. */
  readonly touch = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
  tab: Tab = 'drive';
  layout: Layout = 'phone';
  /** fixed clock, for screenshots */
  frozen: number | null = null;
  introMode: 'auto' | 'force' | 'off' = 'auto';
  private readonly root: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly mapwrap: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly page: HTMLElement;
  private readonly tabs: Record<'drive' | 'drives' | 'map', HTMLButtonElement>;
  private captionKey = '';
  private started = false;
  private mode: 'page' | 'stage' = 'page';
  /** set while the About page is open, so a view switch can redraw it */
  private aboutBack: (() => void) | null = null;

  constructor(host: HTMLElement, data: TireTrailData, region: Region | null) {
    this.data = data;
    this.region = region;
    this.world = new World(data);
    this.sprites = new Sprites(this.world);
    const canvas = h('canvas') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas, this.world, this.sprites);
    this.renderer.region = region;
    this.mapwrap = h('div.mapwrap', {}, canvas, h('div.labels'));
    this.caption = h('div.caption.box', { role: 'status', 'aria-live': 'polite' });
    this.panel = h('div.panel');
    const zoom = h('div.zoom', {},
      h('button', { 'aria-label': 'Zoom in', onclick: () => this.camera.zoomBy(0.5) }, '+'),
      h('button', { 'aria-label': 'Zoom out', onclick: () => this.camera.zoomBy(2) }, '−'));
    this.sheet = h('aside.sheet', {}, zoom, this.panel);
    const stage = h('section.stage', {}, this.mapwrap, this.caption, this.sheet);
    this.page = h('main.page');
    const tab = (t: Tab, label: string, icon: string) => {
      const b = h('button', { 'aria-current': 'false', onclick: () => this.setTab(t) }) as HTMLButtonElement;
      b.innerHTML = `${icon}<span>${label}</span>`;
      return b;
    };
    this.tabs = {
      drive: tab('drive', 'Drive', ICON.car()),
      drives: tab('drives', 'My drives', ICON.list()),
      map: tab('map', 'Map', ICON.map()),
    };
    const brand = h('button.brand', { onclick: () => this.setTab('drive') }, 'TIRETRAIL');
    this.frameEl = h('div.frame.on-page', {},
      h('nav.tabs', {}, brand, this.tabs.drive, this.tabs.drives, this.tabs.map),
      this.page, stage);
    const sw = (l: Layout, label: string) => h('button', { 'data-l': l, 'aria-pressed': 'false', onclick: () => this.setLayout(l, true) }, label);
    this.root = h('div.shell', {}, this.frameEl, h('div.viewswitch', {}, sw('laptop', 'Laptop view'), sw('phone', 'Phone view')));
    host.replaceChildren(this.root);
    const start = { x: this.world.center[0], y: this.world.center[1], mpp: 6 };
    this.camera = new CameraCtl(this.mapwrap, this.renderer, start, this.world.bounds, (p) => this.tap(p), () => this.now());
    if (region) this.camera.maxMpp = 40000;
    this.labels = new Labels(this.mapwrap.querySelector('.labels')!, this.world, region);
    this.tutorial = new Tutorial(this, this.frameEl);
    this.screens = { drive: new DriveScreen(this), drives: new HistoryScreen(this), map: new MapScreen(this), street: new StreetScreen(this), fix: new FixScreen(this) };
  }

  async start(layout?: Layout): Promise<void> {
    await this.sprites.load();
    let saved: string | null = null;
    try { saved = localStorage.getItem('tt-view'); } catch { /* storage blocked */ }
    this.setLayout(layout ?? (saved === 'phone' ? 'phone' : 'laptop'), false);
    new ResizeObserver(() => this.resize()).observe(this.mapwrap);
    addEventListener('resize', () => this.fit());
    addEventListener('popstate', () => this.onBack());
    this.started = true;
    this.screens[this.tab].enter();
    this.markTab();
    requestAnimationFrame(this.loop);
    if (this.introMode === 'force' || (this.introMode === 'auto' && !this.tutorial.seen)) this.tutorial.open();
  }

  now(): number {
    return this.frozen ?? performance.now();
  }

  setLayout(l: Layout, remember: boolean): void {
    if (this.touch) l = 'phone';
    if (this.started && l === this.layout) return;
    this.layout = l;
    this.root.classList.toggle('phone', l === 'phone');
    this.root.classList.toggle('laptop', l === 'laptop');
    this.root.classList.toggle('framed', l === 'phone' && !this.touch);
    this.root.classList.toggle('touch', this.touch);
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.viewswitch button')) b.setAttribute('aria-pressed', String(b.dataset.l === l));
    if (remember) try { localStorage.setItem('tt-view', l); } catch { /* storage blocked */ }
    this.fit();
    this.resize();
    if (!this.started) return;
    if (this.aboutBack) this.about(this.aboutBack);
    else (this.screens[this.tab] as Screen).relayout?.();
  }

  private fit(): void {
    const s = Math.min(1, (innerHeight - 32) / 870, (innerWidth - 24) / 414);
    this.frameEl.style.setProperty('--fit', s.toFixed(3));
  }

  private resize(): void {
    this.renderer.resize(this.mapwrap.clientWidth, this.mapwrap.clientHeight);
  }

  // ---------- navigation ----------

  setTab(t: Tab): void {
    if (t === this.tab) { this.screens[t].leave(); this.screens[t].enter(); return; }
    this.screens[this.tab].leave();
    this.tab = t;
    this.markTab();
    this.screens[t].enter();
  }

  private markTab(): void {
    // the street page and the fix list live under the map
    const lit = this.tab === 'fix' || this.tab === 'street' ? 'map' : this.tab;
    for (const [k, b] of Object.entries(this.tabs)) b.setAttribute('aria-current', String(k === lit));
  }

  /** Remembers a step so the phone's back button returns to it. */
  pushStep(): void {
    try { history.pushState({ tt: 1 }, ''); } catch { /* sandboxed */ }
  }

  private onBack(): void {
    if (this.tutorial.isOpen) { this.tutorial.close(); return; }
    if (this.aboutBack) { const b = this.aboutBack; this.aboutBack = null; b(); return; }
    if (!(this.screens[this.tab] as Screen).back?.() && this.tab !== 'drive') this.setTab('drive');
  }

  /** Shows a scrolling page and hides the map. */
  showPage(node: Node): void {
    this.mode = 'page';
    this.aboutBack = null;
    this.frameEl.classList.add('on-page');
    this.frameEl.classList.remove('on-stage');
    this.page.replaceChildren(node);
    this.page.scrollTop = 0;
  }

  /** Shows the full map with its caption and card. */
  showStage(): void {
    if (this.mode === 'stage') return;
    this.mode = 'stage';
    this.frameEl.classList.add('on-stage');
    this.frameEl.classList.remove('on-page');
    this.resize();
  }

  get pageEl(): HTMLElement {
    return this.page;
  }

  get onStage(): boolean {
    return this.mode === 'stage';
  }

  private tap(p: XY): void {
    // the screen gets first say (a pin, a street); far out, a spare tap zooms in
    if ((this.screens[this.tab] as Screen).tap(p)) return;
    const m = this.camera.cam.mpp;
    if (m <= 16) return;
    const b = this.world.bounds, pad = 1500;
    const nearTown = p[0] > b.x0 - pad && p[0] < b.x1 + pad && p[1] > b.y0 - pad && p[1] < b.y1 + pad;
    // outside town there are only outlines, so stay at region zoom there
    const mpp = Math.max(nearTown ? 6 : REGION_MPP + 6, m / 4);
    const [x, y] = this.camera.clampTarget(p[0], p[1], mpp);
    this.camera.follow();
    this.camera.flyTo(this.camAt([x, y], mpp), 700);
  }

  // ---------- the map stage ----------

  /** Swaps the caption (it fades in with CSS); the same key leaves it alone. */
  setCaption(key: string, icon: string, html: string): void {
    if (key === this.captionKey) return;
    this.captionKey = key;
    this.caption.innerHTML = `<span class="ico">${icon}</span><span class="swap">${html}</span>`;
  }

  setPanel(node: Node | null, compact = false, keepScroll = false): void {
    const top = this.panel.scrollTop;
    this.aboutBack = null;
    this.panel.replaceChildren(...(node ? [node] : []));
    this.panel.classList.toggle('compact', compact);
    this.panel.scrollTop = keepScroll ? top : 0;
  }

  /** The open band of map between the caption and the card, as fractions of its height. */
  private band(): [number, number] {
    const H = this.mapwrap.clientHeight || 1, y0 = this.mapwrap.offsetTop;
    const top = this.caption.offsetTop - y0 + this.caption.offsetHeight + 8;
    const bottom = this.layout === 'phone' && this.panel.childElementCount ? this.sheet.offsetTop - y0 - 8 : H;
    return [Math.min(0.6, top / H), Math.max(0.4, bottom / H)];
  }

  /** Height of the open band in art px. */
  get bandH(): number {
    const [a, b] = this.band();
    return this.renderer.AH * (b - a);
  }

  /** Where a story keeps its action, 0 top .. 1 bottom. */
  get focusY(): number {
    const [a, b] = this.band();
    return (a + b) / 2;
  }

  /** On a laptop the card sits on the left, so the action shifts right of it. */
  private get sideShift(): number {
    return this.layout === 'laptop' && this.panel.childElementCount ? (this.sheet.offsetWidth + 16) / 2 / S : 0;
  }

  /** Camera that puts p in the middle of the open part of the map. */
  camAt(p: XY, mpp: number): Cam {
    return { x: p[0] - this.sideShift * mpp, y: p[1] + (0.5 - this.focusY) * this.renderer.AH * mpp, mpp };
  }

  /** Flies to show all points in the open part of the map; pins stand ~14 art px above their points. */
  fitView(pts: XY[], opt: { ms?: number; min?: number } = {}): void {
    if (!pts.length) return;
    const bb = bboxOf(pts);
    const [a, b] = this.band();
    const AW = this.renderer.AW - this.sideShift * 2, AH = this.renderer.AH * (b - a);
    const need = Math.max((bb.maxX - bb.minX) / Math.max(10, AW - 24), (bb.maxY - bb.minY) / Math.max(10, AH - 36));
    const mpp = Math.min(FIT_MAX, Math.max(opt.min ?? MIN_MPP, need));
    // nudge down so the flags above the top points still fit
    const cy = (bb.minY + bb.maxY) / 2 - 7 * mpp;
    this.camera.follow();
    this.camera.flyTo(this.camAt([(bb.minX + bb.maxX) / 2, cy], mpp), opt.ms ?? 900);
  }

  /** Index of the pin under a tap, or -1. */
  pinAt(pins: XY[], p: XY): number {
    let best = -1, bestD = 30; // css px
    pins.forEach((q, k) => {
      // pins stand above their point; aim at the flag
      const d = (Math.hypot(q[0] - p[0], q[1] - 9 * this.camera.cam.mpp - p[1]) / this.camera.cam.mpp) * S;
      if (d < bestD) [best, bestD] = [k, d];
    });
    return best;
  }

  /** The About page. */
  about(back: () => void): void {
    const d = this.data, n = d.numbers;
    const close = () => { this.aboutBack = null; back(); };
    this.showPage(h('div.wrap.narrow', {},
      h('button.backlink', { onclick: close }, '‹ Back'),
      h('div.eyebrow', {}, 'ABOUT TIRETRAIL'),
      h('h1.h1', {}, "Built from the city's own pipe map"),
      h('p.lead', {}, `TireTrail follows all ${n.drains.total.toLocaleString('en-US')} storm drains in Bonney Lake through the mapped pipes, ditches and ponds to where the water ends up. Where the map has a gap, TireTrail says so instead of guessing.`),
      h('p.p', {}, `${Math.round(n.unmapped.share * 100)}% of drains reach a gap in the city's map, so their streets stay gray. Tire dust amounts are estimates from how hard a car brakes and turns, not measurements.`),
      h('div.eyebrow.gap', {}, 'DATA'),
      h('ul.credits', {}, ...[...d.credits, ...(this.region ? ['US Census Bureau (state, county and city outlines)', 'Natural Earth (Canada and Mexico)'] : [])].map((c) => h('li', {}, c))),
      h('p.note', {}, `${d.disclaimer} Map data is provided as is, without warranty.`),
      h('div.actions.row', {},
        h('button.btn.quiet', { onclick: () => this.tutorial.open() }, 'Watch the tutorial again'),
        h('button.btn.quiet', { onclick: () => this.setTab('fix') }, 'Where to fix it, for the city'))));
    this.aboutBack = back;
  }

  private readonly loop = (): void => {
    // next frame first, so one bad frame can't stop the map
    requestAnimationFrame(this.loop);
    if (this.mode !== 'stage') return;
    // one clock for everything: rAF's timestamp can run behind performance.now()
    const now = this.now();
    this.camera.tick(now);
    const out = this.screens[this.tab].frame(now);
    if (out.cam && !this.camera.userMoved && !this.camera.flying) this.camera.cam = out.cam;
    this.renderer.draw(this.camera.cam, out.scene, now);
    this.labels.update(this.camera.cam, this.renderer, out.hideLabels, this.camera.cam.mpp > 150 ? [this.world.center] : []);
  };
}
