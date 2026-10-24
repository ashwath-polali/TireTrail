// My drives: the week road. The verdict, the week, a road where each drive is a sign, and four questions a driver asks
// (am I smoother, where do I brake hard, what does it cost, am I gentle at creeks), one open at a time. Opening one changes
// what the signs show. It all fits one screen. A sign, a drive or the spot opens on the big map; Back comes to the same place.
// Signed out: the creek scene, one line, Sign in and the sample.
import { brakedAt, streaks } from '../../drive/challenge.ts';
import {
  creekPlaces, creeksFrom, creekTone, weekBefore, weeksOf, weekStats, type Creek, type Week,
} from '../../drive/creeks.ts';
import { gasHow, weekStart } from '../../drive/gas.ts';
import { AHEAD_S, spotsFrom, type Spot } from '../../drive/spots.ts';
import { driveEnds, nearEnds, pathPoints, type DriveSummary } from '../../drive/summary.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import { areaOf } from '../../intel/index.ts';
import { cached, load as loadRain, rainAhead, type Forecast } from '../../intel/rain.ts';
import { speciesIn, speciesList } from '../../salmon/species.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { accountEntry, G_MARK, onPickFile, openAccount } from '../cloud/account.ts';
import { authPhase, onAuth, person, prepare, signIn, type CloudError } from '../cloud/auth.ts';
import { cloudNow } from '../cloud/firebase.ts';
import { fetchRoute, onSync, routeInCloud, syncView } from '../cloud/sync.ts';
import { signInWords } from '../cloud/words.ts';
import { h } from '../dom.ts';
import { fromSpot, tellCityButton } from '../features/city.ts';
import { shareWeekButton, type WeekFacts } from '../features/share-week.ts';
import { nearestOnPolyline } from '../../geo/geo.ts';
import { ROUTE } from '../map/palette.ts';
import { button, calm, glyph, sheet, stagger, toast } from '../ui/ui.ts';
import { creekSheet, streamOf } from './creek.ts';
import { driveTitleOf, loadPlaces } from './drive-names.ts';
import { count } from './drive-words.ts';
import { crossingsOf, crossingState, creeksOffline, findCrossings, needsCrossings } from './history-creeks.ts';
import { Marks, type Mark } from './history-map.ts';
import { Road, type Play, type RoadClock, type RoadLens, type RoadSky } from './history-road.ts';
import { SpotMap } from './history-spot.ts';
import {
  biggest, blocks, brakesHere, calmRun, centsRaw, costliest, crossPick, dayOf, freeRun, gasWhyNot, lightAt, MAX_SIGNS, scoreEnds,
  signsOf, speedRoad, spotParts, spotPasses, weatherOf, weekLost, weekScore, weekVerdict, worstDrive, type Sign,
} from './history-week.ts';
import {
  aheadWord, coachAct, costAnswer, creekAnswer, creekName, dayName, dayTime, FISH_NOTE, gasSay,
  GENTLE_NOTE, hereLine, LENS_ACT, LENS_ASK, LENS_KICKER, LENS_LEGEND, LENS_LEGEND_DAY, lastDriveLine, lastScoreLine, LOST_WORD, lostLine, lostSay,
  NO_SPOT, passLine, passSay, progressSub, shareHead, shortDayTime, signedOutLine, signSay, smoothAnswer, spotAnswer,
  streakWords, uncheckedLine, voiceNote, weekHead, weekRange, weekSum, weekWords, type DrainAt, type LensKey,
} from './history-words.ts';
import { driveSummaries, forgetDrive, trackOf, unpack } from './saved.ts';
import { WeekMap } from './week-map.ts';
import './history.css';

/** signed out: a sample week on the road, so the page shows what it does (labeled "A sample week") */
const SAMPLE_WEEK = [
  { day: 0, score: 72, hardBrakes: 2 }, { day: 1, score: 78, hardBrakes: 1 }, { day: 2, score: 75, hardBrakes: 1 },
  { day: 3, score: 84, hardBrakes: 0 }, { day: 4, score: 88, hardBrakes: 0 },
];
/** routes on All drives' map */
const ALL_ROUTES = 30;
/** laptop: drive rows under the road */
const LIST_ROWS = 6;
/** a cross street this close to the spot names it, m */
const CROSS_M = 40;

type View = 'main' | 'all' | 'creek' | 'creeks';
type WeekS = Omit<Week, 'drives'> & { drives: DriveSummary[] };

// pixel glyphs drawn for this page
const SVG = {
  pin: '<svg width="12" height="16" viewBox="0 0 6 8" fill="currentColor" aria-hidden="true"><path d="M1 0h4v1h1v3H5v1H4v2H2V5H1V4H0V1h1z"/><path fill="#18231d" d="M2 1h2v2H2z"/></svg>',
  go: '<svg width="14" height="12" viewBox="0 0 7 6" fill="currentColor" aria-hidden="true"><path d="M0 2h6v2H0zM3 0h1v1H3zM4 1h1v1H4zM6 2h1v2H6zM4 4h1v1H4zM3 5h1v1H3z"/></svg>',
  chev: '<svg class="wr-chev" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path d="M0 2h2v2H0zM2 4h2v2H2zM4 6h2v2H4zM6 4h2v2H6zM8 2h2v2H8z"/></svg>',
  prev: '<svg width="10" height="16" viewBox="0 0 5 8" fill="currentColor" aria-hidden="true"><path d="M3 0h2v2H3zM2 2h2v1H2zM1 3h2v2H1zM2 5h2v1H2zM3 6h2v2H3z"/></svg>',
  next: '<svg width="10" height="16" viewBox="0 0 5 8" fill="currentColor" aria-hidden="true"><path d="M0 0h2v2H0zM1 2h2v1H1zM2 3h2v2H2zM1 5h2v1H1zM0 6h2v2H0z"/></svg>',
  spot: '<svg width="28" height="36" viewBox="0 0 7 9" aria-hidden="true"><path fill="#ff7a66" d="M1 0h5v1h1v4H6v1H5v1H4v2H3V7H2V6H1V5H0V1h1z"/><path fill="#5e2219" d="M2 2h3v2H2z"/><path fill="#ffc4ba" d="M1 1h2v1H1z"/></svg>',
};

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
/** the fish a creek shows: coho when there or unknown, else its first species */
const mainFish = (sp: number) => (!sp || sp & 1 ? 1 : sp & -sp);
const fishWord = (sp: number) => speciesIn(mainFish(sp))[0]?.word ?? 'coho';

/** One question: its answer, its body, and what the road shows. */
interface Q { k: LensKey; ans: string; icon: HTMLElement; body: (HTMLElement | null)[]; road: RoadLens }

