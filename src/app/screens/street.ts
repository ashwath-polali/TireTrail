// My street: find a street, read where its rain goes, then watch it happen on the map.
import { twist } from '../../data/cards.ts';
import { polylineLength, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';
import { cap, destination, KIND, why } from './common.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';

type View = 'search' | 'result' | 'watch';

/** The answer as one plain sentence. */
export function answer(cls: Cls, receiving: string): string {
  switch (cls) {
    case 'creek': return /tributary/i.test(receiving) || !receiving || receiving === 'Fennel Creek' ? 'Rain here ends up in Fennel Creek.' : `Rain here ends up in ${receiving}, which drains to Fennel Creek.`;
    case 'ground': return 'Rain here soaks into the ground.';
    case 'elsewhere': return `Rain here drains to ${receiving || 'other water'}.`;
    case 'unknown': return "The city's pipe map loses track of this rain.";
    default: return 'No storm drain picks up rain here.';
  }
}

export class StreetScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly byName = new Map<string, Run[]>();
  private readonly names: string[];
  private readonly picks: { run: Run; hint: string }[];
  private view: View = 'search';
  private run: Run | null = null;
  private q = '';
  private msg = '';

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    for (const r of app.world.runs) {
      const name = app.world.pieceNames[r.piece];
      if (!name) continue;
      this.byName.set(name, [...(this.byName.get(name) ?? []), r]);
    }
    this.names = [...this.byName.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    this.picks = this.choosePicks();
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
    if (this.view !== 'search' && this.run) this.result(this.run, false);
    else this.search(false);
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'result';
  }

  back(): boolean {
    if (this.view === 'watch' && this.run) { this.result(this.run, false); return true; }
    if (this.view === 'result') { this.app.setTab('map'); return true; }
    return false;
  }

  relayout(): void {
    if (this.view === 'watch') this.player.relayout();
    else this.enter();
  }

  /** Opens a street's answer, from anywhere in the app. */
  open(run: Run): void {
    this.run = run;
    this.view = 'result';
    if (this.app.tab === 'street') this.result(run, true);
    else this.app.setTab('street');
  }

  pick(i: number): void {
    const p = this.picks[i];
    if (p) this.open(p.run);
  }

  // ---------- search ----------

  private search(push: boolean): void {
    const app = this.app;
    this.view = 'search';
    this.player.stop();
    if (push) app.pushStep();
    const input = h('input.search', { type: 'search', placeholder: 'Type a street, like 214th Ave E', value: this.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Street name' }) as HTMLInputElement;
    const list = h('ul.suggest', { role: 'listbox' });
    const fill = () => {
      this.q = input.value;
      const q = this.q.trim().toLowerCase();
      const hits = q ? this.names.filter((n) => n.toLowerCase().includes(q)).sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q))).slice(0, 8) : [];
      list.replaceChildren(...hits.map((n) => h('li', {}, h('button', { onclick: () => this.openName(n) }, n))));
      if (q && !hits.length) list.replaceChildren(h('li.none', {}, 'No street by that name in the traced area yet.'));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const first = list.querySelector('button');
      if (first) (first as HTMLButtonElement).click();
    });
    fill();
    app.showPage(h('div.wrap.narrow', {},
      h('div.eyebrow', {}, 'MY STREET'),
      h('h1.h1', {}, 'Where does the rain on your street go?'),
      h('p.lead', {}, 'Pick a street in Bonney Lake. TireTrail follows its storm drains through the city\'s real pipes and shows you where the water ends up.'),
      h('div.searchbox', {}, input, list),
      h('div.actions.row', {},
        h('button.btn.quiet', { onclick: () => this.locate() }, 'Use my location'),
        h('button.btn.quiet', { onclick: () => app.setTab('map') }, 'Pick it on the map')),
      this.msg ? h('p.warn', {}, this.msg) : null,
      h('div.eyebrow.gap', {}, 'OR TRY ONE OF THESE'),
      h('div.picks', {}, ...this.picks.map((p) => h('button.pick', { onclick: () => this.open(p.run) },
        h('b', {}, app.world.pieceNames[p.run.piece]), h('span', {}, p.hint))))));
    if (app.layout === 'laptop') input.focus();
  }

  private openName(name: string): void {
    const runs = this.byName.get(name) ?? [];
    // the longest stretch of the street's most common answer
    const byCls = new Map<number, number>();
    for (const r of runs) if (r.drain !== null) byCls.set(r.k, (byCls.get(r.k) ?? 0) + polylineLength(r.line));
    const main = [...byCls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const pool = runs.filter((r) => main === undefined ? true : r.k === main && r.drain !== null);
    const run = pool.sort((a, b) => polylineLength(b.line) - polylineLength(a.line))[0];
    if (run) this.open(run);
  }

  private locate(): void {
    const app = this.app;
    const fail = (m: string) => { this.msg = m; this.search(false); };
    if (!navigator.geolocation || !window.isSecureContext) return fail('Your location needs GPS, which this page can\'t use here. Type your street instead.');
    if (window.self !== window.top) return fail("This preview can't use your location. Type your street instead.");
    navigator.geolocation.getCurrentPosition((pos) => {
      const p = app.world.toWorld([pos.coords.longitude, pos.coords.latitude]);
      const run = app.world.nearestRun(p, 150);
      if (run) { this.msg = ''; this.open(run); } else fail("You're outside the area TireTrail has traced so far. Type a Bonney Lake street to try it.");
    }, () => fail('Location is turned off for this page. Type your street instead.'), { enableHighAccuracy: true, timeout: 12000 });
  }

  // ---------- answer ----------

  private result(run: Run, push: boolean): void {
    const app = this.app, w = app.world;
    this.view = 'result';
    this.run = run;
    this.player.stop();
    if (push) app.pushStep();
    const name = w.pieceNames[run.piece] || 'This street';
    if (run.drain === null) {
      app.showPage(h('div.wrap.narrow', {},
        h('button.backlink', { onclick: () => this.app.setTab('map') }, '‹ Back to the map'),
        h('div.eyebrow', {}, name.toUpperCase()),
        h('h1.h1', {}, 'No storm drain picks up rain here.'),
        h('p.lead', {}, "The city's map shows no storm drain within 160 feet of this stretch, so its rain runs off the road some other way."),
        this.others(run, name),
        h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.app.setTab('map') }, 'Back to the map'))));
      return;
    }
    const d = app.data.drain(run.drain), info = app.data.street(run.i);
    const tw = twist(info.terrain, info.cls, d.receiving);
    const dest = destination(d.cls, d.receiving);
    const hills = info.terrain.cls !== 'unknown'
      ? h('div.cmp', {},
        h('div.row', {}, h('span.lab', {}, 'A map of the hills guesses'), h('span.val.' + (tw.differs ? 'wrong' : CLS.includes(info.terrain.cls as Cls) ? info.terrain.cls : 'other'), {}, cap(tw.normalMap))),
        h('div.row.answer', {}, h('span.lab', {}, 'The real pipes say'), h('span.val.' + d.cls, {}, cap(tw.realPipes))))
      : null;
    app.showPage(h('div.wrap.narrow', {},
      h('button.backlink', { onclick: () => this.app.setTab('map') }, '‹ Back to the map'),
      h('div.answer', { style: `--k:${KIND[d.cls].color}` },
        h('span.ai', { html: dest.icon }),
        h('div', {}, h('div.eyebrow', {}, name.toUpperCase()), h('h1.h1', {}, answer(d.cls, d.receiving)))),
      h('p.lead', { html: why(d.cls, d.receiving) }),
      h('div.actions.row', {},
        h('button.btn.main', { onclick: () => this.watch() }, '▶  See it happen'),
        h('button.btn.quiet', { onclick: () => this.app.setTab('map') }, 'Back to the map')),
      h('div.eyebrow.gap', {}, 'THE TRIP, STEP BY STEP'),
      journeyEl(journey(app, run.drain, name)),
      hills,
      tw.differs && hills ? h('p.p', {}, 'Most maps go by which way the land slopes. Here the pipes send the water somewhere else, which is why TireTrail follows the real pipes.') : null,
      this.others(run, name),
      h('div.eyebrow.gap', {}, 'WHAT YOU CAN DO'),
      h('ul.tips', {},
        h('li', { html: `${ICON.brake()}<span><b>Brake earlier on ${esc(name)}</b>Start slowing sooner so you stop gently. Gentle stops shed less rubber.</span>` }),
        h('li', { html: `${ICON.car(3)}<span><b>Check your own drive</b>TireTrail can find your hardest stops and where their dust goes.</span>` })),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => app.setTab('drive') }, 'Start a drive'))));
  }

  /** How the rest of the street splits up, by length. */
  private others(run: Run, name: string): HTMLElement | null {
    const runs = this.byName.get(name) ?? [];
    if (runs.length < 2) return null;
    const by = new Map<number, number>();
    for (const r of runs) by.set(r.drain === null ? 4 : r.k, (by.get(r.drain === null ? 4 : r.k) ?? 0) + polylineLength(r.line));
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    const label: Record<number, string> = { 0: 'reaches the creek', 1: 'soaks into the ground', 2: 'drains to other water', 3: 'reaches a gap in the pipe map', 4: 'has no storm drain nearby' };
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
    if (rows.length < 2) return null;
    return h('div.split', {},
      h('div.eyebrow.gap', {}, `ALL OF ${name.toUpperCase()}`),
      h('p.p', {}, `Different stretches of a street can drain to different places. Here is all ${fmt.mi(total)} of it:`),
      h('div.bar', {}, ...rows.map(([k, m]) => h('span', { style: `--k:${KIND[CLS[k]].color};flex:${m}`, title: label[k] }))),
      h('ul.legend', {}, ...rows.map(([k, m]) => h('li', { style: `--k:${KIND[CLS[k]].color}` }, `${fmt.ft(m)} ${label[k]}${k === run.k && run.drain !== null ? ' (the part shown above)' : ''}`))));
  }

  // ---------- see it happen ----------

  watch(): void {
    const app = this.app, run = this.run;
    if (!run || run.drain === null) return;
    this.view = 'watch';
    app.pushStep();
    app.showStage();
    const name = app.world.pieceNames[run.piece] || 'this street';
    this.player.start({
      drain: run.drain, street: run.line, name,
      end: (d) => h('div', {},
        h('div.eyebrow', {}, name.toUpperCase()),
        h('h2.h2', {}, destination(d.cls, d.receiving).title),
        h('div.actions.row', {},
          h('button.btn.main', { onclick: () => this.result(run, false) }, '‹ Back to the answer'),
          h('button.btn.quiet', { onclick: () => this.player.replay() }, 'Watch again'))),
    });
  }

  tap(_p: XY): boolean {
    return false;
  }

  frame(now: number): FrameOut {
    return this.player.frame(now) ?? { scene: {} };
  }
}
