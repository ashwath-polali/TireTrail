// My drives, behind sign-in. Signed out: why to sign in, and the Google key. Signed in: this week's goal, money leaks,
// regular trips, the score trend, hard-brake spots, everyone's totals, the backup, then every drive.
import { leaksFrom, placesFromLabels, routesFrom, type Place, type Route } from '../../drive/coach/index.ts';
import type { CommunityTotals } from '../../drive/community.ts';
import { progressOf, type Progress } from '../../drive/progress.ts';
import { spotsFrom, type Spot } from '../../drive/spots.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { accountCard, openAccount, PRIVACY_LINE } from '../cloud/account.ts';
import { authPhase, onAuth, person, prepare, signIn, type CloudError } from '../cloud/auth.ts';
import { communityCard, communityTotals } from '../cloud/community.ts';
import { cloudNow } from '../cloud/firebase.ts';
import { signInWords } from '../cloud/words.ts';
import { h } from '../dom.ts';
import { challengeCard } from '../features/challenge-ui.ts';
import { bars, button, glyph, hero, insight, panel, score, scoreTone, screen, stagger, timeline, toast } from '../ui/ui.ts';
import { driveChips } from './drive-sheets.ts';
import { count, dayWord, needMoreLine, shortDay, timeWord, usdShort } from './drive-words.ts';
import { leakNote, leakWords, noLeaks, NO_TRIPS, progressSub, SIGN_IN, tripNames, tripWords } from './history-words.ts';
import { driveSummaries, forgetDrive, savedDrives } from './saved.ts';
import './history.css';

const label = (text: string) => h('p.u-eyebrow.dv-label', {}, text);
const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

// Google's mark, as Google gives it (the same as the account sheet's)
const G_MARK = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

// schools and parks name the ends of regular trips; loaded once
let places: Place[] | null = null;
let placesAsked = false;

/** Builds without motion: a redraw in place shouldn't count numbers up or light blocks again. */
function still<T>(on: boolean, build: () => T): T {
  const root = document.documentElement, add = on && !root.classList.contains('still');
  if (add) root.classList.add('still');
  try { return build(); } finally { if (add) root.classList.remove('still'); }
}

export class HistoryScreen implements Screen {
  private readonly app: App;
  /** a drive was picked while one is still recording */
  private blocked = false;
  /** who the page was drawn for: a sign-in or sign-out redraws it */
  private shownFor: string | null = null;
  private trips = 0;
  private totals: Promise<CommunityTotals | null> | null = null;

  constructor(app: App) {
    this.app = app;
    onAuth(() => { if (this.here && (person()?.uid ?? null) !== this.shownFor) this.render(false); });
    // drives saved, deleted, or back from the backup
    addEventListener('tt:drives', () => { if (this.here) this.render(true); });
    addEventListener('storage', (e) => { if (this.here && e.key === 'tt-sums') this.render(true); });
  }

  private get here(): boolean {
    return this.app.tab === 'drives';
  }

