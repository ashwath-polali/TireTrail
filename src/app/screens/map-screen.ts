// Map tab: every street colored by where its rain goes. Search or tap a street for a short answer.
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { esc, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Run } from '../map/world.ts';
import { destination, legend } from './common.ts';
import { Intro, introSeen } from './intro.ts';
import { Player } from './player.ts';
import { answer } from './street.ts';
import { StreetIndex } from './streets.ts';

export class MapScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private index: StreetIndex;
  private intro: Intro | null = null;
  private opened = false;
  private sel: Run | null = null;
  private watching = false;
  private q = '';

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
    app.onData(() => {
      this.index = new StreetIndex(app.world, (r) => app.placeOf(r));
      if (this.sel) this.sel = app.world.runs[this.sel.i];
    });
  }

  get introActive(): boolean {
    return this.intro !== null;
  }

  enter(): void {
    const app = this.app, first = !this.opened;
    this.opened = true;
    app.showStage();
    // the zoom from the West Coast plays the first time the map opens
    if (first && app.region && (app.introMode === 'force' || (app.introMode === 'auto' && !introSeen()))) this.playIntro();
    else if (this.sel) this.show(this.sel, false);
    else this.idle();
  }

  leave(): void {
    this.player.stop();
    this.watching = false;
    if (this.intro) {
      // put the camera home instead of leaving it over the whole country
      this.app.camera.follow();
      this.app.camera.cam = this.intro.end();
      this.intro = null;
    }
  }

  back(): boolean {
    if (this.watching && this.sel) { this.show(this.sel, false); return true; }
    if (this.sel) { this.idle(); return true; }
    return false;
  }

  relayout(): void {
    if (this.intro) this.intro.relayout();
    else if (this.watching) this.player.relayout();
    else if (this.sel) this.show(this.sel, false);
    else this.idle();
  }

  playIntro(): void {
    // only moves made after this count as interrupting it
    this.app.camera.follow();
    this.sel = null;
    this.intro = new Intro(this.app, () => { this.intro = null; this.idle(); });
  }

  idle(): void {
    const app = this.app;
    this.sel = null;
    this.watching = false;
    this.player.stop();
    app.setCaption('map', ICON.drop(), '<span class="say">Each street is colored by where its rain goes. Tap one.</span>');
    const input = h('input.search.small', { type: 'search', placeholder: 'Find a street', value: this.q, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find a street' }) as HTMLInputElement;
    const list = h('ul.suggest');
    let ask = 0;
    const fill = async () => {
      this.q = input.value;
      const mine = ++ask;
      const hits = this.index.search(this.q, 5);
      const rows = hits.map((hit) => h('li', {}, h('button', { onclick: () => { const r = this.index.main(hit.key); if (r) this.show(r, true); } }, hit.name, h('span.place', {}, hit.place))));
      list.replaceChildren(...rows);
      // the rest of the county, loaded only when picked
      const more = await app.areas.findStreet(this.q, 6 - rows.length);
      if (mine !== ask) return;
      const have = new Set(hits.map((hit) => hit.key));
      for (const m of more) if (!have.has(`${m.name}|${m.place}`)) rows.push(h('li', {}, h('button', { onclick: () => void this.openFar(m.name, m.place, m.area.bbox) }, m.name, h('span.place', {}, m.place))));
      list.replaceChildren(...rows);
      if (this.q.trim() && !rows.length) list.replaceChildren(h('li.none', {}, 'No street by that name in the traced area yet.'));
    };
    input.addEventListener('input', fill);
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') (list.querySelector('button') as HTMLButtonElement | null)?.click(); });
    fill();
    app.setPanel(h('div.fade', {},
      h('div.searchbox', {}, input, list),
      legend(),
      h('details.more', {},
        h('summary', {}, 'More'),
        h('div.actions.row', {},
          h('button.btn.quiet', { onclick: () => app.setTab('fix') }, 'Where to fix it'),
          app.region ? h('button.btn.quiet', { onclick: () => this.playIntro() }, 'Zoom out to the West Coast') : null))));
  }

  /** A street in a county area that isn't loaded yet. */
  private async openFar(name: string, place: string, bbox: Box): Promise<void> {
    const app = this.app;
    app.setCaption('loading', ICON.drop(), `<span class="say">Loading ${esc(place)}…</span>`);
    await app.ensureAreas(bbox, 1);
    const key = this.index.main(`${name}|${place}`) ? `${name}|${place}` : this.index.search(name, 20).find((hit) => hit.name === name)?.key;
    const r = key ? this.index.main(key) : null;
    if (r) this.show(r, true);
    else this.idle();
  }

  /** A short answer for one street, on the map. */
  show(run: Run, fly: boolean): void {
    const app = this.app, w = app.world;
    this.sel = run;
    this.watching = false;
    this.player.stop();
    const name = w.pieceNames[run.piece] || 'This street';
    const mid = run.line[run.line.length >> 1];
    if (fly) app.camera.flyTo(app.camAt(mid, Math.min(app.camera.cam.mpp, 2.2)), 800);
    const d = run.drain === null ? null : app.data.drain(run.drain);
    const dest = d ? destination(d.cls, d.receiving) : null;
    app.setCaption(`street:${run.i}`, dest ? dest.icon : ICON.x(), `<span class="say"><b>${esc(name)}</b></span>`);
    app.setPanel(h('div.fade', {},
      h('div.eyebrow', {}, `${name} · ${app.placeOf(run.i)}`.toUpperCase()),
      h('h2.h2', {}, d ? answer(d.cls, d.receiving) : 'No storm drain picks up rain here.'),
      h('div.actions.row', {},
        d ? h('button.btn.main', { onclick: () => this.watch(run) }, '▶  See it happen') : null,
        h('button.btn.quiet', { onclick: () => app.screens.street.open(run) }, 'More details')),
      h('button.link', { onclick: () => this.idle() }, '‹ All streets')));
  }

  private watch(run: Run): void {
    const app = this.app;
    if (run.drain === null) return;
    this.watching = true;
    app.pushStep();
    const name = app.world.pieceNames[run.piece] || 'this street';
    this.player.start({
      drain: run.drain, street: run.line, name,
      end: (d) => h('div.fade', {},
        h('div.eyebrow', {}, name.toUpperCase()),
        h('h2.h2', {}, answer(d.cls, d.receiving)),
        h('div.actions.row', {},
          h('button.btn.main', { onclick: () => this.show(run, false) }, '‹ Back'),
          h('button.btn.quiet', { onclick: () => this.player.replay() }, 'Watch again'))),
    });
  }

  tap(p: XY): boolean {
    if (this.intro) { this.intro.skip(); return true; }
    if (this.watching) return false;
    // far out, let the app zoom in instead of grabbing a street
    if (this.app.camera.cam.mpp > 16) return false;
    const run = this.app.world.nearestRun(p, 6 * this.app.camera.cam.mpp + 8);
    if (!run) return false;
    this.show(run, false);
    return true;
  }

  frame(now: number): FrameOut {
    if (this.intro) return { scene: {}, cam: this.intro.frame(now) };
    const f = this.player.frame(now);
    if (f) return f;
    return { scene: { highlight: this.sel?.line ?? null, flash: 0 } };
  }
}
