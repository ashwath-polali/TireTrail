// Map tab: tap a street and follow its rain through the real pipes.
import { twist } from '../../data/cards.ts';
import type { DrainInfo, DrainPath } from '../../data/tiretrail.ts';
import { polylineLength, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';
import { cap, destination, legend, why } from './common.ts';
import { Player } from './player.ts';

export class MapScreen implements Screen {
  private readonly player: Player;
  private lonely: Run | null = null; // tapped street with no drain nearby
  private readonly app: App;
  private readonly picks: { run: Run; hint: string }[];

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
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
        // long enough to see the highlight
        if (r.drain === null || !w.pieceNames[r.piece] || !ok(r) || polylineLength(r.line) < 40) continue;
        const L = pathLen(r.drain);
        if (L > topLen) [top, topLen] = [r, L];
      }
      return top;
    };
    const out: { run: Run | null; hint: string }[] = [
      { run: best((r) => r.k === 0 && data.drain(r.drain!).receiving === 'Fennel Creek'), hint: 'Does its rain reach the creek?' },
      { run: best((r) => r.k === 1 && pieces[r.piece].terrainCls === 0), hint: 'The hills say creek. Do the pipes?' },
      { run: best((r) => r.k === 2), hint: 'Where does this one go?' },
    ];
    return out.filter((p): p is { run: Run; hint: string } => p.run !== null);
  }

  enter(): void {
    this.idle();
  }

  leave(): void {
    this.player.stop();
    this.lonely = null;
  }

  idle(): void {
    const app = this.app;
    this.player.stop();
    this.lonely = null;
    const n = app.data.numbers.creekShareFennelBasin;
    app.setCaption('map', ICON.drop(), '<span class="say">Tap any street to see where its rain goes.</span>');
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'BONNEY LAKE, WA'),
      h('div.stat', {},
        h('div.big', {}, `1 in ${n.oneIn}`),
        h('div.say', {}, 'traced storm drains in the Fennel Creek basin end up in the creek, where coho salmon spawn.')),
      h('div.eyebrow.gap', {}, 'TRY A STREET'),
      h('div.picks', {}, ...this.picks.map((p) => h('button.pick', { onclick: () => this.open(p.run) },
        h('b', {}, app.world.pieceNames[p.run.piece]), h('span', {}, p.hint)))),
      legend(),
      h('div.wide', {},
        h('div.eyebrow.gap', {}, 'HOW IT WORKS'),
        h('ul.tips', {},
          h('li', { html: `${ICON.drop(2)}<span><b>Rain washes tire dust off the road.</b>Tires shed rubber every time you brake and turn.</span>` }),
          h('li', { html: `${ICON.grate(2)}<span><b>Storm drains carry it away.</b>The water runs through the city's pipes, untreated.</span>` }),
          h('li', { html: `${ICON.pipe(2)}<span><b>The pipes decide where it ends up.</b>Some reach Fennel Creek, where coho salmon spawn. Others soak into the ground.</span>` }))),
      h('button.link', { onclick: () => app.about(() => this.idle()) }, 'About this map')));
  }

  tap(p: XY): void {
    const run = this.app.world.nearestRun(p, 6 * this.app.camera.cam.mpp + 8);
    if (run) this.open(run);
  }

  pick(i: number): void {
    const p = this.picks[i];
    if (p) this.open(p.run);
  }

  /** Starts the story for a street run. */
  open(run: Run): void {
    const app = this.app;
    const name = app.world.pieceNames[run.piece] || 'this street';
    if (run.drain === null) {
      this.player.stop();
      this.lonely = run;
      app.setCaption(`lonely:${run.i}`, ICON.x(), `<span class="say">No mapped storm drain near this part of <b>${esc(name)}</b>.</span>`);
      app.setPanel(h('div', {},
        h('div.eyebrow', {}, 'NO DRAIN NEARBY'),
        h('h2.h', {}, name),
        h('p.p', {}, "The city's map shows no storm drain within 160 feet of this stretch, so there's no pipe to follow."),
        h('button.btn.quiet', { onclick: () => this.idle() }, 'Pick another street')));
      return;
    }
    this.lonely = null;
    this.player.start({ drain: run.drain, street: run.line, name, end: (d, p) => this.card(run, name, d, p) });
  }

  private card(run: Run, name: string, d: DrainInfo, p: DrainPath): Node {
    const app = this.app;
    const info = app.data.street(run.i);
    const tw = twist(info.terrain, info.cls, d.receiving);
    const dest = destination(d.cls, d.receiving);
    const guessCls = info.terrain.cls as Cls;
    const row = (lab: string, val: string, cls: string, extra = '') =>
      h('div.row' + extra, {}, h('span.lab', {}, lab), h('span.val.' + cls, {}, cap(val)));
    return h('div', {},
      h('div.eyebrow', {}, `WHERE ${name.toUpperCase()} DRAINS`),
      h('h2.h', {}, dest.title),
      h('div.cmp', {},
        row('Downhill guess', tw.normalMap, tw.differs ? 'wrong' : CLS.includes(guessCls) ? guessCls : 'other'),
        row('Real pipes', tw.realPipes, d.cls, '.answer')),
      h('p.p', { html: why(d.cls, d.receiving) + (tw.differs ? ' <b>Going by the hills alone gets this street wrong.</b>' : '') }),
      h('p.note', {}, `${d.reason} Traced ${fmt.ft(p.lengthM)} from catch basin ${d.id}.`),
      h('div.actions', {},
        h('button.btn.main', { onclick: () => this.player.replay() }, 'Watch it again'),
        h('button.btn.quiet', { onclick: () => { this.idle(); app.camera.flyTo({ mpp: 3.2 }, 900); } }, 'Another street')));
  }

  frame(now: number): FrameOut {
    const f = this.player.frame(now);
    if (f) return f;
    return { scene: { highlight: this.lonely?.line ?? null, flash: now / 1000 } };
  }
}
