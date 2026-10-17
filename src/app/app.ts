// App shell: layout (phone or laptop), tabs, and the map loop.
import { bboxOf, type XY } from '../geo/geo.ts';
import type { TireTrailData } from '../data/tiretrail.ts';
import { CameraCtl, MAX_MPP, MIN_MPP } from './map/camera.ts';
import { Labels } from './map/labels.ts';
import { Renderer, S, type Cam, type Scene } from './map/render.ts';
import { Sprites } from './map/sprites.ts';
import { World } from './map/world.ts';
import { h } from './dom.ts';
import { ICON } from './icons.ts';
import { MapScreen } from './screens/map-screen.ts';
import { DriveScreen } from './screens/drive-screen.ts';
import { FixScreen } from './screens/fix-screen.ts';

export type Tab = 'drive' | 'map' | 'fix';
export type Layout = 'phone' | 'laptop';

export interface FrameOut {
  scene: Scene;
  cam?: Cam | null;
  hideLabels?: boolean;
}

export interface Screen {
  enter(): void;
  leave(): void;
  tap(p: XY): void;
  frame(now: number): FrameOut;
}

export class App {
  readonly world: World;
  readonly sprites: Sprites;
  readonly renderer: Renderer;
  readonly camera: CameraCtl;
  readonly labels: Labels;
  readonly caption: HTMLElement;
  readonly panel: HTMLElement;
  readonly screens: { map: MapScreen; drive: DriveScreen; fix: FixScreen };
  /** Phones and small tablets always get the phone layout. */
  readonly touch = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
  tab: Tab = 'map';
  layout: Layout = 'phone';
  /** fixed clock, for screenshots */
  frozen: number | null = null;
  private readonly root: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly mapwrap: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly tabs: Record<Tab, HTMLButtonElement>;
  private captionKey = '';
  readonly data: TireTrailData;

