// First open: three big pictures, one sentence each. Skippable; then home.
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { button, calm, chip, glyph, meter, score, timeline } from '../ui/ui.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';

export interface Step {
  kicker: string;
  art: string;
  title: string;
  text: string;
}

export const STEPS: readonly Step[] = [
  { kicker: 'WHAT IT DOES', art: 'tut-1-brake', title: 'Drive smoother. Spend less.', text: 'TireTrail finds your hard stops and speeding, and shows what they cost you in gas and tires.' },
  { kicker: 'WHY IT MATTERS', art: 'tut-4-salmon', title: 'Tire dust hurts salmon.', text: 'Rain can wash tire dust into local streams, where a chemical in it can kill coho salmon within hours.' },
  { kicker: 'HOW IT WORKS', art: 'tut-5-app', title: 'A voice helps while you drive.', text: 'TireTrail learns where you brake hard and stop. Next time, a calm voice tells you to ease off before you get there.' },
];

/** A small picture of the app for each step: the score, the water's path, the warning. */
function demo(k: number): HTMLElement {
  if (k === 0) {
    return h('div.dv-ob-demo.dv-board', { 'data-tone': 'warn' },
      h('div.dv-board-cells', {},
        score(58, { label: 'SMOOTH SCORE', caption: 'out of 100', tone: 'warn', countUp: true }),
        score(25, { label: 'COULD SAVE', prefix: '$', caption: 'a year, estimated', tone: 'money', countUp: true })),
      meter(58, 100, { blocks: 20, tone: 'warn' }),
      h('div.dv-lost-pts', {}, chip('-30 hard brakes', 'warn'), chip('-13 over the speed limit', 'warn')),
      h('p.dv-ob-demo-note', {}, 'From the sample drive.'));
  }
  if (k === 1) {
    return h('div.dv-ob-demo.dv-ob-path', {}, timeline([
      { tone: 'you', title: 'Your hard stop', sub: 'Tire dust lands on the road.' },
      { tone: 'plain', title: 'Storm drain', sub: 'Rain washes the dust in.' },
      { tone: 'salmon', title: 'A salmon stream', sub: 'Coho salmon can die within hours.' },
    ]));
  }
  return h('div.dv-ob-demo.dv-rec-warn', { 'data-kind': 'spot' },
    h('span.dv-rec-warn-ico', { 'aria-hidden': 'true', html: glyph('bell', 3) }),
    h('span.dv-rec-warn-text', {}, h('b', {}, 'Hard-stop spot ahead.'), h('span', {}, 'Ease off.')));
}

/** The first-open guide: an overlay over the whole app, with its own history step so Back closes it. */
export class Onboarding {
  protected readonly app: App;
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
      this.el = h('div.dv-ob', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ob-title' });
      this.el.addEventListener('keydown', this.onKey);
      this.host.append(this.el);
      // only the guide can be reached until it closes
      for (const c of Array.from(this.host.children)) if (c !== this.el) (c as HTMLElement).inert = true;
      this.app.pushStep();
      this.pushed = true;
    }
    this.draw('head', 0);
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
    if (e.key === 'ArrowRight' && this.k < STEPS.length - 1) { e.preventDefault(); this.go(this.k + 1, 'next'); return; }
    if (e.key === 'ArrowLeft' && this.k > 0) { e.preventDefault(); this.go(this.k - 1, 'back'); return; }
    if (e.key !== 'Escape') return;
    // handled here, so the app's own Escape doesn't go back a second time
    e.preventDefault();
    e.stopPropagation();
    this.dismiss();
  };

  private go(k: number, focus: string): void {
    const from = this.k;
    this.k = Math.max(0, Math.min(STEPS.length - 1, k));
    this.draw(focus, Math.sign(this.k - from));
  }

  /** focus: what gets focus after the redraw ('head', 'next' or 'back'). dir: which way the step moved. */
  private draw(focus: string, dir: number): void {
    if (!this.el) return;
    const s = STEPS[this.k], last = this.k === STEPS.length - 1, app = this.app;
    const finish = (sample: boolean) => this.dismiss(() => {
      if (app.tab !== 'drive') app.setTab('drive');
      else if (!sample) app.screens.drive.home();
      if (sample) void app.screens.drive.loadSample();
    });
    const steps = h('div.dv-ob-steps', { role: 'tablist', 'aria-label': 'Steps' }, ...STEPS.map((_, i) => h('button.dv-ob-step' + (i <= this.k ? '.dv-on' : ''), {
      type: 'button', role: 'tab', 'aria-label': `Step ${i + 1} of ${STEPS.length}`, 'aria-selected': String(i === this.k), onclick: () => this.go(i, 'head'),
    })));
    const next = button(last ? 'Get started' : 'Next', { kind: 'primary', icon: last ? 'check' : 'arrow', wide: true, onClick: () => (last ? finish(false) : this.go(this.k + 1, 'next')) });
    next.dataset.f = 'next';
    const back = this.k ? button('Back', { kind: 'ghost', icon: 'back', onClick: () => this.go(this.k - 1, 'back') }) : null;
    if (back) back.dataset.f = 'back';
    const keys = h('div.dv-ob-keys', {},
      next,
      last ? button('Try a sample drive', { kind: 'secondary', icon: 'play', wide: true, onClick: () => finish(true) }) : null,
      h('div.dv-ob-small', {}, back ?? h('span'), last ? null : button('Skip', { kind: 'ghost', onClick: () => this.dismiss() })));
    const art = h('div.dv-ob-art', {},
      h('img', { src: `art/${s.art}.png`, alt: '', draggable: 'false' }),
      calm() ? null : h('div.dv-drops', { 'aria-hidden': 'true' }, ...Array.from({ length: 12 }, (_, i) => h('i', { style: `--x:${(i * 41) % 100}%;--d:${(i * 211) % 900}ms;--h:12px` }))));
    const card = h('div.dv-ob-card' + (dir > 0 ? '.dv-in-r' : dir < 0 ? '.dv-in-l' : ''), {},
      art,
      h('div.dv-ob-body', {},
        steps,
        h('p.u-eyebrow.dv-ob-count', {}, h('span.u-sr', {}, `Step ${this.k + 1} of ${STEPS.length}: `), s.kicker),
        h('h2.dv-ob-title', { id: 'ob-title', tabindex: '-1', 'data-f': 'head' }, s.title),
        h('p.dv-ob-text', {}, s.text),
        demo(this.k),
        keys));
    this.el.replaceChildren(card);
    const want = this.el.querySelector<HTMLElement>(`[data-f="${focus}"]`) ?? this.el.querySelector<HTMLElement>('[data-f="next"]');
    want?.focus({ preventScroll: true });
  }
}
