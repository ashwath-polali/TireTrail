// Map tab: every street colored by where its rain goes. Every tap gets a short answer card.
/// <reference types="vite/client" />
import './map-ui.css';
import { decodePath, KINDS } from '../../data/bundle.ts';
import { bboxOf, nearestOnPolyline, pointAlong, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { esc, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CAT, swatchSVG, type Band, type Swatch } from '../map/palette.ts';
import { S, type Tag, type Trip } from '../map/render.ts';
import { CLS, type Run } from '../map/world.ts';
import { Coach, coachSeen } from './coach.ts';
import {
  cap, closingEl, clsIcon, countyName, covers, drainLine, drainOutcome, far, feet, hasStep, headline, isGray, KIND, line, midOf, nearLine, owns, plainWater,
  runOutcome, tapWord, type Outcome,
} from './common.ts';
import { Intro, introSeen } from './intro.ts';
import { Player } from './player.ts';
import { resolve, runWithin, type Answer, type TapState } from './resolve.ts';
import { StreetIndex } from './streets.ts';

/** What the last tap answered, for tests and the live region. */
export interface Said { kind: string; cls?: string; name?: string }

type Shown = Answer | { kind: 'failed'; box: Box };
type View = 'idle' | 'card' | 'help' | 'watch';

const FIT_MIN = 1.2, FIT_MAX = 12;

export class MapScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private index: StreetIndex;
  private intro: Intro | null = null;
  private coach: Coach | null = null;
  private coachNext = false;
  private opened = false;
  private view: View = 'idle';
  private shown: { a: Shown; p: XY | null } | null = null;
  /** the street the open card is about */
  private sel: Run | null = null;
  private stretch: XY[][] | null = null;
  private trip: Trip | null = null;
  private tags: Tag[] | null = null;
  private mark: { at: XY; t0: number } | null = null;
  /** the last tap's answer; tests reset it to null */
  lastAnswer: Said | null = null;
  // history entries this screen pushed that are still there, and pops it asked for itself
  private entries = 0;
  private swallow = 0;
  private seq = 0;
  private pickSeq = 0;
  private q = '';
  private keyEl: HTMLElement | null = null;
  private keyKey = '';
  private tickAt = 0;
  private moreOpen = false;
  private waiting: { id: string; t: number } | null = null;
  /** a caption that wins over the idle one for a while (loading a far street, or why it failed) */
  private note: { key: string; icon: string; say: string; until: number } | null = null;
  private readonly toWater = new Map<string, { streets: number; runs: Set<number> }>();
  /** streets lit up for a water card */
  private lit: Set<number> | null = null;
  private treatment: boolean | null = null;

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
    app.onData(() => {
      this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
      this.toWater.clear();
      this.treatment = null;
      if (this.sel) this.sel = app.world.runs[this.sel.i];
    });
  }

  get introActive(): boolean {
    return this.intro !== null;
  }

  /** The street index the search uses (name|place keys). */
  get streets(): StreetIndex {
    return this.index;
  }

  enter(): void {
    const app = this.app, first = !this.opened;
    this.opened = true;
    app.showStage();
    // the zoom from the West Coast plays the first time the map opens
    if (first && app.region && (app.introMode === 'force' || (app.introMode === 'auto' && !introSeen()))) { this.playIntro(); return; }
    this.restore();
    if (first && app.introMode !== 'off' && !coachSeen()) this.coachNext = true;
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'card';
    this.coachNext = false;
    if (this.coach) { this.coach.end(); this.coach = null; }
    if (this.intro) {
      // put the camera home instead of leaving it over the whole country
      this.app.camera.follow();
      this.app.camera.cam = this.intro.end();
      this.intro = null;
    }
  }

  back(): boolean {
    if (this.swallow > 0) { this.swallow--; return true; }
    const had = this.entries > 0;
    if (had) this.entries--;
    if (this.coach) { this.stopCoach(); this.idle(); return true; }
    if (this.view === 'watch') { this.player.stop(); this.view = 'card'; this.render(true); return true; }
    if (this.view === 'card' || this.view === 'help') { this.idle(); return true; }
    return had;
  }

  relayout(): void {
    if (this.intro) this.intro.relayout();
    else if (this.view === 'watch') this.player.relayout();
    else if (this.coach) { this.idle(); this.coach.relayout(); }
    else this.restore();
  }

  private restore(): void {
    if (this.view === 'card' && this.shown) this.render(false);
    else if (this.view === 'help') this.help();
    else this.idle();
  }

  playIntro(): void {
    // only moves made after this count as interrupting it
    this.app.camera.follow();
    if (this.coach) this.stopCoach();
    this.toIdle();
    this.intro = new Intro(this.app, () => {
      this.intro = null;
      this.idle();
      // next frame, once the camera has landed
      if (!coachSeen()) this.coachNext = true;
    });
  }

  // ---------- history: one entry per open view ----------

  private level(n: number): void {
    while (this.entries < n) { this.app.pushStep(); this.entries++; }
  }

  /** Closes the top view the way the phone's Back would. */
  private close(): void {
    if (this.entries > 0 && hasStep()) history.back();
    else this.back();
  }

  /** Drops entries for views already closed some other way, without closing anything else. */
  private dropTo(n: number): void {
    const k = this.entries - n;
    if (k <= 0) return;
    this.entries = n;
    if (!hasStep()) return;
    this.swallow++;
    history.go(-k);
  }

  /** Back to the plain map, without a Back press. */
  private toIdle(): void {
    if (this.view !== 'idle' || this.entries) { this.dropTo(0); this.idle(); }
  }

  // ---------- the plain map: search, legend, more ----------

  idle(): void {
    const app = this.app;
    this.view = 'idle';
    this.shown = null;
    this.clearPick();
    this.player.stop();
    this.keyKey = '';
    this.tickAt = 0;
    this.idleCaption();
    const input = h('input.search.small', { type: 'search', placeholder: 'Type your street, like 214th Ave E', value: this.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find a street' }) as HTMLInputElement;
    const list = h('ul.suggest');
    let ask = 0;
    const row = (name: string, place: string, go: () => void) => h('li', {}, h('button', { onclick: go }, name, h('span.place', {}, place)));
    const fill = async () => {
      this.q = input.value;
      const mine = ++ask, q = this.q.trim();
      const hits = this.index.search(q, 5);
      const rows = hits.map((hit) => row(hit.name, this.placeLine(hit.key, hit.place), () => { const r = this.index.main(hit.key); if (r) this.pick(r); }));
      list.replaceChildren(...rows);
      // the rest of the county, loaded only when picked
      let more: Awaited<ReturnType<App['areas']['findStreet']>> = [], failed = false;
      try { more = await app.areas.findStreet(q, 6 - rows.length); failed = await this.namesFailed(); } catch { failed = true; }
      if (mine !== ask) return;
      const have = new Set(hits.map((hit) => hit.key));
      for (const m of more) if (!have.has(`${m.name}|${m.place}`)) rows.push(row(m.name, this.boxLine(m.place, m.area.bbox), () => void this.openFar(m.name, m.place, m.area.bbox)));
      list.replaceChildren(...rows);
      if (q && !rows.length) {
        list.replaceChildren(h('li.none', {}, failed
          ? "Couldn't search the county right now. Check your connection and try again."
          : `No street called "${q}" in TireTrail yet. It has ${covers(app.region)} so far.`));
      }
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') (list.querySelector('button') as HTMLButtonElement | null)?.click(); });
    void fill();
    const here = h('button.mu-locbtn', { 'aria-label': 'Use my location', title: 'Use my location', onclick: () => this.locate() });
    here.innerHTML = ICON.pin(2);
    this.keyEl = h('div.mu-key');
    this.fillKey();
    const more = h('details.more', { open: this.moreOpen || undefined, ontoggle: (e: Event) => { this.moreOpen = (e.target as HTMLDetailsElement).open; } },
      h('summary', {}, 'More'),
      h('div.mu-btns.mu-wrap', {},
        btn('Where the city could filter the water', () => app.setTab('fix')),
        app.region ? btn('Watch the opening again', () => this.playIntro()) : null));
    app.setPanel(h('div.fade.mu-idle', {}, h('div.searchbox', {}, h('div.mu-searchrow', {}, input, here), list), this.keyEl, more));
  }

  /** Finds the street nearest the person and opens its card. */
  private locate(): void {
    const app = this.app;
    const say = (m: string) => app.panel.querySelector('.mu-idle .suggest')?.replaceChildren(h('li.none', {}, m));
    if (!navigator.geolocation || !window.isSecureContext) { say("Your location needs GPS, which this page can't use here. Type your street instead."); return; }
    if (window.self !== window.top) { say("This preview can't use your location. Type your street instead."); return; }
    say('Finding where you are…');
    const mine = ++this.pickSeq;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lon = pos.coords.longitude, lat = pos.coords.latitude;
      try { await app.ensureAreas([lon - 0.02, lat - 0.015, lon + 0.02, lat + 0.015], 4); } catch { /* answered below */ }
      if (mine !== this.pickSeq || app.tab !== 'map' || this.view !== 'idle') return;
      const run = runWithin(app.world, app.world.toWorld([lon, lat]), 150);
      if (run) this.pick(run, false);
      else say("You're not near a street TireTrail has traced yet. Type your street to try it.");
    }, () => say('Location is off for this page. You can still search for your street.'), { enableHighAccuracy: true, timeout: 12000 });
  }

  /** "Bonney Lake", or "Tehaleh · Pierce County" for county streets. */
  private placeLine(key: string, place: string): string {
    const run = this.index.runs(key)[0], R = this.app.region;
    if (!run || !R || R.ownerAt(midOf(run)) === 'city') return place;
    const c = countyName(R, midOf(run));
    return c ? `${place} · ${c}` : place;
  }

  private boxLine(place: string, b: Box): string {
    const c = countyName(this.app.region, this.app.world.toWorld([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]));
    return c ? `${place} · ${c}` : place;
  }

  /** The county name list failed to load (it resolves to null then). */
  private async namesFailed(): Promise<boolean> {
    const names = (this.app.areas as unknown as { nameList?: Promise<unknown> | null }).nameList;
    return !!names && (await names) === null;
  }

  /** A street in a county area that isn't loaded yet. */
  private async openFar(name: string, place: string, bbox: Box): Promise<void> {
    const app = this.app, mine = ++this.pickSeq;
    this.say(`loading:${place}`, ICON.drop(), `Loading ${place}…`, 30000);
    try { await app.ensureAreas(bbox, 1); } catch { /* said below */ }
    this.note = null;
    // a newer pick, or another tab, wins
    if (mine !== this.pickSeq || app.tab !== 'map') return;
    const key = this.index.main(`${name}|${place}`) ? `${name}|${place}` : this.index.search(name, 20).find((hit) => hit.name === name)?.key;
    const r = key ? this.index.main(key) : null;
    if (r) { this.pick(r, false); return; }
    const msg = `Couldn't load ${place}. Check your connection and try again.`;
    this.say(`loadfail:${place}`, ICON.q(), msg, 8000);
    const list = app.panel.querySelector('.suggest');
    if (list) list.replaceChildren(h('li.none', {}, msg));
  }

  /** Opens a street's card from a list, then moves focus to its heading. */
  private pick(run: Run, bump = true): void {
    if (bump) this.pickSeq++;
    this.show({ kind: 'street', run }, null);
    (this.app.panel.querySelector('.mu-h') as HTMLElement | null)?.focus();
  }

  /** Shows a caption over the idle one for ms. */
  private say(key: string, icon: string, text: string, ms: number): void {
    this.note = { key, icon, say: text, until: this.app.now() + ms };
    this.app.setCaption(key, icon, `<span class="say">${esc(text)}</span>`);
  }

  private idleCaption(): void {
    const app = this.app, R = app.region, m = app.camera.cam.mpp, T = tapWord(app);
    const n = this.note;
    if (n && app.now() < n.until) { app.setCaption(n.key, n.icon, `<span class="say">${esc(n.say)}</span>`); return; }
    let key = `tap:${T}`, say = `${T} any street to see where its rain goes.`;
    if (m > 24) [key, say] = ['zoom', 'Zoom in on a yellow area to see its streets.'];
    else if (this.loadingView()) [key, say] = ['loading', 'Loading streets here…'];
    else {
      const c = this.bandMid(), pl = R?.placeAt(c), co = R?.countyAt(c);
      if (pl && !R!.isMapped(pl)) [key, say] = [`city:${pl.name}`, `${owns(pl.name)} pipe map isn't in TireTrail yet, so its streets stay gray.`];
      else if (R && (!co || !R.covered(co))) [key, say] = ['outside', "TireTrail hasn't traced this area yet. Zoom out to see where it works."];
      else if (this.noMap()) [key, say] = ['nomap', 'No street map here yet. Zoom out to see where TireTrail works.'];
    }
    app.setCaption(`idle:${key}`, ICON.drop(), `<span class="say">${esc(say)}</span>`);
  }

  /** County areas in view are on their way (a stuck one stops counting after a while). */
  private loadingView(): boolean {
    const miss = this.app.areas.missing(this.app.viewBox());
    if (!miss.length) { this.waiting = null; return false; }
    const now = this.app.now();
    if (this.waiting?.id !== miss[0].id) this.waiting = { id: miss[0].id, t: now };
    return now - this.waiting.t < 8000;
  }

  /** No base map tile and no traced street in view. */
  private noMap(): boolean {
    const app = this.app, r = app.renderer, cam = app.camera.cam;
    const a = r.toWorld(cam, 0, 0), b = r.toWorld(cam, r.AW * S, r.AH * S);
    // the tile list is cheap to ask, so first
    const bm = r.basemap as unknown as { index?: Set<string> | null; size?: number } | null;
    if (!bm?.index || !bm.size) return false;
    for (let ty = Math.floor(a[1] / bm.size); ty <= Math.floor(b[1] / bm.size); ty++) {
      for (let tx = Math.floor(a[0] / bm.size); tx <= Math.floor(b[0] / bm.size); tx++) if (bm.index.has(`${tx}_${ty}`)) return false;
    }
    return !app.world.runsNear([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Math.max(b[0] - a[0], b[1] - a[1]) / 2).length;
  }

  /** World point in the middle of the open part of the map. */
  private bandMid(): XY {
    const app = this.app, r = app.renderer, left = this.cardLeft();
    return r.toWorld(app.camera.cam, (left + r.AW * S) / 2, app.focusY * r.AH * S);
  }

  /** On a laptop, CSS px of map the card covers on the left. */
  private cardLeft(): number {
    const app = this.app;
    return app.layout === 'laptop' && app.panel.childElementCount ? app.panel.offsetWidth + 32 : 0;
  }

  // ---------- the legend ----------

  private fillKey(): void {
    const el = this.keyEl;
    if (!el) return;
    const app = this.app, m = app.camera.cam.mpp, phone = app.layout === 'phone';
    const band: Band = m <= 2.6 ? 'town' : m <= 12 ? 'overview' : 'region';
    const mini = phone && keyMini(), striped = m > 24 || this.stripedInView(), plant = this.hasTreatment();
    const key = [band, m > 24, striped, plant, phone, mini, tapWord(app)].join('|');
    if (key === this.keyKey) return;
    this.keyKey = key;
    const row = (sw: Swatch, b: Band, text: string) => h('div.mu-row', {}, h('span.mu-sw', { html: swatchSVG(sw, b) }), h('span.mu-lab', {}, text));
    let rows: HTMLElement[];
    if (m > 24) rows = [row('traced', 'region', 'Traced by TireTrail'), row('hatch', 'region', 'City pipe map not added yet')];
    else if (mini) {
      rows = [row('creek', band, 'Salmon stream'), row('ground', band, 'Soaks in'), row('elsewhere', band, 'Other water')];
      if (plant) rows.push(row('treatment', band, 'Treatment plant'));
      rows.push(row('none', band, 'No answer'));
    } else {
      rows = [row('creek', band, 'Goes to a salmon stream'), row('ground', band, 'Soaks into the ground'), row('elsewhere', band, 'Goes to other water, like a lake')];
      if (plant) rows.push(row('treatment', band, 'Goes to a sewage treatment plant'));
      rows.push(row('none', band, `No answer yet. ${tapWord(app)} to see why.`));
      if (m <= 2.6) rows.push(row('drain', 'town', 'Storm drain'));
      if (striped) rows.push(row('hatch', band, 'City pipe map not added yet'));
    }
    const help = () => this.openHelp();
    if (phone) {
      el.replaceChildren(h(`div.mu-phonekey${mini ? '.mu-mini' : ''}`, {},
        h(`div.${mini ? 'mu-strip' : 'mu-grid'}`, { role: 'list', 'aria-label': 'Where the rain goes' }, ...rows.map((r) => (r.setAttribute('role', 'listitem'), r))),
        h('button.mu-qbtn', { 'aria-label': 'How to read this map', onclick: help }, '?')));
    } else {
      el.replaceChildren(h('div.mu-keyh', {}, 'WHERE THE RAIN GOES'), h('div.mu-rows', {}, ...rows), h('button.mu-link', { onclick: help }, 'How to read this map'));
    }
  }

  private hasTreatment(): boolean {
    this.treatment ??= this.app.world.runs.some((r) => r.k === 5);
    return this.treatment;
  }

  /** A city whose pipe map isn't in TireTrail shows in the view. */
  private stripedInView(): boolean {
    const app = this.app, R = app.region, r = app.renderer, cam = app.camera.cam;
    if (!R) return false;
    const a = r.toWorld(cam, 0, 0), b = r.toWorld(cam, r.AW * S, r.AH * S);
    return R.places.some((pl) => {
      if (R.isMapped(pl)) return false;
      const x = R.toWorld(pl).box;
      return x[0] <= b[0] && x[2] >= a[0] && x[1] <= b[1] && x[3] >= a[1];
    });
  }

  // ---------- how to read this map ----------

  private openHelp(): void {
    this.level(1);
    this.help();
  }

  private help(): void {
    const app = this.app, T = tapWord(app);
    this.view = 'help';
    this.shown = null;
    this.clearPick();
    const m = app.camera.cam.mpp, band: Band = m <= 2.6 ? 'town' : m <= 12 || m > 24 ? 'overview' : 'region';
    const row = (sw: Swatch, b: Band, text: string) => h('div.mu-row', {}, h('span.mu-sw', { html: swatchSVG(sw, b) }), h('span.mu-lab', {}, text));
    const rows = [row('creek', band, 'Goes to a salmon stream'), row('ground', band, 'Soaks into the ground'), row('elsewhere', band, 'Goes to other water, like a lake')];
    if (this.hasTreatment()) rows.push(row('treatment', band, 'Goes to a sewage treatment plant'));
    rows.push(row('none', band, `No answer yet. ${T} to see why.`),
      row('stream', 'overview', 'Creek or stream'), row('coho', 'overview', 'Coho salmon live here'), row('drain', 'town', 'Storm drain (zoomed in)'),
      row('hatch', 'overview', 'City pipe map not added yet'), row('traced', 'region', 'Traced by TireTrail (zoomed out)'), row('pick', 'overview', 'The street you picked'));
    app.setCaption('help', ICON.drop(), `<span class="say">${T} any street to see where its rain goes.</span>`);
    app.setPanel(h('div.fade.mu-help', {},
      h('h2.h2.mu-h', { tabindex: '-1' }, 'How to read this map'),
      h('p.mu-line', {}, "Rain washes tire dust off roads and into storm drains. Each street's color shows where that rain ends up."),
      h('div.mu-rows', {}, ...rows),
      h('p.mu-line', {}, `${T} a street to see the path its rain takes. Press See it happen to watch it.`),
      h('p.mu-line', {}, "Gray doesn't mean a street is good or bad. It means TireTrail can't follow its rain yet, usually because the pipe map has a gap or no drain is mapped there."),
      h('div.mu-btns', {}, btn('Show me how', () => this.replayCoach(), true), btn('Close', () => this.close()))));
    (app.panel.querySelector('.mu-h') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  // ---------- the coach ----------

  private startCoach(): boolean {
    const c = Coach.make(this.app, (how, run) => this.coachDone(how, run));
    if (!c) return false;
    this.coach = c;
    this.level(1);
    return true;
  }

  /** From How to read this map: the help's entry becomes the coach's. */
  private replayCoach(): void {
    const keep = this.entries;
    this.idle();
    this.entries = keep;
    if (!this.startCoach()) this.help();
  }

  private stopCoach(): void {
    this.coach?.end();
    this.coach = null;
  }

  private coachDone(how: 'skip' | 'show' | 'moved', run?: Run): void {
    if (how === 'show' && run) {
      // its entry carries over to the card
      this.stopCoach();
      if (this.app.layout === 'phone') this.idle();
      this.show({ kind: 'street', run }, null);
    } else if (how === 'moved') {
      this.stopCoach();
      if (this.app.layout === 'phone') this.idle();
      this.dropTo(0);
    } else this.close();
  }

  // ---------- taps ----------

  tap(p: XY): boolean {
    const app = this.app;
    this.mark = { at: p, t0: app.now() };
    if (this.intro) { this.intro.skip(); return true; }
    // a tap during See it happen skips to its end
    if (this.view === 'watch') { (this.player as Player & { skipToEnd?: () => void }).skipToEnd?.(); return true; }
    if (this.coach) {
      // counts as "I'll explore"; the tap is then answered as usual
      this.stopCoach();
      if (app.layout === 'phone') this.idle();
    }
    this.answerAt(p, false);
    // far out the app zooms in
    return app.camera.cam.mpp <= 24;
  }

  private state(): TapState {
    const app = this.app;
    return { world: app.world, region: app.region, basemap: app.renderer.basemap, missing: (b) => app.areas.missing(b), mpp: app.camera.cam.mpp };
  }

  private answerAt(p: XY, retry: boolean): void {
    const app = this.app, mine = ++this.seq;
    const a = resolve(this.state(), p);
    this.lastAnswer = said(app, a);
    if (a.kind === 'zoom') {
      this.toIdle();
      if (app.camera.cam.mpp <= 24) {
        app.camera.follow();
        app.camera.flyTo(app.camAt(p, a.to), 700);
      }
      return;
    }
    if (a.kind === 'loading' && retry) { this.show({ kind: 'failed', box: a.box }, p); return; }
    this.show(a, p);
    if (a.kind !== 'loading') return;
    // load at once, then answer the same spot again
    const again = () => { if (mine === this.seq && app.tab === 'map' && this.view === 'card' && this.shown?.a === a) this.answerAt(p, true); };
    app.ensureAreas(a.box, 4).then(again, again);
  }

  /** Opens a card for an answer (one history step from the plain map). */
  private show(a: Shown, p: XY | null): void {
    if (this.player.active) this.player.stop();
    this.note = null;
    this.view = 'card';
    this.level(1);
    this.shown = { a, p };
    this.render(true);
    if (a.kind !== 'loading' && a.kind !== 'failed') setKeyMini();
  }

  /** Draws the open card; fly moves the camera to it. */
  private render(fly: boolean): void {
    const s = this.shown;
    if (!s) return;
    const a = s.a, p = s.p;
    this.clearPick();
    switch (a.kind) {
      case 'street': return this.streetCard(a.run, p, null, fly);
      case 'near': return this.streetCard(a.run, p, a.d, fly);
      case 'water': return this.waterCard(a, p!);
      case 'city': return this.cityCard(a, p!);
      case 'road': return this.roadCard(a, p!);
      case 'drain': return this.drainCard(a, p!, fly);
      case 'far': return this.farCard(a, p!);
      case 'outside': return this.outsideCard(a);
      case 'loading': return this.loadingCard(p, false);
      case 'failed': return this.loadingCard(p, true);
      default: return this.idle();
    }
  }

  private card(c: { icon: string; color: string; name: string; place: string; chip: string; gray: boolean; head: string; line: string; buttons: (HTMLElement | null)[]; key: string }): void {
    const app = this.app;
    const btns = c.buttons.filter((b): b is HTMLElement => b !== null);
    if (c.place === c.name) c.place = '';
    app.setCaption(`card:${c.key}`, c.icon, `<span class="say"><b>${esc(c.name || c.place)}</b></span><span class="mu-vh"> ${esc(c.head)}</span>`);
    app.setPanel(h('div.fade.mu-card', {},
      h('div.mu-head', {},
        h('span.mu-tile', { style: `--k:${c.color}`, html: c.icon }),
        h('div.mu-who', {},
          h('div.mu-name', {}, c.name ? h('b', {}, c.name) : null, c.name && c.place ? h('span.mu-place', {}, ` · ${c.place}`) : c.place ? h('span.mu-place', {}, c.place) : null),
          c.chip ? h(`span.mu-chip${c.gray ? '.mu-out' : ''}`, { style: `--k:${c.color}` }, c.chip) : null),
        h('button.mu-x', { 'aria-label': 'Close', onclick: () => this.close() }, h('span', { 'aria-hidden': 'true' }, '×'))),
      h('h2.h2.mu-h', { tabindex: '-1' }, c.head),
      c.line ? h('p.mu-line', {}, c.line) : null,
      btns.length ? h('div.mu-btns', {}, ...btns) : null));
  }

  private streetCard(run: Run, p: XY | null, nearD: number | null, fly: boolean): void {
    const app = this.app, w = app.world;
    const name = w.pieceNames[run.piece] || '', place = app.placeOf(run.i);
    const o = runOutcome(app, run), cls = o.cls;
    this.select(run, p);
    let head = headline(o), say = line(o), shown = name || 'This street';
    if (nearD !== null) {
      head = `You ${app.layout === 'laptop' ? 'clicked' : 'tapped'} near ${name || 'a street'}.`;
      say = nearLine(o, name || 'that street');
      shown = `Near ${name || 'a street'}`;
    }
    const watchable = run.drain !== null && !(cls === 'unknown' && o.lengthM < 10);
    const nearer = cls === 'none' && nearD === null ? runWithin(w, midOf(run), 300, (r) => r !== run && r.drain !== null && [0, 1, 2, 5].includes(r.k)) : null;
    this.card({
      key: `street:${run.i}:${nearD === null ? '' : 'near'}`, icon: clsIcon(cls), color: KIND[cls].color, name: shown, place, chip: KIND[cls].chip, gray: isGray(cls), head, line: say,
      buttons: [
        watchable ? btn(play(cls === 'unknown' ? 'See how far it goes' : 'See it happen'), () => this.watch(run), true) : null,
        btn('More details', () => app.screens.street.open(run)),
        nearer ? btn('Show the nearest street with an answer', () => this.pick(nearer)) : null,
      ],
    });
    if (fly) this.fit([...this.pickPoints(), ...(nearD !== null && p ? [p] : [])]);
  }

  private waterCard(a: Extract<Answer, { kind: 'water' }>, p: XY): void {
    const app = this.app, raw = a.name.trim(), lake = !a.water || !!a.water.ring;
    const known = !!raw && (!/unnamed/i.test(raw) || /tributary/i.test(raw));
    const T = tapWord(app);
    let head: string, say: string, chipText: string, name: string, color = '#5591a3', icon = ICON.waves();
    const to = known ? this.drainsTo(raw) : null, n = to?.streets ?? 0;
    if (a.coho) {
      [head, say, chipText, color, icon] = [known ? `This is ${plainWater(raw)}.` : 'This is a salmon stream.', 'Coho salmon live here.', 'SALMON STREAM', CAT.creek, ICON.fish()];
      if (n) say += ` ${n} traced ${n === 1 ? 'street sends its' : 'streets send their'} rain here. ${n === 1 ? "It's" : "They're"} lit up on the map.`;
      name = known ? cap(plainWater(raw)) : 'Salmon stream';
    } else if (known) {
      [head, say, chipText] = [`This is ${plainWater(raw)}.`, n ? `Rain from ${n} traced ${n === 1 ? 'street' : 'streets'} drains here.` : "None of the streets TireTrail has traced drain here.", lake ? 'LAKE' : 'STREAM'];
      name = cap(plainWater(raw));
    } else {
      [head, chipText] = lake ? ['A pond or small lake.', 'POND'] : ['A small stream.', 'STREAM'];
      say = `It has no name on the map. ${T} a street to see where its rain goes.`;
      name = lake ? 'Pond or small lake' : 'Small stream';
    }
    this.lit = n ? to!.runs : null;
    const show = () => { const w = this.app.world, pts: XY[] = []; for (const i of to!.runs) pts.push(...w.runs[i].line); this.fit(pts); };
    this.card({ key: `water:${raw}:${p.join(',')}`, icon, color, name, place: this.placeName(p), chip: chipText, gray: false, head, line: say, buttons: [n ? btn('Show those streets', show) : null] });
  }

  private cityCard(a: Extract<Answer, { kind: 'city' }>, p: XY): void {
    const city = a.place.name, R = this.app.region;
    let say = `So ${owns(city)} streets stay gray. TireTrail has ${covers(R)} so far.`;
    if (a.nearest) say += ` Nearest street with an answer: ${streetOf(this.app, a.nearest)}, ${far(nearestOnPolyline(p, a.nearest.line).d)} away.`;
    this.card({
      key: `city:${city}:${p.join(',')}`, icon: ICON.city(), color: CAT.unknown, name: a.road || city, place: a.road ? city : '', chip: 'NOT ADDED YET', gray: true,
      head: `TireTrail doesn't have ${owns(city)} pipe map yet.`, line: say,
      buttons: [a.nearest ? btn('Go to the nearest street', () => this.pick(a.nearest!)) : null, btn('Where TireTrail works', () => this.showWorks())],
    });
  }

  private roadCard(a: Extract<Answer, { kind: 'road' }>, p: XY): void {
    const nm = a.road.name, near = a.nearest;
    let say = nm ? '' : 'It may be a private road or driveway.';
    if (near) say += `${say ? ' ' : ''}Nearest street with an answer: ${streetOf(this.app, near)}, ${far(nearestOnPolyline(p, near.line).d)} away.`;
    if (a.road.pts) this.stretch = [flat(a.road.pts)];
    const label = near && this.app.world.pieceNames[near.piece];
    this.card({
      key: `road:${nm}:${p.join(',')}`, icon: ICON.q(), color: CAT.unknown, name: nm || 'This road', place: this.placeName(p), chip: 'NO PIPE DATA', gray: true,
      head: nm ? `${nm} isn't in the pipe map TireTrail uses.` : "This road isn't in the pipe map TireTrail uses.", line: say,
      buttons: [near ? btn(label ? `Show ${label}` : 'Show that street', () => this.pick(near)) : null],
    });
  }

  private drainCard(a: Extract<Answer, { kind: 'drain' }>, p: XY, fly: boolean): void {
    const app = this.app, o = drainOutcome(app, a.drain), near = a.near;
    const street = near ? app.world.pieceNames[near.piece] : '';
    const t = this.tripOf(a.drain);
    [this.trip, this.tags] = [t.trip, [t.dest, t.drain, t.pond, t.pipe].filter((x): x is Tag => !!x).slice(0, app.layout === 'phone' ? 3 : 5)];
    this.card({
      key: `drain:${a.drain}`, icon: clsIcon(o.cls), color: KIND[o.cls].color, name: street ? `Near ${street}` : this.placeName(p), place: street ? app.placeOf(near!.i) : '',
      chip: KIND[o.cls].chip, gray: isGray(o.cls),
      head: `A storm drain is mapped right here. ${drainLine(o)}`,
      line: `This spot isn't on the street map, so TireTrail used the drain ${feet(Math.max(3, a.d))} away.`,
      buttons: [o.lengthM >= 2 || o.cls !== 'unknown' ? btn(play('See it happen'), () => this.watchDrain(a.drain, near, o), true) : null],
    });
    if (fly) this.fit([...t.trip.path, ...(t.trip.water ? [t.trip.water] : []), p]);
  }

  private farCard(a: Extract<Answer, { kind: 'far' }>, p: XY): void {
    const near = a.nearest;
    this.card({
      key: `far:${p.join(',')}`, icon: ICON.q(), color: CAT.unknown, name: this.placeName(p) || 'Here', place: '', chip: 'NOT TRACED YET', gray: true,
      head: 'No street TireTrail can trace is close to here.',
      line: near ? `The nearest is ${streetOf(this.app, near)}, ${far(nearestOnPolyline(p, near.line).d)} away.` : '',
      buttons: [near ? btn('Go there', () => this.pick(near)) : null],
    });
  }

  private outsideCard(a: Extract<Answer, { kind: 'outside' }>): void {
    this.card({
      key: `outside:${a.county}`, icon: ICON.q(), color: CAT.unknown, name: a.county ? `${a.county} County` : 'Washington', place: '', chip: 'NOT TRACED YET', gray: true,
      head: "TireTrail hasn't traced this area yet.",
      line: `It covers the yellow areas on the zoomed-out map: ${covers(this.app.region)} so far.`,
      buttons: [btn('Show where TireTrail works', () => this.showWorks())],
    });
  }

  private loadingCard(p: XY | null, failed: boolean): void {
    const place = p ? this.placeName(p) : '';
    this.card({
      key: `${failed ? 'failed' : 'loading'}:${p?.join(',')}`, icon: failed ? ICON.q() : ICON.drop(), color: CAT.unknown, name: place || 'Streets here', place: '', chip: '', gray: true,
      head: failed ? "Couldn't load this area." : 'Loading streets here…',
      line: failed ? 'Check your connection and try again.' : 'This takes a moment the first time.',
      buttons: [failed && p ? btn('Try again', () => this.answerAt(p, false), true) : null],
    });
  }

  /** Flies out to the traced areas, as on the zoomed-out map. */
  private showWorks(): void {
    const app = this.app, R = app.region;
    this.toIdle();
    const box = R?.coverage ? R.toWorld(R.coverage).box : null;
    const c: XY = box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : app.home;
    app.camera.follow();
    app.camera.flyTo(app.camAt(c, 120), 900);
  }

  // ---------- the picked street: stretch, trip and tags ----------

  private clearPick(): void {
    this.sel = null;
    this.stretch = this.trip = this.tags = this.lit = null;
  }

  private select(run: Run, at: XY | null): void {
    const app = this.app, w = app.world;
    this.sel = run;
    this.stretch = w.stretchOf(run).map((r) => r.line);
    const name = w.pieceNames[run.piece] || '';
    const street: Tag | null = name ? { at: at ? nearestOnPolyline(at, run.line).point : midOf(run), text: name, tone: 'street' } : null;
    const t = run.drain === null ? null : this.tripOf(run.drain);
    this.trip = t?.trip ?? null;
    const tags = t ? [t.dest, street, t.drain, t.pond, t.pipe] : [street];
    this.tags = tags.filter((x): x is Tag => !!x).slice(0, app.layout === 'phone' ? 3 : 5);
  }

  /** Points the camera should show for the picked street. */
  private pickPoints(): XY[] {
    const pts: XY[] = [];
    for (const l of this.stretch ?? []) pts.push(...l);
    if (this.trip) { pts.push(...this.trip.path); if (this.trip.water) pts.push(this.trip.water); }
    return pts;
  }

  private tripOf(drain: number): { trip: Trip; dest: Tag; drain: Tag; pond: Tag | null; pipe: Tag | null } {
    const app = this.app, w = app.world, b = app.data.bundle, phone = app.layout === 'phone';
    const d = app.data.drain(drain), cls = w.drainCls(drain), path = app.data.path(drain);
    const pts = path.coords.map((c) => w.toWorld(c));
    const E = pts[pts.length - 1];
    let pipes = 0, ditches = 0, fac: { at: XY; pond: boolean } | null = null;
    for (const k of decodePath(b, drain).slice(1)) {
      const kind = KINDS[b.assets.kind[k]];
      if (kind === 'pipe') pipes++;
      else if (kind === 'channel') ditches++;
      else if (!fac && (kind === 'pond' || kind === 'vault')) fac = { at: w.toWorld(app.data.geometry(k)[0]), pond: kind === 'pond' };
    }
    const viaPond = /^pond-to-(creek|elsewhere)/.test(d.code);
    const water = cls === 'creek' || cls === 'elsewhere' ? w.nearestWater(E, viaPond ? 160 : 40) : null;
    const end: Trip['end'] = viaPond ? 'pond' : cls === 'creek' ? 'salmon' : cls === 'elsewhere' ? 'ripple' : cls === 'ground' ? 'soak' : cls === 'treatment' ? 'plant' : 'gap';
    const trip: Trip = { path: pts, cls, end, water, pond: viaPond ? E : null };
    const r = d.receiving;
    const dest: Tag = cls === 'creek' ? { at: water ?? E, text: creekTag(r), tone: 'creek', fish: true }
      : cls === 'elsewhere' ? { at: water ?? E, text: otherTag(r), tone: 'other' }
        : cls === 'ground' ? { at: E, text: 'soaks in here', tone: 'soak' }
          : cls === 'treatment' ? { at: E, text: 'to a treatment plant', tone: 'treatment' }
            : { at: E, text: 'map stops here', tone: 'gap' };
    const pond: Tag | null = fac ? { at: fac.at, text: fac.pond ? 'pond' : phone ? 'tank' : 'underground tank', tone: 'pond' } : null;
    const pipe: Tag | null = path.lengthM >= 10 ? { at: pointAlong(pts, path.lengthM / 2), text: phone ? 'pipes' : ditches > pipes ? 'roadside ditch' : 'pipes under the street', tone: 'pipe' } : null;
    return { trip, dest, drain: { at: pts[0], text: phone ? 'drain' : 'storm drain', tone: 'drain' }, pond, pipe };
  }

  /** The traced streets whose rain ends in this water (or a stream that feeds it). */
  private drainsTo(name: string): { streets: number; runs: Set<number> } {
    const key = name.toLowerCase().trim();
    let n = this.toWater.get(key);
    if (!n) {
      const app = this.app, b = app.data.bundle, w = app.world, seen = new Set<string>(), runs = new Set<number>();
      for (const r of w.runs) {
        if (r.drain === null || r.k === 3 || r.k === 4) continue;
        const rec = b.endings[b.drains.ending[r.drain]].receiving.toLowerCase().trim();
        if (!rec || !(rec === key || rec.startsWith(`${key} tributary`) || rec.split('/').some((s) => s.trim() === key))) continue;
        seen.add(`${w.pieceNames[r.piece]}|${app.placeOf(r.i)}`);
        runs.add(r.i);
      }
      this.toWater.set(key, (n = { streets: seen.size, runs }));
    }
    return n;
  }

  /** The place a spot belongs to: the nearest street's place, the city, or the county. */
  private placeName(p: XY): string {
    const app = this.app, near = runWithin(app.world, p, 400);
    if (near) return app.placeOf(near.i);
    const pl = app.region?.placeAt(p);
    return pl ? pl.name : countyName(app.region, p);
  }

  /** Fits the points in the open part of the map, unless they already show. */
  private fit(pts: XY[]): void {
    if (!pts.length) return;
    const app = this.app, r = app.renderer, cam = app.camera.cam;
    const left = this.cardLeft(), right = app.layout === 'phone' ? 56 : 0;
    const top = (app.focusY * r.AH - app.bandH / 2) * S, bot = (app.focusY * r.AH + app.bandH / 2) * S;
    const shows = pts.every((q) => {
      const [x, y] = r.toScreen(cam, q);
      return x >= left + 24 && x <= r.AW * S - right - 24 && y >= top + 24 && y <= bot - 24;
    });
    if (shows) return;
    const bb = bboxOf(pts);
    const W = r.AW - (left + right) / S - 24, H = app.bandH - 36;
    const mpp = Math.min(FIT_MAX, Math.max(FIT_MIN, (bb.maxX - bb.minX) / Math.max(10, W), (bb.maxY - bb.minY) / Math.max(10, H)));
    app.camera.follow();
    app.camera.flyTo(app.camAt([(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2], mpp), 800);
  }

  // ---------- see it happen ----------

  private watch(run: Run): void {
    if (run.drain === null) return;
    const app = this.app, name = app.world.pieceNames[run.piece] || 'this street';
    this.view = 'watch';
    this.level(2);
    this.player.start({ drain: run.drain, street: run.line, name, end: () => this.closingCard(runOutcome(app, run), name) });
  }

  private watchDrain(drain: number, near: Run | null, o: Outcome): void {
    const app = this.app, name = (near && app.world.pieceNames[near.piece]) || 'this spot';
    this.view = 'watch';
    this.level(2);
    this.player.start({ drain, street: near?.line ?? null, name, end: () => this.closingCard(o, name) });
  }

  private closingCard(o: Outcome, street: string): Node {
    return closingEl(o, street, () => this.close(), () => this.player.replay());
  }

  frame(now: number): FrameOut {
    if (this.intro) return { scene: { tapMark: this.mark }, cam: this.intro.frame(now) };
    if (this.mark && now - this.mark.t0 > 1500) this.mark = null;
    const f = this.player.frame(now);
    if (f) return { ...f, scene: { ...f.scene, tapMark: this.mark } };
    if (this.coachNext && !this.app.camera.flying) {
      this.coachNext = false;
      if (this.view === 'idle' && !this.coach) this.startCoach();
    }
    this.coach?.frame();
    if (this.view === 'idle' && now - this.tickAt > 250) {
      this.tickAt = now;
      this.idleCaption();
      if (!this.coach) this.fillKey();
    }
    return { scene: { highlight: null, flash: 0, stretch: this.stretch, trip: this.trip, tags: this.tags, tapMark: this.mark, focusRuns: this.lit } };
  }
}

function btn(label: string | (Node | string)[], fn: () => void, main = false): HTMLElement {
  return h(`button.btn.${main ? 'main' : 'quiet'}.mu-btn`, { onclick: fn }, ...(typeof label === 'string' ? [label] : label));
}

/** "▶ See it happen", with the glyph hidden from screen readers. */
const play = (label: string): (Node | string)[] => [h('span', { 'aria-hidden': 'true' }, '▶'), ` ${label}`];

const streetOf = (app: App, run: Run): string => app.world.pieceNames[run.piece] || 'an unnamed street';

function said(app: App, a: Answer): Said {
  switch (a.kind) {
    case 'street': case 'near': return { kind: a.kind, cls: CLS[a.run.k], name: app.world.pieceNames[a.run.piece] };
    case 'water': return { kind: 'water', name: a.name };
    case 'city': return { kind: 'city', name: a.place.name };
    case 'road': return { kind: 'road', name: a.road.name };
    case 'drain': return { kind: 'drain', cls: app.world.drainCls(a.drain) };
    case 'outside': return { kind: 'outside', name: a.county ?? '' };
    default: return { kind: a.kind };
  }
}

function creekTag(r: string): string {
  const s = r.trim();
  if (!s || /^fennel creek$/i.test(s)) return 'Fennel Creek';
  if (/^fennel creek tributary/i.test(s)) return 'stream to Fennel Creek';
  if (/unnamed/i.test(s)) return 'salmon stream';
  const t = /^(.+?)\s+tributary\b/i.exec(s);
  return t ? `stream to ${t[1]}` : s;
}

function otherTag(r: string): string {
  const s = r.trim();
  if (!s) return 'other water';
  const t = /^(.+?)\s+tributary\b/i.exec(s);
  if (t) return `stream to ${t[1]}`;
  if (/unnamed/i.test(s)) return /lake|pond/i.test(s) ? 'small pond' : 'small stream';
  return cap(s.replace(/\s*\/\s*/g, ' and '));
}

/** x, y pairs to points. */
function flat(f: Float32Array): XY[] {
  const out: XY[] = [];
  for (let k = 0; k + 1 < f.length; k += 2) out.push([f[k], f[k + 1]]);
  return out;
}

// phones show the short legend once a first answer has been seen
const keyMini = (): boolean => { try { return localStorage.getItem('tt-key') === 'mini'; } catch { return false; } };
const setKeyMini = (): void => { try { localStorage.setItem('tt-key', 'mini'); } catch { /* storage blocked */ } };

