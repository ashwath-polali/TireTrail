// My drives: a home for your drives. The creek scene with a coho for each gentle crossing this week, then the week on a
// real map (routes, a fish on each creek, the bell on your hard-brake spot), what to do next time, the week beyond salmon,
// the drives as plain rows and Share your week. The month, More and All drives close it in one quiet row.
// A drive, a creek or the spot opens on the big map, and My drives stays lit; Back comes to the same place.
// Signed out: the scene, one line, Sign in and the sample.
import type { Spot } from '../../drive/spots.ts';
import { spotsFrom } from '../../drive/spots.ts';
import {
  creekPlaces, creeksFrom, creekTone, monthStart, monthStats, weekAfter, weekBefore, weeksOf, weekStats, type Creek, type Crossing,
} from '../../drive/creeks.ts';
import { weekStart } from '../../drive/gas.ts';
import { routesFrom } from '../../drive/coach/index.ts';
import { driveEnds, nearEnds, pathPoints, type DriveSummary } from '../../drive/summary.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { accountEntry, G_MARK, onPickFile, openAccount } from '../cloud/account.ts';
import { authPhase, onAuth, person, prepare, signIn, type CloudError } from '../cloud/auth.ts';
import { cloudNow } from '../cloud/firebase.ts';
import { fetchRoute, routeInCloud } from '../cloud/sync.ts';
import { signInWords } from '../cloud/words.ts';
import { h } from '../dom.ts';
import { fromSpot, tellCityButton } from '../features/city.ts';
import { shareWeekButton, type WeekFacts } from '../features/share-week.ts';
import { ROUTE } from '../map/palette.ts';
import { button, glyph, stagger, toast } from '../ui/ui.ts';
import { crossMarks, creekSheet, streamOf } from './creek.ts';
import { driveName, loadPlaces } from './drive-names.ts';
import { count } from './drive-words.ts';
import { crossingsOf, findCrossings, needsCrossings } from './history-creeks.ts';
import { Marks, type Mark } from './history-map.ts';
import { creekScene } from './history-scene.ts';
import {
  changeLine, COHO_KEY, creekName, driveCreeks, DUST_WHY, ESTIMATES, heroLine, monthLine, moreLines, PPDQ, progressSub, salmonLine, salmonStops,
  shareHead, signedOutLine, tripNames, tripWords, watchWords, weekLabel, weekMore,
  type DrainAt, type SalmonStops,
} from './history-words.ts';
import { driveSummaries, forgetDrive, trackOf, unpack } from './saved.ts';
import { WeekMap } from './week-map.ts';
import './history.css';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const square = (label: string, icon: string, onclick: () => void, disabled = false) =>
  h('button.u-btn.u-secondary.u-square.my-sq', { type: 'button', 'aria-label': label, title: label, disabled, onclick, html: glyph(icon) });

/** the sample's fish, signed out */
const SAMPLE_FISH = 6;
/** drive rows under the map */
const ROWS = 4;
/** routes on All drives' map */
const ALL_ROUTES = 30;

type View = 'main' | 'all' | 'more' | 'creek';

/** A drive's route for the map: the coarse route kept on this phone, else its track. */
function routeOf(d: DriveSummary): LngLat[] {
  const p = pathPoints(d.path);
  if (p.length > 1) return p;
  const t = trackOf(d.at);
  if (!t) return [];
  const all = t.fixes.map(unpack).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));
  const step = Math.max(1, Math.floor(all.length / 80));
  return all.filter((_, i) => i % step === 0).map((f) => [f.lon, f.lat] as LngLat);
}

const miText = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;

