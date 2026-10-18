// My drives, behind sign-in. Signed out: how many drives are on this phone (or the pitch) and the Google key.
// Signed in: one calm scroll of short rows, score, your spots, salmon, regular trips, then every drive. Details open on a tap.
// This week's challenge is on Drive home, so it isn't here too.
import { leaksFrom, placesFromLabels, routesFrom, type Place, type Route } from '../../drive/coach/index.ts';
import type { CommunityTotals } from '../../drive/community.ts';
import { progressOf, type Progress } from '../../drive/progress.ts';
import { spotsFrom, type Spot } from '../../drive/spots.ts';
import { driveEnds, nearEnds, type DriveSummary } from '../../drive/summary.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { accountEntry, G_MARK, onPickFile, openAccount } from '../cloud/account.ts';
import { authPhase, onAuth, person, prepare, signIn, type CloudError } from '../cloud/auth.ts';
import { communityCard, communityTotals } from '../cloud/community.ts';
import { cloudNow } from '../cloud/firebase.ts';
import { signInWords } from '../cloud/words.ts';
import { h } from '../dom.ts';
import { fromSpot, tellCityButton } from '../features/city.ts';
import { bars, button, glyph, insight, panel, salmonSVG, score, scoreTone, screen, stagger, toast, type Tone } from '../ui/ui.ts';
import { count, dayWord, needMoreLine, shortDay, timeWord } from './drive-words.ts';
import { gentleSalmonLine } from './drive-words.ts';
import { driveLine, leakNote, leakRow, moneySaid, NO_SPOTS, NO_TRIPS, progressSub, salmonLine, salmonStops, savedHere, SIGN_IN, spotLine, spotMonth, tripNames, tripWords, type DrainAt } from './history-words.ts';
import { driveSummaries, forgetDrive, savedDrives } from './saved.ts';
import './history.css';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

/** drives shown before "Show all" */
const FIRST = 5;

// schools and parks name the ends of regular trips; loaded once
let places: Place[] | null = null;
let placesAsked = false;

/** Builds without motion: a redraw in place shouldn't count numbers up or light blocks again. */
function still<T>(on: boolean, build: () => T): T {
  const root = document.documentElement, add = on && !root.classList.contains('still');
  if (add) root.classList.add('still');
  try { return build(); } finally { if (add) root.classList.remove('still'); }
}

/** A section: an eyebrow, an optional note on the right, then its rows. */
function sec(name: string, note: string | null, ...kids: (Node | null)[]): HTMLElement {
  return h('section.my-sec', { 'aria-label': name },
    h('div.my-sec-head', {}, h('h2.u-eyebrow.my-eyebrow', {}, name), note ? h('span.my-note', {}, note) : null), ...kids);
}

interface RowOpts {
  icon?: string;
  tone?: Tone;
  title: string;
  sub?: Node | string | null;
  /** a figure on the right, like a score */
  end?: Node | string | null;
  /** opens something else (the map, a drive) */
  go?: () => void;
  /** shown under the row on a tap */
  more?: () => (Node | null)[];
  label?: string;
}

/** One short row: icon, a title, a line under it, a figure on the right. A tap opens it or shows more. */
function row(o: RowOpts): HTMLElement {
  const li = h('li.my-row');
  const body = [
    o.icon ? h('span.my-row-ico', { 'aria-hidden': 'true', 'data-tone': o.tone ?? 'plain', html: o.icon.trim().startsWith('<') ? o.icon : glyph(o.icon, 2) }) : null,
    h('span.my-row-text', {}, h('span.my-row-t', {}, o.title), o.sub ? h('span.my-row-s', {}, o.sub) : null),
    o.end ? h('span.my-row-end', {}, o.end) : null,
    o.go || o.more ? h('span.my-row-chev', { 'aria-hidden': 'true', html: glyph('chevron') }) : null,
  ];
  if (o.go) {
    li.append(h('button.my-row-key', { type: 'button', 'aria-label': o.label, onclick: o.go }, ...body));
  } else if (o.more) {
    const more = h('div.my-more', { hidden: true });
    const key = h('button.my-row-key', { type: 'button', 'aria-expanded': 'false', 'aria-label': o.label, onclick: () => {
      const open = more.hidden !== false;
      if (open && !more.childElementCount) more.append(...o.more!().filter((n): n is Node => !!n));
      more.hidden = !open;
      key.setAttribute('aria-expanded', String(open));
      li.classList.toggle('my-open', open);
    } }, ...body);
    li.append(key, more);
  } else {
    li.append(h('div.my-row-key.my-row-flat', {}, ...body));
  }
  return li;
}

