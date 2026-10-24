// First open: three slides. Why Puget Sound's coho die, what TireTrail does, then a drive. Skippable; then home.
// It can open before the map has loaded, and hands its keys to the app once it has.
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { button, calm, score } from '../ui/ui.ts';
import { beat, SAMPLE_CARD, sampleCents, SCIENCE, STEPS, type Step } from './guide-words.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';
// @ts-ignore: Vite loads the CSS
import './guide.css';

export { STEPS, type Step };

interface Pic { img: HTMLImageElement; ok: boolean; ready: Promise<void> }
const pics = new Map<string, Pic>();

/** A picture, loaded and decoded once. A slide waits for its picture, so it never opens on an empty frame. */
function pic(name: string): Pic {
  let p = pics.get(name);
  if (!p) {
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    img.src = `art/${name}.png`;
    const e: Pic = { img, ok: false, ready: Promise.resolve() };
    // a missing picture never holds the guide up
    e.ready = img.decode().catch(() => {}).then(() => { e.ok = true; });
    pics.set(name, p = e);
  }
  return p;
}

/** The fonts, or at most ms, so words never change font in front of you. */
export function fontsReady(ms = 2000): Promise<void> {
  const f = document.fonts as FontFaceSet | undefined;
  const all = f ? Promise.all(['400 16px Silkscreen', '700 16px Silkscreen', '400 16px Geist', '800 16px Geist'].map((s) => f.load(s))).then(() => {}, () => {}) : Promise.resolve();
  return Promise.race([all, new Promise<void>((r) => setTimeout(r, ms))]);
}

/** The guide was finished or skipped on this device. */
export function guideSeen(): boolean {
  try { return localStorage.getItem('tt-tut') === '1'; } catch { return false; }
}

/** The second slide's sample: its score, and the cents a gallon its fast starts and hard brakes added. */
function board(): HTMLElement {
  const cents = sampleCents();
  return h('div.dv-ob-demo', { 'data-tone': 'warn' },
    h('div.dv-board-cells', {},
      score(SAMPLE_CARD.score, { label: 'SMOOTH SCORE', caption: 'sample drive', tone: 'warn', countUp: true }),
      cents ? score(cents, { label: 'EXTRA GAS', suffix: '¢', caption: 'a gallon, estimated', tone: 'money', countUp: true }) : null));
}

/** late: the key was pressed before the map had loaded */
type Then = (app: App, late: boolean) => void;