export class HistoryScreen implements Screen {
  private readonly app: App;
  private readonly marks: Marks;
  /** a drive was picked while one is still recording */
  private blocked = false;
  private view: View = 'main';
  /** Monday of the week shown */
  private week = weekStart();
  private creeks: Creek[] = [];
  /** the creek page's creek, and its name for the map to draw strong */
  private creek: Creek | null = null;
  private creekSet: ReadonlySet<string> | null = null;
  /** the creek page's routes: the drives that crossed it */
  private creekRoutes: XY[][] = [];
  private trips = 0;
  /** history steps taken for the pages under this one, so the phone's Back comes back here */
  private steps = 0;
  /** the home's scroll, kept while a page is open over it */
  private scrollY = 0;
  /** a drive or the spot is open on the Drive screen: coming back keeps the week, the page and its scroll */
  private away: { view: View; scroll: number } | null = null;
  private map: WeekMap | null = null;

  constructor(app: App) {
    this.app = app;
    this.marks = new Marks(app);
    // "Add a drive from a file" lives in the account sheet
    onPickFile(() => app.screens.drive.pickFile());
    onAuth(() => { if (this.here) this.render(false); });
    // drives saved, deleted, or back from the backup
    addEventListener('tt:drives', () => { if (this.here) this.render(false); });
    addEventListener('storage', (e) => { if (this.here && e.key === 'tt-sums') this.render(false); });
  }

  private get here(): boolean {
    return this.app.tab === 'drives';
  }

  enter(): void {
    const back = this.away;
    this.away = null;
    if (back) {
      // back from a drive or the spot: the same week, page and place
      this.view = back.view;
      this.render(false);
      requestAnimationFrame(() => { this.app.pageEl.scrollTop = back.scroll; });
      return;
    }
    this.view = 'main';
    this.steps = 0;
    this.scrollY = 0;
    this.week = weekStart();
    this.creek = null;
    this.render(true);
  }

  /** play: a fresh visit, so things slide in, the coho arrive and the routes draw */
  private render(play: boolean): void {
    if (this.view === 'creek' && this.creek && person()) { this.creekPage(); return; }
    this.marks.hide();
    this.map?.destroy();
    this.map = null;
    if (person()) this.signedIn(play);
    else this.signedOut(play);
  }

  /** A page, keeping its scroll on a redraw. */
  private page(el: HTMLElement, play: boolean, keep = false): void {
    const pg = this.app.pageEl, top = pg.scrollTop;
    if (play) stagger(el);
    this.app.showPage(el);
    if (keep) pg.scrollTop = top;
  }

  // ---------- the hero ----------

  /** The creek scene with the week switcher over it. */
  private hero(fish: number, opts: { dim?: boolean; nav?: HTMLElement | null; label: string }): HTMLElement {
    return h('section.my-hero', { 'aria-label': 'This week' },
      h('div.my-scene-box', {}, creekScene({ fish, dim: opts.dim }, opts.label),
        h('div.my-hero-top', {}, opts.nav ?? h('span'), accountEntry('my-acct'))));
  }

  /** The week's one line, and what the coho mean or how it changed. */
  private plate(say: string, sub: string | null, up: boolean): HTMLElement {
    return h('div.my-plate', {}, h('h1.my-say', { tabindex: '-1' }, say),
      sub ? h(up ? 'p.my-change' : 'p.my-key', {}, up ? ico('up', 2) : null, h('span', {}, sub)) : null);
  }

  // ---------- signed out ----------

  private signedOut(play: boolean): void {
    // Google sign-in loads now, so the key can open Google's window straight from the tap
    if (authPhase() === 'idle') void prepare();
    this.creeks = [];
    const key = button('Sign in with Google', { kind: 'primary', icon: G_MARK, wide: true, onClick: () => this.signIn(key) });
    const sample = button('Try the sample drive', { kind: 'secondary', icon: 'play', wide: true, onClick: () => this.sample() });
    this.page(h('div.my.my-out', {},
      this.hero(SAMPLE_FISH, { dim: true, label: 'A creek with sample coho, one for each gentle crossing' }),
      this.plate(signedOutLine(driveSummaries().length), 'Sign in to back them up and see them on any device.', false),
      h('div.my-out-keys', {}, key, sample)), play);
  }

  /** The sample's report on the Drive screen. */
  private sample(): void {
    const app = this.app;
    app.setTab('drive');
    void app.screens.drive.loadSample();
  }

