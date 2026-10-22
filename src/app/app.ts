// App shell: pages and the full map stage, phone or laptop layout, and the draw loop.
import { bboxOf, type LngLat, type XY } from '../geo/geo.ts';
import { TireTrailData } from '../data/tiretrail.ts';
import { mergeBundles } from '../data/merge.ts';
import { Areas, town, type AreaInfo, type Box } from './areas.ts';
import { CameraCtl, capMpp, inBox, MIN_MPP, type Open } from './map/camera.ts';
import { Labels } from './map/labels.ts';
import { CAT } from './map/palette.ts';
import { REGION_MPP, Renderer, S, type Cam, type Scene } from './map/render.ts';
import { Sprites } from './map/sprites.ts';
import { OVERVIEW_MPP, PLACE_MPP, WANDER } from './map/views.ts';
import { Overview, World } from './map/world.ts';
import { regionPt, worldPt, type Region } from './map/region.ts';
import { StateMap } from './map/state.ts';
import { covers } from './screens/common.ts';
import { h } from './dom.ts';
import { glyph, salmonSVG } from './ui/glyphs.ts';
import { HistoryScreen } from './screens/history.ts';
import { StreetScreen } from './screens/street.ts';
import { DriveScreen } from './screens/drive-screen.ts';
import { FixScreen } from './screens/fix-screen.ts';
import { MapScreen } from './screens/map-screen.ts';
import { Tutorial } from './screens/tutorial.ts';
import { PROBLEM, SCIENCE } from './screens/guide-words.ts';
import { accountEntry } from './cloud/account.ts';

export type Tab = 'drive' | 'drives' | 'map' | 'street' | 'fix';
export type Layout = 'phone' | 'laptop';

/** Widest a fit-to-points view goes: enough for the Fix list or a drive on a phone. */
const FIT_MAX = 40;
/** CSS px the phone's zoom buttons take on the right of the map */
const ZOOM_COL = 56;
/** a window this small gets the phone layout */
const SMALL = { w: 760, h: 520 };
const TITLE: Record<Tab, string> = { drive: 'TireTrail', drives: 'My drives · TireTrail', map: 'Map · TireTrail', street: 'Street · TireTrail', fix: 'Fix list · TireTrail' };
// as the county area files carry them, by county
const AREA_CREDITS: Record<string, string[]> = {
  Pierce: ['Pierce County GIS drainage, road and hydrography layers (unincorporated Pierce County), provided as is, without warranty'],
};
const ANY_AREA_CREDITS = ['WDFW SWIFD (coho distribution)', 'US Census Bureau TIGERweb (place names)'];

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

/** Phones and small tablets always get the phone layout. */
const TOUCH = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const isSmall = () => innerWidth < SMALL.w || innerHeight < SMALL.h;

/** Phones and small windows get the phone layout; else the URL's, else the one the person picked. */
function want(asked: Layout | null): Layout {
  if (TOUCH) return 'phone';
  if (asked) return asked;
  if (isSmall()) return 'phone';
  let saved: string | null = null;
  try { saved = localStorage.getItem('tt-view'); } catch { /* storage blocked */ }
  return saved === 'phone' ? 'phone' : 'laptop';
}

/** A layout's classes on the shell. A small window has no room for the phone frame or the view switch. */
function dress(root: HTMLElement, l: Layout): void {
  const small = !TOUCH && isSmall();
  root.classList.toggle('small', small);
  root.classList.toggle('framed', l === 'phone' && !TOUCH && !small);
  root.classList.toggle('touch', TOUCH);
  root.classList.toggle('phone', l === 'phone');
  root.classList.toggle('laptop', l === 'laptop');
}

/** The phone frame's scale in a small window. */
function fitFrame(frame: HTMLElement): void {
  const s = Math.min(1, (innerHeight - 32) / 870, (innerWidth - 24) / 414);
  frame.style.setProperty('--fit', s.toFixed(3));
}

export interface Shell { root: HTMLElement; frame: HTMLElement }

/** The empty shell, laid out before anything goes in it, so nothing ever shows unstyled. It goes under the splash. */
export function makeShell(host: HTMLElement, asked: Layout | null): Shell {
  const frame = h('div.frame.on-page'), root = h('div.shell', {}, frame);
  dress(root, want(asked));
  fitFrame(frame);
  host.prepend(root);
  return { root, frame };
}

