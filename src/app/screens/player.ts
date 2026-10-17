// Plays one drain's story and keeps the caption and panel in step with it.
import type { DrainInfo, DrainPath } from '../../data/tiretrail.ts';
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON, pips } from '../icons.ts';
import { Story, type StoryInput } from '../map/story.ts';
import { destination } from './common.ts';

export interface Play {
  drain: number;
  street: XY[] | null;
  name: string;
  /** first caption line, html */
  intro?: string;
  end: (d: DrainInfo, p: DrainPath) => Node;
}

export class Player {
  private readonly app: App;
  private story: Story | null = null;
  private inp: StoryInput | null = null;
  private play: Play | null = null;
  private d: DrainInfo | null = null;
  private p: DrainPath | null = null;
  private step = 0;
  private count: HTMLElement | null = null;
  private steps: HTMLElement[] = [];
  private shown = '';

  constructor(app: App) {
    this.app = app;
  }

  get active(): boolean {
    return this.story !== null;
  }

  start(play: Play): void {
    const app = this.app, r = app.renderer;
    this.play = play;
    this.d = app.data.drain(play.drain);
    this.p = app.data.path(play.drain);
    this.step = 0;
    this.progress();
    this.inp = {
      path: this.p.coords.map((c) => app.world.toWorld(c)), street: play.street, cls: this.d.cls, code: this.d.code,
      focusY: app.focusY, viewW: r.AW, viewH: r.AH, bandH: app.bandH,
    };
    this.story = new Story(app.world, this.inp, app.camera.cam, app.now());
    app.camera.follow();
  }

  replay(): void {
    if (this.play) this.start(this.play);
  }

  stop(): void {
    this.story = null;
    this.play = null;
    this.count = null;
  }

  frame(now: number): FrameOut | null {
    if (!this.story || !this.inp || !this.p) return null;
    // ease toward the open part of the screen as panels change size
    const inp = this.inp, r = this.app.renderer, k = this.app.frozen === null ? 0.12 : 1;
    inp.focusY += (this.app.focusY - inp.focusY) * k;
    inp.bandH += (this.app.bandH - inp.bandH) * k;
    [inp.viewW, inp.viewH] = [r.AW, r.AH];
    const f = this.story.frame(now);
    if (f.step !== this.step) {
      this.step = f.step;
      this.onStep();
    }
    if (this.count) {
      const t = `${fmt.ft(this.p.lengthM * f.prog).replace(' ft', '')} of ${fmt.ft(this.p.lengthM)}`;
      if (t !== this.shown) this.count.textContent = this.shown = t;
    }
    return { scene: f.scene, cam: f.cam, hideLabels: (f.scene.dissolve ?? 0) > 0 };
  }

  /** Small row on phones; the four steps on a laptop. */
  private progress(): void {
    const app = this.app, play = this.play!;
    this.count = h('span.count');
    this.shown = '';
    if (app.layout === 'phone') {
      const skip = h('button.skip', { onclick: () => this.story?.skip(app.now()) }, 'Skip');
      this.steps = [];
      app.setPanel(h('div.mini', {}, h('div', {}, h('div.eyebrow', {}, 'FOLLOWING THE RAIN'), h('div.name', {}, play.name)), h('div.side', {}, this.count, skip)), true);
      return;
    }
    const li = (n: number, text: string, extra?: Node) => h('li', {}, h('span.k', {}, String(n)), h('span.t', {}, text), extra ?? null);
    this.steps = [
      li(1, `Rain washes tire dust off ${play.name}`),
      li(2, 'It pours into a storm drain'),
      li(3, "It runs through the city's pipes", this.count),
      li(4, 'Where it ends up'),
    ];
    const skipAll = h('button.btn.quiet', { onclick: () => this.story?.skip(app.now()) }, 'Skip to the end');
    app.setPanel(h('div', {}, h('div.eyebrow', {}, 'FOLLOWING THE RAIN'), h('h2.h', {}, play.name), h('ol.steps', {}, ...this.steps), h('div.actions', {}, skipAll)));
  }

  private onStep(): void {
    const play = this.play!, d = this.d!;
    const dest = destination(d.cls, d.receiving);
    const lines: [string, string][] = [
      [ICON.drop(), play.intro ?? `Rain washes tire dust off <b>${esc(play.name)}</b>.`],
      [ICON.grate(), 'It pours into a storm drain.'],
      [ICON.pipe(), "It follows the city's real pipes underground."],
      [dest.icon, dest.say],
    ];
    const [icon, say] = lines[this.step - 1];
    this.app.setCaption(`story:${play.drain}:${this.step}`, icon, `${pips(this.step)}<span class="say">${say}</span>`);
    this.steps.forEach((el, k) => el.className = k + 1 < this.step ? 'done' : k + 1 === this.step ? 'now' : '');
    if (this.step === 4) {
      this.count = null;
      this.app.setPanel(play.end(d, this.p!));
    }
  }
}