  enter(): void {
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
    return screen([h('div.dv-progress.my-out', {},
      hero({ eyebrow: 'MY DRIVES', title: 'Your progress', art: 'tut-5-app' }),
      panel([
        h('p.my-out-value', {}, SIGN_IN.value),
        h('div.cloud-privacy', {}, h('span.cloud-privacy-ico', { 'aria-hidden': 'true', html: glyph('phone') }), h('p', {}, PRIVACY_LINE)),
        key,
      ], { pad: 'l' }),
      h('p.u-caption.my-out-free', {}, SIGN_IN.free),
      this.foot())]);
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

  private signedIn(): HTMLElement {
    const app = this.app, drive = app.screens.drive;
    drive.ensureSummaries();
    const sums = driveSummaries(), phone = drive.canRecord;
    const warn = this.blocked && drive.recording;
    this.blocked = false;
    if (!sums.length) {
      return screen([h('div.dv-progress', {},
        hero({
          eyebrow: 'MY DRIVES', title: 'No drives yet',
          sub: phone ? 'Record a drive and your progress shows up here: what costs you money, your regular trips and the places you brake hard.'
            : 'Record a drive on your phone. With the same Google account, it shows up here too.',
        }),
        this.empty(phone),
        challengeCard(),
        this.community(),
        accountCard(),
        this.foot())]);
    }
    const miles = sums.reduce((t, s) => t + s.mi, 0);
    return screen([h('div.dv-progress', {},
      hero({ eyebrow: 'MY DRIVES', title: 'Your progress', sub: progressSub(sums.length, miles) }),
      warn ? insight({ icon: 'warn', tone: 'warn', title: 'End your drive first.', body: 'A drive is still recording on the Drive tab.' }) : null,
      h('div.my-cols', {},
        h('div.my-col', {}, challengeCard(), this.leaks(sums), this.routes(sums)),
        h('div.my-col', {}, this.trend(progressOf(sums, 12)), this.spots(spotsFrom(sums)), this.community(), accountCard())),
      this.list(sums),
      this.foot())], { wide: true });
  }

  /** No drives yet: one key that starts one. */
  private empty(phone: boolean): HTMLElement {
    const app = this.app, go = () => { app.setTab('drive'); app.screens.drive.home(); };
    return panel([
      h('div.dv-empty', {},
        h('img.dv-empty-art', { src: 'art/tut-5-app.png', alt: '', draggable: 'false' }),
        phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: go })
          : button('Try a sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: () => { app.setTab('drive'); void app.screens.drive.loadSample(); } })),
    ], { pad: 'm' });
  }

  /** The top 3 habits and places costing money, a month at this rate, each with its fix. */
  private leaks(sums: DriveSummary[]): HTMLElement {
    const L = leaksFrom(sums);
    const rows = L.top.map((l) => insight({ ...leakWords(l), tone: 'warn' }));
    return h('section.dv-sec', { 'aria-label': 'Your money leaks' },
      h('div.dv-card-head', {}, label('YOUR MONEY LEAKS'), rows.length ? h('span.dv-card-note', {}, 'Each month') : null),
      ...(rows.length ? rows : [insight({ ...noLeaks(L), icon: 'coin', tone: 'plain' })]),
      rows.length ? h('p.u-caption', {}, leakNote(L)) : null);
  }

  /** Trips driven again and again: how smooth they are, and the last two side by side. */
  private routes(sums: DriveSummary[]): HTMLElement {
    if (!places) this.askPlaces();
    const routes = routesFrom(sums, places ?? []).slice(0, 3), names = tripNames(routes);
    this.trips = routes.length;
    const hard = new Map(sums.map((s) => [s.at, s.hardBrakes]));
    const row = (r: Route, i: number) => {
      const w = tripWords(r, names[i]), last = r.ats.slice(-2);
      return panel([
        h('div.my-trip-head', {},
          h('span.my-trip-ico', { 'aria-hidden': 'true', html: glyph('route', 3) }),
          h('div.my-trip-text', {}, h('p.my-trip-t', {}, w.title), h('p.my-trip-s', {}, w.sub))),
        timeline(w.days.map((d, i) => ({ tone: (hard.get(last[i] ?? 0) ?? 0) > 0 ? 'warn' : 'money', title: d }))),
      ], { pad: 'm' });
    };
    return h('section.dv-sec.my-trips', { 'aria-label': 'Your regular trips' },
      label('YOUR REGULAR TRIPS'),
      ...(routes.length ? routes.map(row) : [insight({ ...NO_TRIPS, icon: 'route', tone: 'plain' })]));
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

  /** The smooth score: the last 3 drives, the honest verdict, and every drive as pixel bars. */
  private trend(p: Progress): HTMLElement {
    const recent = p.recent, latest = recent[recent.length - 1];
    const avg = p.avgScore ?? latest.score, tone = scoreTone(avg);
    return h('section', { 'aria-label': 'Your smooth score' }, panel([
      h('div.dv-card-head', {}, label('SMOOTH SCORE'), h('span.dv-card-note', {}, p.drives >= 3 ? 'Last 3 drives' : 'So far')),
      score(avg, { tone, countUp: true, caption: 'out of 100' }),
      h('p.dv-verdict', { 'data-tone': p.verdict === 'smoother' ? 'money' : p.verdict === 'rougher' ? 'warn' : 'plain' }, p.verdictText ? `${p.verdictText}.` : needMoreLine(p.needMore)),
      recent.length >= 2 ? h('div.dv-chart', {}, label('EACH DRIVE'), bars(recent.map((d) => d.score), { labels: recent.map((d) => shortDay(d.at)), tone: 'you' })) : null,
    ], { pad: 'm' }));
  }

  /** The places this driver keeps braking hard; each opens on the map. */
  private spots(spots: Spot[]): HTMLElement {
    const app = this.app;
    const row = (s: Spot) => panel([
      h('div.dv-spot-row', {},
        h('span.dv-spot-ico', { 'aria-hidden': 'true', html: glyph('bell', 3) }),
        h('div.dv-spot-text', {},
          h('p.dv-spot-t', {}, s.name || 'A spot on your drives'),
          h('p.dv-spot-s', {}, `${count(s.count, 'hard brake')} on ${count(s.drives, 'drive')}${s.salmon ? ' · drains to a salmon stream' : ''}`)),
        ico('chevron')),
    ], { onClick: () => app.screens.drive.showSpot(s), pad: 's' });
    return h('section.dv-sec', { 'aria-label': 'Your hard-brake spots' },
      h('div.dv-card-head', {}, label('HARD-BRAKE SPOTS'), spots.length ? h('span.dv-card-note', {}, 'It chimes before these') : null),
      spots.length
        ? h('div.dv-spots', {}, ...spots.slice(0, 6).map(row))
        : insight({ icon: 'bell', tone: 'plain', title: 'No hard-brake spots yet.', body: 'Brake hard in the same place on 2 drives and TireTrail learns it. Next time it chimes before you get there.' }));
  }

  /** Everyone's totals, asked once a visit (again after a miss); hidden until they come. */
  private community(): HTMLElement {
    const el = communityCard({ totals: null }), got = (this.totals ??= communityTotals());
    void got.then((t) => {
      if (!t) { if (this.totals === got) this.totals = null; return; }
      if (el.isConnected) el.replaceWith(communityCard({ totals: t }));
    });
    return el;
  }

  /** Every saved drive, newest first. Ones with their full track open on the map. */
  private list(sums: DriveSummary[]): HTMLElement {
    const app = this.app, tracks = new Set(savedDrives().map((d) => d.at));
    const open = (at: number) => {
      // opening a saved drive mid-recording would leave the recording half on screen
      if (app.screens.drive.openSaved(at)) return;
      this.blocked = true;
      this.render(false);
    };
    const row = (d: DriveSummary) => {
      const can = tracks.has(d.at);
      const confirm = h('div.dv-row-confirm', { hidden: true },
        h('p.u-body', {}, "Delete this drive? It can't be undone."),
        h('div.dv-row-keys', {},
          // everything that shows drives redraws, this page too
          button('Delete', { kind: 'danger', icon: 'trash', onClick: () => { forgetDrive(d.at); toast('Drive deleted.', { icon: 'trash' }); dispatchEvent(new CustomEvent('tt:drives')); } }),
          button('Keep', { kind: 'secondary', onClick: () => { confirm.hidden = true; } })));
      const del = h('button.u-btn.u-ghost.u-square.dv-del', { type: 'button', 'aria-label': 'Delete this drive', title: 'Delete', onclick: () => { confirm.hidden = false; } }, ico('trash'));
      const kids = [
        h('div.dv-row-head', {},
          h('div.dv-row-when', {}, h('b', {}, dayWord(d.at)), h('span', {}, timeWord(d.at))),
          h('b.dv-row-score', { 'data-tone': scoreTone(d.score) }, String(d.score)),
          del),
        h('p.dv-row-line', {}, `${d.mi.toFixed(1)} mi · ${Math.max(1, Math.round(d.min))} min · ${usdShort(d.gas.typical + d.tires.typical)} lost`),
        driveChips(d, false),
        can ? null : h('p.u-caption', {}, 'Only its summary is on this device, not its route.'),
        confirm,
      ];
      return can ? panel(kids, { onClick: () => open(d.at), pad: 'm' }) : panel(kids, { pad: 'm' });
    };
    return h('section.dv-sec.my-drives', { 'aria-label': 'Your drives' }, label('YOUR DRIVES'), h('div.dv-rows', {}, ...sums.map(row)));
  }

  private foot(): HTMLElement {
    return h('footer.dv-progress-foot', {}, button('Open a GPX file', { kind: 'ghost', icon: 'up', onClick: () => this.app.screens.drive.pickFile() }));
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
