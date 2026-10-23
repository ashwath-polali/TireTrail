// My drives: a home for your drives. The creek scene with a coho for each gentle crossing this week, your creeks,
// the one thing to work on, recent drives, the month and Share your week. A creek or a drive opens on the map.
// All drives and More are pages of their own. Signed out: the scene with sample fish, one line and Sign in.
import { placesFromLabels, routesFrom, type Place } from '../../drive/coach/index.ts';
import type { CommunityTotals } from '../../drive/community.ts';
import {
  creekPlaces, creekShelf, creeksFrom, creekTone, monthStart, monthStats, weekAfter, weekBefore, weeksOf, weekStats, type Creek, type Crossing,
} from '../../drive/creeks.ts';
import { weekStart } from '../../drive/gas.ts';
import { spotsFrom, type Spot } from '../../drive/spots.ts';
import { driveEnds, nearEnds, pathPoints, type DriveSummary } from '../../drive/summary.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { accountEntry, G_MARK, onPickFile, openAccount } from '../cloud/account.ts';
import { authPhase, onAuth, person, prepare, signIn, type CloudError } from '../cloud/auth.ts';
import { communityCard, communityTotals } from '../cloud/community.ts';
import { cloudNow } from '../cloud/firebase.ts';
import { fetchRoute, routeInCloud } from '../cloud/sync.ts';
import { signInWords } from '../cloud/words.ts';
import { esc, h } from '../dom.ts';
import { fromSpot, tellCityButton } from '../features/city.ts';
import { shareWeekButton, type WeekFacts } from '../features/share-week.ts';
import { button, glyph, salmonSVG, stagger, toast } from '../ui/ui.ts';
import { crossMarks, creekSheet, streamOf } from './creek.ts';
import { count, dayWord, timeWord } from './drive-words.ts';
import { crossingsOf, findCrossings, needsCrossings, sampleCrossings } from './history-creeks.ts';
import { Marks, type Mark } from './history-map.ts';
import { creekScene, portrait, routeThumb, spotThumb } from './history-scene.ts';
import {
  changeLine, cohoWords, creekCardLine, creekName, driveTitle, DUST_WHY, ESTIMATES, heroLine, monthLine, moreLines, PPDQ, progressSub, salmonLine, salmonStops,
  signedOutLine, tripNames, tripWords, watchWords, weekLabel,
  type DrainAt, type SalmonStops,
} from './history-words.ts';
import { driveSummaries, forgetDrive, trackOf, unpack } from './saved.ts';
import './history.css';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const square = (label: string, icon: string, onclick: () => void, disabled = false) =>
  h('button.u-btn.u-secondary.u-square.my-sq', { type: 'button', 'aria-label': label, title: label, disabled, onclick, html: glyph(icon) });

/** coho in a drive's card */
const DRIVE_MAX = 4;
/** the sample's fish, signed out */
const SAMPLE_FISH = 6;

// schools and parks name the ends of regular trips; loaded once
let places: Place[] | null = null;
let placesAsked = false;

type View = 'main' | 'all' | 'more' | 'creek';

/** One coho per crossing: gentle ones in color, the rest gray. */
function cohoRow(cs: readonly Pick<Crossing, 'gentle'>[], cls: string, most: number): HTMLElement {
  const sorted = [...cs].sort((a, b) => Number(b.gentle) - Number(a.gentle)), shown = sorted.slice(0, most), more = sorted.length - shown.length;
  return h(cls, {},
    ...shown.map((c) => h(`span.my-c${c.gentle ? '' : '.my-c-rough'}`, { html: salmonSVG(2) })),
    more > 0 ? h('span.my-c-more', {}, `+${more}`) : null);
}

/** A drive's route for its little map: the coarse route kept on this phone, else its track. */
function routeOf(d: DriveSummary): LngLat[] {
  const p = pathPoints(d.path);
  if (p.length > 1) return p;
  const t = trackOf(d.at);
  if (!t) return [];
  const all = t.fixes.map(unpack).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon));
  const step = Math.max(1, Math.floor(all.length / 80));
  return all.filter((_, i) => i % step === 0).map((f) => [f.lon, f.lat] as LngLat);
}

/** the fish to show for a creek: coho when there or unknown, else its first species */
const mainFish = (sp: number) => (!sp || sp & 1 ? 1 : sp & -sp);

