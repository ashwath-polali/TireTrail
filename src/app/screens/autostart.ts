// Start by itself: websites can't start on their own, so the phone opens TireTrail's #autostart link (or the
// installed app) when it meets the car. This file keeps the switch row, the setup sheet, and what the link opens.
import { h } from '../dom.ts';
import { asApp, canInstall, checkInstalled, install, installed, phoneModel } from '../install.ts';
import { bitmapSVG } from '../ui/glyphs.ts';
import { button, calm, glyph, insight, screen } from '../ui/ui.ts';
import {
  autoState, autoStatus, browserOf, introStep, IOS_SHORTCUT_URL, mustAsk, NOT_YET, OTHER_WAYS, phoneOf, PICK,
  readProgress, samsungModel, stepsFor, TEST_MS, testWord, type Phone, type SetupStep,
} from './autostart-words.ts';
import { autostartLink } from './drive-coach.ts';
import './autostart.css';

// ---------- what it remembers ----------

const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const put = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const drop = (k: string): void => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } };
const num = (k: string): number | null => { const n = Number(get(k)); return n > 0 ? n : null; };

/** When the car last opened TireTrail. */
export const autoOkAt = (): number | null => num('tt-auto-ok');
/** The setup has been opened once, so turning the switch on again doesn't open it. */
export const setupSeen = (): boolean => get('tt-auto-seen') === '1';
/** A setup was left half done (Safari often reloads after a trip to Shortcuts): reopen it. */
export const setupPending = (): boolean => !!readProgress(get('tt-auto-step'));
/** The setup sheet is showing. */
export const setupOpen = (): boolean => openNow !== null;

/** The car opened TireTrail: remember when. True if the setup was waiting on this test. */
export function markOpened(now = Date.now()): boolean {
  const test = num('tt-auto-test');
  const was = !!test && now - test < TEST_MS;
  put('tt-auto-ok', String(now));
  drop('tt-auto-test');
  if (was) drop('tt-auto-step');
  dispatchEvent(new Event('tt:auto-ok'));
  return was;
}

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

// ---------- the switch row ----------

export interface AutoRowIn {
  auto: boolean;
  setAuto(on: boolean): void;
  /** opens the setup */
  setup(): void;
}