/** "Pierce", "Pierce and King", "Pierce, King and Kitsap" */
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export class App {
  /** Bonney Lake plus whatever county areas have been loaded, joined into one */
  data: TireTrailData;
  readonly region: Region | null;
  world: World;
  readonly areas = new Areas();
  /** every traced street, simplified; null until it loads */
  overview: Overview | null = null;
  /** middle of the built-in town (Bonney Lake) */
  readonly home: XY;
  /** which place each block of street runs came from, in load order */
  private readonly runPlaces: { start: number; name: string }[] = [{ start: 0, name: 'Bonney Lake' }];
  readonly sprites: Sprites;
  readonly renderer: Renderer;
  readonly camera: CameraCtl;
  labels: Labels;
  readonly caption: HTMLElement;
  readonly panel: HTMLElement;
  readonly screens: { drive: DriveScreen; drives: HistoryScreen; map: MapScreen; street: StreetScreen; fix: FixScreen };
  readonly tutorial: Tutorial;
  /** Phones and small tablets always get the phone layout. */
  readonly touch = TOUCH;
  tab: Tab = 'drive';
  /** the tab before this one, for Back from the Fix list */
  prevTab: Tab = 'drive';
  layout: Layout = 'phone';
  /** fixed clock, for screenshots */
  frozen: number | null = null;
  introMode: 'auto' | 'force' | 'off' = 'auto';
  private readonly root: HTMLElement;
  private readonly frameEl: HTMLElement;
  private readonly mapwrap: HTMLElement;
  /** where Enter picks, while the map has keyboard focus */
  private readonly cross: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly page: HTMLElement;
  private readonly tabs: Record<'drive' | 'drives' | 'map', HTMLButtonElement>;
  private readonly nav: HTMLElement;
  /** the amber bar that marks the current tab */
  private readonly tabBar: HTMLElement;
  private captionKey = '';
  /** a new card's headline, for screen readers, until the caption is set this turn */
  private say = '';
  private started = false;
  private mode: 'page' | 'stage' = 'page';
  /** set while the About page is open, so a view switch can redraw it */
  private aboutBack: (() => void) | null = null;
  /** the layout the URL asked for */
  private asked: Layout | null = null;
  /** the camera as built, so the first map view can tell nothing has moved it */
  private readonly firstCam: Cam;
  private placed = false;
  /** last focused element outside the tutorial, to return to when it closes */
  private lastFocus: HTMLElement | null = null;
  /** history steps Escape took itself, whose popstate is already handled */
  private skipPop = 0;

  /** shell: from makeShell. guide: the first-open guide, if it opened while the map loaded. */
  constructor(data: TireTrailData, region: Region | null, shell: Shell, guide: Tutorial | null = null) {
    this.data = data;
    this.region = region;
    this.world = new World(data);
    this.home = this.world.center;
    this.sprites = new Sprites(this.world);
    const canvas = h('canvas', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.renderer = new Renderer(canvas, this.world, this.sprites);
    this.renderer.region = region;
    // the land statewide comes in after the first frame, behind the region map's outlines
    if (region) this.renderer.state = new StateMap();
    this.cross = h('div.crosshair', { 'aria-hidden': 'true' });
    this.mapwrap = h('div.mapwrap', { role: 'region', 'aria-label': 'Map', tabindex: '0', onkeydown: (e) => this.mapKey(e as KeyboardEvent) },
      h('p.sr', {}, 'Streets are colored by where their rain goes. Use Find a street to hear the answer for any street.'),
      h('p.sr', {}, 'Arrow keys move the map. Plus and minus zoom. Enter picks the street under the cross.'),
      canvas, h('div.labels', { 'aria-hidden': 'true' }), this.cross);
    this.caption = h('div.caption.box', { role: 'status', 'aria-live': 'polite' });
    this.panel = h('div.panel');
    const key = (label: string, icon: string, fn: () => void, tip?: string) =>
      h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': label, title: tip, html: glyph(icon), onclick: fn });
    const zoom = h('div.zoom', {},
      key('Go to my area', 'home', () => this.goHome(), 'Go to my area'),
      key('Zoom in', 'plus', () => this.camera.zoomBy(0.5)),
      key('Zoom out', 'minus', () => this.camera.zoomBy(2)));
    const attrib = h('button.attrib', { type: 'button', 'aria-label': 'Map data from OpenStreetMap and Microsoft. Open About and data sources.', onclick: () => this.about(() => this.setTab(this.tab)) }, '© OpenStreetMap, Microsoft');
    // the card comes first, so Tab reaches the search box before the zoom buttons
    this.sheet = h('aside.sheet', {}, this.panel, zoom, attrib);
    // the map last, so Tab reaches the card and its buttons first
    const stage = h('section.stage', {}, this.caption, this.sheet, this.mapwrap);
    // a phone's click after a map tap can land on a button that just moved under the finger
    stage.addEventListener('click', (e) => { if (this.camera?.ghost(e)) { e.stopPropagation(); e.preventDefault(); } }, true);
    this.page = h('main.page');
    const tab = (t: Tab, label: string, icon: string) => {
      const b = h('button', { type: 'button', onclick: () => this.setTab(t) }) as HTMLButtonElement;
      b.innerHTML = `<span class="tab-ico" aria-hidden="true">${icon}</span><span class="tab-word">${label}</span>`;
      return b;
    };
    this.tabs = {
      drive: tab('drive', 'Drive', glyph('car')),
      drives: tab('drives', 'My drives', glyph('list')),
      map: tab('map', 'Map', glyph('map')),
    };
    const brand = h('button.brand', { type: 'button', onclick: () => this.setTab('drive') },
      h('span.brand-mark', { 'aria-hidden': 'true', html: salmonSVG(2) }), h('span.brand-word', {}, 'TireTrail'));
    this.tabBar = h('span.tab-bar', { 'aria-hidden': 'true' });
    this.nav = h('nav.tabs', {}, brand, h('div.tabgroup', {}, this.tabs.drive, this.tabs.drives, this.tabs.map, this.tabBar), accountEntry());
    this.frameEl = shell.frame;
    // under the guide, if it is already up
    this.frameEl.prepend(this.nav, this.page, stage);
    // the view switch: two pixel icons in a corner; the words are for screen readers and tooltips
    const sw = (l: Layout, label: string) => h('button', { type: 'button', 'data-l': l, 'aria-pressed': 'false', title: label, onclick: () => this.setLayout(l, true), html: `${glyph(l)}<span class="sr">${label}</span>` });
    this.root = shell.root;
    this.root.append(h('div.viewswitch', { role: 'group', 'aria-label': 'View' }, sw('laptop', 'Laptop view'), sw('phone', 'Phone view')));
    // treatment streets and the answer tones take the map's colors
    const css = document.documentElement.style;
    css.setProperty('--treat', CAT.treatment);
    css.setProperty('--salmon', CAT.creek);
    css.setProperty('--soak', CAT.ground);
    css.setProperty('--other', CAT.elsewhere);
    // a stand-in until the map first shows, when openCam() takes over
    this.camera = new CameraCtl(this.mapwrap, this.renderer, { x: this.home[0], y: this.home[1], mpp: PLACE_MPP.laptop }, (p) => this.tap(p), () => this.now());
    this.firstCam = this.camera.cam;
    const [w, s, e, n] = WANDER, nw = this.world.toWorld([w, n]), se = this.world.toWorld([e, s]);
    this.camera.wander = { x0: nw[0], y0: nw[1], x1: se[0], y1: se[1] };
    this.camera.open = () => this.openArea();
    if (region) {
      const [x0, y0, x1, y1] = region.usBox;
      this.camera.limit = { x0, y0, x1, y1 };
    }
    this.labels = new Labels(this.mapwrap.querySelector('.labels')!, this.world, region);
    this.tutorial = guide ?? new Tutorial(this.frameEl);
    if (this.tutorial.isOpen) this.tutorial.cover();
    this.screens = { drive: new DriveScreen(this), drives: new HistoryScreen(this), map: new MapScreen(this), street: new StreetScreen(this), fix: new FixScreen(this) };
  }

  async start(layout?: Layout): Promise<void> {
    // the layout before the wait, so the tab bar never shows unstyled
    this.asked = layout ?? null;
    this.setLayout(this.wantLayout(), false);
    await Promise.all([this.sprites.load(), this.areas.init()]);
    new ResizeObserver(() => this.resize()).observe(this.mapwrap);
    addEventListener('resize', () => { this.fit(); this.setLayout(this.wantLayout(), false); this.placeBar(); });
    // the tab words change width once the font arrives
    void document.fonts?.ready.then(() => this.placeBar());
    addEventListener('popstate', () => { if (this.skipPop) this.skipPop--; else this.onBack(); });
    addEventListener('keydown', (e) => this.onKey(e));
    // a search sees every loaded street
    document.addEventListener('input', () => { if (this.dataDue) this.tellData(); }, true);
    document.addEventListener('focusin', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest && !t.closest('.dv-ob')) this.lastFocus = t;
    });
    this.started = true;
    this.screens[this.tab].enter();
    this.markTab();
    // slide only after the first placement
    requestAnimationFrame(() => this.nav.classList.add('ready'));
    requestAnimationFrame(this.loop);
    // the county overview comes in behind the first frame
    requestAnimationFrame(() => setTimeout(() => void this.loadOverview(), 0));
    requestAnimationFrame(() => setTimeout(() => this.renderer.state?.load(), 0));
    void this.watchGeo();
    // main.ts opens the first-open guide; a key pressed in it before now runs here
    this.tutorial.attach(this);
  }

  now(): number {
    return this.frozen ?? performance.now();
  }

  private wantLayout(): Layout {
    return want(this.asked);
  }

  setLayout(l: Layout, remember: boolean): void {
    if (this.touch) l = 'phone';
    if (remember) try { localStorage.setItem('tt-view', l); } catch { /* storage blocked */ }
    dress(this.root, l);
    if (this.started && l === this.layout) { this.fit(); return; }
    this.layout = l;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.viewswitch button')) b.setAttribute('aria-pressed', String(b.dataset.l === l));
    this.fit();
    this.resize();
    // a new layout puts the tab marker in place without sliding
    this.nav.classList.remove('ready');
    this.placeBar();
    if (!this.started) return;
    requestAnimationFrame(() => this.nav.classList.add('ready'));
    if (this.aboutBack) this.about(this.aboutBack, false);
    else (this.screens[this.tab] as Screen).relayout?.();
  }

  private fit(): void {
    fitFrame(this.frameEl);
  }

  private resize(): void {
    this.renderer.resize(this.mapwrap.clientWidth, this.mapwrap.clientHeight);
    this.capZoom();
  }

  /** All the way out, the lower 48 just fit the open part of the map; on a tall screen they fill its height. */
  private capZoom(): void {
    const L = this.camera?.limit;
    if (L && this.mapwrap.clientWidth > 0) this.camera.maxMpp = capMpp(L, this.openArea());
  }

  // ---------- navigation ----------

  setTab(t: Tab): void {
    if (t === this.tab) {
      // the Drive tab (or the brand) on a drive page goes home; a recording stays up
      if (t === 'drive' && !this.recording) this.screens.drive.home();
      return;
    }
    this.screens[this.tab].leave();
    this.prevTab = this.tab;
    this.tab = t;
    this.markTab();
    this.screens[t].enter();
  }

  /** A drive is being recorded. */
  private get recording(): boolean {
    const d = this.screens.drive as unknown as { recording?: boolean; rec?: unknown };
    return !!(d.recording ?? d.rec);
  }

  private markTab(): void {
    // the street page and the fix list live under the map
    const lit = this.tab === 'fix' || this.tab === 'street' ? 'map' : this.tab;
    for (const [k, b] of Object.entries(this.tabs)) {
      if (k === lit) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    document.title = TITLE[this.tab];
    this.placeBar();
  }

  /** Puts the amber bar under the current tab (above it on phone). */
  private placeBar(): void {
    const b = this.tabs[this.tab === 'fix' || this.tab === 'street' ? 'map' : this.tab];
    if (!b?.offsetWidth) return;
    // laptop: under the icon and word; phone: a short bar above the icon
    const phone = this.layout === 'phone', w = phone ? 40 : b.offsetWidth - 24;
    const x = phone ? b.offsetLeft + (b.offsetWidth - w) / 2 : b.offsetLeft + 12;
    this.tabBar.style.setProperty('--x', `${Math.round(x)}px`);
    this.tabBar.style.setProperty('--w', `${Math.round(w)}px`);
  }

  /** Remembers a step so the phone's back button returns to it. */
  pushStep(): void {
    try { history.pushState({ tt: 1 }, ''); } catch { /* sandboxed */ }
  }

  /** The phone's Back: closes the top thing. With key set (Escape), it never leaves the tab. True if something closed. */
  private onBack(key = false): boolean {
    if (this.tutorial.isOpen) {
      this.tutorial.close();
      const el = this.lastFocus;
      if (el?.isConnected) el.focus();
      return true;
    }
    if (this.aboutBack) { const b = this.aboutBack; this.aboutBack = null; b(); return true; }
    if ((this.screens[this.tab] as Screen).back?.()) return true;
    if (key || this.tab === 'drive') return false;
    this.setTab(this.tab === 'fix' ? this.prevTab : 'drive');
    return true;
  }

  /** Escape works like the phone's Back, and takes the history step along. */
  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    // a search box clears itself first
    const t = e.target as HTMLInputElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.value) return;
    e.preventDefault();
    if (this.onBack(true) && (history.state as { tt?: number } | null)?.tt) {
      this.skipPop++;
      history.back();
    }
  }

  /** Shows a scrolling page and hides the map. */
  showPage(node: Node): void {
    this.mode = 'page';
    this.aboutBack = null;
    this.frameEl.classList.add('on-page');
    this.frameEl.classList.remove('on-stage');
    this.page.replaceChildren(node);
    this.page.scrollTop = 0;
    document.title = TITLE[this.tab];
  }

  /** Shows the full map with its caption and card. */
  showStage(): void {
    if (this.mode === 'stage') return;
    this.mode = 'stage';
    this.frameEl.classList.add('on-stage');
    this.frameEl.classList.remove('on-page');
    document.title = TITLE[this.tab];
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
    let to = p, mpp = Math.max(6, m / 3);
    if (m > REGION_MPP) {
      // far out the map is the region's drawing; this is the same spot in street meters
      const at = this.region ? worldPt(p) : p;
      if (m <= 1500 && this.traced(p, at)) {
        mpp = 6;
        void this.ensureAreas(this.boxAt(at, mpp));
      } else {
        // where TireTrail has nothing, stay in outlines
        mpp = this.inWander(at) ? m / 4 : Math.max(m / 4, REGION_MPP * 1.25);
      }
      if (mpp <= REGION_MPP) to = at;
    }
    const [x, y] = this.camera.clampTarget(to[0], to[1], mpp);
    this.camera.follow();
    this.camera.flyTo(this.camAt([x, y], mpp), 800);
  }

  /** Keys on the focused map: arrows move a quarter of the view, + and - zoom, Enter taps under the cross. */
  private mapKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const c = this.camera.cam, o = this.openArea(), dx = 0.25 * o.w * c.mpp, dy = 0.25 * o.h * c.mpp;
    const pan: Record<string, XY> = { ArrowLeft: [-dx, 0], ArrowRight: [dx, 0], ArrowUp: [0, -dy], ArrowDown: [0, dy] };
    if (pan[e.key]) this.camera.nudge(...pan[e.key]);
    else if (e.key === '+' || e.key === '=') this.camera.zoomBy(0.5);
    else if (e.key === '-' || e.key === '_') this.camera.zoomBy(2);
    else if (e.key === 'Enter' || e.key === ' ') this.tap(this.renderer.toWorld(c, (this.renderer.AW / 2 + o.cx) * S, (this.renderer.AH / 2 + o.cy) * S));
    else return;
    e.preventDefault();
  }

  /** A region-map spot (p, and at in street meters) is traced: inside the yellow, or in a county area with drains. */
  private traced(p: XY, at: XY): boolean {
    if (this.world.runsNear(at, 300).length) return true;
    if (this.region?.coverage) return this.region.inCoverage(p, true);
    const [lon, lat] = this.lngLat(at);
    return this.areas.list.some((a) => a.drains > 0 && lon >= a.bbox[0] && lon <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3]);
  }

  private inWander(p: XY): boolean {
    const W = this.camera.wander;
    return !W || (p[0] >= W.x0 && p[0] <= W.x1 && p[1] >= W.y0 && p[1] <= W.y1);
  }

  private lngLat(p: XY): LngLat {
    return this.world.P.toLngLat([p[0], -p[1]]);
  }

  /** The lon/lat box a view at this zoom around p shows. */
  private boxAt(p: XY, mpp: number): Box {
    const hw = (this.renderer.AW * mpp) / 2, hh = (this.renderer.AH * mpp) / 2;
    const sw = this.lngLat([p[0] - hw, p[1] + hh]), ne = this.lngLat([p[0] + hw, p[1] - hh]);
    return [sw[0], sw[1], ne[0], ne[1]];
  }

  /** Street-color zoom for one place up close. */
  private placeMpp(): number {
    return this.layout === 'phone' ? PLACE_MPP.phone : PLACE_MPP.laptop;
  }

  /** The box around everything traced, in street meters: the yellow areas, else the area files and the streets loaded. */
  private tracedBox(): Box {
    const R = this.region;
    if (R?.coverage) return R.toWorld(R.coverage).box;
    const b = this.world.bounds;
    let [x0, y0, x1, y1] = [b.x0, b.y0, b.x1, b.y1];
    for (const a of this.areas.list) {
      if (!a.drains) continue;
      const nw = this.world.toWorld([a.bbox[0], a.bbox[3]]), se = this.world.toWorld([a.bbox[2], a.bbox[1]]);
      [x0, y0, x1, y1] = [Math.min(x0, nw[0]), Math.min(y0, nw[1]), Math.max(x1, se[0]), Math.max(y1, se[1])];
    }
    return [x0, y0, x1, y1];
  }

  /** Everything traced so far, fit to the open part of the map but no farther out than its colored streets draw. Too big to fit, it centers where the drains are. */
  tracedView(): { at: XY; mpp: number } {
    const [x0, y0, x1, y1] = this.tracedBox(), o = this.openArea();
    const need = Math.max((x1 - x0) / (o.w * 0.92), (y1 - y0) / (o.h * 0.9));
    if (need <= OVERVIEW_MPP) return { at: [(x0 + x1) / 2, (y0 + y1) / 2], mpp: Math.max(this.placeMpp(), need) };
    // each area file's middle weighted by its drains, with the built-in town's
    const n = this.data.numbers.drains.total;
    let [sx, sy, sw] = [this.home[0] * n, this.home[1] * n, n];
    for (const a of this.areas.list) {
      const p = this.world.toWorld([(a.bbox[0] + a.bbox[2]) / 2, (a.bbox[1] + a.bbox[3]) / 2]);
      [sx, sy, sw] = [sx + p[0] * a.drains, sy + p[1] * a.drains, sw + a.drains];
    }
    return { at: sw > 0 ? [sx / sw, sy / sw] : [(x0 + x1) / 2, (y0 + y1) / 2], mpp: OVERVIEW_MPP };
  }

  /** The opening view: everything traced so far, with its colored streets. */
  openCam(): Cam {
    const v = this.tracedView();
    return this.camAt(v.at, v.mpp);
  }

  /** All the way out: the lower 48 in the open part of the map, west edge first on a tall screen. */
  usCam(): Cam | null {
    const L = this.camera.limit;
    if (!L) return null;
    this.capZoom();
    const mpp = this.camera.maxMpp, [x, y] = inBox(L.x0, (L.y0 + L.y1) / 2, mpp, L, this.openArea());
    return { x, y, mpp };
  }

  /** location is already allowed for this page, as the browser last said; the home key never asks for it */
  private geoOk = false;

  /** Keeps geoOk up to date, without asking for location. */
  private async watchGeo(): Promise<void> {
    try {
      const s = await navigator.permissions.query({ name: 'geolocation' });
      this.geoOk = s.state === 'granted';
      s.addEventListener('change', () => { this.geoOk = s.state === 'granted'; });
    } catch { /* no permissions API: the home key shows everything traced */ }
  }

  /** The home key: the person's own area when location is already allowed, else everything traced. */
  goHome(): void {
    const cam = this.camera;
    if (!this.geoOk || !navigator.geolocation) { cam.goTo(this.openCam(), 650); return; }
    // hold still while the position comes in: a story stops steering, and a pan or zoom meanwhile wins
    cam.goTo({ ...cam.cam }, 1);
    const was = { ...cam.cam };
    const still = () => Math.hypot(cam.cam.x - was.x, cam.cam.y - was.y) < was.mpp && Math.abs(cam.cam.mpp / was.mpp - 1) < 0.01;
    navigator.geolocation.getCurrentPosition((pos) => {
      if (!still()) return;
      const at = this.world.toWorld([pos.coords.longitude, pos.coords.latitude]);
      // up close where TireTrail has streets; else far enough out to see the area around
      const mpp = this.traced(this.region ? regionPt(at) : at, at) ? this.placeMpp() : this.inWander(at) ? OVERVIEW_MPP : 400;
      cam.goTo(this.camAt(cam.clampTarget(at[0], at[1], mpp), mpp), 650);
    }, () => { if (still()) cam.goTo(this.openCam(), 650); }, { maximumAge: 300000, timeout: 8000 });
  }

  // ---------- the map stage ----------

  /** Swaps the caption (it fades in with CSS); the same key leaves it alone. */
  setCaption(key: string, icon: string, html: string): void {
    if (key === this.captionKey) return;
    this.captionKey = key;
    this.caption.innerHTML = `<span class="ico" aria-hidden="true">${icon}</span><span class="swap">${html}</span>`;
    this.sayHeadline();
  }

  setPanel(node: Node | null, compact = false, keepScroll = false): void {
    const top = this.panel.scrollTop;
    this.aboutBack = null;
    this.panel.replaceChildren(...(node ? [node] : []));
    this.panel.classList.toggle('compact', compact);
    this.panel.scrollTop = keepScroll ? top : 0;
    // screen readers hear the card's headline with the caption
    const heads = 'h1, h2, .h2, .h', hd = node instanceof Element ? (node.matches(heads) ? node : node.querySelector(heads)) : null;
    this.say = hd?.textContent?.trim() ?? '';
    this.sayHeadline();
    if (this.say) queueMicrotask(() => { this.say = ''; });
  }

  private sayHeadline(): void {
    this.caption.querySelector(':scope > .sr')?.remove();
    // an empty caption stays hidden
    if (this.say && this.captionKey) this.caption.append(h('span.sr', {}, this.say));
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

  /** The part of the map no caption, card or zoom button covers (art px): the laptop card on the left, the phone's buttons on the right. */
  openArea(): Open {
    const [a, b] = this.band(), AW = this.renderer.AW, AH = this.renderer.AH;
    const left = this.layout === 'laptop' && this.panel.childElementCount ? (this.sheet.offsetWidth + 16) / S : 0;
    const right = this.layout === 'phone' ? ZOOM_COL / S : 0;
    return { cx: (left - right) / 2, cy: ((a + b) / 2 - 0.5) * AH, w: Math.max(10, AW - left - right), h: Math.max(10, AH * (b - a)) };
  }

  /** Camera that puts p in the middle of the open part of the map. */
  camAt(p: XY, mpp: number): Cam {
    const o = this.openArea();
    return { x: p[0] - o.cx * mpp, y: p[1] - o.cy * mpp, mpp };
  }

  /** Flies to show all points in the open part of the map; pins stand ~14 art px above their points. */
  fitView(pts: XY[], opt: { ms?: number; min?: number } = {}): void {
    if (!pts.length) return;
    const bb = bboxOf(pts), o = this.openArea();
    const need = Math.max((bb.maxX - bb.minX) / Math.max(10, o.w - 24), (bb.maxY - bb.minY) / Math.max(10, o.h - 36));
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

  /** Counties the traced area really reaches into (not just spills over), home county first. */
  areaCounties(): string[] {
    const R = this.region;
    if (!R || !this.areas.drains) return [];
    return R.counties.filter((c) => R.covered(c)).sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name)).map((c) => c.name);
  }

  /** Where TireTrail has pipe maps, from the data: "Pierce County (Bonney Lake and unincorporated areas)". County areas count once their list is in. */
  coverageWords(): string {
    return covers(this.region, this.areas.drains > 0);
  }

  /** The biggest cities on the map that TireTrail doesn't have pipe maps for yet. */
  missingCities(n = 3): string[] {
    const R = this.region;
    return R ? R.places.filter((p) => !R.isMapped(p)).sort((a, b) => b.area - a.area).slice(0, n).map((p) => p.name) : [];
  }

  /** The About page. */
  about(back: () => void, push = true): void {
    const d = this.data, n = d.numbers, counties = this.areaCounties(), missing = this.missingCities();
    if (push) this.pushStep();
    // through history, so the step it pushed goes too
    const close = () => {
      if ((history.state as { tt?: number } | null)?.tt) history.back();
      else { this.aboutBack = null; back(); }
    };
    const all = [...new Set([
      ...d.credits,
      ...counties.flatMap((c) => AREA_CREDITS[c] ?? []),
      ...(this.areas.list.length ? ANY_AREA_CREDITS : []),
      ...(this.renderer.basemap ? ['Microsoft Building Footprints (ODbL)', '© OpenStreetMap contributors (ODbL)'] : []),
      // the land statewide: lakes, rivers, roads, towns and glaciers from OpenStreetMap, elevation from USGS by way of AWS
      ...(this.renderer.state ? ['© OpenStreetMap contributors (ODbL)', 'Elevation: AWS Terrain Tiles, from USGS 3DEP, GMTED2010 and SRTM (public domain)'] : []),
      ...(this.region ? ['US Census Bureau (state, county and city outlines)', 'Natural Earth (Canada and Mexico)'] : []),
    ])];
    // "WDFW SWIFD" is covered by "WDFW SWIFD (coho distribution)"
    const credits = all.filter((c) => !all.some((o) => o !== c && o.startsWith(c)));
    // every drain loaded: the built-in bundle's and the county areas'
    const drains = n.drains.total + this.areas.drains;
    // top to bottom: the problem, the numbers, pipe maps, privacy, data, copyright
    this.showPage(h('div.wrap.narrow', {},
      h('button.backlink', { onclick: close }, h('span', { 'aria-hidden': 'true' }, '‹'), ' Back'),
      h('div.eyebrow', {}, 'ABOUT TIRETRAIL'),
      h('h1.h1', {}, 'Built for drivers across Washington'),
      h('div.eyebrow.gap', {}, 'THE PROBLEM'),
      h('p.p', {}, PROBLEM),
      ...SCIENCE.map((f) => h('p.p', {}, f.fact, h('small', {}, f.source))),
      h('div.eyebrow.gap', {}, 'THE MAP'),
      h('p.p', {}, `It traces ${drains.toLocaleString('en-US')} storm drains from real city and county pipe maps.`),
      h('p.p', {}, 'Where a pipe map has a gap, TireTrail says so instead of guessing.'),
      h('p.p', {}, 'Tire dust is an estimate from how you drive.'),
      h('p.p', {}, `Pipe maps so far: ${this.coverageWords()}.`),
      missing.length ? h('p.p', {}, `Not added yet: ${and(missing)}.`) : null,
      h('p.p', {}, 'More of Washington is next.'),
      h('div.eyebrow.gap', {}, 'PRIVACY'),
      h('p.p', {}, 'Your drives and routes stay on this phone.'),
      h('p.p', {}, 'Signing in backs up scores and spots, never routes or anything near home.'),
      h('p.p', {}, 'To delete, open Account: Delete my data, or Delete drives on this phone.'),
      h('div.eyebrow.gap', {}, 'DATA'),
      h('ul.credits', {}, ...credits.map((c) => h('li', {}, c))),
      h('p.note', {}, `${d.disclaimer} Map data is provided as is, without warranty.`),
      h('p.note', {}, 'Fonts: Silkscreen by Jason Kottke and Geist by Vercel (SIL Open Font License).'),
      h('p.note', {}, '© 2026 Ashwath Polali. Made for the 2026 Congressional App Challenge.'),
      h('div.actions.row', {},
        h('button.btn.quiet', { onclick: () => this.tutorial.open() }, 'Watch the tutorial again'),
        h('button.btn.quiet', { onclick: () => this.setTab('fix') }, 'Fix list for the city'))));
    this.aboutBack = back;
    document.title = 'About · TireTrail';
  }

  private readonly dataListeners: (() => void)[] = [];
  /** areas joined in the background that the listeners haven't heard about yet */
  private dataDue = false;
  private camKey = '';
  private camMoved = 0;

  private tellData(): void {
    this.dataDue = false;
    for (const f of this.dataListeners) f();
  }

  /** Background areas are told about once the map has held still a moment (a search box flushes them at once). */
  private lateData(now: number): void {
    const c = this.camera.cam, key = `${c.x},${c.y},${c.mpp}`;
    if (key !== this.camKey) [this.camKey, this.camMoved] = [key, now];
    if (this.dataDue && !this.areaBusy && !this.camera.flying && now - this.camMoved > 1200) setTimeout(() => { if (this.dataDue) this.tellData(); }, 0);
  }
  private areaBusy = false;
  private areaCheck = 0;

  /** The place a street run belongs to, e.g. "Bonney Lake" or "Tehaleh". */
  placeOf(run: number): string {
    let name = this.runPlaces[0].name;
    for (const p of this.runPlaces) if (run >= p.start) name = p.name;
    return name;
  }

  /** Called whenever county areas are joined in. */
  onData(fn: () => void): void {
    this.dataListeners.push(fn);
  }

  /** The lon/lat box the camera sees. */
  viewBox(): Box {
    const a = this.renderer.toWorld(this.camera.cam, 0, 0), b = this.renderer.toWorld(this.camera.cam, this.renderer.AW * S, this.renderer.AH * S);
    const p = this.lngLat(a), q = this.lngLat(b);
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  }

  /** Loads the county areas touching a box and joins them in. True if anything new arrived; a file that fails is tried again next time. */
  async ensureAreas(box: Box, max = 4): Promise<boolean> {
    return this.join(this.areas.missing(box).slice(0, max));
  }

  /** quiet: background loading, whose news can wait for a still moment */
  private async join(want: AreaInfo[], quiet = false): Promise<boolean> {
    if (!want.length) return false;
    let added = 0;
    // each file joins as it arrives, one per task, so no single frame takes them all
    await Promise.all(want.map(async (a) => {
      const add = await this.areas.fetch(a.id);
      if (!add || this.areas.loaded.has(a.id)) return;
      await this.turn();
      if (this.areas.loaded.has(a.id)) return;
      const b = this.data.bundle;
      this.runPlaces.push({ start: b.streets.runs.piece.length, name: town(a.name) });
      this.areas.loaded.add(a.id);
      this.overview?.markLoaded(a.id);
      this.grow(new TireTrailData(mergeBundles(b, add)));
      added++;
    }));
    if (added && quiet) this.dataDue = true;
    else if (added || this.dataDue) this.tellData();
    return added > 0;
  }

  /** Waits for the next turn of the event loop, after a frame if one is due. */
  private turn(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

  /** Takes a bigger bundle into the same world and labels; only the new part is indexed. */
  private grow(d: TireTrailData): void {
    this.data = d;
    const first = this.world.add(d);
    this.labels.add(first);
  }

  /** Every traced street, simplified, so far-off areas draw before their files load. Never holds up the start. */
  private async loadOverview(): Promise<void> {
    try {
      const r = await fetch('data/overview.json');
      if (!r.ok) return;
      const j: unknown = await r.json();
      await this.turn();
      const ov = Overview.read(j, (p) => this.world.toWorld(p));
      if (!ov) return;
      for (const id of this.areas.loaded) ov.markLoaded(id);
      this.overview = ov;
      this.renderer.overview = ov;
    } catch { /* the areas still load as before */ }
  }

  /** While the map is up close and still, quietly bring in the county areas it shows; a file that just failed waits a little. */
  private pullAreas(now: number): void {
    if (this.areaBusy || this.camera.flying || now - this.areaCheck < 600 || this.camera.cam.mpp > REGION_MPP || !this.areas.list.length) return;
    this.areaCheck = now;
    const box = this.viewBox(), want = this.areas.missing(box).filter((a) => !this.areas.resting(a.id)).slice(0, 3);
    if (!want.length) { this.prefetch(box); return; }
    this.areaBusy = true;
    void this.join(want, true).finally(() => { this.areaBusy = false; });
  }

  private prefetching = false;

  /** With the view's own areas in, fetch (not join) the ones just around it while the page is idle. */
  private prefetch(box: Box): void {
    if (this.prefetching) return;
    const w = box[2] - box[0], h = box[3] - box[1];
    const next = this.areas.missing([box[0] - w / 2, box[1] - h / 2, box[2] + w / 2, box[3] + h / 2]).find((a) => !this.areas.resting(a.id) && !this.areas.fetched(a.id));
    if (!next) return;
    this.prefetching = true;
    const go = () => void this.areas.fetch(next.id).finally(() => { this.prefetching = false; });
    const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(go, { timeout: 2000 }); else setTimeout(go, 200);
  }

  /** The first time the map shows, it opens on everything traced, unless something already moved the camera. */
  private placeCamera(): void {
    if (this.placed) return;
    this.placed = true;
    if (this.camera.cam === this.firstCam && !this.camera.flying && !this.camera.userMoved) this.camera.cam = this.openCam();
  }

  private readonly loop = (): void => {
    // next frame first, so one bad frame can't stop the map
    requestAnimationFrame(this.loop);
    if (this.mode !== 'stage') return;
    // one clock for everything: rAF's timestamp can run behind performance.now()
    const now = this.now();
    this.capZoom();
    this.placeCamera();
    this.camera.tick(now);
    const out = this.screens[this.tab].frame(now);
    if (out.cam && !this.camera.userMoved && !this.camera.flying) this.camera.cam = out.cam;
    this.camera.settle();
    if (document.activeElement === this.mapwrap) {
      const o = this.openArea();
      this.cross.style.transform = `translate(${this.mapwrap.clientWidth / 2 + o.cx * S}px, ${this.mapwrap.clientHeight / 2 + o.cy * S}px)`;
    }
    this.renderer.draw(this.camera.cam, out.scene, now);
    this.labels.update(this.camera.cam, this.renderer, out.hideLabels, this.camera.cam.mpp > 150 ? [this.region?.middle ?? this.home] : []);
    this.pullAreas(now);
    this.lateData(now);
  };
}
