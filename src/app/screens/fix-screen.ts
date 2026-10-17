// Fix list tab: the five spots where cleaning the water would catch runoff from the most street.
import type { FixListEntry } from '../../data/tiretrail.ts';
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';

export class FixScreen implements Screen {
  private sel = -1;
  private readonly items: FixListEntry[];
  private readonly at: XY[];
  private readonly runs: Set<number>[];

  private readonly app: App;

  constructor(app: App) {
    this.app = app;
    const b = app.data.bundle;
    this.items = app.data.fixList;
    this.at = this.items.map((f) => app.world.toWorld(f.lngLat));
    // streets whose drains end at each spot
    const byExit = new Map<number, Set<number>>(b.fixList.map((f) => [f.exit, new Set<number>()]));
    for (const r of app.world.runs) {
      if (r.drain === null) continue;
      byExit.get(b.endings[b.drains.ending[r.drain]].exit)?.add(r.i);
    }
    this.runs = b.fixList.map((f) => byExit.get(f.exit)!);
  }

  enter(): void {
    this.render();
    this.frameView();
  }

  leave(): void {}

  select(i: number): void {
    this.sel = i === this.sel ? -1 : i;
    this.render();
    this.frameView();
  }

  private frameView(): void {
    const w = this.app.world;
    if (this.sel < 0) { this.app.fitView(this.at); return; }
    const pts = [...this.runs[this.sel]].flatMap((i) => w.runs[i].line);
    this.app.fitView([...pts, this.at[this.sel]]);
  }

  private render(): void {
    const app = this.app, f = this.items[this.sel];
    app.setCaption(`fix:${this.sel}`, ICON.grate(), f
      ? `<span class="say">Spot ${this.sel + 1}: runoff from the <b>highlighted streets</b> all ends up here.</span>`
      : '<span class="say">Five spots where cleaning the water would help Fennel Creek most.</span>');
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'FIX LIST FOR THE CITY'),
      h('h2.h', {}, 'Where a filter would catch the most'),
      h('p.p', {}, 'At each spot, runoff from many streets comes together on its way to the creek. Cleaning the water there catches tire dust from all of them.'),
      h('div.list', {}, ...this.items.map((it, i) => this.item(it, i))),
      h('p.note', {}, "Some paths cross small gaps in the city's pipe map that TireTrail had to bridge. They're listed so the city can check them."),
      h('button.link', { onclick: () => app.about(() => this.render()) }, 'About this data')));
  }

  private item(f: FixListEntry, i: number): HTMLElement {
    const on = i === this.sel;
    const title = f.label.split(', ')[0];
    const near = /near (.+)$/.exec(f.label)?.[1];
    const more = on
      ? h('span.more', {},
        h('span.s', { html: `<b>Streets:</b> ${esc(f.streets.join(', '))}` }),
        f.bridges.length ? h('span.s', { html: `<b>Gaps to check:</b> ${f.bridges.map(esc).join('; ')}` }) : null)
      : null;
    return h('button.item' + (on ? '.on' : ''), { onclick: () => this.select(i), 'aria-expanded': String(on) },
      h('span.n', {}, String(i + 1)),
      h('span', {},
        h('span.t', {}, near ? `${title}, near ${near}` : title),
        h('span.s', {}, `${fmt.mi(f.streetM)} of street from ${f.drains} drains, to ${f.receiving}.`),
        more));
  }

  tap(p: XY): void {
    const k = this.app.pinAt(this.at, p);
    if (k >= 0) this.select(k);
  }

  frame(): FrameOut {
    return {
      scene: {
        pins: this.at.map((at, k) => ({ at, n: k + 1, active: k === this.sel })),
        focusRuns: this.sel >= 0 ? this.runs[this.sel] : null,
      },
    };
  }
}