const list = (rows: HTMLElement[]) => h('ul.my-list', {}, ...rows);

/** A quiet "How we figure this" that opens one line. */
function how(text: string, label = 'How we figure this'): HTMLElement {
  const box = h('details.my-how', {}, h('summary', {}, label), h('p', {}, text));
  return box;
}

export class HistoryScreen implements Screen {
  private readonly app: App;
  /** a drive was picked while one is still recording */
  private blocked = false;
  /** who the page was drawn for: a sign-in or sign-out redraws it */
  private shownFor: string | null = null;
  private trips = 0;
  private allDrives = false;
  private totals: Promise<CommunityTotals | null> | null = null;

  constructor(app: App) {
    this.app = app;
    // "Add a drive from a file" lives in the account sheet
    onPickFile(() => app.screens.drive.pickFile());
    onAuth(() => { if (this.here && (person()?.uid ?? null) !== this.shownFor) this.render(false); });
    // drives saved, deleted, or back from the backup
    addEventListener('tt:drives', () => { if (this.here) this.render(true); });
    addEventListener('storage', (e) => { if (this.here && e.key === 'tt-sums') this.render(true); });
  }

  private get here(): boolean {
    return this.app.tab === 'drives';
  }

  enter(): void {
    this.allDrives = false;
    this.render(false);
  }

  /** keep: redraw in place, at the same scroll, without the slide-in. */
  private render(keep: boolean): void {
    const app = this.app, who = person(), y = keep ? app.pageEl.scrollTop : 0;
    this.shownFor = who?.uid ?? null;
    const page = still(keep, () => (who ? this.signedIn() : this.signedOut()));
    if (!keep) stagger(page.firstElementChild as HTMLElement);
    app.showPage(page);
    if (keep) app.pageEl.scrollTop = y;
  }

  // ---------- signed out ----------