const miText = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
const shortDay = (t: number) => dayWord(t).replace(/, \w+ \d+$/, '');

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
  private trips = 0;
  private totals: Promise<CommunityTotals | null> | null = null;
  /** history steps taken for the pages under this one, so the phone's Back comes back here */
  private steps = 0;
  /** the home's scroll, kept while a page is open over it */
  private scrollY = 0;

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
    this.view = 'main';
    this.steps = 0;
    this.scrollY = 0;
    this.week = weekStart();
    this.creek = null;
    this.render(true);
  }

  /** play: a fresh visit, so things slide in and the coho arrive */
  private render(play: boolean): void {
    if (this.view === 'creek' && this.creek && person()) { this.creekPage(); return; }
    this.marks.hide();
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

  /** The creek scene, the week switcher over it, and its line under it. */
  private hero(fish: number, say: string, sub: string | null, opts: { dim?: boolean; nav?: HTMLElement | null; label: string; key?: string }): HTMLElement {
    return h('section.my-hero', { 'aria-label': 'This week' },
      h('div.my-scene-box', {}, creekScene({ fish, dim: opts.dim }, opts.label),
        h('div.my-hero-top', {}, opts.nav ?? h('span'), accountEntry('my-acct'))),
      h('div.my-plate', {}, h('h1.my-say', { tabindex: '-1' }, say),
        sub ? h('p.my-change', {}, ico('up', 2), h('span', {}, sub)) : opts.key ? h('p.my-key', {}, opts.key) : null));
  }

  // ---------- signed out ----------

  private signedOut(play: boolean): void {
    // Google sign-in loads now, so the key can open Google's window straight from the tap
    if (authPhase() === 'idle') void prepare();
    this.creeks = [];
    const key = button('Sign in with Google', { kind: 'primary', icon: G_MARK, wide: true, onClick: () => this.signIn(key) });
    // drives already here: say how many, not the drives themselves
    const say = signedOutLine(driveSummaries().length);
    this.page(h('div.my.my-out', {},
      this.hero(SAMPLE_FISH, say, null, { dim: true, label: 'A creek with sample coho, one for each gentle creek crossing' }),
      h('div.my-out-keys', {}, h('p.my-p', {}, 'Each coho is a salmon creek you crossed gently.'), key),
      this.sampleShelf()), play);
  }

  /** Signed out: the sample drive's creeks as cards, quiet and not tappable, to show what comes after sign-in. */
  private sampleShelf(): HTMLElement {
    const box = h('div.my-sample', { 'aria-hidden': 'true' });
    void sampleCrossings().then((cs) => {
      if (!cs.length || !box.isConnected) return;
      const shelf = creekShelf(creeksFrom([{ at: 0 }], () => cs));
      box.replaceChildren(this.sec('From a sample drive', 'my-shelf', null, h('ul.my-cards', {}, ...shelf.map((c) =>
        h('li', {}, h('div.my-cc', {}, h('span.my-cc-art', {}, portrait(mainFish(c.sp))), h('span.my-cc-t', {}, creekName(c.name)),
          h('span.my-cc-m', {}, crossMarks(c.marks, 8)), h('span.my-cc-s', {}, creekCardLine(c))))))));
    });
    return box;
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
      this.page(h('div.my', {},
        this.hero(0, phone ? 'Your first drive shows up here.' : 'Drives you record on your phone show up here.', null, { label: 'An empty creek' }),
        h('div.my-out-keys', {},
          h('p.my-p', {}, 'Each salmon creek you cross gently adds a coho.'),
          phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: () => drive.startDrive() })
            : button('Try the sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: () => { app.setTab('drive'); void drive.loadSample(); } }))), play);
      return;
    }
    // crossings for drives that don't have them yet; redraws once found
    const finding = needsCrossings(sums);
    this.creeks = creeksFrom(sums, crossingsOf);
    void findCrossings(sums).then((more) => { if ((more || finding) && this.here && this.view !== 'creek') this.render(false); });
    if (this.view === 'all') this.page(this.all(sums), false, true);
    else if (this.view === 'more') this.page(this.more(sums), false, true);
    else {
      this.page(this.main(sums), play, !play);
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

  /** The home: hero, creeks, the one thing, recent drives, the month, share, More. */
  private main(sums: DriveSummary[]): HTMLElement {
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
    const label = w.crossed ? `A creek with ${count(w.gentle, 'coho')}, ${cohoWords(w.gentle, w.crossed)}` : 'A creek with no coho yet this week';
    const spot = spotsFrom(sums)[0] ?? null;
    // laptop: the week, creeks and drives on the left, the one thing and the rest beside; phone: one column
    return h('div.my.my-home', {},
      h('div.my-main', {}, this.hero(w.gentle, say, change, { nav, label, key: w.gentle ? 'Each coho is a salmon creek you crossed gently.' : undefined }), this.shelf(), this.recent(sums)),
      h('div.my-side', {}, this.work(spot, sums), this.month(sums), this.share(w, spot, sums), this.moreKey()));
  }

  /** A section with its heading; aside: a key on the right. */
  private sec(title: string, cls: string, aside: HTMLElement | null, ...kids: (Node | null)[]): HTMLElement {
    return h(`section.my-sec.${cls}`, { 'aria-label': title }, h('div.my-sec-top', {}, h('h2.my-sec-h', {}, title), aside), ...kids);
  }

  // ---------- your creeks ----------

  /** Your creeks: a card each, newest crossing first, swiped sideways. */
  private shelf(): HTMLElement | null {
    const cs = creekShelf(this.creeks);
    if (!cs.length) return this.sec('Your creeks', 'my-shelf', null, h('p.my-p', {}, 'Salmon creeks you cross show up here.'));
    return this.sec('Your creeks', 'my-shelf', null,
      h('ul.my-cards', {}, ...cs.map((c) => {
        const name = creekName(c.name), line = creekCardLine(c);
        return h('li', {}, h('button.my-cc', { type: 'button', 'aria-label': `${name}. ${line}. Open it.`, onclick: () => this.openCreek(c) },
          h('span.my-cc-art', {}, portrait(mainFish(c.sp))),
          h('span.my-cc-t', {}, name),
          h('span.my-cc-m', {}, crossMarks(c.marks, 8)),
          h('span.my-cc-s', {}, line)));
      })));
  }

  // ---------- the one thing to work on ----------

  private work(s: Spot | null, sums: DriveSummary[]): HTMLElement | null {
    if (!s) return null;
    const sw = watchWords(s), paths = sums.slice(0, 20).map(routeOf), marks = this.creeks.map((c) => ({ ll: c.ll, gentle: c.gentle >= c.times }));
    return this.sec('One thing to work on', 'my-work', null,
      h('button.my-spot', { type: 'button', 'aria-label': `${sw.line}. ${sw.sub} Show it on the map.`, onclick: () => this.showSpot(s) },
        h('span.my-spot-map', { html: spotThumb(s.lngLat, paths, marks) }),
        h('span.my-spot-t', {}, h('b', {}, sw.line), h('small', {}, sw.sub)),
        ico('chevron')));
  }

  // ---------- recent drives ----------

  private recent(sums: DriveSummary[]): HTMLElement {
    const all = button('All drives', { kind: 'ghost', icon: 'list', onClick: () => this.go('all') });
    return this.sec('Recent drives', 'my-recent', all, h('ul.my-drives', {}, ...sums.slice(0, 3).map((d) => {
      const cs = crossingsOf(d.at), title = driveTitle(d, cs), when = `${shortDay(d.at)} · ${miText(d.mi)}`;
      const fish = cs?.length ? `, ${cohoWords(cs.filter((c) => c.gentle).length, cs.length)} at salmon creeks` : '';
      return h('li', {}, h('button.my-dc', { type: 'button', 'aria-label': `${title}, ${dayWord(d.at)} ${timeWord(d.at)}, ${miText(d.mi)}${fish}. Open it on the map.`, onclick: () => void this.open(d.at) },
        h('span.my-dc-map', { html: routeThumb(routeOf(d), cs ?? []) }),
        h('span.my-dc-t', {}, title),
        h('span.my-dc-s', {}, when),
        cs?.length ? cohoRow(cs, 'span.my-dc-c', DRIVE_MAX) : h('span.my-dc-c.my-dc-none', {}, 'No creeks')));
    })));
  }

  // ---------- the month, share, More ----------

  private month(sums: DriveSummary[]): HTMLElement | null {
    const m = monthStart(Date.now()), last = monthStart(m - 86_400_000);
    const line = monthLine(monthStats(sums, m, crossingsOf), monthStats(sums, last, crossingsOf));
    return line ? h('p.my-month', {}, ico('calendar'), h('span', {}, line)) : null;
  }

  /** Share your week: a picture for family, with nothing near where drives start or end. */
  private share(w: ReturnType<typeof weekStats<DriveSummary>>, s: Spot | null, sums: DriveSummary[]): HTMLElement | null {
    if (!w.crossed) return null;
    const cs = w.drives.flatMap((d) => crossingsOf(d.at) ?? []);
    const names = [...new Set(cs.map((c) => c.name).filter(Boolean))].slice(0, 3);
    const far = s && s.name && !nearEnds(s.lngLat, driveEnds(sums));
    const f: WeekFacts = {
      week: `Week of ${new Date(this.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      headline: heroLine({ ...w, drives: w.drives.length }, this.week).replace(/^(This week|Last week|That week): g/, 'G'),
      fish: w.gentle,
      change: null,
      creeks: names,
      fix: far ? `Next week: ease off sooner at ${s.name}.` : s ? 'Next week: ease off sooner at my hard-brake spot.' : null,
    };
    return h('div.my-share', {}, h('p.my-p', {}, 'Send your week to family. They see the creek and your coho, not where you drove.'), shareWeekButton(f, this.week));
  }

  private moreKey(): HTMLElement {
    return h('button.my-more', { type: 'button', onclick: () => this.go('more') },
      h('span', {}, h('b', {}, 'More'), h('small', {}, 'Hard brakes, gas and tire dust, week by week')), ico('chevron'));
  }

  // ---------- a creek ----------

  private openCreek(c: Creek): void {
    this.creek = c;
    this.go('creek');
  }

  /** The creek on the map with your crossings, and its sheet. */
  private creekPage(): void {
    const app = this.app, c = this.creek!;
    app.showStage();
    this.marks.show();
    const at = creekPlaces(c);
    const marks: Mark[] = at.map((p) => ({ ll: p.ll, kind: creekTone(p) }));
    this.marks.picked = -1;
    this.marks.set(marks, true);
    this.creekSet = new Set([c.name]);
    app.setCaption(`my-creek:${c.name}:${c.times}`, salmonSVG(2), `<span class="say"><b>${esc(creekName(c.name))}</b> · where you crossed it</span>`);
    const head = () => h('div.my-head', {},
      square('Back', 'back', () => this.home()),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, creekName(c.name))));
    app.setPanel(creekSheet(c, null, head()));
    // framed once the sheet is in, so the flags sit in the open part of the map
    requestAnimationFrame(() => this.marks.fit(at.map((p) => p.ll), 900, 6));
    void streamOf(c.ll).then((s) => { if (s && this.here && this.view === 'creek' && this.creek === c) app.setPanel(creekSheet(c, s, head()), false, true); });
  }

  /** Opens a saved drive's report; a route from another device loads first. */
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
    // set after the Drive tab opens, as its home clears it
    if (this.app.screens.drive.openSaved(at)) { this.app.screens.drive.returnTo = 'drives'; return; }
    this.blocked = true;
    this.render(false);
  }

  /** The spot on the map; Back comes here. */
  private showSpot(s: Spot): void {
    const d = this.app.screens.drive;
    if (d.showSpot(s)) d.returnTo = 'drives';
  }

  /** A page's head: back to the home, and a title. */
  private head(title: string, sub?: string): HTMLElement {
    return h('div.my-head', {},
      square('Back', 'back', () => this.home()),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, title), sub ? h('p.my-head-s', {}, sub) : null));
  }

  // ---------- All drives ----------

  private all(sums: DriveSummary[]): HTMLElement {
    const miles = sums.reduce((t, s) => t + s.mi, 0);
    const rowOf = (d: DriveSummary) => {
      const cs = crossingsOf(d.at), name = driveTitle(d, cs), when = `${dayWord(d.at)} · ${timeWord(d.at)}`;
      const sub = `${when} · ${miText(d.mi)}${d.hardBrakes ? ` · ${count(d.hardBrakes, 'hard brake')}` : ''}`;
      const fish = cs?.length ? cohoRow(cs, 'span.my-dc-c', DRIVE_MAX) : null;
      if (trackOf(d.at) || routeInCloud(d.at)) {
        return h('li', {}, h('button.my-row', { type: 'button', 'aria-label': `${name}, ${sub}. Open it on the map.`, onclick: () => void this.open(d.at) },
          h('span.my-row-map', { html: routeThumb(routeOf(d), cs ?? [], 72, 56) }),
          h('span.my-row-t', {}, name), h('span.my-row-s', {}, sub), fish, ico('chevron')));
      }
      // only the summary is here: say so, and delete stays one tap away
      return h('li.my-row.my-row-flat', {}, h('span.my-row-t', {}, name), h('span.my-row-s', {}, `${sub}. Only its summary is on this phone.`), this.delKey(d.at));
    };
    return h('div.my.my-pg', {}, this.head('All drives', progressSub(sums.length, miles)), h('ul.my-rows', {}, ...sums.map(rowOf)));
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
    const app = this.app, w = weekStats(sums, this.week, crossingsOf), b = weekStats(sums, weekBefore(this.week), crossingsOf);
    const lines = moreLines(w, b.drives.length ? b : null);
    const line = (icon: string, text: string, small?: string) => h('li.my-line', {}, ico(icon), h('span', {}, text, small ? h('small', {}, small) : null));
    const sec = (title: string, ...kids: (Node | null)[]) => h('section.my-msec', {}, h('h3.my-msec-h', {}, title), ...kids);
    const spots = spotsFrom(sums).slice(0, 3), ends = driveEnds(sums), drainAt = this.drainAt();
    // gentle stops over traced drains that reach salmon streams
    let stops: SalmonStops | null = null;
    try { stops = salmonStops(sums, drainAt); } catch { /* no drain maps here */ }
    // the note to the city never names a spot near where drives start or end (usually home)
    const city = spots.filter((s) => s.salmon && !nearEnds(s.lngLat, ends)).flatMap((s) => {
      const d = drainAt(s.lngLat);
      return d?.cls === 'creek' ? [fromSpot(s, d.receiving)] : [];
    });
    if (!places) this.askPlaces();
    const routes = routesFrom(sums, places ?? []).slice(0, 3), names = tripNames(routes);
    this.trips = routes.length;
    return h('div.my.my-pg.my-moresheet', {},
      this.head(weekLabel(this.week), w.drives.length ? `${count(w.drives.length, 'drive')}, against the week before` : undefined),
      w.drives.length ? h('ul.my-lines', {},
        line('stop', lines.brakes),
        lines.gas ? line('gas', lines.gas) : null,
        lines.dust ? line('tire', lines.dust, DUST_WHY) : null) : h('p.my-p', {}, 'No drives that week.'),
      stops?.gentle ? sec('Rain and salmon', h('ul.my-lines', {}, line('drop', `${count(stops.gentle, 'gentle stop')} where rain drains to a salmon stream.`, salmonLine(stops)))) : null,
      spots.length ? sec('Spots to watch', h('ul.my-lines', {}, ...spots.map((s) => {
        const sw = watchWords(s);
        return h('li', {}, h('button.my-row.my-row-plain', { type: 'button', 'aria-label': `${sw.line}. ${sw.sub} Open it.`, onclick: () => this.showSpot(s) },
          h('span.my-row-t', {}, s.name || 'A spot on your drives'), h('span.my-row-s', {}, count(s.count, 'hard brake')), ico('chevron')));
      })), city.length ? tellCityButton(city, 'brakes') : null) : null,
      routes.length ? sec('Regular trips', h('ul.my-lines', {}, ...routes.map((r, i) => {
        const t = tripWords(r, names[i]);
        return h('li.my-line', {}, ico('route'), h('span', {}, t.title, h('small', {}, t.days.join(' '))));
      }))) : null,
      this.community(),
      h('p.my-src', {}, `${PPDQ.line} (${PPDQ.source}.) ${ESTIMATES}${w.gas ? ` ${w.gas.price}` : ''}`));
  }

  /** Where rain at a point goes, from the drain maps, and whether it's Bonney Lake's own map. */
  private drainAt(): DrainAt {
    const app = this.app, base = app.screens.drive.baseDrains;
    return (ll: LngLat) => {
      const d = app.data.nearestDrain(ll, 50);
      return d ? { cls: app.world.drainCls(d.drain.index), receiving: d.drain.receiving, local: d.drain.index < base } : null;
    };
  }

  /** labels.json for trip names; More redraws when it arrives. */
  private askPlaces(): void {
    if (placesAsked) return;
    placesAsked = true;
    fetch('data/labels.json').then((r) => (r.ok ? r.json() : null)).then((j: unknown) => {
      places = placesFromLabels(j as Parameters<typeof placesFromLabels>[0]);
      if (this.here && this.trips && this.view === 'more') this.render(false);
    }).catch(() => { places = []; });
  }

  /** Everyone's total, asked once a visit (again after a miss); hidden until it comes. */
  private community(): HTMLElement {
    const el = communityCard({ totals: null }), got = (this.totals ??= communityTotals());
    void got.then((t) => {
      if (!t) { if (this.totals === got) this.totals = null; return; }
      if (el.isConnected) el.replaceWith(communityCard({ totals: t }));
    });
    return el;
  }

  leave(): void {
    this.marks.hide();
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
    return { scene: { muted: true, creeks: this.view === 'creek' ? this.creekSet : null } };
  }

  relayout(): void {
    this.render(false);
  }
}
