// My drives: your creeks on the map, one week at a time, and a sheet with one sentence, the spot to watch and recent drives.
// All drives and More (the week against the week before, creeks, spots, trips) open in the same sheet. Signed out: one line and Sign in.
import { placesFromLabels, routesFrom, type Place } from '../../drive/coach/index.ts';
import type { CommunityTotals } from '../../drive/community.ts';
import { creeksFrom, creekTone, SAME_CREEK_M, SAME_SPOT_M, weekAfter, weekBefore, weeksOf, weekStats, type Creek, type Crossing } from '../../drive/creeks.ts';
import { weekStart } from '../../drive/gas.ts';
import { spotsFrom, type Spot } from '../../drive/spots.ts';
import { driveEnds, nearEnds, type DriveSummary } from '../../drive/summary.ts';
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
import { button, glyph, salmonSVG, stagger, toast } from '../ui/ui.ts';
import { count, dayWord, timeWord } from './drive-words.ts';
import { crossingsOf, findCrossings, needsCrossings, sampleCrossings } from './history-creeks.ts';
import { Marks, type Mark } from './history-map.ts';
import {
  cohoWords, creekLine, driveName, DUST_WHY, ESTIMATES, moreLines, PPDQ, progressSub, salmonLine, salmonStops, signedOutLine, tripNames, tripWords, watchWords, weekLabel, weekSentence,
  type DrainAt, type SalmonStops,
} from './history-words.ts';
import { driveSummaries, forgetDrive, trackOf } from './saved.ts';
import './history.css';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const square = (label: string, icon: string, onclick: () => void, disabled = false) =>
  h('button.u-btn.u-secondary.u-square.my-sq', { type: 'button', 'aria-label': label, title: label, disabled, onclick, html: glyph(icon) });

/** coho shown in a row before "+n" */
const ROW_MAX = 12;
/** in a drive's tile or row */
const DRIVE_MAX = 3;

// schools and parks name the ends of regular trips; loaded once
let places: Place[] | null = null;
let placesAsked = false;

type View = 'main' | 'all' | 'more';

/** One coho per crossing: gentle ones in color, the rest gray. */
function cohoRow(cs: readonly Pick<Crossing, 'gentle'>[], cls: string, scale: number, play: boolean, most = ROW_MAX): HTMLElement {
  const sorted = [...cs].sort((a, b) => Number(b.gentle) - Number(a.gentle)), shown = sorted.slice(0, most), more = sorted.length - shown.length;
  return h(cls, {},
    ...shown.map((c, i) => h(`span.my-c${c.gentle ? '' : '.my-c-rough'}${play ? '.my-pop' : ''}`, { style: play ? `animation-delay:${360 + i * 70}ms` : undefined, html: salmonSVG(scale) })),
    more > 0 ? h('span.my-c-more', {}, `+${more}`) : null);
}

/** Is this creek one of those crossings? */
const sameCreek = (k: Creek, c: Crossing) => k.name === c.name && Math.hypot((k.ll[0] - c.ll[0]) * 75_000, (k.ll[1] - c.ll[1]) * 111_000) <= (c.name ? SAME_CREEK_M : SAME_SPOT_M);