/** Start by itself: one switch and one line. Gray when off, yellow until the phone opens TireTrail, green after. */
export function autoRow(c: AutoRowIn): HTMLElement {
  const row = h('section.dv-auto-row', { 'aria-label': 'Start by itself' });
  const fill = () => {
    const ok = autoOkAt(), state = autoState(c.auto, ok), s = autoStatus({ on: c.auto, okAt: ok });
    row.dataset.state = state;
    const sw = h('button.dv-switch.dv-auto-sw', {
      type: 'button', role: 'switch', 'aria-checked': String(c.auto), 'aria-describedby': 'auto-status',
      onclick: () => {
        const on = !c.auto;
        c.setAuto(on);
        if (on && !autoOkAt() && !setupSeen()) c.setup();
      },
    }, h('span.dv-switch-text', {}, h('b', {}, 'Start by itself')), h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')));
    const said = h('span.dv-auto-said', {}, s.text,
      s.act ? ' ' : '', s.act ? h('b.dv-auto-act', {}, s.act) : '',
      s.when ? ' · ' : '', s.when ? h('span.dv-nw', {}, s.when) : '');
    const label = [s.text, s.act, s.when].filter(Boolean).join(' ');
    const line = c.auto
      ? h('button.dv-auto-line', { type: 'button', id: 'auto-status', 'aria-label': `${label}. Opens the setup`, onclick: () => c.setup() }, said, ico('chevron'))
      : h('p.dv-auto-line', { id: 'auto-status' }, said);
    row.replaceChildren(sw, line);
  };
  fill();
  // the car may open TireTrail in another tab while this one shows
  const onOk = (e: Event) => {
    if (!row.isConnected) { removeEventListener('tt:auto-ok', onOk); removeEventListener('storage', onOk); return; }
    if (e instanceof StorageEvent && e.key !== 'tt-auto-ok') return;
    const had = row.dataset.state;
    if (had !== autoState(c.auto, autoOkAt())) fill();
  };
  addEventListener('tt:auto-ok', onOk);
  addEventListener('storage', onOk);
  return row;
}

// ---------- the setup sheet ----------

// small pixel pictures the glyph set doesn't have
const ART: Record<string, string[]> = {
  link: ['..XXX.....', '.X...X....', 'X...X.X...', 'X..X..X...', '.X..X..X..', '...X..X..X', '...X.X...X', '....X...X.', '.....XXX..'],
  bt: ['..X...', '..XX..', 'X.X.X.', '.XXX..', '..X...', '.XXX..', 'X.X.X.', '..XX..', '..X...'],
  gear: ['...XX...', '.X.XX.X.', '..XXXX..', 'XXX..XXX', 'XXX..XXX', '..XXXX..', '.X.XX.X.', '...XX...'],
};
const pic = (name: string) => (ART[name] ? bitmapSVG(ART[name], 3) : glyph(name, 3));

function art(names: string[], ok = false): HTMLElement {
  const row = h('div.dv-setup-art', { 'aria-hidden': 'true' });
  names.forEach((n, i) => {
    if (i) row.append(h('i.dv-setup-dots'));
    row.append(h('span.dv-setup-tile' + (i === names.length - 1 ? (ok ? '.dv-last.dv-ok' : '.dv-last') : ''), { html: pic(ok && i === names.length - 1 ? 'check' : n) }));
  });
  return row;
}

/** Copies the link. False when there's no clipboard. */
async function copy(link: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

/** A real link styled as a key, so iOS and Android hand it to the right app. */
function linkKey(label: string, href: string, kind: 'primary' | 'secondary', icon: string, onClick: () => void): HTMLElement {
  return h(`a.u-btn.u-${kind}.u-wide`, { href, target: '_blank', rel: 'noopener', onclick: onClick },
    h('span.u-ico', { 'aria-hidden': 'true', html: glyph(icon, 2) }), h('span.u-btn-label', {}, label));
}

export interface SetupIn {
  /** runs once it has closed */
  onClose(): void;
}

let openNow: { close: () => void } | null = null;

/**
 * The setup: one step per screen, dots, Back and Skip. Each step's main key does the step; Next takes over
 * once it's done. The step is saved, so a reload reopens it there. Back on the phone closes it.
 */
export function openSetup(c: SetupIn): void {
  if (openNow) return;
  put('tt-auto-seen', '1');
  const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const link = autostartLink(location.origin, location.pathname);
  const ua = navigator.userAgent;
  let guess = phoneOf(ua, navigator.maxTouchPoints || 0);
  const saved = readProgress(get('tt-auto-step'));
  let picked: Phone | null = saved?.p ?? ((get('tt-auto-os') as Phone | null) || (mustAsk(guess, null) ? null : guess));
  let asking: 'os' | 'samsung' | null = null;
  let cur = saved?.id ?? 'intro', since = saved?.since ?? 0, timer = 0, shown = false, answer: 'yes' | 'no' | null = null, copied = '';
  // steps whose own key was pressed, so Next leads there now
  const acted = new Set<string>(saved?.acted ?? []);
  // frozen while open, so the steps don't shift under the person
  const was = { app: asApp(), installed: installed(), browser: browserOf(ua) };

  const box = h('div.dv-setup', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setup-title' });
  const layer = h('div.dv-setup-layer' + (calm() ? '' : '.dv-setup-in'), {}, h('div.dv-setup-scrim', { onclick: () => done() }), box);
  const list = (): SetupStep[] => (picked ? stepsFor(picked, { ...was, canPrompt: canInstall() }) : [introStep(null)]);
  const at = () => Math.max(0, list().findIndex((s) => s.id === cur));

  const save = () => { if (picked) put('tt-auto-step', JSON.stringify({ p: picked, id: cur, since, at: Date.now(), acted: [...acted] })); };

  let pushed = false;
  const onPop = () => { if (openNow) { pushed = false; close(); } };
  const redraw = () => draw('keep');
  const close = () => {
    layer.remove();
    clearInterval(timer);
    drop('tt-auto-step');
    removeEventListener('popstate', onPop);
    removeEventListener('storage', onOk);
    removeEventListener('tt:auto-ok', onOk);
    removeEventListener('tt:install', redraw);
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
    const it = list()[at()];
    if (it.test && testWord(autoOkAt(), since).done !== shown) redraw();
  };

  const go = (to: number, focus = 'head') => {
    const L = list();
    cur = L[Math.max(0, Math.min(L.length - 1, to))].id;
    answer = null;
    copied = '';
    draw(focus);
  };
  const choose = (p: Phone | 'android-any') => {
    if (p === 'android-any') { asking = 'samsung'; draw('head'); return; }
    picked = p;
    asking = null;
    put('tt-auto-os', p);
    go(1);
  };

  // Chrome hides a Samsung's model in the user agent, but says it when asked
  if (!picked && guess === 'android') {
    void phoneModel().then((m) => {
      if (!m || picked || !openNow) return;
      guess = samsungModel(m) ? 'samsung' : 'android';
      picked = guess;
      redraw();
    });
  }
  if (!was.installed) void checkInstalled().then((yes) => { if (yes && openNow) { was.installed = true; redraw(); } });

  const big = (label: string, fn: () => void) => { const b = button(label, { kind: 'secondary', icon: 'phone', wide: true, onClick: fn }); b.classList.add('dv-setup-big'); return b; };

  function introKeys(): HTMLElement | null {
    if (picked) {
      const b = button('Different phone?', { kind: 'ghost', onClick: () => { picked = null; asking = 'os'; drop('tt-auto-os'); draw('head'); } });
      b.classList.add('dv-setup-other');
      return b;
    }
    const q = asking ?? (guess === 'android' ? 'samsung' : 'os');
    return h('div.dv-setup-pick', {},
      h('p.dv-setup-ask', {}, q === 'os' ? PICK.title : PICK.android),
      ...(q === 'os'
        ? [big('iPhone', () => choose('iphone')), big('Android', () => choose('android-any'))]
        : [big('Samsung Galaxy', () => choose('samsung')), big('Another Android', () => choose('android'))]));
  }

  /** The step's main key, and whether it's still the one to press. */
  function actKey(s: SetupStep): { el: HTMLElement | null; main: boolean } {
    const main = !acted.has(s.id);
    const kind = main ? 'primary' : 'secondary';
    const did = () => { acted.add(s.id); save(); setTimeout(redraw, 300); };
    if (s.act === 'copy-shortcuts' || s.act === 'copy') {
      // no clipboard: say how, and select the link so a long press copies it
      const failed = () => { copied = 'Press and hold the link to copy it.'; redraw(); box.querySelector<HTMLInputElement>('.dv-setup-field')?.select(); };
      const field = h('input.dv-setup-field', { type: 'text', readonly: '', value: link, 'aria-label': 'Your TireTrail link', spellcheck: 'false' }) as HTMLInputElement;
      field.addEventListener('focus', () => field.select());
      const key = s.act === 'copy-shortcuts'
        ? button(main ? 'Copy link and open Shortcuts' : 'Copy and open again', { kind, icon: 'arrow', wide: true, onClick: () => void copy(link).then((yes) => { if (!yes) return failed(); copied = 'Link copied.'; did(); location.href = 'shortcuts://'; }) })
        : button(main ? 'Copy link' : 'Copy it again', { kind, icon: 'check', wide: true, onClick: () => void copy(link).then((yes) => { if (!yes) return failed(); copied = 'Link copied. Now open MacroDroid.'; did(); }) });
      const said = copied ? h('p.dv-setup-said' + (copied.startsWith('Link') ? '' : '.dv-warn'), { role: 'status' }, ico(copied.startsWith('Link') ? 'check' : 'info'), h('span', {}, copied)) : null;
      return { el: h('div.dv-setup-act', {}, field, key, said ?? ''), main };
    }
    if (s.act === 'shortcuts') return { el: button('Open Shortcuts', { kind, icon: 'arrow', wide: true, onClick: () => { did(); location.href = 'shortcuts://'; } }), main };
    if (s.act === 'shortcut') return { el: linkKey('Add the shortcut', IOS_SHORTCUT_URL, kind, 'plus', did), main };
    if (s.act === 'play') return { el: linkKey('Open the Play Store', 'https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid', kind, 'arrow', did), main };
    if (s.act === 'install') {
      if (installed()) return { el: h('div.dv-setup-test.dv-ok', { role: 'status' }, ico('check'), h('span', {}, 'TireTrail is installed.')), main: false };
      if (!canInstall()) return { el: null, main: false };
      return {
        el: button('Install TireTrail', { kind: 'primary', icon: 'down', wide: true, onClick: () => void install().then((yes) => { if (yes) { acted.add(s.id); go(at() + 1); } else redraw(); }) }),
        main: true,
      };
    }
    return { el: null, main: false };
  }

  /** The test: wait for the link to open here, or ask when it can't be seen from here. */
  function testBody(s: SetupStep, p: Phone): { els: HTMLElement[]; ok: boolean } {
    const w = testWord(autoOkAt(), since);
    shown = w.done;
    if (w.done) return { els: [h('div.dv-setup-test.dv-ok', { role: 'status' }, ico('check'), h('span', {}, w.text))], ok: true };
    if (s.test === 'watch') {
      return { els: [h('div.dv-setup-test', { role: 'status' }, ico('clock'), h('span', {}, w.text))], ok: false };
    }
    const els: HTMLElement[] = [h('div.dv-setup-yes', {},
      button('Yes, it opened', { kind: 'primary', icon: 'check', wide: true, onClick: () => { markOpened(); answer = 'yes'; draw('next'); } }),
      button('Not yet', { kind: 'secondary', wide: true, onClick: () => { answer = 'no'; redraw(); } }))];
    if (answer === 'no') {
      els.push(insight({ icon: 'info', title: NOT_YET[p] }));
      if (p === 'samsung') {
        const b = button('Use MacroDroid instead', { kind: 'ghost', onClick: () => { picked = 'android'; put('tt-auto-os', 'android'); cur = 'play'; answer = null; draw('head'); } });
        b.classList.add('dv-setup-other');
        els.push(b);
      }
    }
    return { els, ok: false };
  }

  function draw(focus: string): void {
    const L = list(), k = at(), item = L[k], last = k === L.length - 1;
    cur = item.id;
    if (item.test && !since) { since = Date.now() - 1000; put('tt-auto-test', String(Date.now())); }
    save();
    // dots for the steps this phone will have; unknown phones show the iPhone count
    const n = picked ? L.length : stepsFor(guess ?? 'iphone').length;
    const dots = h('div.dv-setup-steps', { 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) => h('i' + (i <= k ? '.dv-on' : ''))));
    let body: (HTMLElement | null)[], primary: HTMLElement | null = null, ok = false;
    if (item.test) {
      const t = testBody(item, picked!);
      ok = t.ok;
      body = t.els;
      if (ok) {
        primary = button('Done', { kind: 'primary', icon: 'check', onClick: done });
        if (picked === 'iphone' && IOS_SHORTCUT_URL) {
          body.push(h('details.dv-setup-more', {}, h('summary', {}, h('span', {}, 'Other ways to start'), ico('chevron')), h('p', {}, OTHER_WAYS)));
        }
      }
    } else if (item.id === 'intro') {
      body = [introKeys()];
      if (picked) primary = button('Next', { kind: 'primary', icon: 'arrow', onClick: () => go(k + 1, 'next') });
    } else {
      const a = actKey(item);
      body = [a.el];
      // the step's own key leads; Next takes over once it's done
      primary = button('Next', { kind: a.main ? 'ghost' : 'primary', icon: 'arrow', onClick: () => go(k + 1, 'next') });
    }
    if (primary) primary.dataset.f = 'next';
    const later = item.test && !ok;
    const top = h('div.dv-setup-top', {}, dots, h('span.u-sr', {}, `Step ${k + 1} of ${n}`),
      // before a phone is picked the intro is the only step, and it still needs a way out
      last && !later && item.id !== 'intro' ? h('span') : button(later ? 'Later' : 'Skip', { kind: 'ghost', onClick: done }));
    const head = [
      art(item.art, ok),
      h('h2.dv-setup-title', { id: 'setup-title', tabindex: '-1', 'data-f': 'head' }, ok ? 'It works' : item.title),
      h('p.dv-setup-line', {}, ok ? 'Next time you get in, TireTrail opens and records as you drive.' : item.line),
      item.list ? h('ol.dv-setup-list', {}, ...item.list.map((x) => h('li', {}, x))) : null,
    ];
    const notes = item.notes?.length ? h('ul.dv-setup-notes', {}, ...item.notes.map((x) => h('li', {}, x))) : null;
    const back = k ? button('Back', { kind: 'ghost', icon: 'back', onClick: () => go(k - 1, 'back') }) : h('span');
    if (k) back.dataset.f = 'back';
    box.replaceChildren(top, h('div.dv-setup-body', {}, ...head, ...body, notes), h('div.dv-setup-keys', {}, back, primary ?? h('span')));
    box.dataset.step = item.id;
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
  addEventListener('tt:install', redraw);
  document.addEventListener('visibilitychange', onOk);
  // the link may open in another tab, which only some browsers tell this one about
  timer = window.setInterval(() => onOk(), 2000);
  openNow = { close };
  draw('head');
}

// ---------- what the link opens ----------

/** The car opened TireTrail during the setup's test: say it works, and record nothing. */
export function showWorks(onDone: () => void): void {
  const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
  const box = h('div.dv-setup.dv-works', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'works-title' });
  const layer = h('div.dv-setup-layer' + (calm() ? '' : '.dv-setup-in'), {}, h('div.dv-setup-scrim'), box);
  const close = () => {
    layer.remove();
    for (const el of Array.from(host.children)) (el as HTMLElement).inert = false;
    onDone();
  };
  box.append(
    h('div.dv-setup-body', {},
      art(['car', 'phone'], true),
      h('h2.dv-setup-title', { id: 'works-title', tabindex: '-1' }, 'It works. TireTrail opened by itself.'),
      h('p.dv-setup-line', {}, 'Next time you get in, it opens and records as you drive.'),
      h('ul.dv-setup-notes', {}, h('li', {}, 'Before you pull out, tap the screen once so the voice can talk.'))),
    h('div.dv-setup-keys.dv-end', {}, button('Done', { kind: 'primary', icon: 'check', onClick: close })));
  host.append(layer);
  for (const el of Array.from(host.children)) if (el !== layer && !el.classList.contains('u-toasts')) (el as HTMLElement).inert = true;
  box.querySelector<HTMLElement>('#works-title')?.focus({ preventScroll: true });
}

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
