// More details: one street's answer, its trip step by step, the rest of the street, and details for city staff.
import { twist } from '../../data/cards.ts';
import { polylineLength, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';
import { cap, closingEl, clsIcon, far, hasStep, headline, KIND, line, runOutcome } from './common.ts';
import { journey, journeyEl, staff } from './journey.ts';
import { Player } from './player.ts';
import { StreetIndex } from './streets.ts';

type View = 'search' | 'result' | 'watch';

// how each part of a street drains, for "All of {street}"; 4 = no drain
const PART: Record<number, string> = {
  0: 'reaches a salmon stream', 1: 'soaks into the ground', 2: 'drains to other water', 3: 'reaches a gap in the pipe map', 4: 'has no storm drain nearby', 5: 'goes to a sewage treatment plant',
};

export class StreetScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private index: StreetIndex;
  private readonly picks: { run: Run; hint: string }[];
  private view: View = 'search';
  private run: Run | null = null;
  private q = '';
  private msg = '';

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
    this.picks = this.choosePicks();
    app.onData(() => {
      this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
      if (this.run) this.run = app.world.runs[this.run.i];
    });
  }

  // Three showcase streets: one reaches the creek, one fools the hills, one goes elsewhere.
  private choosePicks(): { run: Run; hint: string }[] {
    const { world: w, data } = this.app;
    const pieces = data.bundle.streets.pieces;
    const lens = new Map<number, number>();
    const pathLen = (d: number) => lens.get(d) ?? lens.set(d, data.path(d).lengthM).get(d)!;
    const best = (ok: (r: Run) => boolean) => {
      let top: Run | null = null, topLen = 0;
      for (const r of w.runs) {
        // long enough to see on the map
        if (r.drain === null || !w.pieceNames[r.piece] || !ok(r) || polylineLength(r.line) < 40) continue;
        const L = pathLen(r.drain);
        if (L > topLen) [top, topLen] = [r, L];
      }
      return top;
    };
    const out = [
      { run: best((r) => r.k === 0 && data.drain(r.drain!).receiving === 'Fennel Creek'), hint: 'Does its rain reach the creek?' },
      { run: best((r) => r.k === 1 && pieces[r.piece].terrainCls === 0), hint: 'The hills say creek. Do the pipes?' },
      { run: best((r) => r.k === 2), hint: 'Where does this one go?' },
    ];
    return out.filter((p): p is { run: Run; hint: string } => p.run !== null);
  }

  enter(): void {
    if (this.view !== 'search' && this.run) this.result(this.run);
    else this.search();
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'result';
  }

  back(): boolean {
    if (this.view === 'watch' && this.run) { this.result(this.run); return true; }
    if (this.view === 'result') { this.app.setTab('map'); return true; }
    return false;
  }

  /** In-app back: through the browser history when there is a step for it. */
  private close(): void {
    if (hasStep()) history.back();
    else this.back();
  }

  relayout(): void {
    if (this.view === 'watch') this.player.relayout();
    else this.enter();
  }

  /** Opens a street's details, from anywhere in the app (one history step). */
  open(run: Run): void {
    this.run = run;
    this.view = 'result';
    this.app.pushStep();
    if (this.app.tab === 'street') this.result(run);
    else this.app.setTab('street');
  }

  pick(i: number): void {
    const p = this.picks[i];
    if (p) this.open(p.run);
  }

  // ---------- search ----------

  private search(): void {
    const app = this.app;
    this.view = 'search';
    this.player.stop();
    const input = h('input.search', { type: 'search', placeholder: 'Type your street, like 214th Ave E', value: this.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Street name' }) as HTMLInputElement;
    const list = h('ul.suggest');
    const fill = () => {
      this.q = input.value;
      const hits = this.index.search(this.q, 8);
      list.replaceChildren(...hits.map((hit) => h('li', {}, h('button', { onclick: () => { const r = this.index.main(hit.key); if (r) this.open(r); } }, hit.name, h('span.place', {}, hit.place)))));
      if (this.q.trim() && !hits.length) list.replaceChildren(h('li.none', {}, `No street called "${this.q.trim()}" in TireTrail yet.`));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      (list.querySelector('button') as HTMLButtonElement | null)?.click();
    });
    fill();
    app.showPage(h('div.wrap.narrow', {},
      h('div.eyebrow', {}, 'MY STREET'),
      h('h1.h1', {}, 'Where does the rain on your street go?'),
      h('p.lead', {}, 'Pick a street. TireTrail follows its storm drains through real pipe maps and shows you where the water ends up.'),
      h('div.searchbox', {}, input, list),
      h('div.actions.row', {},
        h('button.btn.quiet', { onclick: () => this.locate() }, 'Use my location'),
        h('button.btn.quiet', { onclick: () => app.setTab('map') }, 'Pick it on the map')),
      this.msg ? h('p.warn', {}, this.msg) : null,
      this.picks.length ? h('div.eyebrow.gap', {}, 'OR TRY ONE OF THESE') : null,
      h('div.picks', {}, ...this.picks.map((p) => h('button.pick', { onclick: () => this.open(p.run) },
        h('b', {}, app.world.pieceNames[p.run.piece]), h('span', {}, p.hint))))));
    if (app.layout === 'laptop') input.focus();
  }

  private locate(): void {
    const app = this.app;
    const fail = (m: string) => { this.msg = m; this.search(); };
    if (!navigator.geolocation || !window.isSecureContext) return fail('Your location needs GPS, which this page can\'t use here. Type your street instead.');
    if (window.self !== window.top) return fail("This preview can't use your location. Type your street instead.");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lon = pos.coords.longitude, lat = pos.coords.latitude;
      await app.ensureAreas([lon - 0.02, lat - 0.015, lon + 0.02, lat + 0.015], 4);
      const p = app.world.toWorld([lon, lat]);
      const run = app.world.nearestRun(p, 150);
      if (run) { this.msg = ''; this.open(run); } else fail("You're outside the area TireTrail has traced so far. Type your street to try it.");
    }, () => fail('Location is off for this page. You can still search for your street.'), { enableHighAccuracy: true, timeout: 12000 });
  }

  // ---------- more details ----------

  private result(run: Run): void {
    const app = this.app, w = app.world;
    this.view = 'result';
    this.run = run;
    this.player.stop();
    const name = w.pieceNames[run.piece] || 'This street', place = app.placeOf(run.i);
    const o = runOutcome(app, run), cls = o.cls;
    // creek streets also get the chemical by name
    const lead = cls === 'creek'
      ? `${o.code === 'downstream-creek' ? line(o) : 'Coho salmon live there.'} Tire dust carries a chemical called 6PPD-quinone. In streams like this one it can kill coho salmon within hours of a storm.`
      : line(o);
    const watchable = run.drain !== null && !(cls === 'unknown' && o.lengthM < 10);
    const page = h('div.wrap.narrow.mu-page.fade', {},
      h('button.backlink.mu-back', { onclick: () => this.close() }, h('span', { 'aria-hidden': 'true' }, '‹'), ' Back to the map'),
      h('div.mu-top', { style: `--k:${KIND[cls].color}` },
        h('span.mu-big', { html: clsIcon(cls) }),
        h('div', {}, h('p.mu-sub', {}, name, h('span.mu-place', {}, ` · ${place}`)), h('h1.mu-title', {}, headline(o)))),
      h('p.lead', {}, lead),
      watchable ? h('div.actions.row', {}, h('button.btn.main', { onclick: () => this.watch() }, h('span', { 'aria-hidden': 'true' }, '▶'), cls === 'unknown' ? '  See how far it goes' : '  See it happen')) : null,
      run.drain !== null ? h('div.mu-sec', {}, 'THE TRIP, STEP BY STEP') : null,
      run.drain !== null ? journeyEl(journey(app, run.drain, name === 'This street' ? 'This street' : name)) : null,
      this.hills(run),
      run.drain !== null ? this.staffEl(run.drain) : null,
      this.others(run, name),
      h('div.mu-sec', {}, 'WHAT YOU CAN DO'),
      h('ul.tips', {},
        h('li', { html: `${ICON.brake()}<span><b>Brake earlier on ${esc(name)}</b>Start slowing sooner so you stop gently. Gentle stops shed less rubber.</span>` }),
        h('li', { html: `${ICON.car(3)}<span><b>Check your own drive</b>TireTrail can find your hardest stops and where their dust goes.</span>` })),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => { app.setTab('drive'); app.screens.drive.home(); } }, 'Start a drive')));
    app.showPage(page);
  }

  /** What the slope of the land alone would say, next to the real pipes. */
  private hills(run: Run): HTMLElement | null {
    const app = this.app;
    if (run.drain === null) return null;
    const d = app.data.drain(run.drain), info = app.data.street(run.i), cls = CLS[run.k];
    if (info.terrain.cls === 'unknown') return null;
    const tw = twist(info.terrain, info.cls, d.receiving);
    const guess = tw.differs ? 'wrong' : CLS.includes(info.terrain.cls as Cls) ? info.terrain.cls : 'other';
    return h('div', {},
      h('div.cmp', {},
        h('div.row', {}, h('span.lab', {}, 'Slope of the land alone predicts'),
          h('span.val.' + guess, {}, cap(tw.normalMap), tw.differs ? h('span.mu-vh', {}, ' (wrong)') : null)),
        h('div.row.answer', {}, h('span.lab', {}, 'The real pipes say'), h('span.val.' + cls, {}, cap(tw.realPipes)))),
      tw.differs ? h('p.p', {}, 'Most maps go by which way the land slopes. Here the pipes send the water somewhere else, which is why TireTrail follows the real pipes.') : null);
  }

  private staffEl(drain: number): HTMLElement {
    return h('details.mu-staff', {},
      h('summary', {}, 'For city staff'),
      h('dl.mu-facts', {}, ...staff(this.app, drain).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  }

  /** How the rest of the street (same name, same place) splits up, by length. */
  private others(run: Run, name: string): HTMLElement | null {
    const key = this.index.keyOf(run);
    const runs = key ? this.index.runs(key) : [];
    if (runs.length < 2) return null;
    const by = new Map<number, number>();
    for (const r of runs) { const k = r.drain === null ? 4 : r.k; by.set(k, (by.get(k) ?? 0) + polylineLength(r.line)); }
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
    if (rows.length < 2) return null;
    const mine = run.drain === null ? 4 : run.k;
    const tone = (k: number) => `--k:${KIND[CLS[k]].color}`;
    return h('div', { 'data-key': key },
      h('div.mu-sec', {}, `ALL OF ${name.toUpperCase()}`),
      h('p.p', { 'data-m': String(Math.round(total)) }, `Different stretches of a street can drain to different places. Here is all ${far(total)} of it:`),
      h('div.mu-bar', {}, ...rows.map(([k, m]) => h('span' + (k === 3 ? '.mu-hatch' : ''), { style: `${tone(k)};flex:${m}`, title: PART[k] }))),
      h('ul.mu-split', {}, ...rows.map(([k, m]) => h('li' + (k === 3 ? '.mu-hatch' : ''), { style: tone(k) }, `${far(m)} ${PART[k]}${k === mine ? ' (the part shown above)' : ''}`))));
  }

  // ---------- see it happen ----------

  watch(): void {
    const app = this.app, run = this.run;
    if (!run || run.drain === null) return;
    this.view = 'watch';
    app.pushStep();
    app.showStage();
    const name = app.world.pieceNames[run.piece] || 'this street';
    this.player.start({ drain: run.drain, street: run.line, name, end: () => closingEl(runOutcome(app, run), name, () => this.close(), () => this.player.replay()) });
  }

  tap(_p: XY): boolean {
    // a tap during the story skips to its end
    if (this.view === 'watch') (this.player as Player & { skipToEnd?: () => void }).skipToEnd?.();
    return this.view === 'watch';
  }

  frame(now: number): FrameOut {
    return this.player.frame(now) ?? { scene: {} };
  }
}
