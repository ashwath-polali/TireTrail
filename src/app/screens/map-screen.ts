// Map tab: every street colored by where its rain goes. Every tap gets a short card: where the rain goes,
// why it matters, and what you can do.
/// <reference types="vite/client" />
import './map-ui.css';
import { decodePath, KINDS } from '../../data/bundle.ts';
import { bboxOf, nearestOnPolyline, pointAlong, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { esc, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { swatchSVG, type Band, type Swatch } from '../map/palette.ts';
import { S, type Tag, type Trip } from '../map/render.ts';
import { CLS, type Run } from '../map/world.ts';
import { button, glyph, insight, stagger, type Tone } from '../ui/ui.ts';
import { Coach, coachSeen } from './coach.ts';
import {
  cap, cardHead, clsIcon, cohoSay, countyName, covers, destWords, doLine, drainOutcome, endingEl, ends, far, feet, hasStep, headEl, headline,
  KIND, midOf, mineText, nearLine, owns, plainWater, roadName, runOutcome, scrolls, tapWord, todo, touching, why, type Outcome,
} from './common.ts';
import { Intro, introSeen } from './intro.ts';
import { Player } from './player.ts';
import { cohoHere, noteCityWaters, resolve, runWithin, type Answer, type TapState } from './resolve.ts';
import { driveSummaries } from './saved.ts';
import { shorten, StreetIndex } from './streets.ts';

/** What the last tap answered, for tests and the live region. */
export interface Said { kind: string; cls?: string; name?: string }

type Shown = Answer | { kind: 'failed'; box: Box };
type View = 'idle' | 'card' | 'help' | 'watch';

/** One card: its label and color, the headline, why it matters, what to do, and its keys. */
interface Card {
  key: string;
  tone: Tone;
  kicker: string;
  head: string;
  /** words of the headline to color */
  dest?: string;
  /** caption: icon, name, place */
  icon: string;
  name: string;
  place: string;
  note?: string;
  /** why it matters; keep: the second line stays on phones too (else only laptops show it) */
  why?: { glyph: string; title: string; body?: string; keep?: boolean };
  todo?: string;
  /** the pixel icon before the todo line: a brake for braking, a pin for going somewhere */
  todoIcon?: string;
  /** your drives here, said with what to do; it takes the todo line's place */
  mine?: { text: string; tone: Tone; icon: string } | null;
  /** anything else, under the note (the loading blocks) */
  extra?: HTMLElement | null;
  buttons: (HTMLElement | null)[];
}

const FIT_MIN = 1.2, FIT_MAX = 12;
const KILLS = 'A chemical in tire dust can kill them within hours of a storm.';

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
  private statusEl: HTMLElement | null = null;
  private tickAt = 0;
  private waiting: { id: string; t: number } | null = null;
  /** a status that wins over the idle one for a while (loading a far street, or why it failed) */
  private note: { key: string; say: string; until: number } | null = null;
  private readonly toWater = new Map<string, { streets: number; runs: Set<number> }>();
  private readonly boxCounty = new Map<string, string>();
  /** streets lit up for a water card */
  private lit: Set<number> | null = null;
  private treatment: boolean | null = null;
  /** the search bar on top of the plain map */
  private find: { root: HTMLElement; input: HTMLInputElement; list: HTMLElement; fill: () => Promise<void> } | null = null;
  /** saved drives as map points, kept while the saved list doesn't change */
  private tracks: { raw: string; pts: XY[][] } | null = null;

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
    noteCityWaters(app.world);
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
    this.showFind(false);
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
    this.showFind(false);
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

  // ---------- the plain map: search on top, the one prompt and the legend below ----------

  idle(): void {
    const app = this.app;
    this.view = 'idle';
    this.shown = null;
    this.clearPick();
    this.player.stop();
    this.keyKey = '';
    this.tickAt = 0;
    this.keyEl = h('div.mu-key');
    this.statusEl = h('p.mu-status', { 'aria-live': 'polite' });
    this.fillKey();
    const help = h('button.u-btn.u-secondary.u-square.mu-q', { type: 'button', 'aria-label': 'How to read this map', title: 'How to read this map', onclick: () => this.openHelp(), html: ICON.help() });
    app.setPanel(stagger(h('div.u-sheet.mu-sheet.mu-explore', {},
      h('div.mu-head', {}, h('div.mu-titles', {}, h('p.mu-kicker', {}, 'EXPLORE'), this.statusEl), help),
      this.keyEl)));
    this.showFind(true);
    this.idleCaption();
  }

  /** The search bar: on the map's top edge, in the caption's place, with "Use my location" inside it. */
  private showFind(on: boolean): void {
    const app = this.app, stage = app.caption.parentElement;
    stage?.classList.toggle('mu-finding', on);
    if (!on) {
      if (this.find) { this.find.root.hidden = true; this.find.list.replaceChildren(); }
      return;
    }
    if (!this.find) this.find = this.makeFind();
    if (stage && !this.find.root.isConnected) stage.append(this.find.root);
    this.find.root.hidden = false;
  }

  /** Closes the list under the search bar (a tap on the map, or a pick). */
  private closeFind(clear: boolean): void {
    if (!this.find) return;
    this.find.list.replaceChildren();
    if (clear) this.find.input.value = this.q = '';
  }

  private makeFind(): NonNullable<MapScreen['find']> {
    const app = this.app;
    const input = h('input.mu-input', { type: 'search', placeholder: 'Find your street, like 214th Ave E', value: this.q, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Find a street' }) as HTMLInputElement;
    const list = h('ul.mu-suggest', { 'aria-label': 'Streets' });
    let ask = 0;
    const row = (name: string, place: string, go: () => void) => h('li', {}, h('button', { type: 'button', onclick: go }, h('span.mu-sname', {}, name), h('span.mu-splace', {}, place)));
    const fill = async () => {
      this.q = input.value;
      const mine = ++ask, q = this.q.trim();
      const hits = this.index.search(q, 5);
      const rows = hits.map((hit) => row(hit.name, this.placeLine(hit.key, hit.place), () => { const r = this.index.main(hit.key); if (r) this.pick(r); }));
      list.replaceChildren(...rows);
      if (!q) return;
      // the rest of the county, loaded only when picked
      let more: Awaited<ReturnType<App['areas']['findStreet']>> = [], failed = false;
      try { more = await app.areas.findStreet(shorten(q), 6 - rows.length); failed = await this.namesFailed(); } catch { failed = true; }
      if (mine !== ask) return;
      const have = new Set(hits.map((hit) => hit.key));
      for (const m of more) if (!have.has(`${m.name}|${m.place}`)) rows.push(row(m.name, this.boxLine(m.place, m.area.bbox), () => void this.openFar(m.name, m.place, m.area.bbox)));
      list.replaceChildren(...rows);
      if (!rows.length) {
        list.replaceChildren(h('li.mu-none', {}, failed
          ? "Couldn't search the county right now. Check your connection and try again."
          : `No street called "${q}" in TireTrail yet. It has ${covers(app.region)} so far.`));
      }
    };
    input.addEventListener('input', () => void fill());
    // the list comes back when the box is used again, not on its own
    input.addEventListener('focus', () => { if (input.value.trim()) void fill(); });
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') (list.querySelector('button') as HTMLButtonElement | null)?.click(); });
    const here = h('button.mu-loc', { type: 'button', 'aria-label': 'Use my location', title: 'Use my location', onclick: () => this.locate(), html: glyph('locate') });
    const root = h('div.mu-find', { role: 'search' },
      h('div.mu-findbar', {}, h('span.mu-findico', { 'aria-hidden': 'true', html: glyph('search') }), input, here),
      list);
    return { root, input, list, fill };
  }

  /** A message under the search bar. */
  private findSay(m: string): void {
    if (!this.find) return;
    this.find.list.replaceChildren(h('li.mu-none', {}, m));
  }

  /** Finds the street nearest the person and opens its card. */
  private locate(): void {
    const app = this.app;
    const say = (m: string) => this.findSay(m);
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

  /** For a county area not loaded yet: the county holding most of its traced streets. */
  private boxLine(place: string, b: Box): string {
    const app = this.app, R = app.region, key = b.join(',');
    let c = this.boxCounty.get(key);
    if (c === undefined) {
      const votes = new Map<string, number>();
      for (let i = 0; R && i < 5; i++) for (let j = 0; j < 5; j++) {
        const p = app.world.toWorld([b[0] + ((b[2] - b[0]) * (i + .5)) / 5, b[1] + ((b[3] - b[1]) * (j + .5)) / 5]);
        const co = R.inCoverage(p) ? R.countyAt(p) : null;
        if (co) votes.set(co.name, (votes.get(co.name) ?? 0) + 1);
      }
      const top = [...votes.entries()].sort((x, y) => y[1] - x[1])[0];
      c = top ? `${top[0]} County` : countyName(R, app.world.toWorld([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]));
      this.boxCounty.set(key, c);
    }
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
    this.say(`loading:${place}`, `Loading ${place}…`, 30000);
    try { await app.ensureAreas(bbox, 1); } catch { /* said below */ }
    this.note = null;
    // a newer pick, or another tab, wins
    if (mine !== this.pickSeq || app.tab !== 'map') return;
    const key = this.index.main(`${name}|${place}`) ? `${name}|${place}` : this.index.search(name, 20).find((hit) => hit.name === name)?.key;
    const r = key ? this.index.main(key) : null;
    if (r) { this.pick(r, false); return; }
    const msg = `Couldn't load ${place}. Check your connection and try again.`;
    this.say(`loadfail:${place}`, msg, 8000);
    this.findSay(msg);
  }

  /** Opens a street's card from a list, then moves focus to its heading. */
  private pick(run: Run, bump = true): void {
    if (bump) this.pickSeq++;
    this.closeFind(true);
    this.show({ kind: 'street', run }, null);
    (this.app.panel.querySelector('.mu-h') as HTMLElement | null)?.focus();
  }

  /** Shows a status over the idle one for ms. */
  private say(key: string, text: string, ms: number): void {
    this.note = { key, say: text, until: this.app.now() + ms };
    this.idleCaption();
  }

  /** The one prompt on the plain map, or why there is nothing to tap here. */
  private idleCaption(): void {
    const app = this.app, R = app.region, m = app.camera.cam.mpp, T = tapWord(app);
    const n = this.note;
    let say = `${T} any street to see where its rain goes.`;
    if (n && app.now() < n.until) say = n.say;
    else if (m > 24) say = 'Zoom in on a yellow area to see its streets.';
    else if (this.loadingView()) say = 'Loading streets here…';
    else {
      const c = this.bandMid(), pl = R?.placeAt(c), co = R?.countyAt(c);
      if (pl && !R!.isMapped(pl)) say = `${owns(pl.name)} pipe map isn't in TireTrail yet, so its streets stay gray.`;
      else if (R && (!co || !R.covered(co))) say = "TireTrail hasn't traced this area yet. Zoom out to see where it works.";
      else if (this.noMap()) say = 'No street map here yet. Zoom out to see where TireTrail works.';
    }
    const el = this.statusEl;
    if (el && el.textContent !== say) el.textContent = say;
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
    const striped = m > 24 || this.stripedInView(), plant = this.hasTreatment();
    const key = [band, m > 24, striped, plant, phone].join('|');
    if (key === this.keyKey) return;
    this.keyKey = key;
    let rows: HTMLElement[];
    if (m > 24) rows = [legendRow('traced', 'region', 'Traced by TireTrail'), legendRow('hatch', 'region', 'City pipe map not added yet')];
    else if (phone) {
      rows = [legendRow('creek', band, 'Salmon stream'), legendRow('ground', band, 'Soaks in'), legendRow('elsewhere', band, 'Other water')];
      if (plant) rows.push(legendRow('treatment', band, 'Treatment plant'));
      rows.push(legendRow('none', band, 'No answer yet'));
    } else {
      rows = [legendRow('creek', band, 'Goes to a salmon stream'), legendRow('ground', band, 'Soaks into the ground'), legendRow('elsewhere', band, 'Goes to other water, like a lake')];
      if (plant) rows.push(legendRow('treatment', band, 'Goes to a sewage treatment plant'));
      rows.push(legendRow('none', band, `No answer yet. ${tapWord(app)} to see why.`));
      if (m <= 2.6) rows.push(legendRow('drain', 'town', 'Storm drain'));
      if (striped) rows.push(legendRow('hatch', band, 'City pipe map not added yet'));
    }
    el.replaceChildren(h('div.mu-legend', { role: 'list', 'aria-label': 'Where the rain goes' }, ...rows));
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
    // the coach's step carries over to the sheet
    if (this.coach) this.stopCoach();
    this.level(1);
    this.help();
  }

  private help(): void {
    const app = this.app, T = tapWord(app);
    this.view = 'help';
    this.shown = null;
    this.clearPick();
    this.showFind(false);
    const m = app.camera.cam.mpp, band: Band = m <= 2.6 ? 'town' : m <= 12 || m > 24 ? 'overview' : 'region';
    const rows = [legendRow('creek', band, 'Goes to a salmon stream'), legendRow('ground', band, 'Soaks into the ground'), legendRow('elsewhere', band, 'Goes to other water, like a lake')];
    if (this.hasTreatment()) rows.push(legendRow('treatment', band, 'Goes to a sewage treatment plant'));
    rows.push(legendRow('none', band, `No answer yet. ${T} to see why.`),
      legendRow('stream', 'overview', 'Creek or stream'), legendRow('coho', 'overview', 'Salmon stream'), legendRow('drain', 'town', 'Storm drain (zoomed in)'),
      legendRow('hatch', 'overview', 'City pipe map not added yet'), legendRow('traced', 'region', 'Traced by TireTrail (zoomed out)'), legendRow('pick', 'overview', 'The street you picked'));
    app.setCaption('help', ICON.drop(), `<span class="say">${T} any street to see where its rain goes.</span>`);
    app.setPanel(stagger(h('div.u-sheet.mu-sheet.mu-help', {},
      cardHead('HOW TO READ THIS MAP', 'plain', headEl("Each street's color shows where its rain ends up."), () => this.close()),
      h('p.u-body', {}, 'Rain washes tire dust off roads into storm drains and roadside ditches. TireTrail follows the pipe maps to see where it goes.'),
      h('div.mu-legend.mu-all', { role: 'list', 'aria-label': 'Map key' }, ...rows),
      h('p.u-body', {}, "Gray doesn't mean a street is good or bad. It means TireTrail can't follow its rain yet, usually because the pipe map has a gap or no drain is mapped there."),
      h('div.mu-acts', {}, button('Show me how', { kind: 'primary', icon: 'play', onClick: () => this.replayCoach() }), button('Close', { kind: 'secondary', onClick: () => this.close() })),
      h('div.mu-more', {},
        button('Where the city could filter the water', { kind: 'ghost', icon: 'arrow', onClick: () => app.setTab('fix') }),
        app.region ? button('Watch the opening again', { kind: 'ghost', icon: 'play', onClick: () => this.playIntro() }) : null))));
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
    this.closeFind(false);
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
    // a search pick ends the coach too; its step carries over to the card
    if (this.coach) this.stopCoach();
    this.note = null;
    this.view = 'card';
    this.level(1);
    this.shown = { a, p };
    this.render(true);
  }

  /** Draws the open card; fly moves the camera to it. */
  private render(fly: boolean): void {
    const s = this.shown;
    if (!s) return;
    const a = s.a, p = s.p;
    this.clearPick();
    this.showFind(false);
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

  /** Puts a card in the panel and its name in the caption. */
  private card(c: Card): void {
    const app = this.app;
    const place = c.place === c.name ? '' : c.place;
    // the panel adds the headline for screen readers
    app.setCaption(`card:${c.key}`, c.icon, `<span class="say"><b>${esc(c.name || place)}</b>${c.name && place ? `<span class="mu-cplace"> · ${esc(place)}</span>` : ''}</span>`);
    const btns = c.buttons.filter((b): b is HTMLElement => b !== null);
    const why = c.why ? insight({ icon: c.why.glyph, tone: c.tone, title: c.why.title, body: c.why.body || undefined }) : null;
    if (why && !c.why!.keep) why.classList.add('mu-opt');
    const mine = c.mine ? doLine(c.mine.text, c.mine.icon) : null;
    if (mine) { mine.classList.add('mu-mine'); mine.dataset.tone = c.mine!.tone; }
    const sheet = h('div.u-sheet.mu-sheet', { 'data-tone': c.tone },
      cardHead(c.kicker, c.tone, headEl(c.head, c.dest ?? ''), () => this.close()),
      c.note ? h('p.mu-note', {}, c.note) : null,
      c.extra ?? null,
      why,
      mine ?? (c.todo ? doLine(c.todo, c.todoIcon) : null),
      btns.length ? h('div.mu-acts', {}, ...btns) : null);
    app.setPanel(stagger(sheet));
    scrolls(sheet);
  }

  private streetCard(run: Run, p: XY | null, nearD: number | null, fly: boolean): void {
    const app = this.app, w = app.world;
    const name = w.pieceNames[run.piece] || '', place = app.placeOf(run.i);
    const o = runOutcome(app, run), cls = o.cls, k = KIND[cls] ?? KIND.unknown;
    this.select(run, p);
    const near = nearD !== null;
    const head = near ? nearLine(o, name || 'that street') : headline(o);
    const wy = why(o);
    const watchable = run.drain !== null && !(cls === 'unknown' && o.lengthM < 10);
    const nearer = cls === 'none' && !near ? runWithin(w, midOf(run), 300, (r) => r !== run && r.drain !== null && [0, 1, 2, 5].includes(r.k)) : null;
    this.card({
      key: `street:${run.i}:${near ? 'near' : ''}`, tone: k.tone, kicker: k.chip, head, dest: destWords(o),
      icon: clsIcon(cls), name: near ? `Near ${name || 'a street'}` : name || 'This street', place,
      why: { glyph: k.glyph, title: wy.title, body: wy.body, keep: cls === 'creek' },
      todo: todo(o, name),
      mine: this.mineLine(run),
      buttons: [
        watchable ? button(cls === 'unknown' && o.code !== 'discharge-probable' ? 'Follow the rain' : 'See it happen', { kind: 'primary', icon: 'play', onClick: () => this.watch(run) }) : null,
        button('More details', { kind: watchable ? 'secondary' : 'primary', onClick: () => app.screens.street.open(run) }),
        nearer ? button('Try a nearby street', { kind: 'secondary', onClick: () => this.pick(nearer) }) : null,
      ],
    });
    if (fly) this.fit([...this.pickPoints(), ...(near && p ? [p] : [])]);
  }

  private waterCard(a: Extract<Answer, { kind: 'water' }>, p: XY): void {
    const app = this.app, w = app.world, raw = a.name.trim(), lake = !a.water || !!a.water.ring;
    const known = !!raw && (!/unnamed/i.test(raw) || /tributary/i.test(raw));
    const T = tapWord(app);
    const to = known ? this.drainsTo(raw) : null, n = to?.streets ?? 0;
    const streets = `${n} traced ${n === 1 ? 'street sends its' : 'streets send their'} rain here.`;
    const show = () => { const pts: XY[] = []; for (const i of to!.runs) pts.push(...w.runs[i].line); this.fit(pts); };
    const showKey = n ? button(n === 1 ? 'Show that street' : 'Show those streets', { kind: 'primary', icon: 'route', onClick: show }) : null;
    this.lit = n ? to!.runs : null;
    const base = { key: `water:${raw}:${p.join(',')}`, place: this.placeName(p) };
    if (a.coho) {
      const c = a.water ? cohoHere(w, a.water) : 'here';
      const title = c === 'spawn' ? 'Coho salmon spawn in its lower reach, a few miles downstream.' : c === 'along' ? 'WDFW records coho salmon in other parts of this stream.' : 'WDFW records coho salmon here.';
      const nm = known ? plainWater(raw) : 'a salmon stream';
      this.card({
        ...base, tone: 'salmon', kicker: 'SALMON STREAM', head: `This is ${nm}.`, dest: nm, icon: ICON.fish(), name: known ? cap(nm) : 'Salmon stream',
        why: { glyph: 'fish', title, body: KILLS, keep: true },
        todo: n ? `${streets} Brake gently on ${n === 1 ? 'it' : 'them'}.` : 'Brake gently on streets nearby.',
        buttons: [showKey],
      });
      return;
    }
    if (known) {
      const nm = plainWater(raw);
      this.card({
        ...base, tone: 'other', kicker: lake ? 'LAKE' : 'STREAM', head: `This is ${nm}.`, dest: nm, icon: ICON.waves(), name: cap(nm),
        why: { glyph: 'wave', title: n ? `Rain from ${n} traced ${n === 1 ? 'street' : 'streets'} drains here.` : 'None of the streets TireTrail has traced drain here.', body: n ? `They're lit up on the map.` : `${T} a street to see where its rain goes.` },
        buttons: [showKey],
      });
      return;
    }
    this.card({
      ...base, tone: 'other', kicker: lake ? 'POND' : 'STREAM', head: lake ? 'A pond or small lake.' : 'A small stream.', icon: ICON.waves(), name: lake ? 'Pond or small lake' : 'Small stream',
      why: { glyph: 'wave', title: 'It has no name on the map.', body: `${T} a street to see where its rain goes.` },
      buttons: [],
    });
  }

  private cityCard(a: Extract<Answer, { kind: 'city' }>, p: XY): void {
    const city = a.place.name, R = this.app.region, near = a.nearest;
    this.card({
      key: `city:${city}:${p.join(',')}`, tone: 'plain', kicker: 'NOT ADDED YET', icon: ICON.city(), name: a.road ? roadName(a.road) : city, place: a.road ? city : '',
      head: `TireTrail doesn't have ${owns(city)} pipe map yet.`,
      why: { glyph: 'info', title: `So ${owns(city)} streets stay gray.`, body: `TireTrail has ${covers(R)} so far.`, keep: true },
      todo: near ? `Nearest street with an answer: ${streetOf(this.app, near)}, ${far(nearestOnPolyline(p, near.line).d)} away.` : '', todoIcon: 'pin',
      buttons: [near ? button('Go there', { kind: 'primary', icon: 'arrow', onClick: () => this.pick(near) }) : null, button('Where it works', { kind: 'secondary', icon: 'map', onClick: () => this.showWorks() })],
    });
  }

  private roadCard(a: Extract<Answer, { kind: 'road' }>, p: XY): void {
    const nm = roadName(a.road.name), near = a.nearest;
    if (a.road.pts) this.stretch = [flat(a.road.pts)];
    const label = near && this.app.world.pieceNames[near.piece];
    this.card({
      key: `road:${nm}:${p.join(',')}`, tone: 'plain', kicker: 'NO PIPE DATA', icon: ICON.q(), name: nm || 'This road', place: this.placeName(p),
      head: nm ? `${nm} isn't in the pipe map TireTrail uses.` : "This road isn't in the pipe map TireTrail uses.",
      why: { glyph: 'info', title: "So TireTrail can't tell where its rain goes.", body: nm ? 'State highways and private roads often aren\'t on city or county pipe maps.' : 'It may be a private road or driveway.' },
      todo: near ? `Nearest street with an answer: ${streetOf(this.app, near)}, ${far(nearestOnPolyline(p, near.line).d)} away.` : '', todoIcon: 'pin',
      buttons: [near ? button(label ? `Show ${label}` : 'Show that street', { kind: 'primary', icon: 'arrow', onClick: () => this.pick(near) }) : null],
    });
  }

  private drainCard(a: Extract<Answer, { kind: 'drain' }>, p: XY, fly: boolean): void {
    const app = this.app, o = drainOutcome(app, a.drain), near = a.near, k = KIND[o.cls] ?? KIND.unknown;
    const street = near ? app.world.pieceNames[near.piece] : '';
    const t = this.tripOf(a.drain);
    [this.trip, this.tags] = [t.trip, [t.dest, t.drain, t.pond, t.pipe].filter((x): x is Tag => !!x).slice(0, app.layout === 'phone' ? 3 : 5)];
    const what = o.ditch ? 'roadside ditch' : 'storm drain';
    const head = o.cls === 'unknown' || o.cls === 'none' ? headline(o) : `Rain at this ${what} ${ends(o)}`;
    const wy = why(o);
    this.card({
      key: `drain:${a.drain}`, tone: k.tone, kicker: k.chip, head, dest: destWords(o), icon: clsIcon(o.cls),
      name: street ? `Near ${street}` : this.placeName(p), place: street ? app.placeOf(near!.i) : '',
      note: `No street here, so TireTrail used the ${what} ${feet(Math.max(3, a.d))} away.`,
      why: { glyph: k.glyph, title: wy.title, body: wy.body, keep: o.cls === 'creek' },
      todo: todo(o, street),
      buttons: [o.lengthM >= 2 || o.cls !== 'unknown' ? button('See it happen', { kind: 'primary', icon: 'play', onClick: () => this.watchDrain(a.drain, near, o) }) : null],
    });
    if (fly) this.fit([...t.trip.path, ...(t.trip.water ? [t.trip.water] : []), p]);
  }

  private farCard(a: Extract<Answer, { kind: 'far' }>, p: XY): void {
    const near = a.nearest;
    this.card({
      key: `far:${p.join(',')}`, tone: 'plain', kicker: 'NOT TRACED YET', icon: ICON.q(), name: this.placeName(p) || 'Here', place: '',
      head: 'No street TireTrail can trace is close to here.',
      why: near ? { glyph: 'pin', title: `The nearest is ${streetOf(this.app, near)}, ${far(nearestOnPolyline(p, near.line).d)} away.` } : undefined,
      buttons: [near ? button('Go there', { kind: 'primary', icon: 'arrow', onClick: () => this.pick(near) }) : null],
    });
  }

  private outsideCard(a: Extract<Answer, { kind: 'outside' }>): void {
    this.card({
      key: `outside:${a.county}`, tone: 'plain', kicker: 'NOT TRACED YET', icon: ICON.q(), name: a.county ? `${a.county} County` : 'Washington', place: '',
      head: "TireTrail hasn't traced this area yet.",
      why: { glyph: 'map', title: `It covers the yellow areas on the zoomed-out map: ${covers(this.app.region)} so far.` },
      buttons: [button('Show where TireTrail works', { kind: 'primary', icon: 'map', onClick: () => this.showWorks() })],
    });
  }

  private loadingCard(p: XY | null, failed: boolean): void {
    const place = p ? this.placeName(p) : '';
    this.card({
      key: `${failed ? 'failed' : 'loading'}:${p?.join(',')}`, tone: 'plain', kicker: failed ? "COULDN'T LOAD" : 'LOADING', icon: failed ? ICON.q() : ICON.drop(), name: place || 'Streets here', place: '',
      head: failed ? "Couldn't load this area." : 'Loading streets here…',
      note: failed ? 'Check your connection and try again.' : 'This takes a moment the first time.',
      extra: failed ? null : h('div.mu-wait', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      buttons: [failed && p ? button('Try again', { kind: 'primary', icon: 'arrow', onClick: () => this.answerAt(p, false) }) : null],
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

  // ---------- your drives on this street ----------

  /** Your saved drives that pass this street, and the ones with a hard brake on it. */
  mineOf(run: Run): { passes: number; hard: number } {
    const w = this.app.world, lines = w.stretchOf(run).map((r) => r.line);
    let brakes: XY[][] = [];
    try { brakes = driveSummaries().map((s) => s.brakes.map((b) => w.toWorld([b.lon, b.lat]))); } catch { /* storage blocked */ }
    return { passes: touching(lines, this.trackPts(), 25), hard: touching(lines, brakes, 30) };
  }

  /** Saved tracks as map points; parsed again only when the saved list changes. */
  private trackPts(): XY[][] {
    let raw = '';
    try { raw = localStorage.getItem('tt-drives') ?? ''; } catch { /* storage blocked */ }
    if (this.tracks?.raw === raw) return this.tracks.pts;
    let pts: XY[][] = [];
    try {
      const list = JSON.parse(raw || '[]') as { fixes?: (number | null)[][] }[];
      const w = this.app.world;
      pts = (Array.isArray(list) ? list : []).map((d) => (Array.isArray(d?.fixes) ? d.fixes : []).filter((f) => f[1] != null && f[2] != null).map((f) => w.toWorld([f[2]!, f[1]!])));
    } catch { /* a damaged list counts as none */ }
    this.tracks = { raw, pts };
    return pts;
  }

  /** Your drives here, with what to do about it: "You braked hard here on 2 drives. Ease off sooner here." */
  private mineLine(run: Run): Card['mine'] {
    const m = mineText(this.mineOf(run));
    if (!m) return null;
    return { ...m, text: `${m.text} ${m.tone === 'warn' ? 'Ease off sooner here.' : 'Brake gently here.'}` };
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
    const o = drainOutcome(app, drain), cls = o.cls, path = app.data.path(drain);
    const pts = path.coords.map((c) => w.toWorld(c));
    const E = pts[pts.length - 1];
    let pipes = 0, ditches = 0, fac: { at: XY; pond: boolean } | null = null;
    const ids = decodePath(b, drain), last = ids[ids.length - 1], viaPond = /^pond-to-(creek|elsewhere)/.test(o.code);
    for (const k of ids.slice(1)) {
      const kind = KINDS[b.assets.kind[k]];
      if (kind === 'pipe') pipes++;
      else if (kind === 'channel') ditches++;
      // a pond the water ends in gets the ending's tag instead
      else if (!fac && (kind === 'pond' || kind === 'vault') && (k !== last || viaPond)) fac = { at: w.toWorld(app.data.geometry(k)[0]), pond: kind === 'pond' };
    }
    const water = cls === 'creek' || cls === 'elsewhere' ? w.nearestWater(E, viaPond ? 160 : 40) : null;
    // a jumping salmon only where WDFW records coho at the water itself; upstream endings get ripples
    const fish = cls === 'creek' && cohoSay(o) === 'here';
    const end: Trip['end'] = viaPond ? 'pond' : cls === 'creek' ? (fish ? 'salmon' : 'ripple') : cls === 'elsewhere' ? 'ripple' : cls === 'ground' ? 'soak' : cls === 'treatment' ? 'plant' : 'gap';
    const trip: Trip = { path: pts, cls, end, water, pond: viaPond ? E : null };
    const r = o.receiving;
    const dest: Tag = cls === 'creek' ? { at: water ?? E, text: creekTag(r), tone: 'creek', fish: fish || undefined }
      : cls === 'elsewhere' ? { at: water ?? E, text: otherTag(r), tone: 'other' }
        : cls === 'ground' ? { at: E, text: 'soaks in here', tone: 'soak' }
          : cls === 'treatment' ? { at: E, text: 'to a treatment plant', tone: 'treatment' }
            : { at: E, text: 'map stops here', tone: 'gap' };
    const pond: Tag | null = fac ? { at: fac.at, text: fac.pond ? 'pond' : phone ? 'tank' : 'underground tank', tone: 'pond' } : null;
    const pipe: Tag | null = path.lengthM >= 10 ? { at: pointAlong(pts, path.lengthM / 2), text: phone ? (ditches > pipes ? 'ditch' : 'pipes') : ditches > pipes ? 'roadside ditch' : 'pipes under the street', tone: 'pipe' } : null;
    const inlet = o.ditch ? (phone ? 'ditch' : 'roadside ditch') : phone ? 'drain' : 'storm drain';
    return { trip, dest, drain: { at: pts[0], text: inlet, tone: 'drain' }, pond, pipe };
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
    this.player.start({ drain: run.drain, street: run.line, name, end: () => this.closingCard(runOutcome(app, run), name, midOf(run)) });
  }

  private watchDrain(drain: number, near: Run | null, o: Outcome): void {
    const app = this.app, name = (near && app.world.pieceNames[near.piece]) || 'this spot';
    this.view = 'watch';
    this.level(2);
    this.player.start({ drain, street: near?.line ?? null, name, end: () => this.closingCard(o, name, app.world.drains[drain]) });
  }

  /** The end of See it happen: where it ends up, why it matters, what to do, and a next step. */
  private closingCard(o: Outcome, street: string, at: XY): Node {
    const app = this.app;
    // after a non-salmon answer, the nearest street whose rain does reach a salmon stream
    const salmon = o.cls === 'creek' ? null : nearestCreek(app, at);
    return endingEl(o, street, {
      done: () => this.close(),
      again: () => this.player.replay(),
      drive: () => { app.setTab('drive'); app.screens.drive.home(); },
      next: salmon ? { label: 'Find a salmon stream', go: () => { this.player.stop(); this.dropTo(1); this.pick(salmon); } } : null,
      art: app.layout === 'laptop',
    });
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

/** One legend row: a swatch drawn like the map, and its words. */
function legendRow(sw: Swatch, b: Band, text: string): HTMLElement {
  return h('div.mu-row', { role: 'listitem' }, h('span.mu-sw', { html: swatchSVG(sw, b) }), h('span.mu-lab', {}, text));
}

/** The nearest street whose rain reaches a salmon stream, looking farther out step by step. */
function nearestCreek(app: App, p: XY): Run | null {
  for (const r of [500, 1500, 4000, 10000]) {
    const run = runWithin(app.world, p, r, (x) => x.k === 0 && x.drain !== null && !!app.world.pieceNames[x.piece]);
    if (run) return run;
  }
  return null;
}

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