  private signedOut(): HTMLElement {
    // Google sign-in loads now, so the key can open Google's window straight from the tap
    if (authPhase() === 'idle') void prepare();
    const key = button('Sign in with Google', { kind: 'secondary', icon: G_MARK, wide: true, onClick: () => this.signIn(key) });
    // drives already here: say how many, not the drives themselves
    const n = driveSummaries().length, here = n ? savedHere(n) : null;
    return screen([h('div.my.my-out', {},
      h('div.my-out-art', {}, h('img', { src: 'art/tut-1-brake.png', alt: '', draggable: 'false' })),
      h('header.my-out-head', {},
        h('p.u-eyebrow.my-eyebrow', {}, 'My drives'),
        h('h1.my-title', {}, here ? here.title : SIGN_IN.title),
        ...(here ? [here.line] : SIGN_IN.lines).map((l) => h('p.my-out-line', {}, l))),
      key,
      h('p.my-privacy', {}, ico('phone'), h('span', {}, SIGN_IN.privacy)))]);
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

  private head(sub: string): HTMLElement {
    return h('header.my-head', {},
      h('div.my-head-text', {}, h('h1.my-title', {}, 'Your progress'), h('p.my-sub', {}, sub)),
      accountEntry('my-acct'));
  }

  private signedIn(): HTMLElement {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries(), phone = drive.canRecord;
    const warn = this.blocked && drive.recording;
    this.blocked = false;
    if (!sums.length) {
      return screen([h('div.my', {},
        this.head('No drives yet'),
        this.empty(phone),
        h('div.my-salmon-all', {}, h('span.my-salmon-art', { 'aria-hidden': 'true', html: salmonSVG(2) }), this.community()))]);
    }
    const miles = sums.reduce((t, s) => t + s.mi, 0), spots = spotsFrom(sums);
    return screen([h('div.my', {},
      this.head(progressSub(sums.length, miles)),
      warn ? insight({ icon: 'warn', tone: 'warn', title: 'End your drive first.', body: 'A drive is still recording.' }) : null,
      this.trend(progressOf(sums, 12)),
      this.spots(sums, spots),
      this.salmon(sums),
      this.routes(sums),
      this.list(sums))]);
  }

  /** No drives yet: one key that starts one. */
  private empty(phone: boolean): HTMLElement {
    const app = this.app, go = () => app.screens.drive.startDrive();
    return panel([
      h('div.my-empty', {},
        h('img', { src: 'art/tut-1-brake.png', alt: '', width: '256', height: '160', draggable: 'false' }),
        h('p.my-empty-line', {}, phone ? 'Your first drive shows up here.' : 'Record on your phone. It shows up here too.'),
        phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: go })
          : button('Try a sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: () => { app.setTab('drive'); void app.screens.drive.loadSample(); } })),
    ], { pad: 'm' });
  }

  /** The smooth score: the number, one verdict line, and every drive as pixel bars. */
  private trend(p: Progress): HTMLElement {
    const recent = p.recent, latest = recent[recent.length - 1];
    const avg = p.avgScore ?? latest.score, tone = scoreTone(avg);
    const verdict = p.verdictText ? `${p.verdictText}.` : needMoreLine(p.needMore);
    return h('section.u-panel.u-plain.u-pad-m.my-score', { 'aria-label': 'Your smooth score' },
      h('div.my-sec-head', {}, h('h2.u-eyebrow.my-eyebrow', {}, 'Smooth score'), h('span.my-note', {}, p.drives >= 3 ? 'Last 3 drives' : 'So far')),
      h('div.my-score-row', {},
        score(avg, { tone, countUp: true, suffix: '/100' }),
        h('p.my-verdict', { 'data-tone': p.verdict === 'smoother' ? 'money' : p.verdict === 'rougher' ? 'warn' : 'plain' }, verdict)),
      recent.length >= 2 ? bars(recent.map((d) => d.score), { labels: recent.map((d) => shortDay(d.at)), tone: 'you' }) : null);
  }

  /**
   * Your spots: the places you keep braking hard and the roads you speed on, one row each,
   * with hard brakes and tire wear or gas a month. Spots open on the map; salmon ones can go to the city.
   */
  private spots(sums: DriveSummary[], spots: Spot[]): HTMLElement {
    const app = this.app, L = leaksFrom(sums, undefined, 12);
    const rows: { month: number; n: number; el: HTMLElement }[] = spots.slice(0, 5).map((s) => {
      const m = spotMonth(s.lngLat, sums), name = s.name || 'A spot on your drives', line = spotLine(s.count, m);
      return {
        month: m ?? 0, n: s.count,
        el: row({
          icon: 'bell', tone: 'you', title: name,
          sub: h('span', {}, line, s.salmon ? h('span.my-fish', {}, ' · salmon stream') : null),
          label: `${name}: ${count(s.count, 'hard brake')}${m ? `, ${moneySaid(m)}` : ''}${s.salmon ? ', rain drains to a salmon stream' : ''}. Show on the map.`,
          go: () => app.screens.drive.showSpot(s),
        }),
      };
    });
    // speeding has no one spot: its road, gas a month, and the tip on a tap
    for (const l of L.top.filter((x) => x.kind === 'speeding').slice(0, 2)) {
      const r = leakRow(l), title = l.place || 'Fast roads';
      rows.push({
        month: l.month.typical, n: 0,
        el: row({
          icon: 'gas', tone: 'warn', title, sub: `Speeding · ${r.amount}`,
          label: `${title}: speeding, ${moneySaid(l.month.typical)}. Show the tip.`,
          more: () => [h('p', {}, r.tip)],
        }),
      });
    }
    if (!rows.length) return sec('Your spots', null, list([row({ icon: 'bell', title: NO_SPOTS.title, sub: NO_SPOTS.body })]));
    rows.sort((x, y) => y.month - x.month || y.n - x.n);
    const drainAt = this.drainAt();
    // the note to the city never names a spot near where drives start or end (usually home)
    const ends = driveEnds(driveSummaries());
    const items = spots.filter((s) => s.salmon && !nearEnds(s.lngLat, ends)).slice(0, 3).flatMap((s) => {
      const d = drainAt(s.lngLat);
      return d?.cls === 'creek' ? [fromSpot(s, d.receiving)] : [];
    });
    const money = rows.some((r) => r.month > 0);
    return sec('Your spots', spots.length ? 'It warns you ahead' : null, list(rows.map((r) => r.el)),
      money ? how(leakNote(L), 'How we figure the money') : null,
      items.length ? tellCityButton(items, 'brakes') : null);
  }

  /** Where rain at a point goes, from the drain maps, and whether it's Bonney Lake's own map. */
  private drainAt(): DrainAt {
    const app = this.app, base = app.screens.drive.baseDrains;
    return (ll: LngLat) => {
      const d = app.data.nearestDrain(ll, 50);
      return d ? { cls: app.world.drainCls(d.drain.index), receiving: d.drain.receiving, local: d.drain.index < base } : null;
    };
  }

  /** Gentle stops where rain flows to salmon streams: this driver's, then every driver's, one line each. */
  private salmon(sums: DriveSummary[]): HTMLElement {
    let x;
    try { x = salmonStops(sums, this.drainAt()); } catch { x = { gentle: 0, water: null, local: true }; }
    return sec('Salmon', null, h('div.u-panel.u-plain.u-pad-m.my-salmon', {},
      h('span.my-salmon-art', { 'aria-hidden': 'true', html: salmonSVG(3) }),
      h('div.my-salmon-text', {},
        h('p.my-salmon-t', {}, gentleSalmonLine(2).replace(/^\d+ g/, 'G')),
        h('p.my-salmon-figs', {}, h('span.f-community-fig', {}, h('b', {}, String(x.gentle)), h('span', {}, 'yours')), this.community(true))),
      h('p.my-salmon-line', {}, salmonLine(x))));
  }

  /** Trips driven again and again: how smooth they are; the last two side by side on a tap. */
  private routes(sums: DriveSummary[]): HTMLElement {
    if (!places) this.askPlaces();
    const routes = routesFrom(sums, places ?? []).slice(0, 3), names = tripNames(routes);
    this.trips = routes.length;
    if (!routes.length) return sec('Regular trips', null, list([row({ icon: 'route', title: NO_TRIPS.title, sub: NO_TRIPS.body })]));
    const rowOf = (r: Route, i: number) => {
      const w = tripWords(r, names[i]);
      return row({
        icon: 'route', tone: 'soak', title: w.title, sub: w.sub,
        end: h('b.my-score-n', { 'data-tone': scoreTone(r.avgScore), 'aria-hidden': 'true' }, String(r.avgScore)),
        label: `${w.title}: ${w.sub}, average score ${r.avgScore}. Compare the last two.`,
        more: () => w.days.map((d) => h('p', {}, d)),
      });
    };
    return sec('Regular trips', 'Average score', list(routes.map(rowOf)));
  }

  /** labels.json for trip names; trips on screen get their names when it arrives. */
  private askPlaces(): void {
    if (placesAsked) return;
    placesAsked = true;
    fetch('data/labels.json').then((r) => (r.ok ? r.json() : null)).then((j: unknown) => {
      places = placesFromLabels(j as Parameters<typeof placesFromLabels>[0]);
      if (this.here && this.trips) this.render(true);
    }).catch(() => { places = []; });
  }

  /** Everyone's total, asked once a visit (again after a miss); hidden until it comes. */
  private community(figure = false): HTMLElement {
    const el = communityCard({ totals: null, figure }), got = (this.totals ??= communityTotals());
    void got.then((t) => {
      if (!t) { if (this.totals === got) this.totals = null; return; }
      if (el.isConnected) el.replaceWith(communityCard({ totals: t, figure }));
    });
    return el;
  }

  /** Every saved drive, newest first: day, miles, score. Ones with their track open; delete is inside. */
  private list(sums: DriveSummary[]): HTMLElement {
    const app = this.app, tracks = new Set(savedDrives().map((d) => d.at));
    const open = (at: number) => {
      // opening a saved drive mid-recording would leave the recording half on screen
      if (app.screens.drive.openSaved(at)) return;
      this.blocked = true;
      this.render(false);
    };
    const rowOf = (d: DriveSummary) => {
      const can = tracks.has(d.at), when = `${dayWord(d.at)} · ${timeWord(d.at)}`;
      const end = h('b.my-score-n', { 'data-tone': scoreTone(d.score), 'aria-hidden': 'true' }, String(d.score));
      const said = `${when}, ${driveLine(d)}, score ${d.score}.`;
      if (can) return row({ title: when, sub: driveLine(d), end, label: `${said} Open it.`, go: () => open(d.at) });
      // only the summary is here: say so, and delete stays one tap away
      return row({
        title: when, sub: driveLine(d), end, label: `${said} More.`,
        more: () => [h('p', {}, 'Only its summary is on this phone, not its route.'), this.delKey(d.at)],
      });
    };
    const shown = this.allDrives ? sums : sums.slice(0, FIRST);
    const rest = sums.length - shown.length;
    return sec('Your drives', null, list(shown.map(rowOf)),
      rest > 0 ? button(`Show all ${sums.length} drives`, { kind: 'ghost', onClick: () => { this.allDrives = true; this.render(true); } }) : null);
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

  leave(): void {}

  tap(_p: XY): boolean {
    return false;
  }

  frame(): FrameOut {
    return { scene: {} };
  }

  relayout(): void {
    this.render(false);
  }
}
