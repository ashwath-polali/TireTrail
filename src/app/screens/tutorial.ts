// First-run tutorial: four calm pictures that explain the whole idea.
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { art } from './art.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';

const STEPS: { img: string; title: string; text: string }[] = [
  { img: 'tut-1-brake', title: 'Braking sheds rubber', text: 'Every time you brake hard, your tires leave a little rubber dust on the road.' },
  { img: 'tut-2-drain', title: 'Rain washes it away', text: 'When it rains, that dust runs into the nearest storm drain.' },
  { img: 'tut-3-pipes', title: 'Some drains lead to creeks', text: 'Underground pipes carry it off. Some go straight to a creek. Others let it soak into the ground.' },
  { img: 'tut-4-salmon', title: 'It harms salmon', text: "A chemical in tire dust can kill coho salmon within hours. TireTrail shows where your stops' dust goes, so you know where to brake gently." },
];

export class Tutorial {
  private readonly app: App;
  private readonly host: HTMLElement;
  private el: HTMLElement | null = null;
  private k = 0;
  /** it has a history step, so the phone's Back closes it */
  private pushed = false;
  /** what had focus before it opened */
  private opener: HTMLElement | null = null;
  /** runs once it has closed */
  private then: (() => void) | null = null;

  constructor(app: App, host: HTMLElement) {
    this.app = app;
    this.host = host;
  }

  get seen(): boolean {
    try { return localStorage.getItem('tt-tut') === '1'; } catch { return false; }
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(): void {
    this.k = 0;
    if (!this.el) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el = h('div.tutorial', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tut-title' });
      this.el.addEventListener('keydown', this.onKey);
      this.host.append(this.el);
      // only the tutorial can be reached until it closes
      for (const c of Array.from(this.host.children)) if (c !== this.el) (c as HTMLElement).inert = true;
      this.app.pushStep();
      this.pushed = true;
    }
    this.draw('head');
  }

  /** Closes it. The app calls this on Back, when its history step is already gone. */
  close(): void {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this.pushed = false;
    for (const c of Array.from(this.host.children)) (c as HTMLElement).inert = false;
    try { localStorage.setItem('tt-tut', '1'); } catch { /* storage blocked */ }
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
    const then = this.then;
    this.then = null;
    then?.();
  }

  /** In-app close: through history while its step is on top, so the phone's Back stays in step. */
  private dismiss(then?: () => void): void {
    this.then = then ?? null;
    let ours = false;
    try { ours = this.pushed && !!(history.state as { tt?: number } | null)?.tt; } catch { /* sandboxed */ }
    if (ours) history.back();
    else this.close();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // handled here, so the app's own Escape doesn't go back a second time
    e.preventDefault();
    e.stopPropagation();
    this.dismiss();
  };

  private go(k: number, focus: string): void {
    this.k = Math.max(0, Math.min(STEPS.length - 1, k));
    this.draw(focus);
  }

  /** focus: which control gets focus after the redraw ('head', 'next', 'back' or 'dot') */
  private draw(focus: string): void {
    if (!this.el) return;
    const s = STEPS[this.k], last = this.k === STEPS.length - 1;
    const dots = h('div.dv-dots', {}, ...STEPS.map((_, i) => h('button.dv-dot', {
      'aria-label': `Step ${i + 1}`, 'aria-current': i === this.k ? 'step' : undefined, 'data-f': i === this.k ? 'dot' : undefined, onclick: () => this.go(i, 'dot'),
    })));
    const finish = (sample: boolean) => this.dismiss(() => {
      this.app.setTab('drive');
      if (sample) void this.app.screens.drive.loadSample();
    });
    this.el.replaceChildren(h('div.tcard.fade', {},
      h('div.tart', {}, art(s.img, 'art big')),
      h('div.tbody', {},
        h('div.eyebrow', {}, `HOW IT WORKS · ${this.k + 1} OF ${STEPS.length}`),
        h('h2.h2.dv-head', { id: 'tut-title', tabindex: '-1', 'data-f': 'head' }, s.title),
        h('p.lead', {}, s.text),
        dots,
        last
          ? h('div.actions.row', {},
            h('button.btn.main', { onclick: () => finish(false), 'data-f': 'next' }, 'Got it'),
            h('button.btn.quiet', { onclick: () => finish(true) }, 'Try a sample drive'))
          : h('div.actions.row', {},
            h('button.btn.main', { onclick: () => this.go(this.k + 1, 'next'), 'data-f': 'next' }, 'Next'),
            this.k ? h('button.btn.quiet', { onclick: () => this.go(this.k - 1, 'back'), 'data-f': 'back' }, 'Back') : null),
        h('button.link', { onclick: () => this.dismiss() }, last ? 'Close' : 'Skip'))));
    const want = this.el.querySelector<HTMLElement>(`[data-f="${focus}"]`) ?? this.el.querySelector<HTMLElement>('[data-f="next"]');
    want?.focus();
  }
}
