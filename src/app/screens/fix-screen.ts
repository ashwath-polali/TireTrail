// Fix list tab: the five spots where cleaning the water would catch runoff from the most street.
import type { FixListEntry } from '../../data/tiretrail.ts';
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen, Tab } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { button, panel, sheet } from '../ui/ui.ts';
import { far } from './drive-words.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** "(4.19 m gap)" in a gap's label, said in feet: "(about 14 ft)" */
export const gapFeet = (s: string): string => s.replace(/\((\d+(?:\.\d+)?) m gap\)/g, (_, m: string) => `(about ${Math.max(1, Math.round(Number(m) * 3.28084))} ft)`);
const tt = (): boolean => { try { return !!(history.state as { tt?: number } | null)?.tt; } catch { return false; } };

export class FixScreen implements Screen {
  private sel = -1;
  private readonly items: FixListEntry[];
  private readonly at: XY[];
  private readonly runs: Set<number>[];
  /** history steps the list holds: one for itself, one more for an open spot */
  private depth = 0;
  /** when a jump back over the list's steps began; its own popstate leaves the list */
  private leaveAt = 0;
  /** the tab the list was opened from */
  private from: Tab = 'drive';

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
    // App.setTab keeps the tab it came from (B20); without it, Back goes to Drive
    const prev = (this.app as unknown as { prevTab?: Tab }).prevTab;
    this.from = prev && prev !== 'fix' ? prev : 'drive';
    // a list opened from a page with its own step (About) shares it; otherwise it gets one, so Back returns
    this.sel = -1;
    if (!tt()) this.app.pushStep();
    this.depth = 1;
    this.app.showStage();
    this.render();
    this.frameView();
  }

  leave(): void {}

  /** The phone's Back: closes an open spot, else goes back to where the list was opened from. */
  back(): boolean {
    const leaving = this.leaveAt > 0 && Date.now() - this.leaveAt < 3000;
    this.leaveAt = 0;
    if (this.depth > 0) this.depth--;
    if (this.sel >= 0 && !leaving) { this.show(-1); return true; }
    this.depth = 0;
    this.app.setTab(this.from);
    return true;
  }

  relayout(): void {
    this.render();
    this.frameView();
  }

  /** Opens a spot, or closes it when it's already open. */
  select(i: number): void {
    if (i === this.sel) { this.close(); return; }
    // one step for an open spot, however many are tapped in turn
    if (this.sel < 0) { this.app.pushStep(); this.depth++; }
    this.show(i);
  }

  /** In-app back: through history while our step is on top. */
  private close(): void {
    if (this.depth > 0 && tt()) history.back();
    else { this.depth = 0; this.back(); }
  }

  private show(i: number): void {
    this.sel = i;
    this.render(true);
    this.panelItem()?.scrollIntoView({ block: 'nearest' });
    this.frameView();
  }

  private panelItem(): HTMLElement | null {
    return this.sel < 0 ? null : this.app.panel.querySelectorAll<HTMLElement>('.dv-fix-list > *')[this.sel] ?? null;
  }

  private frameView(): void {
    const w = this.app.world;
    // never tighter than overview zoom, where the highlighted streets read best
    if (this.sel < 0) { this.app.fitView(this.at, { min: 3 }); return; }
    const pts = [...this.runs[this.sel]].flatMap((i) => w.runs[i].line);
    this.app.fitView([...pts, this.at[this.sel]], { min: 3 });
  }

  private render(keepScroll = false): void {
    const app = this.app, f = this.items[this.sel], n = this.items.length;
    app.setCaption(`fix:${this.sel}`, ICON.grate(), f
      ? `<span class="say">Spot ${this.sel + 1}: runoff from the <b>highlighted streets</b> all ends up here.</span>`
      : `<span class="say">${COUNT[n] ?? n} spots that collect runoff from the most street on its way to Fennel Creek.</span>`);
    app.setPanel(sheet([
      h('p.u-body', {}, 'At each spot, runoff from several streets comes together on its way to the creek. Cleaning the water there catches tire dust from all of them.'),
      h('div.dv-fix-list', {}, ...this.items.map((it, i) => this.item(it, i))),
      h('p.u-caption', {}, "Some paths cross small gaps in the city's pipe map that TireTrail had to bridge. They're listed so the city can check them."),
    ], {
      eyebrow: 'FIX LIST FOR THE CITY',
      title: 'Where a filter would catch runoff from the most street',
      actions: [
        button('Back', { kind: 'secondary', icon: 'back', onClick: () => this.leaveList() }),
        button('The full map', { kind: 'secondary', icon: 'map', onClick: () => app.setTab('map') }),
      ],
    }), false, keepScroll);
  }

  /** The list's own Back button: back over its steps in history, so the phone's Back stays in step. */
  private leaveList(): void {
    if (this.depth > 0 && tt()) { this.leaveAt = Date.now(); history.go(-this.depth); return; }
    this.depth = 0;
    this.app.setTab(this.from);
  }

  private item(f: FixListEntry, i: number): HTMLElement {
    const on = i === this.sel;
    const title = f.label.split(', ')[0];
    const near = /near (.+)$/.exec(f.label)?.[1];
    const bridged = f.inferredStreetM >= 30 ? ` ${far(f.inferredStreetM)} of it crosses gaps TireTrail bridged.` : '';
    const more = on
      ? h('div.dv-fix-more', {},
        h('p', { html: `<b>Streets:</b> ${esc(f.streets.join(', '))}` }),
        f.bridges.length ? h('p', { html: `<b>Gaps to check:</b> ${f.bridges.map((b) => esc(gapFeet(b))).join('; ')}` }) : null)
      : null;
    const el = panel([
      h('div.dv-fix-row', {},
        h('span.dv-fix-n', { 'aria-hidden': 'true' }, String(i + 1)),
        h('div.dv-fix-text', {},
          h('p.dv-fix-t', {}, near ? `${title}, near ${near}` : title),
          h('p.dv-fix-s', {}, `${fmt.mi(f.streetM)} of street from ${f.drains} drains, to ${f.receiving}.${bridged}`))),
      more,
    ], { onClick: () => this.select(i), pad: 's' });
    el.classList.toggle('dv-on', on);
    el.setAttribute('aria-expanded', String(on));
    el.setAttribute('aria-label', `Spot ${i + 1}: ${near ? `${title}, near ${near}` : title}`);
    return el;
  }

  tap(p: XY): boolean {
    const k = this.app.pinAt(this.at, p);
    if (k >= 0) this.select(k);
    return k >= 0;
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