/** The first-open guide: an overlay over the whole app, with its own history step so Back closes it. */
export class Onboarding {
  /** null until the map has loaded */
  protected app: App | null = null;
  private readonly host: HTMLElement;
  private el: HTMLElement | null = null;
  private k = 0;
  /** it has a history step, so the phone's Back closes it */
  private pushed = false;
  /** what had focus before it opened */
  private opener: HTMLElement | null = null;
  /** runs once it has closed */
  private then: Then | null = null;
  /** a key's action, waiting for the app */
  private queued: Then | null = null;
  private opening: Promise<void> | null = null;
  /** the latest slide change; an older one still waiting on its picture is dropped */
  private drawn = 0;
  /** the first slide's pictures and lines, and which one is lit */
  private frames: HTMLImageElement[] = [];
  private rows: HTMLElement[] = [];
  private at = 0;
  private timer = 0;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get seen(): boolean {
    return guideSeen();
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** The app is ready: a key pressed before now does its job. */
  attach(app: App): void {
    this.app = app;
    removeEventListener('popstate', this.onPop);
    const q = this.queued;
    this.queued = null;
    q?.(app, true);
  }

  /** Keeps whatever else is in the frame out of reach while it is open. */
  cover(): void {
    for (const c of Array.from(this.host.children)) if (c !== this.el) (c as HTMLElement).inert = true;
  }

  /** Opens on the first slide, once its picture and the fonts are ready. */
  open(): Promise<void> {
    return (this.opening ??= this.show().finally(() => { this.opening = null; }));
  }

  private async show(): Promise<void> {
    // every picture starts loading now, so Next never waits long
    for (const s of STEPS) for (const n of s.art) pic(n);
    await Promise.all([pic(STEPS[0].art[0]).ready, fontsReady()]);
    this.drawn++;
    this.k = 0;
    if (!this.el) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el = h('div.dv-ob', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ob-title' });
      this.el.addEventListener('keydown', this.onKey);
      this.host.append(this.el);
      // only the guide can be reached until it closes
      this.cover();
      try { history.pushState({ tt: 1 }, ''); } catch { /* sandboxed */ }
      this.pushed = true;
      // until the app is in, the phone's Back is ours
      if (!this.app) addEventListener('popstate', this.onPop);
    }
    this.paint('head', 0);
  }

  /** Closes it. The app calls this on Back, when its history step is already gone. */
  close(): void {
    if (!this.el) return;
    this.stopFrames();
    this.drawn++;
    this.el.remove();
    this.el = null;
    this.pushed = false;
    for (const c of Array.from(this.host.children)) (c as HTMLElement).inert = false;
    try { localStorage.setItem('tt-tut', '1'); } catch { /* storage blocked */ }
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
    const then = this.then;
    this.then = null;
    if (!then) return;
    if (this.app) then(this.app, false);
    else this.queued = then;
  }

  /** In-app close: through history while its step is on top, so the phone's Back stays in step. */
  private dismiss(then?: Then): void {
    this.then = then ?? null;
    let ours = false;
    try { ours = this.pushed && !!(history.state as { tt?: number } | null)?.tt; } catch { /* sandboxed */ }
    if (ours) history.back();
    else this.close();
  }

  private readonly onPop = (): void => {
    if (this.el) this.close();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowRight' && this.k < STEPS.length - 1) { e.preventDefault(); this.go(this.k + 1, 'next'); return; }
    if (e.key === 'ArrowLeft' && this.k > 0) { e.preventDefault(); this.go(this.k - 1, 'back'); return; }
    if (e.key !== 'Escape') return;
    // handled here, so the app's own Escape doesn't go back a second time
    e.preventDefault();
    e.stopPropagation();
    this.dismiss();
  };

  /** Moves to slide k once its picture is ready. */
  private go(k: number, focus: string): void {
    const to = Math.max(0, Math.min(STEPS.length - 1, k)), mine = ++this.drawn;
    void pic(STEPS[to].art[0]).ready.then(() => {
      if (mine !== this.drawn || !this.el) return;
      const dir = Math.sign(to - this.k);
      this.k = to;
      this.paint(focus, dir);
    });
  }

  /** focus: what gets focus after the redraw ('head', 'next' or 'back'). dir: which way the slide moved. */
  private paint(focus: string, dir: number): void {
    if (!this.el) return;
    this.stopFrames();
    const k = this.k, s = STEPS[k], last = k === STEPS.length - 1;
    const dots = h('div.dv-ob-steps', { role: 'tablist', 'aria-label': 'Steps' }, ...STEPS.map((_, i) => h('button.dv-ob-step' + (i <= k ? '.dv-on' : ''), {
      type: 'button', role: 'tab', 'aria-label': `Step ${i + 1} of ${STEPS.length}`, 'aria-selected': String(i === k), onclick: () => this.go(i, 'head'),
    })));
    const back = k ? button('Back', { kind: 'ghost', icon: 'back', onClick: () => this.go(this.k - 1, 'back') }) : null;
    if (back) back.dataset.f = 'back';
    const imgs = s.art.map((n) => pic(n).img);
    imgs.forEach((im, i) => im.classList.toggle('dv-off', i > 0));
    const art = h('div.dv-ob-art', {}, ...imgs,
      calm() ? null : h('div.dv-drops', { 'aria-hidden': 'true' }, ...Array.from({ length: 12 }, (_, i) => h('i', { style: `--x:${(i * 41) % 100}%;--d:${(i * 211) % 900}ms;--h:12px` }))));
    // the lines light up with the pictures; a tap on one shows its picture
    const story = s.lines ? h('ol.dv-ob-story', {}, ...s.lines.map((t, i) => h('li', i === s.lines!.length - 1 ? { 'data-tone': 'salmon' } : {},
      h('button', { type: 'button', onclick: () => this.frame(i, true) }, h('b', { 'aria-hidden': 'true' }, String(i + 1)), h('span', {}, t))))) : null;
    // the numbers and their sources, behind a tap
    const why = h('ul.dv-ob-why', { id: 'ob-why', hidden: true }, ...SCIENCE.map((f) => h('li', {}, h('span', {}, f.fact),
      h('small', {}, f.href ? h('a', { href: f.href, target: '_blank', rel: 'noopener' }, f.source) : f.source))));
    const whyKey = button('The science', { kind: 'ghost', onClick: () => {
      const open = why.hidden;
      why.hidden = !open;
      whyKey.setAttribute('aria-expanded', String(open));
      if (open) why.scrollIntoView({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' });
    } });
    whyKey.dataset.f = 'why';
    whyKey.setAttribute('aria-expanded', 'false');
    whyKey.setAttribute('aria-controls', 'ob-why');
    const card = h('div.dv-ob-card' + (dir > 0 ? '.dv-in-r' : dir < 0 ? '.dv-in-l' : ''), {},
      art,
      h('div.dv-ob-body', {},
        dots,
        h('p.u-eyebrow.dv-ob-count', {}, h('span.u-sr', {}, `Step ${k + 1} of ${STEPS.length}: `), s.kicker),
        h('h2.dv-ob-title', { id: 'ob-title', tabindex: '-1', 'data-f': 'head' }, s.title),
        s.text ? h('p.dv-ob-text', {}, s.text) : null,
        story,
        story ? why : null,
        k === 1 ? board() : null,
        last ? this.endKeys(back) : this.nextKeys(back ?? (story ? whyKey : null))));
    this.el.replaceChildren(card);
    if (story) {
      this.frames = imgs;
      this.rows = Array.from(story.children) as HTMLElement[];
      // a tap on the picture steps on; with reduced motion that is the only way it moves
      art.classList.add('dv-ob-tap');
      art.addEventListener('click', () => this.frame(this.at + 1, true));
      this.frame(0, false);
      if (!calm()) this.timer = window.setTimeout(this.tick, beat(0));
    }
    const want = this.el.querySelector<HTMLElement>(`[data-f="${focus}"]`) ?? this.el.querySelector<HTMLElement>('[data-f="next"]');
    want?.focus({ preventScroll: true });
  }

  /** left: Back, or on the first slide The science */
  private nextKeys(left: HTMLElement | null): HTMLElement {
    const next = button('Next', { kind: 'primary', icon: 'arrow', wide: true, onClick: () => this.go(this.k + 1, 'next') });
    next.dataset.f = 'next';
    return h('div.dv-ob-keys', {}, next, h('div.dv-ob-small', {}, left ?? h('span'), button('Skip', { kind: 'ghost', onClick: () => this.dismiss() })));
  }

  /** The last slide: Start a drive leads on phones. Laptops can't record, so the sample leads there and the phone code follows. */
  private endKeys(back: HTMLElement | null): HTMLElement {
    const phone = !!this.host.closest('.touch');
    const drive = phone ? button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: () => this.dismiss((app, late) => {
      // a drive starts from this tap; pressed while the map loaded, it opens the Drive tab instead
      if (!late) app.screens.drive.startDrive();
      else if (app.tab !== 'drive') app.setTab('drive');
    }) })
      // a laptop can't record: home, with the phone code lit
      : button('Drive with it on your phone', { kind: 'secondary', icon: 'phone', wide: true, onClick: () => this.dismiss((app) => {
        if (app.tab !== 'drive') app.setTab('drive');
        requestAnimationFrame(() => {
          const qr = document.querySelector<HTMLElement>('.dv-qr');
          if (!qr) return;
          qr.scrollIntoView({ block: 'nearest' });
          qr.classList.add('dv-qr-hi');
          setTimeout(() => qr.classList.remove('dv-qr-hi'), 2400);
        });
      }) });
    const sample = button('Try a sample drive', { kind: phone ? 'secondary' : 'primary', icon: 'play', wide: true, onClick: () => this.dismiss((app) => {
      if (app.tab !== 'drive') app.setTab('drive');
      void app.screens.drive.loadSample();
    }) });
    (phone ? drive : sample).dataset.f = 'next';
    const about = button('About the data', { kind: 'ghost', onClick: () => this.dismiss((app) => {
      if (app.tab !== 'drive') app.setTab('drive');
      app.about(() => app.screens.drive.home());
    }) });
    return h('div.dv-ob-keys', {}, ...(phone ? [drive, sample] : [sample, drive]), h('div.dv-ob-small', {}, back ?? h('span'), about));
  }

  /** Lights picture and line i of the first slide. A tap takes over from the timer. */
  private frame(i: number, byHand: boolean): void {
    const n = this.frames.length;
    if (!n) return;
    const to = ((i % n) + n) % n, p = pic(STEPS[this.k].art[to]);
    if (byHand) this.stopTimer();
    // a picture shows only once it is decoded
    if (!p.ok) {
      if (byHand) void p.ready.then(() => { if (this.frames.length) this.frame(to, false); });
      return;
    }
    this.at = to;
    this.frames.forEach((im, j) => im.classList.toggle('dv-off', j !== to));
    this.rows.forEach((r, j) => {
      r.classList.toggle('dv-on', j === to);
      r.classList.toggle('dv-past', j < to);
      if (j === to) r.setAttribute('aria-current', 'step');
      else r.removeAttribute('aria-current');
    });
  }

  /** Steps on once, then holds on the salmon. */
  private readonly tick = (): void => {
    this.frame(this.at + 1, false);
    this.timer = this.at < this.frames.length - 1 ? window.setTimeout(this.tick, beat(this.at)) : 0;
  };

  private stopTimer(): void {
    clearTimeout(this.timer);
    this.timer = 0;
  }

  private stopFrames(): void {
    this.stopTimer();
    this.frames = [];
    this.rows = [];
  }
}
