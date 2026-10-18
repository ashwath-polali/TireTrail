// Start by itself: phones don't let websites run in the background, so the phone opens TireTrail's #autostart link
// when it meets the car. This file keeps the setup sheet, what it remembers, and the page the link opens.
import { h } from '../dom.ts';
import { bitmapSVG } from '../ui/glyphs.ts';
import { button, calm, glyph, insight, screen, toast } from '../ui/ui.ts';
import { mustAsk, phoneOf, PICK, stepsFor, TEST_MS, testWord, type Phone, type SetupStep } from './autostart-words.ts';
import { autostartLink } from './drive-coach.ts';

// ---------- what it remembers ----------

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const num = (k: string): number | null => { const n = Number(get(k)); return n > 0 ? n : null; };

/** When the car last opened TireTrail. */
export const autoOkAt = (): number | null => num('tt-auto-ok');
/** The setup has been opened once, so turning the switch on again doesn't open it. */
export const setupSeen = (): boolean => get('tt-auto-seen') === '1';

/** Running from a Home Screen or installed icon. */
const asApp = (): boolean => {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true; } catch { return false; }
};

/** The car opened TireTrail: remember when. True if the setup was waiting on this test. */
export function markOpened(now = Date.now()): boolean {
  const test = num('tt-auto-test');
  put('tt-auto-ok', String(now));
  try { localStorage.removeItem('tt-auto-test'); } catch { /* storage blocked */ }
  dispatchEvent(new Event('tt:auto-ok'));
  return !!test && now - test < TEST_MS;
}

// Chrome on Android offers its own install prompt; keep it for the Samsung setup
let install: (Event & { prompt(): Promise<void> }) | null = null;
try {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); install = e as typeof install; });
  addEventListener('appinstalled', () => { install = null; });
} catch { /* no window */ }

// ---------- the setup sheet ----------

// small pixel pictures the glyph set doesn't have
const ART: Record<string, string[]> = {
  link: ['..XXX.....', '.X...X....', 'X...X.X...', 'X..X..X...', '.X..X..X..', '...X..X..X', '...X.X...X', '....X...X.', '.....XXX..'],
  bt: ['..X...', '..XX..', 'X.X.X.', '.XXX..', '..X...', '.XXX..', 'X.X.X.', '..XX..', '..X...'],
  gear: ['...XX...', '.X.XX.X.', '..XXXX..', 'XXX..XXX', 'XXX..XXX', '..XXXX..', '.X.XX.X.', '...XX...'],
};
const pic = (name: string) => (ART[name] ? bitmapSVG(ART[name], 3) : glyph(name, 3));

function art(names: string[]): HTMLElement {
  const row = h('div.dv-setup-art', { 'aria-hidden': 'true' });
  names.forEach((n, i) => {
    if (i) row.append(h('i.dv-setup-dots'));
    row.append(h('span.dv-setup-tile' + (i === names.length - 1 ? '.dv-last' : ''), { html: pic(n) }));
  });
  return row;
}

async function copy(link: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied.', { icon: 'check' });
    return true;
  } catch {
    // no clipboard here: select it so a long press copies it
    field?.focus();
    field?.select();
    toast('Select the link and copy it.', { icon: 'info' });
    return false;
  }
}

export interface SetupIn {
  /** runs once it has closed */
  onClose(): void;
}

let openNow: { close: () => void } | null = null;