  /** Google's window from the tap once Firebase is in; until then the account sheet loads it and signs in. */
  private signIn(from: HTMLElement): void {
    if (!cloudNow() || authPhase() !== 'ready') { openAccount(from); return; }
    signIn().then(() => toast('Signed in. Your drives back up to your Google account.', { icon: 'check' }), (e: CloudError) => {
      const m = signInWords(e.code);
      if (m) toast(m, { icon: 'warn', ms: 5000 });
    });
  }

  // ---------- signed in ----------

  private signedIn(play: boolean): void {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries();
    if (this.blocked && drive.recording) toast('End your drive first. A drive is still recording.', { icon: 'warn', ms: 4000 });
    this.blocked = false;
    if (!sums.length) {
      this.creeks = [];
      const phone = drive.canRecord;
      this.page(h('div.my.my-out', {},
        this.hero(0, { label: 'An empty creek' }),
        this.plate(phone ? 'Your first drive shows up here.' : 'Drives you record on your phone show up here.', 'Each salmon creek you cross gently adds a coho.', false),
        h('div.my-out-keys', {},
          phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: () => drive.startDrive() }) : null,
          button('Try the sample drive', { kind: phone ? 'secondary' : 'primary', icon: 'play', wide: true, onClick: () => this.sample() }))), play);
      return;
    }
    // crossings for drives that don't have them yet; redraws once found
    const finding = needsCrossings(sums);
    this.creeks = creeksFrom(sums, crossingsOf);
    void findCrossings(sums).then((more) => { if ((more || finding) && this.here && this.view !== 'creek') this.render(false); });
    // trip names from schools and parks, once
    loadPlaces(() => { if (this.here && this.view !== 'creek') this.render(false); });
    if (this.view === 'all') this.page(this.all(sums), false, true);
    else if (this.view === 'more') this.page(this.more(sums), false, true);
    else {
      this.page(this.main(sums, play), play, !play);
      if (play && this.scrollY) this.app.pageEl.scrollTop = this.scrollY;
    }
  }

  private go(v: View): void {
    if (this.view === 'main') this.scrollY = this.app.pageEl.scrollTop;
    if (v !== 'main' && this.view === 'main') { this.app.pushStep(); this.steps++; }
    this.view = v;
    this.render(false);
    if (v === 'main') requestAnimationFrame(() => { this.app.pageEl.scrollTop = this.scrollY; });
    // keyboard and screen reader users land on the new page's heading
    const root = v === 'creek' ? this.app.panel : this.app.pageEl;
    (root.querySelector(v === 'main' ? 'h1' : 'h2') as HTMLElement | null)?.focus({ preventScroll: v === 'main' });
  }

  /** Back to the home, through history so the step it pushed goes too. */
  private home(): void {
    if (this.steps && (history.state as { tt?: number } | null)?.tt) history.back();
    else this.go('main');
  }

  /** The home: the scene and its line, the week on the map, next time, beyond salmon, the drives, share, then the quiet row. */
  private main(sums: DriveSummary[], play: boolean): HTMLElement {
    const weeks = weeksOf(sums), i = weeks.indexOf(this.week), now = weekStart();
    const older = weeks.find((x) => x < this.week) ?? null;
    const step = (to: number) => { this.week = to; this.render(false); };
    const nav = h('div.my-week', { role: 'group', 'aria-label': 'Week' },
      square('Week before', 'back', () => older != null && step(older), older == null),
      h('p.my-week-name', { 'aria-live': 'polite' }, weekLabel(this.week)),
      square('Week after', 'chevron', () => step(i > 0 ? weeks[i - 1] : weekAfter(this.week)), this.week >= now));
    const w = weekStats(sums, this.week, crossingsOf), b = weekStats(sums, weekBefore(this.week), crossingsOf);
    const say = heroLine({ ...w, drives: w.drives.length }, this.week);
    const change = w.known && b.known ? changeLine(w.gentle, b.gentle, this.week) : null;
    const label = w.crossed ? `A creek with ${count(w.gentle, 'coho')}, one for each gentle crossing` : 'A creek with no coho yet this week';
    const spot = spotsFrom(sums)[0] ?? null;
    const map = this.weekMap(w.drives, spot, play);
    // laptop: the scene and the map on the left, the words beside them; phone: one column in this order
    return h('div.my.my-home', {},
      h('div.my-main', {}, this.hero(w.gentle, { nav, label }), map),
      h('div.my-side', {},
        this.plate(say, change ?? (w.gentle ? COHO_KEY : null), !!change),
        this.lines(spot, w, b),
        this.rows(w.drives, sums),
        this.share(w, spot, sums),
        this.foot(sums)));
  }

  // ---------- the week on the map ----------

  private weekMap(drives: DriveSummary[], spot: Spot | null, play: boolean): HTMLElement | null {
    const routes = drives.map((d) => ({ at: d.at, pts: routeOf(d) })).filter((r) => r.pts.length > 1);
    if (!routes.length) return null;
    const creeks = creeksFrom(drives, crossingsOf);
    this.map = new WeekMap(this.app, {
      routes, spot: spot ? { ll: spot.lngLat, name: spot.name } : null,
      creeks: creeks.map((c) => ({ name: c.name, ll: c.ll, sp: c.sp, times: c.times, gentle: c.gentle })),
      label: `This week on the map: ${count(routes.length, 'drive')}${creeks.length ? `, ${count(creeks.length, 'salmon creek')}` : ''}`,
      play,
      openDrive: (at) => void this.open(at),
      openCreek: (k) => this.openCreek(this.allTime(creeks[k])),
      openSpot: () => { if (spot) this.showSpot(spot); },
    });
    return this.map.el;
  }

  // ---------- next time, and beyond salmon ----------

  private lines(s: Spot | null, w: ReturnType<typeof weekStats<DriveSummary>>, b: ReturnType<typeof weekStats<DriveSummary>>): HTMLElement | null {
    const more = weekMore({ drives: w.drives.length, hardBrakes: w.hardBrakes, gas: w.gas }, { drives: b.drives.length, hardBrakes: b.hardBrakes });
    const sw = s ? watchWords(s) : null;
    if (!sw && !more) return null;
    return h('div.my-lines-now', {},
      sw ? h('button.my-now.my-next', { type: 'button', 'aria-label': `${sw.line} ${sw.sub} Show it on the map.`, onclick: () => this.showSpot(s!) },
        h('span.my-now-ico', { 'aria-hidden': 'true', html: glyph('bell', 2) }),
        h('span.my-now-t', {}, h('b', {}, sw.line), h('small', {}, sw.sub)), ico('chevron')) : null,
      more ? h('p.my-now', {}, h('span.my-now-ico', { 'aria-hidden': 'true', html: glyph(/gallon/.test(more) ? 'gas' : 'stop', 2) }), h('span.my-now-t', {}, h('b', {}, more))) : null);
  }

  // ---------- the drives ----------

  /** A drive as one row: when, which trip and its creeks. Hover or focus lights its route on the map. */
  private row(d: DriveSummary, sums: DriveSummary[], cls = 'my-dr'): HTMLElement {
    const n = driveName(d, sums), cr = driveCreeks(crossingsOf(d.at)), sub = `${n.what} · ${miText(d.mi)}`;
    const light = (on: boolean) => this.map?.light(on ? d.at : null);
    const kids = [
      h('span.my-dr-when', {}, n.when),
      h('span.my-dr-what', {}, sub),
      cr ? h('span.my-dr-c', { 'data-gentle': String(cr.gentle) }, cr.text) : null,
      ico('chevron'),
    ];
    if (!trackOf(d.at) && !routeInCloud(d.at)) {
      // only the summary is here: say so, and delete stays one tap away
      return h(`li.${cls}.my-dr-flat`, {}, ...kids.slice(0, 3), h('span.my-dr-note', {}, 'Only its summary is on this phone.'), this.delKey(d.at));
    }
    return h('li', {}, h(`button.${cls}`, {
      type: 'button', 'aria-label': `${n.when}. ${sub}.${cr ? ` ${cr.text}.` : ''} Open it on the map.`,
      onclick: () => void this.open(d.at), onmouseenter: () => light(true), onmouseleave: () => light(false), onfocus: () => light(true), onblur: () => light(false),
    }, ...kids));
  }

  private rows(drives: DriveSummary[], sums: DriveSummary[]): HTMLElement {
    if (!drives.length) return h('p.my-p.my-none', {}, this.week >= weekStart() ? 'No drives yet this week.' : 'No drives that week.');
    return h('section.my-drs', { 'aria-label': 'Drives this week' }, h('ul.my-dr-list', {}, ...drives.slice(0, ROWS).map((d) => this.row(d, sums))));
  }

  // ---------- share, and the quiet row ----------

  /** Share your week: a picture for family with the creeks and coho, no map and no street. */
  private share(w: ReturnType<typeof weekStats<DriveSummary>>, s: Spot | null, sums: DriveSummary[]): HTMLElement | null {
    if (!w.crossed) return null;
    const cs = w.drives.flatMap((d) => crossingsOf(d.at) ?? []);
    const names = [...new Set(cs.map((c) => c.name).filter(Boolean))].slice(0, 3);
    const f: WeekFacts = {
      week: `Week of ${new Date(this.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      headline: shareHead({ ...w, drives: w.drives.length }),
      fish: w.gentle,
      change: null,
      creeks: names,
      // never a street: the card leaves the phone
      fix: s && sums.length ? 'Next week: ease off sooner at my hard-brake spot.' : null,
    };
    return h('div.my-share', {}, shareWeekButton(f, this.week, 'Send your week to family'), h('p.my-small', {}, 'They see your creeks and coho. The picture has no map.'));
  }

  private foot(sums: DriveSummary[]): HTMLElement {
    const m = monthStart(Date.now()), last = monthStart(m - 86_400_000);
    const line = monthLine(monthStats(sums, m, crossingsOf), monthStats(sums, last, crossingsOf));
    return h('nav.my-foot', { 'aria-label': 'More about your drives' },
      line ? h('p.my-month', {}, line) : null,
      h('div.my-foot-keys', {},
        h('button.my-link-k', { type: 'button', onclick: () => this.go('more') }, 'More about this week'),
        h('button.my-link-k', { type: 'button', onclick: () => this.go('all') }, `All drives (${sums.length})`)));
  }

  // ---------- a creek ----------

  /** The same creek across every drive, so its page counts them all. */
  private allTime(c: Creek): Creek {
    const m = c.marks[0];
    return this.creeks.find((x) => x.marks.some((y) => y.at === m.at && y.ll[0] === m.ll[0] && y.ll[1] === m.ll[1])) ?? c;
  }

  private openCreek(c: Creek): void {
    this.creek = c;
    this.go('creek');
  }

  /** The creek on the map: the drives that crossed it, a flag where each crossing was, and one sheet. */
  private creekPage(): void {
    const app = this.app, c = this.creek!;
    app.showStage();
    this.marks.show();
    const at = creekPlaces(c);
    const fish = !c.sp || c.sp & 1 ? 1 : c.sp & -c.sp, marks: Mark[] = at.map((p) => ({ ll: p.ll, kind: creekTone(p), fish }));
    this.marks.picked = -1;
    this.marks.set(marks, true);
    this.creekSet = new Set([c.name]);
    const sums = driveSummaries(), ats = new Set(c.marks.map((m) => m.at));
    this.creekRoutes = sums.filter((d) => ats.has(d.at)).map((d) => routeOf(d).map((ll) => app.world.toWorld(ll)));
    // one title, on the sheet
    app.clearCaption();
    const head = () => h('div.my-head', {},
      square('Back to My drives', 'back', () => this.home()),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, creekName(c.name))));
    app.setPanel(creekSheet(c, null, head()));
    // framed once the sheet is in, so the flags sit in the open part of the map
    requestAnimationFrame(() => this.marks.fit(at.map((p) => p.ll), 900, 2.2));
    void streamOf(c.ll).then((s) => { if (s && this.here && this.view === 'creek' && this.creek === c) app.setPanel(creekSheet(c, s, head()), false, true); });
  }

  /** Opens a saved drive's report on the map; a route from another device loads first. */
  private fetching = false;
  private async open(at: number): Promise<void> {
    if (!trackOf(at)) {
      if (this.fetching) return;
      this.fetching = true;
      const ok = await fetchRoute(at);
      this.fetching = false;
      if (!ok) { toast("Can't load this route right now.", { icon: 'warn' }); return; }
    }
    // opening a saved drive mid-recording would leave the recording half on screen
    const back = { view: this.view, scroll: this.app.pageEl.scrollTop };
    if (this.app.screens.drive.openSaved(at, 'drives')) { this.away = back; return; }
    this.blocked = true;
    this.render(false);
  }

  /** The spot on the map; Back comes here. */
  private showSpot(s: Spot): void {
    const back = { view: this.view, scroll: this.app.pageEl.scrollTop };
    if (this.app.screens.drive.showSpot(s, 'drives')) this.away = back;
  }

  /** A page's head: back to the home, and a title. */
  private head(title: string, sub?: string): HTMLElement {
    return h('div.my-head', {},
      square('Back to My drives', 'back', () => this.home()),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, title), sub ? h('p.my-head-s', {}, sub) : null));
  }

  // ---------- All drives ----------

  private all(sums: DriveSummary[]): HTMLElement {
    const miles = sums.reduce((t, s) => t + s.mi, 0);
    const shown = sums.slice(0, ALL_ROUTES), routes = shown.map((d) => ({ at: d.at, pts: routeOf(d) })).filter((r) => r.pts.length > 1);
    if (routes.length) {
      const creeks = creeksFrom(shown, crossingsOf);
      this.map = new WeekMap(this.app, {
        routes, spot: null, play: false,
        creeks: creeks.map((c) => ({ name: c.name, ll: c.ll, sp: c.sp, times: c.times, gentle: c.gentle })),
        label: `Your drives on the map: ${count(routes.length, 'drive')}`,
        openDrive: (at) => void this.open(at),
        openCreek: (k) => this.openCreek(creeks[k]),
        openSpot: () => {},
      });
    }
    return h('div.my.my-pg.my-all', {}, this.head('All drives', progressSub(sums.length, miles)), this.map?.el ?? null,
      h('ul.my-dr-list', {}, ...sums.map((d) => this.row(d, sums))));
  }

  /** Delete, then a confirm in place. */
  private delKey(at: number): HTMLElement {
    const box = h('div.my-del');
    const ask = () => box.replaceChildren(
      h('p', {}, "Delete this drive? It can't be undone."),
      h('div.my-del-keys', {},
        // everything that shows drives redraws, this page too
        button('Delete', { kind: 'danger', icon: 'trash', onClick: () => { forgetDrive(at); toast('Drive deleted.', { icon: 'trash' }); dispatchEvent(new CustomEvent('tt:drives')); } }),
        button('Keep', { kind: 'secondary', onClick: reset })));
    const reset = () => box.replaceChildren(button('Delete this drive', { kind: 'ghost', icon: 'trash', onClick: ask }));
    reset();
    return box;
  }

  // ---------- More ----------

  private more(sums: DriveSummary[]): HTMLElement {
    const w = weekStats(sums, this.week, crossingsOf), b = weekStats(sums, weekBefore(this.week), crossingsOf);
    const lines = moreLines(w, b.drives.length ? b : null);
    const line = (icon: string, text: string, small?: string) => h('li.my-line', {}, ico(icon), h('span', {}, text, small ? h('small', {}, small) : null));
    const sec = (title: string, ...kids: (Node | null)[]) => h('section.my-msec', {}, h('h3.my-msec-h', {}, title), ...kids);
    const spots = spotsFrom(sums).slice(0, 3), ends = driveEnds(sums), drainAt = this.drainAt();
    // gentle stops over traced drains that reach salmon streams
    let stops: SalmonStops | null = null;
    try { stops = salmonStops(w.drives, drainAt); } catch { /* no drain maps here */ }
    // the note to the city never names a spot near where drives start or end (usually home)
    const city = spots.filter((s) => s.salmon && !nearEnds(s.lngLat, ends)).flatMap((s) => {
      const d = drainAt(s.lngLat);
      return d?.cls === 'creek' ? [fromSpot(s, d.receiving)] : [];
    });
    const routes = routesFrom(sums, loadPlaces(() => { if (this.here && this.trips && this.view === 'more') this.render(false); }) ?? []).slice(0, 3), names = tripNames(routes);
    this.trips = routes.length;
    return h('div.my.my-pg.my-moresheet', {},
      this.head(weekLabel(this.week), w.drives.length ? `${count(w.drives.length, 'drive')}, against the week before` : undefined),
      w.drives.length ? h('ul.my-lines', {},
        line('stop', lines.brakes),
        lines.gas ? line('gas', lines.gas) : null,
        stops?.gentle ? line('drop', salmonLine(stops)) : null) : h('p.my-p', {}, 'No drives that week.'),
      spots.length ? sec('Spots to watch', h('ul.my-lines', {}, ...spots.map((s) => {
        const sw = watchWords(s);
        return h('li', {}, h('button.my-row.my-row-plain', { type: 'button', 'aria-label': `${sw.line} ${sw.sub} Open it.`, onclick: () => this.showSpot(s) },
          h('span.my-row-t', {}, s.name || 'A spot on your drives'), h('span.my-row-s', {}, count(s.count, 'hard brake')), ico('chevron')));
      })), city.length ? tellCityButton(city, 'brakes') : null) : null,
      routes.length ? sec('Regular trips', h('ul.my-lines', {}, ...routes.map((r, i) => {
        const t = tripWords(r, names[i]);
        return h('li.my-line', {}, ico('route'), h('span', {}, t.title, h('small', {}, t.days.join(' '))));
      }))) : null,
      lines.dust ? sec('This week, estimated', h('ul.my-lines', {}, line('tire', lines.dust, DUST_WHY))) : null,
      h('p.my-src', {}, `${ESTIMATES}${w.gas ? ` ${w.gas.price}` : ''} `,
        h('a', { href: PPDQ.href, target: '_blank', rel: 'noopener' }, 'Source: why tire dust matters')));
  }

  /** Where rain at a point goes, from the drain maps, and whether it's Bonney Lake's own map. */
  private drainAt(): DrainAt {
    const app = this.app, base = app.screens.drive.baseDrains;
    return (ll: LngLat) => {
      const d = app.data.nearestDrain(ll, 50);
      return d ? { cls: app.world.drainCls(d.drain.index), receiving: d.drain.receiving, local: d.drain.index < base } : null;
    };
  }

  leave(): void {
    this.marks.hide();
    this.map?.destroy();
  }

  back(): boolean {
    if (this.view === 'main') return false;
    this.steps = Math.max(0, this.steps - 1);
    this.go('main');
    return true;
  }

  tap(p: XY): boolean {
    if (this.view !== 'creek') return false;
    const i = this.marks.hit(p);
    if (i < 0 && this.marks.picked < 0) return false;
    this.marks.pick(i);
    return true;
  }

  frame(): FrameOut {
    this.marks.place(this.app.camera.cam);
    const creek = this.view === 'creek';
    return { scene: { muted: true, creeks: creek ? this.creekSet : null, replay: creek ? this.creekRoutes.map((path) => ({ path, color: ROUTE.fill })) : null } };
  }

  relayout(): void {
    this.render(false);
  }
}
