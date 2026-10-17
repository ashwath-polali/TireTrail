// First-run tutorial: four calm pictures that explain the whole idea.
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { art } from './art.ts';

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
      this.el = h('div.tutorial', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How TireTrail works' });
      this.host.append(this.el);
    }
    this.draw();
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    try { localStorage.setItem('tt-tut', '1'); } catch { /* storage blocked */ }
  }

  private go(k: number): void {
    this.k = Math.max(0, Math.min(STEPS.length - 1, k));
    this.draw();
  }

  private draw(): void {
    if (!this.el) return;
    const s = STEPS[this.k], last = this.k === STEPS.length - 1;
    const dots = h('div.dots', {}, ...STEPS.map((_, i) => h('button' + (i === this.k ? '.on' : ''), { 'aria-label': `Step ${i + 1}`, onclick: () => this.go(i) })));
    const finish = (sample: boolean) => {
      this.close();
      this.app.setTab('drive');
      if (sample) void this.app.screens.drive.loadSample();
    };
    this.el.replaceChildren(h('div.tcard.fade', {},
      h('div.tart', {}, art(s.img, 'art big')),
      h('div.tbody', {},
        h('div.eyebrow', {}, `HOW IT WORKS · ${this.k + 1} OF ${STEPS.length}`),
        h('h2.h2', {}, s.title),
        h('p.lead', {}, s.text),
        dots,
        last
          ? h('div.actions.row', {},
            h('button.btn.main', { onclick: () => finish(false) }, 'Got it'),
            h('button.btn.quiet', { onclick: () => finish(true) }, 'Try a sample drive'))
          : h('div.actions.row', {},
            h('button.btn.main', { onclick: () => this.go(this.k + 1) }, 'Next'),
            this.k ? h('button.btn.quiet', { onclick: () => this.go(this.k - 1) }, 'Back') : null),
        h('button.link', { onclick: () => this.close() }, last ? 'Close' : 'Skip'))));
  }
}
