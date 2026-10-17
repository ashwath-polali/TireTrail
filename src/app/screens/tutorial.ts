// First-run tutorial: five pictures that explain the whole idea.
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { art } from './art.ts';

const STEPS: { img: string; title: string; text: string }[] = [
  { img: 'tut-1-brake', title: 'Your tires wear down', text: 'Every time you brake or turn, your tires shed tiny bits of rubber onto the road.' },
  { img: 'tut-2-drain', title: 'Rain washes it away', text: 'When it rains, the water carries that tire dust into the nearest storm drain.' },
  { img: 'tut-3-pipes', title: 'The pipes decide', text: 'Underground pipes carry it off. Some lead straight to a creek. Others let the water soak into the ground.' },
  { img: 'tut-4-salmon', title: 'It harms salmon', text: 'Tire dust carries a chemical called 6PPD-quinone. In creeks it can kill coho salmon within hours of a storm.' },
  { img: 'tut-5-app', title: 'TireTrail shows you where', text: 'It follows every storm drain through the real pipe map, so you can see where your street\'s rain goes and drive in a way that sheds less.' },
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
    const finish = (tab: 'street' | 'drive') => { this.close(); this.app.setTab(tab); };
    this.el.replaceChildren(h('div.tcard', {},
      h('div.tart', {}, art(s.img, 'art big')),
      h('div.tbody', {},
        h('div.eyebrow', {}, `HOW IT WORKS · ${this.k + 1} OF ${STEPS.length}`),
        h('h2.h2', {}, s.title),
        h('p.lead', {}, s.text),
        dots,
        last
          ? h('div.actions.row', {},
            h('button.btn.main', { onclick: () => finish('street') }, 'Check my street'),
            h('button.btn.quiet', { onclick: () => finish('drive') }, 'Check my drive'))
          : h('div.actions.row', {},
            h('button.btn.main', { onclick: () => this.go(this.k + 1) }, 'Next'),
            this.k ? h('button.btn.quiet', { onclick: () => this.go(this.k - 1) }, 'Back') : null),
        h('button.link', { onclick: () => this.close() }, last ? 'Close' : 'Skip the tutorial'))));
  }
}