export class HistoryScreen implements Screen {
  private readonly app: App;
  private readonly marks: Marks;
  /** a drive was picked while one is still recording */
  private blocked = false;
  private view: View = 'main';
  /** Monday of the week shown */
  private week = weekStart();
  /** the open question; it stays when a drive or the spot opens and comes back */
  private lens: LensKey = 'smooth';
  private creeks: Creek[] = [];
  /** the creek page's creek, and the week's creeks for their map */
  private creek: Creek | null = null;
  private weekCreeks: Creek[] = [];
  private creekSet: ReadonlySet<string> | null = null;
  private creekRoutes: XY[][] = [];
  /** history steps taken for the pages under this one, so the phone's Back comes back here */
  private steps = 0;
  /** a drive or the spot is open on the Drive screen: coming back keeps the week, the question and the page */
  private away: { view: View; scroll: number } | null = null;
  private map: WeekMap | null = null;
  private road: Road | null = null;
  private spotMap: SpotMap | null = null;
  /** the open list of drives, over the page */
  private layer: { close: (focus?: boolean) => void } | null = null;
  /** focus goes back to this key after the page draws again */
  private refocus: string | null = null;

  constructor(app: App) {
    this.app = app;
    this.marks = new Marks(app);
    // "Add a drive from a file" lives in the account sheet
    onPickFile(() => app.screens.drive.pickFile());
    onAuth(() => { if (this.here) this.refresh(); });
    // drives saved, deleted, or back from the backup
    addEventListener('tt:drives', () => { if (this.here) this.refresh(); });
    addEventListener('storage', (e) => { if (this.here && e.key === 'tt-sums') this.refresh(); });
    // the first pull from the backup ends: the loading page gives way
    onSync(() => { if (this.here && this.view === 'main' && this.loadingShown !== syncView().busy && !driveSummaries().length) this.refresh(); });
  }

  /** the page shows "Getting your drives" */
  private loadingShown = false;

  private get here(): boolean {
    return this.app.tab === 'drives';
  }

  private get laptop(): boolean {
    return this.app.layout === 'laptop';
  }

  enter(): void {
    const back = this.away;
    this.away = null;
    if (back) {
      // back from a drive or the spot: the same week, question and place, with no replay
      this.view = back.view;
      this.render('still');
      requestAnimationFrame(() => { this.app.pageEl.scrollTop = back.scroll; });
      return;
    }
    this.view = 'main';
    this.steps = 0;
    this.week = weekStart();
    this.lens = 'smooth';
    this.creek = null;
    this.render('intro');
  }

  /** New data (crossings found, a drive synced): the same page again, the road carrying on and focus where it was. */
  private refresh(): void {
    const a = document.activeElement as HTMLElement | null, pg = this.app.pageEl;
    const key = a && pg.contains(a) ? (a.id ? `#${a.id}` : a.dataset.k ? `[data-k="${a.dataset.k}"]` : a.dataset.i ? `.wr-sign[data-i="${a.dataset.i}"]` : null) : null;
    this.resume = this.road?.clock ?? null;
    if (key) this.refocus = key;
    this.render('still');
    this.resume = null;
  }
  /** the road being replaced, so a new one carries on its arrival */
  private resume: RoadClock | null = null;

  /** intro: a fresh visit, so the car drives the week in; week: a new week; still: as it was */
  private render(play: Play): void {
    if (this.view === 'creek' && this.creek && person()) { this.creekPage(); return; }
    if (this.view === 'creeks' && person()) { this.creeksPage(); return; }
    this.closeLayer(false);
    this.marks.hide();
    this.map?.destroy();
    this.map = null;
    this.road = null;
    this.spotMap = null;
    if (person()) this.signedIn(play);
    else this.signedOut(play === 'intro');
  }

  /** A page, keeping its scroll on a redraw. */
  private page(el: HTMLElement, play: boolean, keep = false): void {
    const pg = this.app.pageEl, top = pg.scrollTop;
    if (play) stagger(el);
    this.app.showPage(el);
    if (keep) pg.scrollTop = top;
  }

  // ---------- signed out, and no drives yet ----------

  /** The week road with no week of yours on it yet: a sample week (signed out) or an empty road, and the account key. */
  private hero(sample: boolean, play: Play): HTMLElement {
    const sums = driveSummaries();
    const signs = sample ? SAMPLE_WEEK.map((s) => ({ day: s.day, score: s.score, hardBrakes: s.hardBrakes, cents: null })) : [];
    const ends = sample ? scoreEnds(SAMPLE_WEEK) : null;
    const road = new Road({
      signs, last: sample ? 70 : null, ahead: { short: '', long: '' }, rain: null, sky: this.skyNow(sums), empty: !sample,
      open: () => this.sample(),
    }, {
      legend: sample ? 'A sample week' : 'Each drive adds a sign to this road', kicker: LENS_KICKER.smooth, ref: null, words: false,
      val: (i) => String(SAMPLE_WEEK[i].score), tone: (i) => (ends && i === ends.hard ? 'hard' : ends && i === ends.best ? 'best' : ''),
      say: (i) => `Sample drive, smooth score ${SAMPLE_WEEK[i].score}. Opens the sample drive.`, tags: [], extra: 'skid', sparkle: ends?.best ?? null,
      base: () => 70,
    }, play);
    this.road = road;
    return h('section.my-hero', { 'aria-label': 'Your drives' },
      h('div.my-scene-box', {}, road.el, h('div.my-hero-top', {}, h('span'), accountEntry('my-acct'))));
  }

  private plate(say: string, sub: string | null): HTMLElement {
    return h('div.my-plate', {}, h('h1.my-say', { tabindex: '-1' }, say), sub ? h('p.my-key', {}, h('span', {}, sub)) : null);
  }

