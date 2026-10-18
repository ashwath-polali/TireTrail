/// <reference types="vite/client" />
// Plays one drain's story and keeps the caption and panel in step with it.
import { decodePath, KINDS } from '../../data/bundle.ts';
import type { DrainInfo, DrainPath } from '../../data/tiretrail.ts';
import { pointAlong, polylineLength, type XY } from '../../geo/geo.ts';
import type { App, FrameOut } from '../app.ts';
import { fmt, h } from '../dom.ts';
import { ICON, pips } from '../icons.ts';
import { S } from '../map/render.ts';
import { Story, words, type Mark, type StoryInput, type Words } from '../map/story.ts';
import './story.css';

export interface Play {
  drain: number;
  street: XY[] | null;
  name: string;
  /** first caption line, html */
  intro?: string;
  end: (d: DrainInfo, p: DrainPath) => Node;
}

// icons the map tab may add; plain ones until then
const I = ICON as typeof ICON & Partial<Record<'soak' | 'waves' | 'q', (s?: number) => string>>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Player {
  private readonly app: App;
  private story: Story | null = null;
  private inp: StoryInput | null = null;
  private play: Play | null = null;
  private d: DrainInfo | null = null;
  private p: DrainPath | null = null;
  private say: Words | null = null;
  private step = -1;
  /** reduced motion: still steps, moved by Back and Next */
  private calm = false;
  private at = 1;
  private count: HTMLElement | null = null;
  private steps: HTMLElement[] = [];
  private back: HTMLButtonElement | null = null;
  private next: HTMLButtonElement | null = null;
  private ending = false; // the closing card is up
  private fixed = ''; // still steps: the layout the open band was measured for
  private shown = '';

  constructor(app: App) {
    this.app = app;
  }

  get active(): boolean {
    return this.story !== null;
  }

  start(play: Play): void {
    const app = this.app, r = app.renderer, w = app.world;
    this.play = play;
    this.d = app.data.drain(play.drain);
    this.p = app.data.path(play.drain);
    [this.step, this.at, this.calm, this.ending] = [-1, 1, r.calm, false];
    const path = this.p.coords.map((c) => w.toWorld(c));
    const owner = app.region && path.length ? app.region.ownerAt(path[0]) : null;
    this.inp = {
      path, street: play.street, cls: w.drainCls(play.drain), code: this.d.code,
      focusY: app.focusY, viewW: r.AW, viewH: r.AH, bandH: app.bandH, side: 0,
      name: play.name, receiving: this.d.receiving, owner, marks: marks(app, play.drain), phone: app.layout === 'phone',
    };
    const s = this.story = new Story(w, this.inp, app.camera.cam, app.now());
    this.say = words({ name: play.name, cls: s.cls, code: this.d.code, receiving: this.d.receiving, lengthM: s.lengthM, hopM: s.hopM, tiny: s.tiny, owner, calm: this.calm, intro: play.intro });
    this.progress();
    // still steps: caption and card first, so the open band is measured once with them up
    if (this.calm) {
      this.step = 1;
      this.onStep();
    }
    this.fixed = '';
    this.measure(true);
    app.camera.follow();
  }

  /** Where the open band is. Moving, it eases as panels change size; still, it holds until the layout or the phone card changes. */
  private measure(snap = false): void {
    const app = this.app, inp = this.inp!, r = app.renderer;
    [inp.viewW, inp.viewH, inp.phone] = [r.AW, r.AH, app.layout === 'phone'];
    if (this.calm) {
      const key = `${app.layout} ${r.AW}x${r.AH} ${app.layout === 'phone' ? app.panel.offsetHeight : 0}`;
      if (key === this.fixed) return;
      this.fixed = key;
      snap = true;
    }
    const k = snap || app.frozen !== null ? 1 : 0.12;
    inp.focusY += (app.focusY - inp.focusY) * k;
    inp.bandH += (app.bandH - inp.bandH) * k;
    inp.side = (inp.side ?? 0) + (this.side() - (inp.side ?? 0)) * k;
  }

  /** Rebuilds the progress panel for a new layout, mid-story. */
  relayout(): void {
    if (!this.story || this.ending) return;
    this.progress();
  }

  replay(): void {
    if (this.play) this.start(this.play);
  }

  stop(): void {
    this.story = null;
    this.play = null;
    this.count = null;
    this.back = this.next = null;
  }

  /** A tap on the map, or Skip: straight to the end. */
  skipToEnd(): void {
    if (!this.story) return;
    if (this.calm) this.at = 4;
    else this.story.skipToEnd(this.app.now(), this.app.camera.cam);
  }

  frame(now: number): FrameOut | null {
    if (!this.story || !this.inp || !this.p) return null;
    const app = this.app;
    this.measure();
    const f = this.calm ? this.story.still(this.at) : this.story.frame(now);
    if (f.step !== this.step) {
      this.step = f.step;
      this.onStep();
    }
    const under = (f.scene.dissolve ?? 0) > 0;
    this.chip(under);
    if (this.count) {
      const L = this.p.lengthM, t = `${fmt.ft(L * f.prog).replace(' ft', '')} of ${fmt.ft(L)}${app.layout === 'phone' ? ' of pipe' : ''}`;
      if (t !== this.shown) this.count.textContent = this.shown = t;
    }
    return { scene: f.scene, cam: f.cam, hideLabels: under };
  }

  /** On a laptop the card sits on the left, so the action keeps to its right, as app.camAt does. */
  private side(): number {
    const pn = this.app.panel;
    return this.app.layout === 'laptop' && pn.childElementCount ? (pn.offsetWidth + 16) / 2 / S : 0;
  }

  /** UNDER THE STREET rides in the caption while the view is under the street. */
  private chip(on: boolean): void {
    const row = this.app.caption.querySelector('.st-row'), el = row?.querySelector('.st-under');
    if (on && row && !el) row.append(h('span.chip.st-under', {}, 'UNDER THE STREET'));
    else if (!on && el) el.remove();
  }

  /** Small row on phones; the four steps on a laptop. Reduced motion gets Back and Next instead of Skip. */
  private progress(): void {
    const app = this.app, play = this.play!, say = this.say!;
    this.count = this.story?.tiny ? null : h('span.st-count');
    this.shown = '';
    this.ending = false;
    const nav = this.calm ? this.nav() : null;
    if (!this.calm) this.back = this.next = null;
    if (app.layout === 'phone') {
      this.steps = [];
      const skip = this.calm ? null : h('div.side', {}, h('button.skip.st-tap', { onclick: () => this.skipToEnd() }, 'Skip'));
      app.setPanel(h('div', {}, h('div.mini', {}, h('div', {}, h('div.eyebrow', {}, 'FOLLOWING THE RAIN'), h('div.name', {}, play.name), this.count), skip), nav), true);
    } else {
      const li = (n: number, text: string, extra: Node | null) => h('li', {}, h('span.k', {}, String(n)), h('span.t', {}, text), extra);
      this.steps = say.steps.map((t, i) => li(i + 1, t, i === 2 ? this.count : null));
      const skipAll = h('button.btn.quiet', { onclick: () => this.skipToEnd() }, 'Skip to the end');
      app.setPanel(h('div', {}, h('div.eyebrow', {}, 'FOLLOWING THE RAIN'), h('h2.h', {}, cap(play.name)), h('ol.steps', {}, ...this.steps), nav ?? h('div.actions', {}, skipAll)));
    }
    this.paint();
  }

  private nav(): HTMLElement {
    this.back = h('button.btn.quiet', { onclick: () => this.go(this.at - 1) }, 'Back') as HTMLButtonElement;
    this.next = h('button.btn.main', { onclick: () => this.go(this.at + 1) }, 'Next') as HTMLButtonElement;
    return h('div.st-nav', {}, this.back, this.next);
  }

  private go(k: number): void {
    this.at = Math.min(4, Math.max(1, k));
  }

  private paint(): void {
    const k = this.step;
    this.steps.forEach((el, i) => el.className = i + 1 < k ? 'done' : i + 1 === k ? 'now' : '');
    if (this.back) this.back.disabled = this.at <= 1;
  }

  private onStep(): void {
    const play = this.play!, say = this.say!, k = this.step;
    const lines: [string, string][] = [[this.icon(), say.pro], [ICON.drop(), say.rain], [ICON.grate(), say.drain], [ICON.pipe(), say.pipes], [this.icon(), say.end]];
    const [icon, text] = lines[k];
    this.app.setCaption(`story:${play.drain}:${k}`, icon, `<div class="st-row">${pips(k)}</div><span class="say">${text}</span>`);
    // keyboard focus follows the buttons when the card changes under it
    const pn = this.app.panel, had = pn.contains(document.activeElement);
    if (k === 4) {
      this.count = null;
      this.ending = true;
      const end = play.end(this.d!, this.p!);
      this.app.setPanel(this.calm ? h('div', {}, end, h('button.st-back', { onclick: () => this.go(3) }, 'Back to step 3')) : end);
      if (had) pn.querySelector<HTMLElement>('button')?.focus();
      return;
    }
    if (this.ending) {
      // back from the closing card
      this.progress();
      if (had) this.back?.focus();
    }
    this.paint();
  }

  private icon(): string {
    switch (this.story!.cls) {
      case 'creek': return ICON.fish();
      case 'ground': return I.soak?.() ?? ICON.pond();
      case 'elsewhere': return I.waves?.() ?? ICON.drop();
      case 'treatment': return ICON.pipe();
      default: return I.q?.() ?? ICON.pipe();
    }
  }
}

/** What the water passes on its way, from the data file. */
function marks(app: App, drain: number): Mark[] {
  const b = app.data.bundle, out: Mark[] = [];
  let ids: number[];
  try { ids = decodePath(b, drain); } catch { return out; }
  for (const a of ids.slice(1)) {
    const kind = KINDS[b.assets.kind[a]], key = b.assets.key[a] ?? '';
    // catch basins and dry wells along the way aren't manholes
    const m: Mark['kind'] | null = kind === 'pipe' ? 'pipe' : kind === 'channel' ? 'ditch' : kind === 'vault' ? 'tank' : kind === 'pond' ? 'pond'
      : kind === 'outlet' ? 'outfall' : kind === 'structure' && !/^(CB|DW)/i.test(key) ? 'manhole' : null;
    if (!m) continue;
    const g = app.data.geometry(a).map((c) => app.world.toWorld(c));
    if (g.length) out.push({ kind: m, at: g[0], mid: g.length > 1 ? pointAlong(g, polylineLength(g) / 2) : g[0] });
  }
  return out;
}