  constructor(host: HTMLElement, data: TireTrailData) {
    this.data = data;
    this.world = new World(data);
    this.sprites = new Sprites(this.world);
    const canvas = h('canvas') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas, this.world, this.sprites);
    this.mapwrap = h('div.mapwrap', {}, canvas, h('div.labels'));
    this.caption = h('div.caption.box', { role: 'status', 'aria-live': 'polite' });
    this.panel = h('div.panel');
    const tab = (t: Tab, label: string, icon: string) => {
      const b = h('button', { role: 'tab', 'aria-selected': 'false', onclick: () => this.setTab(t) }) as HTMLButtonElement;
      b.innerHTML = `${icon}<span>${label}</span>`;
      return b;
    };
    this.tabs = { drive: tab('drive', 'Drive', ICON.car()), map: tab('map', 'Map', ICON.map()), fix: tab('fix', 'Fix list', ICON.list()) };
    const zoom = h('div.zoom', {},
      h('button', { 'aria-label': 'Zoom in', onclick: () => this.camera.zoomBy(0.5) }, '+'),
      h('button', { 'aria-label': 'Zoom out', onclick: () => this.camera.zoomBy(2) }, '−'));
    this.sheet = h('aside.sheet', {}, zoom, this.panel);
    this.frameEl = h('div.frame', {},
      h('nav.tabs', { role: 'tablist' }, h('span.brand', {}, 'TIRETRAIL'), this.tabs.drive, this.tabs.map, this.tabs.fix),
      this.mapwrap, this.caption, this.sheet);
    const sw = (l: Layout, label: string) => h('button', { 'data-l': l, 'aria-pressed': 'false', onclick: () => this.setLayout(l, true) }, label);
    this.root = h('div.shell', {}, this.frameEl, h('div.viewswitch', {}, sw('laptop', 'Laptop view'), sw('phone', 'Phone view')));
    host.replaceChildren(this.root);
    const start = { x: this.world.center[0], y: this.world.center[1], mpp: 6 };
    this.camera = new CameraCtl(this.mapwrap, this.renderer, start, this.world.bounds, (p) => this.screens[this.tab].tap(p), () => this.now());
    this.labels = new Labels(this.mapwrap.querySelector('.labels')!, this.world);
    this.screens = { map: new MapScreen(this), drive: new DriveScreen(this), fix: new FixScreen(this) };
  }

  async start(): Promise<void> {
    await this.sprites.load();
    let saved: string | null = null;
    try { saved = localStorage.getItem('tt-view'); } catch { /* storage blocked */ }
    this.setLayout(saved === 'phone' ? 'phone' : 'laptop', false);
    new ResizeObserver(() => this.resize()).observe(this.mapwrap);
    addEventListener('resize', () => this.fit());
    this.screens.map.enter();
    this.markTab();
    requestAnimationFrame(this.loop);
  }

  now(): number {
    return this.frozen ?? performance.now();
  }

  setLayout(l: Layout, remember: boolean): void {
    if (this.touch) l = 'phone';
    this.layout = l;
    this.root.classList.toggle('phone', l === 'phone');
    this.root.classList.toggle('laptop', l === 'laptop');
    this.root.classList.toggle('framed', l === 'phone' && !this.touch);
    this.root.classList.toggle('touch', this.touch);
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.viewswitch button')) b.setAttribute('aria-pressed', String(b.dataset.l === l));
    if (remember) try { localStorage.setItem('tt-view', l); } catch { /* storage blocked */ }
    this.fit();
    this.resize();
  }

  private fit(): void {
    const s = Math.min(1, (innerHeight - 32) / 870, (innerWidth - 24) / 414);
    this.frameEl.style.setProperty('--fit', s.toFixed(3));
  }

  private resize(): void {
    this.renderer.resize(this.mapwrap.clientWidth, this.mapwrap.clientHeight);
  }

  setTab(t: Tab): void {
    if (t === this.tab) return;
    this.screens[this.tab].leave();
    this.tab = t;
    this.markTab();
    this.screens[t].enter();
  }

  private markTab(): void {
    for (const [k, b] of Object.entries(this.tabs)) b.setAttribute('aria-selected', String(k === this.tab));
  }

  /** Swaps the caption; the same key leaves it alone. */
  setCaption(key: string, icon: string, html: string): void {
    if (key === this.captionKey) return;
    this.captionKey = key;
    const fill = () => { this.caption.innerHTML = `<span class="ico">${icon}</span><span class="swap">${html}</span>`; };
    if (this.frozen !== null || !this.caption.firstChild) { fill(); return; }
    this.caption.querySelector('.swap')?.classList.add('out');
    setTimeout(() => { if (this.captionKey === key) fill(); }, 150);
  }

  setPanel(node: Node | null, compact = false): void {
    this.panel.replaceChildren(...(node ? [node] : []));
    this.panel.classList.toggle('compact', compact);
    this.panel.scrollTop = 0;
  }

  /** The open band of map between the caption and the sheet, as fractions of its height. */
  private band(): [number, number] {
    const H = this.mapwrap.clientHeight || 1;
    if (this.layout === 'laptop') return [0, 1];
    const top = this.caption.offsetTop + this.caption.offsetHeight + 8;
    const bottom = this.panel.childElementCount ? this.sheet.offsetTop - 8 : H;
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

  /** Camera that puts p in the middle of the open band. */
  camAt(p: XY, mpp: number): Cam {
    return { x: p[0], y: p[1] + (0.5 - this.focusY) * this.renderer.AH * mpp, mpp };
  }

  /** Flies to show all points in the open band. */
  fitView(pts: XY[], ms = 900): void {
    if (!pts.length) return;
    const bb = bboxOf(pts);
    const [a, b] = this.band();
    const AW = this.renderer.AW, AH = this.renderer.AH * (b - a);
    const mpp = Math.min(MAX_MPP, Math.max(MIN_MPP, (bb.maxX - bb.minX) / (AW * 0.84), (bb.maxY - bb.minY) / (AH * 0.8)));
    this.camera.follow();
    this.camera.flyTo(this.camAt([(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2], mpp), ms);
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

  about(back: () => void): void {
    const d = this.data, n = d.numbers;
    this.setPanel(h('div', {},
      h('div.eyebrow', {}, 'ABOUT THIS MAP'),
      h('h2.h', {}, "Built from the city's own pipe map"),
      h('p.p', {}, `TireTrail follows all ${n.drains.total.toLocaleString('en-US')} storm drains in Bonney Lake through the mapped pipes, ditches and ponds to where the water ends up. Where the map has a gap, TireTrail says so instead of guessing.`),
      h('p.p', {}, `Streets are colored by where their nearest drain goes. ${Math.round(n.unmapped.share * 100)}% of drains reach a gap in the map, so their streets stay gray.`),
      h('div.eyebrow', {}, 'DATA'),
      h('ul.credits', {}, ...d.credits.map((c) => h('li', {}, c))),
      h('p.note', {}, `${d.disclaimer} Map data is provided as is, without warranty.`),
      h('button.btn.quiet', { onclick: back }, 'Back')));
  }

  private readonly loop = (t: number): void => {
    const now = this.frozen ?? t;
    this.camera.tick(now);
    const out = this.screens[this.tab].frame(now);
    if (out.cam && !this.camera.userMoved && !this.camera.flying) this.camera.cam = out.cam;
    this.renderer.draw(this.camera.cam, out.scene, now);
    this.labels.update(this.camera.cam, this.renderer, out.hideLabels);
    requestAnimationFrame(this.loop);
  };
}