  private signedOut(play: boolean): void {
    // Google sign-in loads now, so the key can open Google's window straight from the tap
    if (authPhase() === 'idle') void prepare();
    this.creeks = [];
    const key = button('Sign in with Google', { kind: 'primary', icon: G_MARK, wide: true, onClick: () => this.signIn(key) });
    const sample = button('Try the sample drive', { kind: 'secondary', icon: 'play', wide: true, onClick: () => this.sample() });
    this.page(h('div.my.my-out', {},
      this.hero(true, play ? 'intro' : 'still'),
      this.plate(signedOutLine(driveSummaries().length), 'Each drive becomes a sign on your week road. Sign in to back them up and see them on any device.'),
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

  private signedIn(play: Play): void {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries();
    if (this.blocked && drive.recording) toast('End your drive first. A drive is still recording.', { icon: 'warn', ms: 4000 });
    this.blocked = false;
    if (!sums.length) {
      this.creeks = [];
      const phone = drive.canRecord, loading = syncView().busy;
      this.loadingShown = loading;
      this.page(h('div.my.my-out', {},
        this.hero(false, play),
        loading
          ? this.plate('Getting your drives.', 'They come from your Google account backup. This takes a moment.')
          : this.plate(phone ? 'Your first drive shows up here.' : 'Drives you record on your phone show up here.', 'Each drive becomes a sign on this road, with its smooth score.'),
        loading ? h('p.my-load', { role: 'status' }, h('i', { 'aria-hidden': 'true' }), h('i', { 'aria-hidden': 'true' }), h('i', { 'aria-hidden': 'true' }), h('span.sr', {}, 'Loading')) : h('div.my-out-keys', {},
          phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: () => drive.startDrive() }) : null,
          button('Try the sample drive', { kind: phone ? 'secondary' : 'primary', icon: 'play', wide: true, onClick: () => this.sample() }))), play === 'intro');
      return;
    }
    this.loadingShown = false;
    // crossings for drives that don't have them yet; redraws once found
    const finding = needsCrossings(sums);
    this.creeks = creeksFrom(sums, crossingsOf);
    void findCrossings(sums).then((more) => { if ((more || finding) && this.here && this.view === 'main') this.refresh(); });
    // trip names from schools and parks, once
    loadPlaces(() => { if (this.here && this.view === 'main') this.refresh(); });
    if (this.view === 'all') this.page(this.all(sums), false, true);
    else this.page(this.home(sums, play), false);
    if (this.refocus) {
      (app.pageEl.querySelector(this.refocus) as HTMLElement | null)?.focus({ preventScroll: true });
      this.refocus = null;
    }
  }

  private go(v: View): void {
    if (v !== 'main' && this.view === 'main') { this.app.pushStep(); this.steps++; }
    this.view = v;
    this.render('still');
    // keyboard and screen reader users land on the new page's heading
    const root = v === 'creek' || v === 'creeks' ? this.app.panel : this.app.pageEl;
    (root.querySelector(v === 'main' ? 'h1' : 'h2') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Back to the home, through history so the step it pushed goes too. */
  private toMain(): void {
    if (this.steps && (history.state as { tt?: number } | null)?.tt) history.back();
    else this.go('main');
  }

  // ---------- the week road ----------

  /** A drive's name: its first named creek, else its regular trip, its main street or its miles. */
  private title(d: DriveSummary, sums: DriveSummary[]): string {
    return driveTitleOf(d, sums);
  }

  /** The home: the verdict, the week, the road and the four questions. */
  private home(sums: DriveSummary[], play: Play): HTMLElement {
    const now = weekStart(), thisWeek = this.week === now;
    const w = weekStats(sums, this.week, crossingsOf), b = weekStats(sums, weekBefore(this.week), crossingsOf);
    const drives = w.drives, score = weekScore(drives), last = weekScore(b.drives);
    const head = weekHead(weekVerdict(score, last), drives.length, thisWeek);
    const h1 = h('h1.wr-h1', { tabindex: '-1' }, head.pre, head.em ? h('em', {}, head.em) : null, head.post);
    // the open answer's art arrives with the road; a road carried on from new data keeps its timing
    const r = this.resume, since = r?.t0 ? performance.now() - r.t0 : 0, anim = !calm() && (play !== 'still' || (!!r && r.play !== 'still'));
    const root = h(`div.wr${anim ? '.wr-anim' : ''}`, { style: anim && r ? `--d0:${Math.round(700 - since)}ms` : undefined });
    const pg = h('div.wr-page', {}, h('header.wr-head', {}, h1, this.weekRow(sums, w)));
    root.append(pg);
    if (!drives.length) { pg.append(...this.emptyWeek(sums, thisWeek)); return root; }

    const byOrder = [...drives].sort((a, c) => a.at - c.at);
    const max = this.laptop ? MAX_SIGNS.laptop : MAX_SIGNS.phone;
    const signs = signsOf(byOrder.map((d) => {
      const cs = crossingsOf(d.at);
      return { at: d.at, mi: d.mi, score: d.score, hardBrakes: d.hardBrakes, fastStarts: d.fastStarts, cents: centsRaw(d), crossed: cs ? cs.length : null, gentle: cs ? cs.filter((c) => c.gentle).length : 0 };
    }), max);
    const byDay = signs.length < drives.length;
    const spot = spotsFrom(sums)[0] ?? null;
    const qs = this.questions(sums, w, b, signs, byDay, spot, score!, last, thisWeek);
    const lensOf = (k: LensKey) => qs.find((q) => q.k === k)!.road;
    // the days still ahead: from the day after the latest drive, and never before today
    const lastDay = signs[signs.length - 1].day, from = thisWeek ? Math.max(lastDay + 1, dayOf(Date.now())) : 7;
    const road = (this.road = new Road({
      signs: signs.map((s) => ({ day: s.day, score: s.score, hardBrakes: s.hardBrakes, cents: s.cents })),
      last, ahead: { short: aheadWord(from, true), long: aheadWord(from, false) },
      rain: thisWeek ? this.rainNow(sums) : null, sky: this.skyNow(sums), empty: false,
      open: (i) => { const s = signs[i]; if (s.ats.length === 1) void this.open(s.ats[0]); else this.openList(byOrder.filter((d) => s.ats.includes(d.at)), dayName(s.ats[0]), false); },
    }, lensOf(this.lens), play, this.resume));
    this.rainLater(sums, thisWeek);
    if (this.spotMap) road.also.push((t) => this.spotMap?.tick(t));
    pg.append(road.el);
    if (this.laptop) pg.append(this.list(byOrder, sums, thisWeek));
    const acc = this.accordion(qs, (k) => road.setLens(lensOf(k)));
    // laptop: the questions and, at the foot of the column, the week's keys, so both columns start and end together
    pg.append(this.laptop ? h('div.wr-side', {}, acc, h('div.wr-side-foot', {}, ...this.weekKeys(w, spot, sums))) : acc);
    if (this.spotMap && calm()) for (const ms of [50, 800, 2500]) setTimeout(() => this.spotMap?.tick(performance.now()), ms);
    return root;
  }

  /** All drives, share the week and tell the city: in the drives sheet on a phone, under the questions on a laptop. */
  private weekKeys(w: WeekS, spot: Spot | null, sums: DriveSummary[]): (HTMLElement | null)[] {
    return [
      button(`All drives (${sums.length})`, { kind: 'secondary', icon: 'list', wide: true, onClick: () => { this.closeLayer(false); this.go('all'); } }),
      this.share(w, spot, sums),
      this.city(sums),
    ];
  }

  /** The week row: last week, the range, next week, and the drives behind a tap. */
  private weekRow(sums: DriveSummary[], w: WeekS): HTMLElement {
    const weeks = weeksOf(sums), now = weekStart(), cur = this.week;
    const older = weeks.find((x) => x < cur) ?? null, newer = [...weeks].reverse().find((x) => x > cur) ?? null;
    const step = (to: number, key: string) => { this.week = to; this.refocus = `[data-k="${key}"]`; this.render('week'); };
    const prevLabel = older == null ? 'No earlier drives'
      : `${older === weekBefore(cur) ? (cur === now ? 'Last week' : 'Week before') : 'Earlier week'}, ${weekRange(older)}`;
    const nextLabel = cur >= now ? 'Next week' : newer === now || newer == null ? 'This week' : `Next week, ${weekRange(newer)}`;
    const key = (k: string, label: string, svg: string, to: number | null) => h('button.wr-key.wr-sq', {
      type: 'button', 'data-k': k, 'aria-label': label, 'aria-disabled': to == null ? 'true' : undefined,
      onclick: () => { if (to != null) step(to, k); }, html: svg,
    });
    const pager = h('div.wr-pager', { role: 'group', 'aria-label': 'Week' },
      key('prev', prevLabel, SVG.prev, older),
      h('span.wr-range', { 'aria-live': 'polite' }, weekRange(cur)),
      key('next', nextLabel, SVG.next, cur >= now ? null : newer ?? now));
    const n = w.drives.length, ww = weekWords(cur === now);
    const sum = n ? h('button.wr-sum', {
      type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${count(n, 'drive')} ${ww.the}. Show the list.`,
      onclick: () => this.openList(w.drives, ww.drives, true),
    }, weekSum(n, w.miles)) : null;
    return h('div.wr-weekrow', {}, pager, sum);
  }

  /** No drives this week: the road waits with the car at the start, the last drive, and a key to the week it was in. */
  private emptyWeek(sums: DriveSummary[], thisWeek: boolean): HTMLElement[] {
    const lastAt = Math.max(...sums.map((s) => s.at)), lastWeek = weekStart(lastAt);
    const from = thisWeek ? dayOf(Date.now()) : 7;
    const road = (this.road = new Road({
      signs: [], last: null, ahead: { short: aheadWord(from, true), long: aheadWord(from, false) },
      rain: thisWeek ? this.rainNow(sums) : null, sky: this.skyNow(sums), empty: true, open: () => {},
    }, { legend: 'Each drive adds a sign to this road', kicker: '', ref: null, val: () => '', tone: () => '', words: false, say: () => '', tags: [], extra: null, sparkle: null, base: () => 0 }, 'still'));
    this.rainLater(sums, thisWeek);
    const see = lastWeek < this.week ? h('button.wr-key', { type: 'button', 'data-k': 'see', onclick: () => { this.week = lastWeek; this.render('week'); } },
      h('span', {}, lastWeek === weekBefore(this.week) ? `See ${weekWords(thisWeek).before}` : `See ${weekRange(lastWeek)}`)) : null;
    const before = weekScore(weekStats(sums, weekBefore(this.week), crossingsOf).drives);
    return [road.el, h('div.wr-empty', {}, h('p', {}, lastDriveLine(lastAt), before != null ? h('br') : null, before != null ? lastScoreLine(before, thisWeek) : null), see)];
  }

  /** Rain coming, from the kept NWS forecast for where you drive: 'tomorrow' and so on, or null. */
  private rainNow(sums: DriveSummary[]): string | null {
    const f = cached(areaOf(sums));
    return f ? rainAhead(f, Date.now())?.when ?? null : null;
  }

  /** The sky over the road: light by the Washington clock, weather from the kept NWS forecast. */
  private skyNow(sums: DriveSummary[]): RoadSky {
    return this.skyOf(cached(areaOf(sums)), Date.now());
  }

  /** With rain coming in the next day, the sky is never clear. */
  private skyOf(f: Forecast | null, now: number): RoadSky {
    const w = weatherOf(f, now);
    return { light: lightAt(now), weather: w === 'clear' && f && rainAhead(f, now) ? 'cloudy' : w, now };
  }

  /** The fresh forecast, when it comes, updates the sky and the rain ahead (rain ahead only on the current week). */
  private rainLater(sums: DriveSummary[], thisWeek: boolean): void {
    const road = this.road, was = this.rainNow(sums);
    void loadRain(areaOf(sums)).then((f) => {
      if (road !== this.road || !road?.el.isConnected) return;
      const now = Date.now();
      road.setSky(this.skyOf(f, now));
      const when = thisWeek && f ? rainAhead(f, now)?.when ?? null : null;
      if (thisWeek && when !== was) road.setRain(when);
    }).catch(() => {});
  }

  /** Laptop: the week's drives as plain rows under the road, each opening its map. */
  private list(drives: DriveSummary[], sums: DriveSummary[], thisWeek: boolean): HTMLElement {
    const ends = scoreEnds(drives), title = weekWords(thisWeek).drives;
    const many = drives.length > LIST_ROWS, shown = many ? drives.slice(-(LIST_ROWS - 1)) : drives;
    const tone = (d: DriveSummary) => (!ends ? '' : d === drives[ends.hard] ? 'hard' : d === drives[ends.best] ? 'best' : '');
    return h('section.wr-list', { 'aria-labelledby': 'wr-list-h' },
      h('h2', { id: 'wr-list-h' }, title),
      ...shown.map((d) => this.row(d, sums, tone(d))),
      many ? h('button.wr-row.wr-row-more', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => this.openList(drives, title, true) },
        h('span.wr-mini', { 'aria-hidden': 'true' }, String(drives.length)), h('span', {}, h('span.wr-row-t', {}, `See all ${drives.length} drives`))) : null);
  }

  /** A drive as one row: a small road sign with its score, its name, when and how far. */
  private row(d: DriveSummary, sums: DriveSummary[], tone = '', then?: () => void): HTMLElement {
    const t = this.title(d, sums), sub = `${shortDayTime(d.at)} · ${miText(d.mi)}`;
    return h('button.wr-row', {
      type: 'button', 'aria-label': `${t}, ${dayTime(d.at)}, smooth score ${d.score}. Open on the map.`,
      onclick: () => { then?.(); void this.open(d.at); },
    }, h(`span.wr-mini${d.score >= 100 ? '.wr-long' : ''}`, { 'data-tone': tone, 'aria-hidden': 'true' }, String(d.score)),
    h('span.wr-row-tx', { 'aria-hidden': 'true' }, h('span.wr-row-t', {}, t), h('span.wr-row-s', {}, sub)));
  }

  // ---------- the four questions ----------

  private questions(sums: DriveSummary[], w: WeekS, b: WeekS, signs: Sign[], byDay: boolean, spot: Spot | null, score: number, last: number | null, thisWeek: boolean): Q[] {
    const drives = w.drives, laptop = this.laptop, ww = weekWords(thisWeek);
    const legend = byDay ? LENS_LEGEND_DAY : LENS_LEGEND;
    // each question's icon in the same pixel tile, so the rows line up
    const tile = (kid: Node | string, tone = '') => h('span.wr-tile', { 'data-tone': tone }, kid);
    const sayOf = (lens: LensKey) => (i: number) => {
      const s = signs[i], v = signSay(lens, s);
      if (s.ats.length > 1) return `${dayName(s.ats[0])}, ${count(s.ats.length, 'drive')}, ${v}. Show the list.`;
      const d = drives.find((x) => x.at === s.ats[0])!;
      return `${dayTime(d.at)}, ${this.title(d, sums)}, ${v}. Open on the map.`;
    };
    const base: Pick<RoadLens, 'words' | 'sparkle' | 'base' | 'ref' | 'tags'> = { words: false, sparkle: null, base: () => 0, ref: null, tags: [] };
    // every action in an answer looks the same: a yellow line with an arrow
    const act = (text: string, onClick: () => void, o: { say?: string; svg?: string } = {}) =>
      h('button.wr-act', { type: 'button', 'aria-label': o.say, onclick: onClick }, h('span', {}, text), h('i', { 'aria-hidden': 'true', html: o.svg ?? SVG.go }));
    const p = (cls: string, ...kids: (Node | string | null)[]) => h(`p${cls}`, {}, ...kids);

    // 1. am I smoother: the score, where the points went, and the one thing to do
    const lost = weekLost(drives)!, big = biggest(lost), bl = blocks(score, lost), ends = scoreEnds(signs);
    const cells = [...Array(bl.kept)].map(() => 'k').concat([...Array(bl.brakes)].map(() => 'b'), [...Array(bl.starts)].map(() => 's'), [...Array(bl.speed)].map(() => 'v'));
    const ll = lostLine(big, big ? lost[big] : 0, 100 - score, thisWeek);
    const sp = spot ? spotParts(spot.name) : null, street = sp?.street ?? '', cross = spot ? sp!.cross || this.crossOf(spot, street) : '';
    let coach: HTMLElement | null = null;
    if (big) {
      const top = big === 'speed' ? speedRoad(drives) : '';
      const words = coachAct(big, { spot: big === 'brakes' && spot ? street : undefined, at: cross, road: top });
      const worst = worstDrive(drives, big);
      const go = big === 'brakes' && spot ? () => this.showSpot(spot) : worst ? () => void this.open(worst.at) : null;
      if (go) coach = act(words.text, go, { say: words.say, svg: big === 'brakes' && spot ? SVG.pin : SVG.go });
    }
    const bestD = drives.length > 1 ? [...drives].sort((a, c) => c.score - a.score || c.at - a.at)[0] : null;
    const smooth: Q = {
      k: 'smooth', ans: smoothAnswer(score, last, thisWeek),
      icon: tile(h('b', {}, String(score)), 'score'),
      body: [
        h('div.wr-pts', { role: 'img', 'aria-label': lostSay(score, lost, thisWeek) }, ...cells.map((c, i) => h(`i.wr-${c}`, { style: `--k:${Math.floor(i / 3)}` }))),
        laptop ? h('p.wr-pkey', { 'aria-hidden': 'true' }, ...(['brakes', 'starts', 'speed'] as const).map((k) => h(`span.wr-pk-${k}`, {}, LOST_WORD[k]))) : null,
        p('', ll.pre, ll.b ? h('b', {}, ll.b) : null, ll.post),
        coach || laptop && bestD ? h('div.wr-acts', {}, coach, laptop && bestD ? act(LENS_ACT.best, () => void this.open(bestD.at)) : null) : null,
      ],
      road: {
        ...base, legend: legend.smooth, kicker: LENS_KICKER.smooth, ref: last, refWord: ww.Before, say: sayOf('smooth'), extra: 'skid',
        val: (i) => String(signs[i].score),
        tone: (i) => (ends && i === ends.hard ? 'hard' : ends && i === ends.best ? 'best' : ''),
        tags: ends ? [
          { i: ends.hard, tone: 'hard', k: 'Hardest', t: signs[ends.hard].hardBrakes ? count(signs[ends.hard].hardBrakes, 'hard brake') : `Score ${signs[ends.hard].score}` },
          { i: ends.best, tone: 'best', k: 'Best', t: signs[ends.best].hardBrakes ? `Score ${signs[ends.best].score}` : 'No hard brakes' },
        ] : [],
        sparkle: ends ? ends.best : null,
        // scores count from last week's, so the count itself says up or down
        base: (i) => last ?? Math.max(0, signs[i].score - 12),
      },
    };

    // 2. where do I brake hard: the spot, this week there, the last passes, the voice
    const where: Q = {
      k: 'where', ans: spotAnswer(spot ? { name: street } : null, cross), icon: tile(h('span', { html: SVG.spot })), body: [],
      road: { ...base, legend: legend.where, kicker: LENS_KICKER.where, say: sayOf('where'), extra: 'skid', val: (i) => String(signs[i].hardBrakes), tone: (i) => (signs[i].hardBrakes ? 'hard' : 'quiet') },
    };
    const st = streaks(sums), sw = laptop ? streakWords(st.streak, st.best) : null;
    if (spot) {
      const here = brakesHere(spot, drives), hl = hereLine(here, w.hardBrakes, thisWeek), ps = spotPasses(spot, sums, 5), run = calmRun(ps), pl = passLine(run);
      const first = here ? signs.findIndex((s) => drives.some((d) => s.ats.includes(d.at) && brakedAt(spot, d.brakes))) : -1;
      if (first >= 0) where.road.tags = [{ i: first, tone: 'hard', k: `${here} here`, t: street || 'Your spot' }];
      if (laptop) {
        const near = drives.map((d) => routeOf(d)).map((r) => r.filter((ll2) => this.meters(ll2, spot.lngLat) < 220)).filter((r) => r.length > 1);
        const hits = drives.flatMap((d) => d.brakes.filter((x) => brakedAt(spot, [x])).map((x) => [x.lon, x.lat] as LngLat));
        this.spotMap = new SpotMap(this.app, {
          ll: spot.lngLat, heading: spot.heading, routes: near, brakes: hits, street, cross, open: () => this.showSpot(spot),
          label: `Map of ${spotAnswer({ name: street }, cross)}, with ${count(hits.length, 'hard brake')} ${ww.the} marked. Opens the big map there.`,
        });
      }
      where.body = [
        this.spotMap?.el ?? null,
        p('', hl.b ? h('b', {}, hl.b) : null, hl.post),
        ps.length ? h('div.wr-pips', {}, h('span.wr-pip-row', { role: 'img', 'aria-label': passSay(ps) }, ...[...ps].reverse().map((x, i) => h(`i.wr-pip-${x}`, { style: `--k:${i * 2}` }))), pl ? h('p', {}, pl) : null) : null,
        p('.wr-note.wr-voice', voiceNote(AHEAD_S)),
        sw ? p('', sw) : null,
        act(LENS_ACT.where, () => this.showSpot(spot)),
      ];
    } else where.body = [p('', NO_SPOT), sw ? p('', sw) : null];

    // 3. what is it costing me: cents a gallon this week against last week, an estimate
    const why = gasWhyNot(drives), whyB = b.drives.length ? gasWhyNot(b.drives) : 'short';
    const nowA = w.gas?.amount ?? (why ? null : 'Under 5¢'), lastA = b.gas?.amount ?? (whyB ? null : 'Under 5¢');
    const nowC = w.gas?.cents ?? 0, lastC = b.gas?.cents ?? 0, scale = Math.max(30, nowC, lastC);
    const bar = (c: number, cls: string) => h(`span.wr-bl${cls}`, { 'aria-hidden': 'true' }, ...[...Array(12)].map((_, i) => h(i < Math.round((c / scale) * 12) ? 'i.on' : 'i', { style: `--k:${i}` })));
    const costliestI = costliest(signs), free = freeRun(signs);
    const how = act(LENS_ACT.cost, () => this.openHow(drives));
    const cost: Q = {
      k: 'cost', ans: costAnswer(w.gas?.amount ?? null, why),
      icon: tile(h('i.wr-coin', { style: 'background-image:url(art/anim/coin-spin.png)' })),
      body: nowA ? [
        h('div.wr-gbars', { role: 'img', 'aria-label': gasSay(nowA, lastA, thisWeek) },
          h('span', { 'aria-hidden': 'true' }, ww.The), bar(nowC, ''), h('b', { 'aria-hidden': 'true' }, nowA),
          ...(lastA ? [h('span', { 'aria-hidden': 'true' }, ww.Before), bar(lastC, '.wr-last'), h('b', { 'aria-hidden': 'true' }, lastA)] : [])),
        w.gas ? p('', w.gas.pitch) : null,
        laptop && w.gas ? p('.wr-note', [w.gas.range, w.gas.price].filter(Boolean).join(' ')) : null,
        how,
      ] : [p('', why === 'ev' ? 'Electric cars burn no gas.' : `Your drives ${ww.the} add up to under 2 miles.`), why === 'ev' ? null : how],
      road: {
        ...base, legend: legend.cost, kicker: LENS_KICKER.cost, say: sayOf('cost'), extra: 'coins',
        val: (i) => (signs[i].cents == null ? '-' : String(signs[i].cents)),
        tone: (i) => (i === costliestI ? 'hard' : signs[i].cents ? '' : 'quiet'),
        tags: free ? [{
          i: signs.length - free, mid: free >= 2, tone: 'best', k: 'No extra cost',
          t: free >= 2 ? `Your last ${free} ${byDay ? 'days' : 'drives'}` : `Your last ${byDay ? 'day' : 'drive'}`,
        }] : [],
      },
    };

    // 4. am I gentle at creeks: each creek and its fish
    const wc = (this.weekCreeks = creeksFrom(drives, crossingsOf));
    // each drive's crossings are found, being found, or can't be (no route here, or offline): never stuck on "checking"
    const states = drives.map((d) => crossingState(d.at)), checking = states.filter((s) => s === 'checking').length;
    const unchecked = states.filter((s) => s === 'none').length, whyNot = creeksOffline() ? 'offline' : 'route';
    const pending = (s: Sign) => s.ats.some((at) => crossingState(at) === 'checking');
    const roughI = [...signs.keys()].reverse().find((i) => signs[i].crossed != null && signs[i].gentle < signs[i].crossed!) ?? -1;
    const roughName = roughI >= 0 ? creekName(drives.filter((d) => signs[roughI].ats.includes(d.at)).flatMap((d) => crossingsOf(d.at) ?? []).find((c) => !c.gentle)?.name ?? '') : '';
    const salmon: Q = {
      k: 'salmon', ans: creekAnswer({ drives: drives.length, known: w.known, crossed: w.crossed, gentle: w.gentle, checking }, thisWeek, whyNot),
      icon: tile(h('img', { src: 'art/icon-salmon.png', width: '48', height: '48', alt: '' })),
      body: [
        wc.length ? h('div.wr-creeks', {}, ...wc.slice(0, 3).map((c, i) => h('div', { style: `--k:${i * 2}` },
          h('img', { src: `art/drives/fish-${fishWord(c.sp)}.png`, alt: '' }),
          h('span.wr-cn', {}, creekName(c.name), laptop ? h('small', {}, speciesList(c.sp || 1)) : h('span.sr', {}, `, ${speciesList(c.sp || 1)}`)),
          h(`em${c.gentle < c.times ? '.wr-miss' : ''}`, {}, `${c.gentle} of ${c.times}`, laptop ? ' gentle' : h('span.sr', {}, ' gentle'))))) : null,
        checking ? p('', 'Looking for salmon creeks along your routes.') : null,
        !wc.length && !checking && w.known ? p('', 'Salmon creeks you drive over show up here.') : null,
        !checking && unchecked ? p('', uncheckedLine(unchecked, whyNot)) : null,
        p('.wr-note', GENTLE_NOTE, laptop ? ` ${FISH_NOTE}` : null),
        wc.length ? act(LENS_ACT.salmon, () => (wc.length === 1 ? this.openCreek(this.allTime(wc[0])) : this.go('creeks'))) : null,
      ],
      road: {
        ...base, legend: legend.salmon, kicker: LENS_KICKER.salmon, say: sayOf('salmon'), extra: 'creek', words: true,
        val: (i) => { const s = signs[i]; return s.crossed == null ? (pending(s) ? '...' : '-') : s.crossed ? `${s.gentle} of ${s.crossed}` : '-'; },
        tone: (i) => { const s = signs[i]; return s.crossed == null || !s.crossed ? 'quiet' : s.gentle < s.crossed ? 'hard' : ''; },
        tags: roughI >= 0 ? [{ i: roughI, tone: 'hard', k: 'Not gentle', t: roughName }] : [],
      },
    };
    return [smooth, where, cost, salmon];
  }

  /** The four questions: exactly one open, its answer art shown and the road showing it. Arrows move between them. */
  private accordion(qs: Q[], onLens: (k: LensKey) => void): HTMLElement {
    const box = h('div.wr-qs');
    const items = qs.map((q) => {
      const btn = h('button.wr-q-btn', { type: 'button', id: `wr-qb-${q.k}`, 'aria-controls': `wr-qd-${q.k}`, 'aria-expanded': String(q.k === this.lens) },
        h('span.wr-q-ico', { 'aria-hidden': 'true' }, q.icon),
        h('span.wr-q-t', {}, h('span.wr-q-ask', {}, LENS_ASK[q.k]), h('span.wr-q-ans', {}, q.ans)),
        h('span.wr-q-chev', { 'aria-hidden': 'true', html: SVG.chev }));
      btn.addEventListener('click', () => {
        if (this.lens === q.k) return;
        this.lens = q.k;
        if (!calm()) box.closest('.wr')?.classList.add('wr-anim', 'wr-again');
        for (const it of items) {
          const on = it.dataset.k === q.k;
          it.classList.toggle('wr-open', on);
          it.querySelector('.wr-q-btn')!.setAttribute('aria-expanded', String(on));
        }
        onLens(q.k);
      });
      return h(`div.wr-q${q.k === this.lens ? '.wr-open' : ''}`, { 'data-k': q.k },
        h('h2', {}, btn),
        h('div.wr-q-body', { id: `wr-qd-${q.k}`, role: 'region', 'aria-labelledby': `wr-qb-${q.k}` }, ...q.body));
    });
    box.append(...items);
    box.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !t.classList.contains('wr-q-btn')) return;
      const bs = [...box.querySelectorAll<HTMLElement>('.wr-q-btn')], i = bs.indexOf(t);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length;
      bs[j].focus();
      e.preventDefault();
    });
    return box;
  }

  /** The nearest street with another name within 40 m of the spot, from the streets the map has loaded. */
  private crossOf(s: Spot, street: string): string {
    try {
      const wd = this.app.world, p = wd.toWorld(s.lngLat);
      const near = wd.runsNear(p, CROSS_M).map((i) => ({ name: wd.pieceNames[wd.runs[i].piece] ?? '', d: nearestOnPolyline(p, wd.runs[i].line).d }));
      return crossPick(street, near, CROSS_M);
    } catch { return ''; }
  }

  private meters(a: LngLat, b: LngLat): number {
    const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k), y = (b[1] - a[1]) * k;
    return Math.hypot(x, y) * 6_371_000;
  }

  // ---------- the list of drives, over the page ----------

  /** A sheet over the page: a week's or a day's drives, then All drives, share, the city note and the account. */
  private openList(drives: DriveSummary[], title: string, foot: boolean): void {
    const sums = driveSummaries(), rows = [...drives].sort((a, c) => a.at - c.at);
    const ends = scoreEnds(rows), tone = (d: DriveSummary) => (!ends ? '' : d === rows[ends.hard] ? 'hard' : d === rows[ends.best] ? 'best' : '');
    const close = () => this.closeLayer(false);
    const kids: (HTMLElement | null)[] = [h('div.wr-sheet-rows', {}, ...rows.map((d) => this.row(d, sums, tone(d), close)))];
    if (foot) {
      const w = weekStats(sums, this.week, crossingsOf), spot = spotsFrom(sums)[0] ?? null;
      kids.push(h('div.wr-sheet-foot', {}, ...this.weekKeys(w, spot, sums), accountEntry('wr-acct')));
    }
    this.openLayer(sheet(kids, { title, onClose: () => this.closeLayer(true) }), title);
  }

  /** How the gas line is figured, with its sources. */
  private openHow(drives: DriveSummary[]): void {
    const car = drives.find((d) => d.car)?.car, x = gasHow(car === 'ev' ? undefined : car);
    if (!x) return;
    this.openLayer(sheet([
      ...x.body.map((t) => h('p.wr-how-p', {}, t)),
      h('details.wr-how-src', {}, h('summary', {}, 'Sources'), h('ul', {}, ...x.sources.map((s) => h('li', {}, s)))),
    ], { title: x.heading, onClose: () => this.closeLayer(true) }), x.heading);
  }

  /** A dialog over the page: Escape, the scrim or Close shuts it, and focus goes back. Tab stays inside. */
  private openLayer(content: HTMLElement, title: string): void {
    this.closeLayer(false);
    const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
    const from = document.activeElement as HTMLElement | null;
    const box = h('div.u-panel.u-raised.u-pad-l.wr-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, content);
    const layer = h(`div.wr-layer${calm() ? '' : '.wr-layer-in'}`, {}, h('div.wr-scrim', { onclick: () => this.closeLayer(true) }), box);
    layer.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const fs = [...box.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]')].filter((x) => x.getClientRects().length);
      if (!fs.length) return;
      const a = fs[0], z = fs[fs.length - 1];
      if (e.shiftKey && document.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && document.activeElement === z) { a.focus(); e.preventDefault(); }
    });
    host.append(layer);
    this.layer = {
      close: (focus = true) => {
        layer.remove();
        this.layer = null;
        if (focus && from?.isConnected) from.focus();
      },
    };
    (box.querySelector('.wr-row, button') as HTMLElement | null)?.focus();
  }

  private closeLayer(focus: boolean): void {
    this.layer?.close(focus);
  }

  /** Share your week: a picture for family with the creeks and coho, no map and no street. */
  private share(w: WeekS, s: Spot | null, sums: DriveSummary[]): HTMLElement | null {
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
    return h('div.wr-share', {}, shareWeekButton(f, this.week, 'Share your week'));
  }

  /** Tell your city about hard-brake spots that drain to salmon creeks, never near where drives start or end. */
  private city(sums: DriveSummary[]): HTMLElement | null {
    try {
      const ends = driveEnds(sums), drainAt = this.drainAt();
      const items = spotsFrom(sums).slice(0, 3).filter((s) => s.salmon && !nearEnds(s.lngLat, ends)).flatMap((s) => {
        const d = drainAt(s.lngLat);
        return d?.cls === 'creek' ? [fromSpot(s, d.receiving)] : [];
      });
      return items.length ? tellCityButton(items, 'brakes') : null;
    } catch { return null; }
  }

  // ---------- creeks on the map ----------

  /** The same creek across every drive, so its page counts them all. */
  private allTime(c: Creek): Creek {
    const m = c.marks[0];
    return this.creeks.find((x) => x.marks.some((y) => y.at === m.at && y.ll[0] === m.ll[0] && y.ll[1] === m.ll[1])) ?? c;
  }

  private openCreek(c: Creek): void {
    this.creek = c;
    this.go('creek');
  }

  /** A sheet's head: back to My drives, and a title. */
  private sheetHead(title: string): HTMLElement {
    return h('div.my-head', {},
      h('button.u-btn.u-secondary.u-square.my-sq', { type: 'button', 'aria-label': 'Back to My drives', title: 'Back to My drives', onclick: () => this.toMain(), html: glyph('back') }),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, title)));
  }

  /** The creek on the map: the drives that crossed it, a flag where each crossing was, and one sheet. */
  private creekPage(): void {
    const app = this.app, c = this.creek!;
    app.showStage();
    this.marks.show();
    const at = creekPlaces(c);
    const marks: Mark[] = at.map((p) => ({ ll: p.ll, kind: creekTone(p), fish: mainFish(c.sp) }));
    this.marks.picked = -1;
    this.marks.set(marks, true);
    this.creekSet = new Set([c.name]);
    const sums = driveSummaries(), ats = new Set(c.marks.map((m) => m.at));
    this.creekRoutes = sums.filter((d) => ats.has(d.at)).map((d) => routeOf(d).map((ll) => app.world.toWorld(ll)));
    app.clearCaption();
    const head = () => this.sheetHead(creekName(c.name));
    app.setPanel(creekSheet(c, null, head()));
    // framed once the sheet is in, so the flags sit in the open part of the map
    requestAnimationFrame(() => this.marks.fit(at.map((p) => p.ll), 900, 2.2));
    void streamOf(c.ll).then((s) => { if (s && this.here && this.view === 'creek' && this.creek === c) app.setPanel(creekSheet(c, s, head()), false, true); });
  }

  /** The week's creeks on the map: its routes, a flag at each crossing, and the creeks as rows that open each one. */
  private creeksPage(): void {
    const app = this.app, cs = this.weekCreeks;
    if (!cs.length) { this.view = 'main'; this.render('still'); return; }
    app.showStage();
    this.marks.show();
    const marks: Mark[] = cs.flatMap((c) => creekPlaces(c).map((p) => ({ ll: p.ll, kind: creekTone(p), fish: mainFish(c.sp) })));
    this.marks.picked = -1;
    this.marks.set(marks, true);
    this.creekSet = new Set(cs.map((c) => c.name).filter(Boolean));
    const sums = driveSummaries(), ats = new Set(cs.flatMap((c) => c.marks.map((m) => m.at)));
    this.creekRoutes = sums.filter((d) => ats.has(d.at)).map((d) => routeOf(d).map((ll) => app.world.toWorld(ll)));
    app.clearCaption();
    app.setPanel(h('div.u-sheet.wr-creeks-sheet', {}, this.sheetHead('Salmon creeks this week'),
      h('div.wr-sheet-rows', {}, ...cs.map((c) => h('button.wr-row.wr-creek-row', {
        type: 'button', 'aria-label': `${creekName(c.name)}, gentle ${c.gentle} of ${c.times}. Open it.`, onclick: () => this.openCreek(this.allTime(c)),
      }, h('img.wr-px', { src: `art/drives/fish-${fishWord(c.sp)}.png`, alt: '', width: '48', height: '24' }),
      h('span', { 'aria-hidden': 'true' }, h('span.wr-row-t', {}, creekName(c.name)), h('span.wr-row-s', {}, `${speciesList(c.sp || 1)} · gentle ${c.gentle} of ${c.times}`))))),
      h('p.wr-note', {}, GENTLE_NOTE)));
    requestAnimationFrame(() => this.marks.fit(marks.map((m) => m.ll), 900, 2.2));
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
    this.render('still');
  }

  /** The spot on the map; Back comes here. */
  private showSpot(s: Spot): void {
    const back = { view: this.view, scroll: this.app.pageEl.scrollTop };
    if (this.app.screens.drive.showSpot(s, 'drives')) this.away = back;
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
    return h('div.my.my-pg.my-all', {},
      h('div.my-head', {},
        h('button.u-btn.u-secondary.u-square.my-sq', { type: 'button', 'aria-label': 'Back to My drives', title: 'Back to My drives', onclick: () => this.toMain(), html: glyph('back') }),
        h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, 'All drives'), h('p.my-head-s', {}, progressSub(sums.length, miles)))),
      this.map?.el ?? null,
      h('ul.my-dr-list', {}, ...sums.map((d) => this.allRow(d, sums))));
  }

  /** A drive in All drives: when, its name and miles; one kept only as a summary can be deleted. */
  private allRow(d: DriveSummary, sums: DriveSummary[]): HTMLElement {
    const t = this.title(d, sums), sub = `${t} · ${miText(d.mi)}`, when = dayName(d.at);
    const light = (on: boolean) => this.map?.light(on ? d.at : null);
    const kids = [h('span.my-dr-when', {}, `${when}, ${shortDayTime(d.at).split(' ').slice(1).join(' ')}`), h('span.my-dr-what', {}, `Score ${d.score} · ${sub}`), h('span.u-ico', { 'aria-hidden': 'true', html: glyph('chevron', 2) })];
    if (!trackOf(d.at) && !routeInCloud(d.at)) {
      return h('li.my-dr.my-dr-flat', {}, kids[0], kids[1], h('span.my-dr-note', {}, 'Only its summary is on this phone.'), this.delKey(d.at));
    }
    return h('li', {}, h('button.my-dr', {
      type: 'button', 'aria-label': `${when}. Smooth score ${d.score}. ${sub}. Open it on the map.`,
      onclick: () => void this.open(d.at), onmouseenter: () => light(true), onmouseleave: () => light(false), onfocus: () => light(true), onblur: () => light(false),
    }, ...kids));
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

  /** Where rain at a point goes, from the drain maps, and whether it's Bonney Lake's own map. */
  private drainAt(): DrainAt {
    const app = this.app, base = app.screens.drive.baseDrains;
    return (ll: LngLat) => {
      const d = app.data.nearestDrain(ll, 50);
      return d ? { cls: app.world.drainCls(d.drain.index), receiving: d.drain.receiving, local: d.drain.index < base } : null;
    };
  }

  leave(): void {
    this.closeLayer(false);
    this.marks.hide();
    this.map?.destroy();
  }

  back(): boolean {
    if (this.layer) { this.closeLayer(true); return true; }
    if (this.view === 'main') return false;
    this.steps = Math.max(0, this.steps - 1);
    this.go('main');
    return true;
  }

  tap(p: XY): boolean {
    if (this.view !== 'creek' && this.view !== 'creeks') return false;
    const i = this.marks.hit(p);
    if (i < 0 && this.marks.picked < 0) return false;
    this.marks.pick(i);
    return true;
  }

  frame(): FrameOut {
    this.marks.place(this.app.camera.cam);
    const creek = this.view === 'creek' || this.view === 'creeks';
    return { scene: { muted: true, creeks: creek ? this.creekSet : null, replay: creek ? this.creekRoutes.map((path) => ({ path, color: ROUTE.fill })) : null } };
  }

  relayout(): void {
    this.render('still');
  }
}
