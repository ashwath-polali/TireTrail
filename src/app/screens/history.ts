// My drives, behind sign-in. Signed out: how many drives are on this phone (or the pitch) and the Google key.
// Signed in, salmon first: this week (streams crossed, tire dust, gas cents), your spots, every drive, trips, salmon stops.
// This week's challenge is on Drive home, so it isn't here too.
import { placesFromLabels, routesFrom, type Place, type Route } from '../../drive/coach/index.ts';
import type { CommunityTotals } from '../../drive/community.ts';
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
import { h } from '../dom.ts';
import { fromSpot, tellCityButton } from '../features/city.ts';
import { gramsText } from '../../drive/dust.ts';
import { gasHabits, gasWeek, type GasWeek } from '../../drive/gas.ts';
import { button, calm, glyph, insight, panel, salmonSVG, score, scoreTone, screen, stagger, toast, type Tone } from '../ui/ui.ts';
import { count, dayWord, pctVs, timeWord, vsTone, vsWord } from './drive-words.ts';
import { gentleSalmonLine } from './drive-words.ts';
import { driveLine, dustTrend, dustWeek, goalWord, NO_SPOTS, NO_TRIPS, progressSub, salmonLine, salmonStops, savedHere, SIGN_IN, streamsWeek, streamsWord, tripNames, tripWords, type DrainAt } from './history-words.ts';
import { creekStrip } from './pixel-anim.ts';
import { fillStreams } from './streams.ts';
import { driveSummaries, forgetDrive, trackOf } from './saved.ts';
import './history.css';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Tire dust vs typical, drive by drive, as pixel columns from the typical line: down is less, up is more. */
function dustSpark(pcts: number[]): HTMLElement | null {
  if (pcts.length < 2) return null;
  // 1 pixel for each 3%, up to 30%; 3 CSS px a pixel
  const W = 4, mid = 10, H = 2 * mid + 1;
  const bars = pcts.map((p, i) => {
    const flat = Math.abs(p) < 3, ht = flat ? 1 : Math.max(1, Math.round(Math.min(Math.abs(p), 30) / 3));
    const tone = p <= -3 ? 'money' : p >= 3 ? 'warn' : 'text-3';
    return `<rect x="${i * W}" y="${flat ? mid : p < 0 ? mid + 1 : mid - ht}" width="3" height="${ht}" fill="var(--${tone})"/>`;
  }).join('');
  const w = pcts.length * W - 1;
  const svg = `<svg viewBox="0 0 ${w} ${H}" width="${w * 3}" height="${H * 3}" shape-rendering="crispEdges" aria-hidden="true"><rect x="0" y="${mid}" width="${w}" height="1" fill="var(--rim-mid)"/>${bars}</svg>`;
  const el = h('div.my-spark', { role: 'img', 'aria-label': `Tire dust on your last ${pcts.length} drives, against typical` },
    h('span.my-spark-svg', { html: svg }), h('span.my-spark-cap', { 'aria-hidden': 'true' }, h('b', {}, `Last ${pcts.length} drives`), h('span', {}, 'Line: typical')));
  if (!calm()) { el.classList.add('my-spark-in'); el.style.setProperty('--n', String(pcts.length)); }
  return el;
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
      this.week(sums),
      this.spots(sums, spots),
      this.list(sums),
      this.routes(sums),
      this.salmon(sums))]);
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

  /** This week, salmon first: a creek with a coho for each stream crossed, tire dust vs typical with its trend, then the gas cents. */
  private week(sums: DriveSummary[]): HTMLElement {
    const w = dustWeek(sums), fish = streamsWeek(sums), gas = gasWeek(sums);
    // crossings for drives saved before they were kept, from routes on this phone; redraws once counted
    if (fish.known < fish.drives) void fillStreams(sums, Date.now() - 7 * 86_400_000).then((more) => { if (more && this.here) this.render(true); });
    const head = h('div.my-sec-head', {}, h('h2.u-eyebrow.my-eyebrow', {}, 'This week'), w ? h('span.my-note', {}, count(w.drives, 'drive')) : null);
    const said = fish.known ? `${fish.n} ${streamsWord(fish.n)} this week` : 'Salmon streams you cross show here';
    const creek = h('div.my-wk-creek', {}, creekStrip({ fish: fish.n, label: said }),
      fish.known
        ? h('div.my-wk-fish', {}, score(fish.n, { suffix: streamsWord(fish.n), tone: 'salmon', countUp: true }))
        : h('p.my-wk-none', {}, fish.drives ? 'Salmon streams show after your next drive.' : 'No drives this week yet.'));
    if (!w) return h('section.u-panel.u-plain.u-pad-m.my-week', { 'aria-label': 'This week' }, head, creek, gas ? this.gasRow(gas) : null);
    const tone = vsTone(w.pct), goal = goalWord(w.pct), g = w.mg / 1000;
    return h('section.u-panel.u-plain.u-pad-m.my-week', { 'aria-label': 'This week' },
      head,
      creek,
      h('div.my-wk-dust', {},
        h('div.my-score-row', {},
          score(g, { suffix: 'g tire dust', decimals: g < 0.995 ? 2 : g < 9.95 ? 1 : 0, tone, countUp: true }),
          h('p.my-verdict', { 'data-tone': tone }, vsWord(w.pct))),
        dustSpark(dustTrend(sums)),
        h('p.my-goal', { 'data-met': String(goal.met) }, h('span', { 'aria-hidden': 'true', html: glyph(goal.met ? 'trophy' : 'star', 2) }), h('span', {}, goal.text), h('span.my-goal-typ', {}, `Typical: ${gramsText(w.typMg)}`))),
      gas ? this.gasRow(gas) : null);
  }

  /** The cents the week's habits added to every gallon, an estimate. */
  private gasRow(w: GasWeek): HTMLElement {
    const c = w.cents.typical, big = c < 97.5 ? Math.round(c / 5) * 5 : Math.round(c / 10) / 10;
    return h('div.my-wk-gas', {},
      h('span.my-wk-gas-ico', { 'aria-hidden': 'true', html: glyph('gas', 2) }),
      h('div.my-wk-gas-n', {}, score(big, c < 97.5 ? { suffix: '¢', tone: 'warn', countUp: true } : { prefix: '$', decimals: 2, tone: 'warn', countUp: true })),
      h('p.my-wk-gas-t', {}, h('b', {}, `added to every gallon${w.last ? ' last week' : ''}`), h('span', {}, `${cap(gasHabits(w))} · estimate`)));
  }

  /** Your spots: the places you keep braking hard, one row each. They open on the map; salmon ones can go to the city. */
  private spots(sums: DriveSummary[], spots: Spot[]): HTMLElement {
    const app = this.app;
    const rows = spots.slice(0, 5).map((s) => {
      const name = s.name || 'A spot on your drives';
      return row({
        icon: 'bell', tone: 'you', title: name,
        sub: h('span', {}, count(s.count, 'hard brake'), s.salmon ? h('span.my-fish', {}, ' · salmon stream') : null),
        label: `${name}: ${count(s.count, 'hard brake')}${s.salmon ? ', rain drains to a salmon stream' : ''}. Show on the map.`,
        go: () => app.screens.drive.showSpot(s),
      });
    });
    if (!rows.length) return sec('Your spots', null, list([row({ icon: 'bell', title: NO_SPOTS.title, sub: NO_SPOTS.body })]));
    const drainAt = this.drainAt();
    // the note to the city never names a spot near where drives start or end (usually home)
    const ends = driveEnds(sums);
    const items = spots.filter((s) => s.salmon && !nearEnds(s.lngLat, ends)).slice(0, 3).flatMap((s) => {
      const d = drainAt(s.lngLat);
      return d?.cls === 'creek' ? [fromSpot(s, d.receiving)] : [];
    });
    return sec('Your spots', 'It warns you ahead', list(rows), items.length ? tellCityButton(items, 'brakes') : null);
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
      x.water ? h('p.my-salmon-line', {}, salmonLine(x)) : null));
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
    const app = this.app;
    let fetching = false;
    const open = async (at: number) => {
      // a route from another device loads on the first open
      if (!trackOf(at)) {
        if (fetching) return;
        fetching = true;
        const ok = await fetchRoute(at);
        fetching = false;
        if (!ok) { toast("Can't load this route right now.", { icon: 'warn' }); return; }
      }
      // opening a saved drive mid-recording would leave the recording half on screen
      if (app.screens.drive.openSaved(at)) return;
      this.blocked = true;
      this.render(false);
    };
    const rowOf = (d: DriveSummary) => {
      const can = !!trackOf(d.at) || routeInCloud(d.at), when = `${dayWord(d.at)} · ${timeWord(d.at)}`;
      // tire dust vs typical; drives saved before it was kept show their score
      const pct = d.dustMg != null && d.typMg ? pctVs(d.dustMg, d.typMg) : null;
      const end = pct != null
        ? h('b.my-score-n.my-pct', { 'data-tone': vsTone(pct), 'aria-hidden': 'true' }, pct >= 3 ? `+${pct}%` : pct <= -3 ? `${pct}%` : '0%')
        : h('b.my-score-n', { 'data-tone': scoreTone(d.score), 'aria-hidden': 'true' }, String(d.score));
      const said = `${when}, ${driveLine(d)}, ${pct != null ? `tire dust ${Math.abs(pct) < 3 ? 'about typical' : `${vsWord(pct)} than typical`}` : `score ${d.score}`}.`;
      if (can) return row({ title: when, sub: driveLine(d), end, label: `${said} Open it.`, go: () => void open(d.at) });
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