export class HistoryScreen implements Screen {
  private readonly app: App;
  private readonly marks: Marks;
  /** a drive was picked while one is still recording */
  private blocked = false;
  private view: View = 'main';
  /** Monday of the week shown */
  private week = weekStart();
  private creeks: Creek[] = [];
  private spot: Spot | null = null;
  /** what the map was last framed on */
  private framed = '';
  /** your own marks dropped in this visit */
  private dropped = false;
  private trips = 0;
  private totals: Promise<CommunityTotals | null> | null = null;

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
    this.dropped = false;
    this.week = weekStart();
    this.framed = '';
    this.marks.picked = -1;
    this.render(true);
  }

  /** play: a fresh visit, so things slide and drop in */
  private render(play: boolean): void {
    const app = this.app;
    app.showStage();
    this.marks.show();
    if (person()) this.signedIn(play);
    else this.signedOut(play);
  }

  // ---------- the map ----------

  /** The key in the caption: what the colors on the map mean. */
  private key(sample: boolean): void {
    const fish = (tone: string) => `<i class="my-k-fish" data-kind="${tone}">${salmonSVG(1)}</i>`;
    this.app.setCaption(sample ? 'my-key-sample' : 'my-key', salmonSVG(2), sample
      ? '<span class="say my-key">Sample creeks from a drive near Spanaway</span>'
      : `<span class="say my-key"><span class="my-k">${fish('gentle')}Gentle</span><span class="my-k">${fish('mixed')}Hard brake near</span>${this.spot ? `<span class="my-k"><i class="my-k-bell">${glyph('bell', 1)}</i>Your spot</span>` : ''}</span>`);
  }

  /** Marks on the map, framed once per set of places. */
  /** a sample still loading is dropped once this moves on */
  private sampleTok = 0;

  private mapMarks(marks: Mark[], play: boolean): void {
    this.marks.set(marks, play);
    const key = marks.map((m) => `${m.kind}${m.ll.join()}`).join(';');
    if (key !== this.framed && marks.length) {
      this.framed = key;
      this.marks.fit(marks.map((m) => m.ll), play ? 900 : 600);
    }
  }

  /** The sample drive's creeks, dimmed, while there are none of your own. */
  private sampleMap(play: boolean): void {
    this.key(true);
    const tok = ++this.sampleTok;
    void sampleCrossings().then((cs) => {
      if (!this.here || tok !== this.sampleTok) return;
      this.mapMarks(cs.map((c): Mark => ({ ll: c.ll, kind: 'sample', dim: true })), play);
    });
  }

  // ---------- signed out ----------

  private signedOut(play: boolean): void {
    // Google sign-in loads now, so the key can open Google's window straight from the tap
    if (authPhase() === 'idle') void prepare();
    this.creeks = [];
    this.spot = null;
    const key = button('Sign in with Google', { kind: 'primary', icon: G_MARK, wide: true, onClick: () => this.signIn(key) });
    // drives already here: say how many, not the drives themselves
    this.panel(h('div.my-sheet.my-out', {}, h('h1.my-say', {}, signedOutLine(driveSummaries().length)), key), play);
    this.sampleMap(play);
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

  private panel(el: HTMLElement, play: boolean): void {
    if (play) stagger(el);
    this.app.setPanel(el);
  }

  private signedIn(play: boolean): void {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries();
    if (this.blocked && drive.recording) toast('End your drive first. A drive is still recording.', { icon: 'warn', ms: 4000 });
    this.blocked = false;
    if (!sums.length) {
      this.creeks = [];
      this.spot = null;
      const phone = drive.canRecord;
      this.panel(h('div.my-sheet.my-out', {},
        h('div.my-top', {}, h('h1.my-say', {}, phone ? 'Your first drive shows up here.' : 'Drives you record on your phone show up here.'), accountEntry('my-acct')),
        phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: () => drive.startDrive() })
          : button('Try the sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: () => { app.setTab('drive'); void drive.loadSample(); } })), play);
      this.sampleMap(play);
      return;
    }
    // crossings for drives that don't have them yet; redraws once found
    const finding = needsCrossings(sums);
    this.creeks = creeksFrom(sums, crossingsOf);
    // nothing known yet: the map waits for the creeks rather than flying twice
    const hold = finding && !this.creeks.length;
    void findCrossings(sums).then((more) => { if ((more || hold) && this.here) this.render(false); });
    this.spot = spotsFrom(sums)[0] ?? null;
    const w = weekStats(sums, this.week, crossingsOf);
    const inWeek = w.drives.flatMap((d) => crossingsOf(d.at) ?? []);
    const marks: Mark[] = this.creeks.map((c) => ({ ll: c.ll, kind: creekTone(c), dim: !inWeek.some((x) => sameCreek(c, x)) }));
    if (this.spot) marks.push({ ll: this.spot.lngLat, kind: 'spot' });
    this.sampleTok++;
    if (hold) {
      this.marks.set([], false);
      this.app.setCaption('my-finding', salmonSVG(2), '<span class="say">Finding the salmon creeks on your drives</span>');
    } else if (marks.length) {
      this.key(false);
      // the first time your own creeks show this visit, they drop in, even after the sample's
      this.mapMarks(marks, play || !this.dropped);
      this.dropped = true;
    } else {
      this.marks.set([], false);
      this.app.setCaption('my-none', salmonSVG(2), '<span class="say">Salmon creeks you cross show here</span>');
    }
    if (this.view === 'all') this.panel(this.all(sums), false);
    else if (this.view === 'more') this.panel(this.more(sums), false);
    else this.panel(this.main(sums, w, play), play);
  }

  /** history steps taken for All drives and More, so the phone's Back comes back here */
  private steps = 0;

  private go(v: View): void {
    if (v !== 'main' && this.view === 'main') { this.app.pushStep(); this.steps++; }
    this.view = v;
    this.render(false);
    // keyboard and screen reader users land on the new sheet's heading
    (this.app.panel.querySelector('h1, h2') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** The main sheet: the week, its sentence and coho, the spot to watch, its drives, then All drives and More. */
  private main(sums: DriveSummary[], w: ReturnType<typeof weekStats<DriveSummary>>, play: boolean): HTMLElement {
    const weeks = weeksOf(sums), i = weeks.indexOf(this.week), now = weekStart();
    const older = weeks.find((x) => x < this.week) ?? null;
    const step = (to: number) => { this.week = to; this.marks.picked = -1; this.render(false); };
    const label = weekLabel(this.week);
    const nav = h('div.my-top', {},
      h('div.my-week', { role: 'group', 'aria-label': 'Week' },
        square('Week before', 'back', () => older != null && step(older), older == null),
        h('p.my-week-name', { 'aria-live': 'polite' }, label),
        square('Week after', 'chevron', () => step(i > 0 ? weeks[i - 1] : weekAfter(this.week)), this.week >= now)),
      accountEntry('my-acct'));
    const cs = w.drives.flatMap((d) => crossingsOf(d.at) ?? []);
    const say = weekSentence({ drives: w.drives.length, known: w.known, crossed: w.crossed, gentle: w.gentle }, this.week === now);
    const row = cs.length ? cohoRow(cs, 'div.my-coho', 2, play) : null;
    if (row) { row.setAttribute('role', 'img'); row.setAttribute('aria-label', cohoWords(w.gentle, w.crossed)); }
    const s = this.spot, sw = s ? watchWords(s) : null;
    const watch = s && sw ? h('button.my-watch', { type: 'button', 'aria-label': `${sw.line}. ${sw.sub} Show it on the map.`, onclick: () => this.pickSpot() },
      h('span.my-watch-ico', { 'aria-hidden': 'true', html: glyph('bell', 2) }), h('span.my-watch-t', {}, sw.line), ico('chevron')) : null;
    return h('div.my-sheet', {},
      nav,
      h('h1.my-say', { tabindex: '-1' }, say),
      row,
      watch,
      w.drives.length ? this.strip(w.drives) : null,
      h('div.my-foot', {},
        button('All drives', { kind: 'secondary', icon: 'list', onClick: () => this.go('all') }),
        button('More', { kind: 'secondary', icon: 'info', onClick: () => this.go('more') })));
  }

  /** The week's drives, side by side: a name, the day, and a coho for each creek. A tap opens the report. */
  private strip(drives: DriveSummary[]): HTMLElement {
    return h('ul.my-strip', { 'aria-label': `${weekLabel(this.week)}: drives` }, ...drives.map((d) => {
      const cs = crossingsOf(d.at), name = driveName(d, cs), when = `${dayWord(d.at)} ${timeWord(d.at)}`;
      const fish = cs?.length ? `, ${cohoWords(cs.filter((c) => c.gentle).length, cs.length)} at salmon creeks` : '';
      return h('li', {}, h('button.my-drv', { type: 'button', 'aria-label': `${name}, ${when}, ${d.mi.toFixed(1)} mi${fish}. Open it.`, onclick: () => void this.open(d.at) },
        h('span.my-drv-t', {}, name),
        h('span.my-drv-s', {}, `${dayWord(d.at).replace(/, \w+ \d+$/, '')} · ${d.mi < 10 ? d.mi.toFixed(1) : Math.round(d.mi)} mi`),
        cs?.length ? cohoRow(cs, 'span.my-drv-c', 2, false, DRIVE_MAX) : h('span.my-drv-c.my-drv-none', {}, 'No creeks')));
    }));
  }

  /** The spot to watch: picked on the map, in the caption. */
  private pickSpot(): void {
    const s = this.spot;
    if (!s) return;
    const i = this.creeks.length;
    this.marks.pick(i);
    this.say(i);
    this.marks.fit([s.lngLat], 700);
    this.framed = '';
  }

  /** The caption for a picked mark, else the key. */
  private say(i: number): void {
    const c = this.creeks[i], s = this.spot;
    if (c) this.app.setCaption(`my-c:${i}:${c.times}:${c.gentle}`, salmonSVG(2), `<span class="say">${esc(creekLine(c))}</span>`);
    else if (s && i === this.creeks.length) {
      const w = watchWords(s);
      this.app.setCaption(`my-s:${s.id}`, glyph('bell', 3), `<span class="say"><b>${esc(s.name || 'Your spot')}</b><br>${esc(w.sub)}</span>`);
    } else this.key(!this.creeks.length && !s);
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
    if (this.app.screens.drive.openSaved(at)) return;
    this.blocked = true;
    this.render(false);
  }

  /** A sheet's head: back to the main sheet, and a title. */
  private head(title: string, sub?: string): HTMLElement {
    return h('div.my-head', {},
      // through history, so the step it pushed goes too
      square('Back', 'back', () => { if (this.steps && (history.state as { tt?: number } | null)?.tt) history.back(); else this.go('main'); }),
      h('div.my-head-t', {}, h('h2.my-h', { tabindex: '-1' }, title), sub ? h('p.my-head-s', {}, sub) : null));
  }

  // ---------- All drives ----------

  private all(sums: DriveSummary[]): HTMLElement {
    const miles = sums.reduce((t, s) => t + s.mi, 0);
    const rowOf = (d: DriveSummary) => {
      const cs = crossingsOf(d.at), name = driveName(d, cs), when = `${dayWord(d.at)} · ${timeWord(d.at)}`;
      const sub = `${when} · ${d.mi < 10 ? d.mi.toFixed(1) : Math.round(d.mi)} mi${d.hardBrakes ? ` · ${count(d.hardBrakes, 'hard brake')}` : ''}`;
      const fish = cs?.length ? cohoRow(cs, 'span.my-drv-c', 2, false, DRIVE_MAX) : null;
      if (trackOf(d.at) || routeInCloud(d.at)) {
        return h('li', {}, h('button.my-row', { type: 'button', 'aria-label': `${name}, ${sub}. Open it.`, onclick: () => void this.open(d.at) },
          h('span.my-row-t', {}, name), h('span.my-row-s', {}, sub), fish, ico('chevron')));
      }
      // only the summary is here: say so, and delete stays one tap away
      return h('li.my-row.my-row-flat', {}, h('span.my-row-t', {}, name), h('span.my-row-s', {}, `${sub}. Only its summary is on this phone.`), this.delKey(d.at));
    };
    return h('div.my-sheet.my-all', {}, this.head('All drives', progressSub(sums.length, miles)), h('ul.my-rows', {}, ...sums.map(rowOf)));
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
    const sec = (title: string, ...kids: (Node | null)[]) => h('section.my-sec', {}, h('h3.my-sec-h', {}, title), ...kids);
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
    return h('div.my-sheet.my-moresheet', {},
      this.head(weekLabel(this.week), w.drives.length ? `${count(w.drives.length, 'drive')}, against the week before` : undefined),
      w.drives.length ? h('ul.my-lines', {},
        line('stop', lines.brakes),
        lines.gas ? line('gas', lines.gas) : null,
        lines.dust ? line('tire', lines.dust, DUST_WHY) : null) : h('p.my-p', {}, 'No drives that week.'),
      this.creeks.length ? sec('Your creeks', h('ul.my-lines', {}, ...this.creeks.slice(0, 8).map((c) =>
        h('li.my-line', {}, h('span.my-k-fish', { 'data-kind': creekTone(c), 'aria-hidden': 'true', html: salmonSVG(1) }), h('span', {}, creekLine(c)))),
        stops?.gentle ? line('drop', `${count(stops.gentle, 'gentle stop')} where rain drains to a salmon stream.`, salmonLine(stops)) : null)) : null,
      spots.length ? sec('Spots to watch', h('ul.my-lines', {}, ...spots.map((s) => {
        const sw = watchWords(s);
        return h('li', {}, h('button.my-row', { type: 'button', 'aria-label': `${sw.line}. ${sw.sub} Open it.`, onclick: () => app.screens.drive.showSpot(s) },
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
    const i = this.marks.hit(p);
    if (i < 0) {
      if (this.marks.picked < 0) return false;
      this.marks.pick(-1);
      this.say(-1);
      return true;
    }
    this.marks.pick(i);
    this.say(i);
    return true;
  }

  frame(): FrameOut {
    this.marks.place(this.app.camera.cam);
    return { scene: { muted: true } };
  }

  relayout(): void {
    this.framed = '';
    this.render(false);
  }
}