/** The step-by-step setup: one step per screen, dots, Back, Next and Skip. Back on the phone closes it. */
export function openSetup(c: SetupIn): void {
  if (openNow) return;
  put('tt-auto-seen', '1');
  const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const link = autostartLink(location.origin, location.pathname);
  const guess = phoneOf(navigator.userAgent, navigator.maxTouchPoints || 0);
  let picked = (get('tt-auto-os') as Phone | null) || (mustAsk(guess, null) ? null : guess);
  let asking: 'os' | 'samsung' | null = null;
  let k = 0, since = 0, timer = 0, shown = false;

  const box = h('div.dv-setup', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setup-title' });
  const layer = h('div.dv-setup-layer' + (calm() ? '' : '.dv-setup-in'), {}, h('div.dv-setup-scrim', { onclick: () => done() }), box);
  const steps = () => stepsFor(picked ?? 'iphone', { app: asApp(), installed: asApp() });
  // the question goes right after the first step until the phone is known
  const list = (): (SetupStep | 'pick')[] => { const s = steps(); return picked ? s : [s[0], 'pick', ...s.slice(1)]; };

  let pushed = false;
  const onPop = () => { if (openNow) { pushed = false; close(); } };
  const close = () => {
    layer.remove();
    clearInterval(timer);
    removeEventListener('popstate', onPop);
    removeEventListener('storage', onOk);
    removeEventListener('tt:auto-ok', onOk);
    document.removeEventListener('visibilitychange', onOk);
    for (const el of Array.from(host.children)) (el as HTMLElement).inert = false;
    openNow = null;
    if (opener?.isConnected) opener.focus();
    c.onClose();
  };
  // through history while its step is on top, so the phone's Back stays in step
  const done = () => {
    let ours = false;
    try { ours = pushed && !!(history.state as { tt?: number } | null)?.tt; } catch { /* sandboxed */ }
    if (ours) history.back(); else close();
  };
  const onOk = (e?: Event) => {
    if (e instanceof StorageEvent && e.key !== 'tt-auto-ok') return;
    const it = list()[k];
    if (it !== 'pick' && it.title === 'Test it' && testWord(autoOkAt(), since).done !== shown) draw('keep');
  };

  const go = (to: number, focus = 'head') => { k = Math.max(0, Math.min(list().length - 1, to)); draw(focus); };
  const choose = (p: Phone | 'android-any') => {
    if (p === 'android-any') { asking = 'samsung'; draw('head'); return; }
    picked = p;
    asking = null;
    put('tt-auto-os', p);
    // the question is gone from the list, so the step after it has its index
    go(1);
  };

  function pickView(): HTMLElement[] {
    const q = asking ?? (guess === 'android' ? 'samsung' : 'os');
    const big = (label: string, fn: () => void) => { const b = button(label, { kind: 'secondary', icon: 'phone', wide: true, onClick: fn }); b.classList.add('dv-setup-big'); return b; };
    return [
      art(['phone']),
      h('h2.dv-setup-title', { id: 'setup-title', tabindex: '-1', 'data-f': 'head' }, q === 'os' ? PICK.title : PICK.android),
      h('div.dv-setup-pick', {}, ...(q === 'os'
        ? [big('iPhone', () => choose('iphone')), big('Android', () => choose('android-any'))]
        : [big('Samsung Galaxy', () => choose('samsung')), big('Another Android', () => choose('android'))])),
    ];
  }

  function actView(s: SetupStep): HTMLElement | null {
    if (s.act === 'copy' || s.act === 'copy-shortcuts') {
      const field = h('input.dv-setup-field', { type: 'text', readonly: '', value: link, 'aria-label': 'Your TireTrail link', spellcheck: 'false' }) as HTMLInputElement;
      field.addEventListener('focus', () => field.select());
      const key = s.act === 'copy-shortcuts'
        ? button('Copy link and open Shortcuts', { kind: 'secondary', icon: 'arrow', wide: true, onClick: () => void copy(link, field).then(() => { location.href = 'shortcuts://'; }) })
        : button('Copy link', { kind: 'secondary', wide: true, onClick: () => void copy(link, field) });
      return h('div.dv-setup-act', {}, field, key);
    }
    if (s.act === 'install' && install) {
      const ev = install;
      return button('Install app', { kind: 'secondary', icon: 'down', wide: true, onClick: () => void ev.prompt().catch(() => {}) });
    }
    if (s.act === 'play') {
      return h('a.u-btn.u-secondary.u-wide', { href: 'https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid', target: '_blank', rel: 'noopener' },
        h('span.u-ico', { 'aria-hidden': 'true', html: glyph('arrow', 2) }), h('span.u-btn-label', {}, 'Open the Play Store'));
    }
    if (k === 0 && picked) {
      const b = button('Different phone?', { kind: 'ghost', onClick: () => { picked = null; asking = 'os'; go(1); } });
      b.classList.add('dv-setup-other');
      return b;
    }
    return null;
  }

  function testView(s: SetupStep): HTMLElement {
    const w = testWord(autoOkAt(), since);
    shown = w.done;
    const state = h('div.dv-setup-test' + (w.done ? '.dv-ok' : ''), { role: 'status' },
      h('span.u-ico', { 'aria-hidden': 'true', html: glyph(w.done ? 'check' : 'clock', 2) }), h('span', {}, w.text));
    // Samsung opens the app, not the link, so it can't notice by itself
    if (s.act === 'opened' && !w.done) return button('Yes, it opened', { kind: 'secondary', icon: 'check', wide: true, onClick: () => { markOpened(); draw('keep'); } });
    return state;
  }

  function draw(focus: string): void {
    const L = list(), item = L[k], last = k === L.length - 1;
    const dots = h('div.dv-ob-steps.dv-setup-steps', { 'aria-hidden': 'true' }, ...L.map((_, i) => h('i.dv-ob-step' + (i <= k ? '.dv-on' : ''))));
    const top = h('div.dv-setup-top', {}, dots, h('span.u-sr', {}, `Step ${k + 1} of ${L.length}`),
      last ? h('span') : button('Skip', { kind: 'ghost', onClick: done }));
    let body: HTMLElement[];
    if (item === 'pick') body = pickView();
    else {
      const test = item.title === 'Test it';
      if (test && !since) { since = Date.now() - 1000; put('tt-auto-test', String(Date.now())); }
      body = [
        art(item.art),
        h('h2.dv-setup-title', { id: 'setup-title', tabindex: '-1', 'data-f': 'head' }, item.title),
        h('p.dv-setup-line', {}, item.line),
        ...[test ? testView(item) : actView(item)].filter((x): x is HTMLElement => !!x),
      ];
    }
    const back = k ? button('Back', { kind: 'ghost', icon: 'back', onClick: () => go(k - 1, 'back') }) : h('span');
    if (k) back.dataset.f = 'back';
    const next = item === 'pick' ? null : button(last ? 'Done' : 'Next', { kind: 'primary', icon: last ? 'check' : 'arrow', onClick: () => (last ? done() : go(k + 1, 'next')) });
    if (next) next.dataset.f = 'next';
    box.replaceChildren(top, h('div.dv-setup-body', {}, ...body), h('div.dv-setup-keys', {}, back, next));
    if (focus === 'keep') return;
    const want = box.querySelector<HTMLElement>(`[data-f="${focus}"]`) ?? box.querySelector<HTMLElement>('[data-f="head"]');
    want?.focus({ preventScroll: true });
  }

  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // handled here, so the app's own Escape doesn't go back a second time
    e.preventDefault();
    e.stopPropagation();
    done();
  });
  host.append(layer);
  for (const el of Array.from(host.children)) if (el !== layer && !el.classList.contains('u-toasts')) (el as HTMLElement).inert = true;
  try { history.pushState({ tt: 1 }, ''); pushed = true; } catch { /* sandboxed */ }
  addEventListener('popstate', onPop);
  addEventListener('storage', onOk);
  addEventListener('tt:auto-ok', onOk);
  document.addEventListener('visibilitychange', onOk);
  // the link may open in another tab, which only some browsers tell this one about
  timer = window.setInterval(() => onOk(), 2000);
  openNow = { close };
  draw('head');
}

// ---------- the page the link opens ----------

export interface ReadyIn {
  /** watching GPS for the car to move */
  waiting: boolean;
  error: string;
  start(): void;
  cancel(): void;
}

/** Opened by the link, but the location still needs a tap: one big Start key. */
export function readyPage(c: ReadyIn): HTMLElement {
  return screen(h('div.dv-ready', {},
    h('img.dv-ready-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' }),
    h('p.u-eyebrow', {}, 'READY TO RECORD'),
    h('h1.u-title', {}, 'Tap Start, then drive as usual.'),
    c.error ? insight({ icon: 'warn', tone: 'warn', title: c.error }) : null,
    button('Start', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }),
    c.waiting ? h('p.u-body.dv-ready-note', {}, "Or just drive. It starts by itself once you're going 15 mph.") : null,
    button('Not now', { kind: 'ghost', onClick: c.cancel })));
}
