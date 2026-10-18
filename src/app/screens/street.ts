// More details: one street's answer, why it matters, what to do, its trip step by step, the rest of the street,
// and honest notes with the details for city staff.
import { twist } from '../../data/cards.ts';
import { polylineLength, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';
import { button, calm, glyph, hero, insight, panel, screen, stagger, stat } from '../ui/ui.ts';
import { blocks, cap, destWords, endingEl, far, hasStep, headEl, headline, keepNames, KIND, mineText, runOutcome, todoParts, why, type Outcome } from './common.ts';
import { journey, journeyEl, staff } from './journey.ts';
import { Player } from './player.ts';
import { StreetIndex } from './streets.ts';

type View = 'search' | 'result' | 'watch';

// how each part of a street drains, for "All of {street}"; 4 = no drain
const PART: Record<number, string> = {
  0: 'drains to a salmon stream', 1: 'soaks into the ground', 2: 'drains to other water', 3: 'reaches a gap in the pipe map', 4: 'has no mapped storm drain nearby', 5: 'goes to a sewage treatment plant',
};
/** blocks in the pixel strip that shows how a street splits */
const BLOCKS = 20;
/** why braking gently helps, by answer */
const DO = {
  creek: 'Hard stops shed more tire dust, and rain carries it to the creek.',
  other: 'Gentle stops make your tires last longer.',
  unknown: 'Less tire dust is better wherever the rain goes.',
};

export class StreetScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly picks: { run: Run; hint: string }[];
  private view: View = 'search';
  private run: Run | null = null;
  private q = '';
  private msg = '';

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.picks = this.choosePicks();
    app.onData(() => {
      if (this.run) this.run = app.world.runs[this.run.i];
    });
  }

  /** The map's street index (name|place keys), kept current as areas load. */
  private get index(): StreetIndex {
    return this.app.screens.map.streets;
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
    const input = h('input.mu-input', { type: 'search', placeholder: 'Find your street, like 214th Ave E', value: this.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Street name' }) as HTMLInputElement;
    const list = h('ul.mu-suggest');
    const fill = () => {
      this.q = input.value;
      const hits = this.index.search(this.q, 8);
      list.replaceChildren(...hits.map((hit) => h('li', {}, h('button', { type: 'button', onclick: () => { const r = this.index.main(hit.key); if (r) this.open(r); } }, h('span.mu-sname', {}, hit.name), h('span.mu-splace', {}, hit.place)))));
      if (this.q.trim() && !hits.length) list.replaceChildren(h('li.mu-none', {}, `No street called "${this.q.trim()}" in TireTrail yet.`));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      (list.querySelector('button') as HTMLButtonElement | null)?.click();
    });
    fill();
    app.showPage(stagger(screen([
      hero({ eyebrow: 'MY STREET', title: 'Where does the rain on your street go?', sub: 'Pick a street to see where its rain ends up.' }),
      h('div.mu-find.mu-onpage', {}, h('div.mu-findbar', {}, h('span.mu-findico', { 'aria-hidden': 'true', html: glyph('search') }), input), list),
      h('div.u-row', {}, button('Use my location', { kind: 'secondary', icon: 'locate', onClick: () => this.locate() }), button('Pick it on the map', { kind: 'secondary', icon: 'map', onClick: () => app.setTab('map') })),
      this.msg ? h('p.mu-warn', {}, this.msg) : null,
      this.picks.length ? h('p.u-eyebrow', {}, 'OR TRY ONE OF THESE') : null,
      this.picks.length ? h('div.u-stack', {}, ...this.picks.map((p) => panel([h('div.u-spread', {}, h('div', {}, h('b.mu-pickname', {}, app.world.pieceNames[p.run.piece]), h('p.u-caption', {}, p.hint)), h('span.mu-chev', { 'aria-hidden': 'true', html: glyph('chevron') }))], { onClick: () => this.open(p.run), pad: 's' }))) : null,
    ])));
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
    const o = runOutcome(app, run), cls = o.cls, k = KIND[cls] ?? KIND.unknown;
    const wy = why(o);
    const watchable = run.drain !== null && !(cls === 'unknown' && o.lengthM < 10);
    const drive = () => app.screens.drive.startDrive();
    // the headline with its water in the answer's color
    // why it matters sits in the cards and the trip below, so the top is just the answer
    const top = hero({ eyebrow: place && place !== name ? `${name} · ${place}` : name, title: headline(o), art: k.art });
    const t = top.querySelector('.u-hero-title');
    if (t) t.replaceChildren(...headEl(headline(o), destWords(o), 'span').childNodes);
    top.dataset.tone = k.tone;
    top.classList.add('mu-hero');
    const mine = mineText(app.screens.map.mineOf(run));
    const page = screen([
      button('Back to the map', { kind: 'ghost', icon: 'back', onClick: () => this.close() }),
      top,
      h('div.u-row.mu-pageacts', {},
        watchable ? button(cls === 'unknown' && o.code !== 'discharge-probable' ? 'See how far it goes' : 'See it happen', { kind: 'primary', icon: 'play', onClick: () => this.watch() }) : null,
        button('Start a drive', { kind: watchable ? 'secondary' : 'primary', icon: 'car', onClick: drive })),
      h('div.mu-twoup', {},
        insight({ icon: k.glyph, tone: k.tone, ...this.deeper(o, wy) }),
        insight({ icon: 'stop', tone: 'you', title: keepNames(todoParts(o, name).title), body: mine?.text ?? DO[cls === 'creek' ? 'creek' : cls === 'unknown' ? 'unknown' : 'other'] })),
      run.drain !== null ? h('section.u-stack', {}, h('p.u-eyebrow', {}, 'THE TRIP, STEP BY STEP'), journeyEl(journey(app, run.drain, name))) : null,
      this.hills(run),
      this.others(run, name),
      this.notes(o, run.drain),
    ]);
    page.classList.add('mu-page');
    app.showPage(stagger(page));
  }

  /** Why it matters, one level deeper than the headline says it. */
  private deeper(o: Outcome, wy: { title: string; body: string }): { title: string; body?: string } {
    switch (o.cls) {
      case 'creek': return { title: 'Tire dust carries 6PPD-quinone.', body: 'In studies it killed coho salmon within hours.' };
      case 'ground': return { title: 'Soil removes most of the tire chemical.', body: 'In lab tests, runoff soaked through soil no longer killed coho.' };
      case 'elsewhere': return { title: wy.body || 'TireTrail follows the rain only as far as this water.' };
      case 'unknown': return { title: wy.body, body: 'TireTrail stops where the map stops instead of guessing.' };
      case 'none': return { title: wy.body, body: 'Many roads drain into roadside ditches instead.' };
      default: return { title: wy.body || wy.title };
    }
  }

  /** What the slope of the land alone would say, next to the pipe map. */
  private hills(run: Run): HTMLElement | null {
    const app = this.app;
    if (run.drain === null) return null;
    const d = app.data.drain(run.drain), info = app.data.street(run.i), cls = CLS[run.k];
    // the slope guess knows nothing of treatment plants
    if (info.terrain.cls === 'unknown' || cls === 'treatment') return null;
    const tw = twist(info.terrain, info.cls, d.receiving);
    const guessCls = CLS.includes(info.terrain.cls as Cls) ? (info.terrain.cls as Cls) : 'elsewhere';
    // the map's words: "Salmon stream", "Soaks in", "Puyallup River"
    const say = (s: string) => cap(s === 'the creek' ? 'salmon stream' : s === 'the ground' ? 'soaks in' : s.replace(/^the /, ''));
    // in a sentence: "a salmon stream", "the ground", "the Puyallup River"
    const said = (s: string) => (s === 'the creek' ? 'a salmon stream' : s);
    return h('section.u-stack', {},
      h('p.u-eyebrow', {}, 'THE LAND VS THE PIPES'),
      h('div.mu-cmp', {},
        stat('Slope of the land alone predicts', say(tw.normalMap), { tone: tw.differs ? 'plain' : KIND[guessCls].tone }),
        stat('The pipe map says', say(tw.realPipes), { tone: KIND[cls].tone })),
      h('p.u-body', {}, tw.differs ? `The pipes take it to ${said(tw.realPipes)}, not where the slope points.` : 'Here the land and the pipes agree.'));
  }

  /** Honest notes, and the details for city staff, folded away. */
  private notes(o: Outcome, drain: number | null): HTMLElement {
    const app = this.app, wdfw = o.reason.split(/(?<=\.)\s+/).find((s) => /WDFW/.test(s));
    const notes = [
      `This answer follows ${o.owner} storm pipe map. Maps can have gaps and mistakes.`,
      o.cls === 'creek' && o.city ? 'WDFW records coho spawning in lower Fennel Creek, a few miles downstream.' : '',
      o.cls !== 'creek' || o.city ? '' : wdfw ?? '',
      o.cls === 'elsewhere' && wdfw ? wdfw : '',
      o.cls === 'creek' ? 'The chemical forms from 6PPD, which is added to tires.' : '',
      o.cls === 'creek' ? 'Sources: Tian and others, Science, 2021; French and others, 2022.' : '',
      o.cls === 'ground' ? 'The soil tests used rain garden soil, not dry wells or ponds. Some ponds overflow in very big storms.' : '',
      o.cls === 'ground' ? 'Sources: McIntyre and others, 2015; Rodgers and others, 2023.' : '',
      o.cls === 'unknown' ? "Gray isn't good or bad. TireTrail stops where the map stops instead of guessing." : '',
      o.cls === 'none' ? 'No drain on the map doesn\'t mean no drain on the street. Many roads drain into roadside ditches.' : '',
    ].filter(Boolean);
    return h('details.mu-notes', {},
      h('summary', {}, h('span', {}, 'How we figure this'), h('span.mu-chev', { 'aria-hidden': 'true', html: glyph('chevron') })),
      h('div.mu-notebody', {},
        h('ul.mu-notelist', {}, ...notes.map((n) => h('li', {}, n))),
        drain !== null ? h('p.u-eyebrow', {}, 'FOR CITY STAFF') : null,
        drain !== null ? h('dl.mu-facts', {}, ...staff(app, drain).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null));
  }

  /** How the rest of the street (same name, same place) splits up, by length, as a pixel strip. */
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
    const n = blocks(rows.map((r) => r[1]), BLOCKS);
    const tone = (k: number) => `--k:${KIND[CLS[k]].color}`;
    let b = 0;
    const strip = h('div.mu-strip', { role: 'img', 'aria-label': rows.map(([k, m]) => `${far(m)} ${PART[k]}`).join(', ') },
      ...rows.flatMap(([k], i) => Array.from({ length: n[i] }, () => h('i' + (k === 3 ? '.mu-hatch' : ''), { style: `${tone(k)};--i:${b++}` }))));
    fillWhenSeen(strip);
    return h('section.u-stack', { 'data-key': key },
      h('p.u-eyebrow', {}, `ALL ${far(total).toUpperCase()} OF ${name.toUpperCase()}`),
      h('p.u-body', { 'data-m': String(Math.round(total)) }, 'Parts of a street can drain to different places.'),
      strip,
      h('ul.mu-split', {}, ...rows.map(([k, m]) => h('li' + (k === 3 ? '.mu-hatch' : ''), { style: tone(k) }, h('span', {}, `${far(m)} ${PART[k]}`, k === mine ? h('b', {}, ' (this part)') : null)))));
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
      end: () => endingEl(runOutcome(app, run), name, {
        done: () => this.close(), again: () => this.player.replay(),
        drive: () => app.screens.drive.startDrive(), art: app.layout === 'laptop',
      }),
    });
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

/** The strip's blocks light one by one once it's on screen (not with reduced motion). */
function fillWhenSeen(el: HTMLElement): void {
  if (calm() || typeof IntersectionObserver === 'undefined') return;
  el.classList.add('mu-wait');
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    el.classList.replace('mu-wait', 'mu-go');
  }, { threshold: 0.6 });
  io.observe(el);
}
