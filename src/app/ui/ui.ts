// UI kit, "premium pixel": notched panels, keys that sink, scoreboard numbers, block meters. Styles in ui.css.
import { h } from '../dom.ts';
import { barBlocks, formatNumber, meterLit, tickAt, type Tone } from './format.ts';
import { glyph } from './glyphs.ts';

export type { Tone } from './format.ts';
export { TONES, formatNumber, roundTo, clampScore, scoreTone, meterLit, barBlocks, tickAt, snap4 } from './format.ts';
export { glyph, GLYPHS, salmonSVG, type GlyphName } from './glyphs.ts';

type Kid = Node | string | null | undefined | false;

/** No motion: the person asked for less, or this is a still screenshot. */
export function calm(): boolean {
  return document.documentElement.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// iOS only shows :active (the key sinking) when the page listens for touches
try { document.addEventListener('touchstart', () => {}, { passive: true }); } catch { /* no DOM */ }

/** An icon from a glyph name, or from markup (an svg or img string, like the pixel art). */
function iconEl(icon: string, cls = 'u-ico', scale = 2): HTMLElement {
  const el = h('span.' + cls, { 'aria-hidden': 'true' });
  el.innerHTML = icon.trim().startsWith('<') ? icon : glyph(icon, scale);
  return el;
}

/** Makes a box act like a button: click, Enter or Space; taps on its own buttons pass through. */
function pressable(el: HTMLElement, fn: () => void): void {
  el.classList.add('u-press');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', (e) => {
    const hit = (e.target as Element).closest('button, a, input, select, textarea, [role="button"]');
    if (hit === el) fn();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn(); }
  });
}

/** Runs fn once the element is mostly on screen (at once without IntersectionObserver). */
function whenSeen(el: HTMLElement, fn: () => void): void {
  if (typeof IntersectionObserver === 'undefined') { requestAnimationFrame(fn); return; }
  const io = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); }
  }, { threshold: 0.4 });
  io.observe(el);
}

const kids = (c: Kid[] | Node) => (Array.isArray(c) ? c : [c]);

// ---------- surfaces ----------

/** A notched, bordered box. raised ones stand up on a hard shadow; with onClick it presses like a key. */
export function panel(children: Kid[] | Node, opts: { tone?: 'plain' | 'raised' | 'inset'; pad?: 's' | 'm' | 'l'; onClick?: () => void } = {}): HTMLElement {
  const tone = opts.onClick ? 'raised' : opts.tone ?? 'plain';
  const el = h(`div.u-panel.u-${tone}.u-pad-${opts.pad ?? 'm'}`, {}, ...kids(children));
  if (opts.onClick) pressable(el, opts.onClick);
  return el;
}

/** A page's top: optional pixel art (a public/art name), a small eyebrow, the headline and one line under it. */
export function hero(opts: { eyebrow?: string; title: string; sub?: string; art?: string }): HTMLElement {
  let pic: HTMLElement | null = null;
  const el = h('header.u-hero', {});
  if (opts.art) {
    const img = h('img', { src: `art/${opts.art}.png`, alt: '', draggable: 'false' });
    pic = h('div.u-hero-art', {}, img);
    img.addEventListener('error', () => { pic?.remove(); el.classList.remove('u-has-art'); });
    el.classList.add('u-has-art');
  }
  el.append(...[pic, h('div.u-hero-text', {},
    opts.eyebrow ? h('p.u-eyebrow', {}, opts.eyebrow) : null,
    h('h1.u-hero-title', {}, opts.title),
    opts.sub ? h('p.u-hero-sub', {}, opts.sub) : null)].filter((n): n is HTMLElement => !!n));
  return el;
}

// ---------- numbers ----------

/** Ticks el's text up to value like a scoreboard: 14 steps, 50 ms apart. */
function tickUp(el: HTMLElement, value: number, decimals: number): void {
  if (calm() || !value) return;
  el.textContent = formatNumber(0, decimals);
  whenSeen(el, () => {
    let k = 0;
    const id = window.setInterval(() => {
      k++;
      el.textContent = formatNumber(tickAt(value, k, 14, decimals), decimals);
      if (k >= 14) clearInterval(id);
    }, 50);
  });
}

/** A big scoreboard number in the pixel font, like "$0.42". Size it with --score-size on a parent. */
export function score(value: number, opts: { label?: string; caption?: string; tone?: Tone; countUp?: boolean; prefix?: string; suffix?: string; decimals?: number } = {}): HTMLElement {
  const d = opts.decimals ?? 0, final = formatNumber(value, d);
  const val = h('span.u-score-val', {}, final);
  const said = `${opts.prefix ?? ''}${final}${opts.suffix ? ` ${opts.suffix.replace(/^\//, 'a ').trim()}` : ''}`;
  const el = h('div.u-score', { 'data-tone': opts.tone ?? 'plain' },
    h('span.u-sr', {}, opts.label ? `${opts.label}: ${said}` : said),
    opts.label ? h('div.u-score-label', { 'aria-hidden': 'true' }, opts.label) : null,
    h('div.u-score-row', { 'aria-hidden': 'true' },
      opts.prefix ? h('span.u-score-pre', {}, opts.prefix) : null,
      // the hidden copy holds the final width, so ticking never moves things around
      h('span.u-score-fig', {}, h('span.u-score-ghost', {}, final), val),
      opts.suffix ? h('span.u-score-suf', {}, opts.suffix) : null),
    opts.caption ? h('div.u-score-cap', { 'aria-hidden': 'true' }, opts.caption) : null);
  if (opts.countUp) tickUp(val, value, d);
  return el;
}

/** A segmented pixel meter, like a health bar, with the number beside it. Blocks light one by one. */
export function meter(value: number, max: number, opts: { blocks?: number; tone?: Tone; label?: string } = {}): HTMLElement {
  const n = Math.max(2, Math.min(24, Math.round(opts.blocks ?? 10))), lit = meterLit(value, max, n);
  const shown = formatNumber(Math.max(0, Math.min(max, value)), Number.isInteger(value) ? 0 : 1);
  const track = h('div.u-meter-track', {}, ...Array.from({ length: n }, (_, i) =>
    h('i' + (i < lit ? '.u-on' : ''), { style: `--i:${i}` })));
  const el = h('div.u-meter', { 'data-tone': opts.tone ?? 'you', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value), 'aria-label': opts.label ?? 'Score' },
    opts.label ? h('div.u-meter-label', { 'aria-hidden': 'true' }, opts.label) : null,
    h('div.u-meter-row', {}, track, h('span.u-meter-num', { 'aria-hidden': 'true' }, shown)));
  if (!calm() && lit) {
    el.classList.add('u-wait');
    whenSeen(el, () => { el.classList.remove('u-wait'); el.classList.add('u-go'); });
  }
  return el;
}

/** A small fact tile: label, value, an optional hint. Put two or three in a .u-grid2 or .u-grid3. */
export function stat(label: string, value: string, opts: { tone?: Tone; hint?: string } = {}): HTMLElement {
  return h('div.u-stat', { 'data-tone': opts.tone ?? 'plain' },
    h('div.u-stat-label', {}, label),
    h('div.u-stat-value', {}, value),
    opts.hint ? h('div.u-stat-hint', {}, opts.hint) : null);
}

// ---------- messages and actions ----------

/** Why it matters and what to do: an icon tile, a line, a short body and one action. */
export function insight(opts: { icon?: string; tone?: Tone; title: string; body?: string; action?: { label: string; onClick: () => void } }): HTMLElement {
  const art = opts.icon?.trim().startsWith('<');
  return h('div.u-insight', { 'data-tone': opts.tone ?? 'plain' },
    opts.icon ? iconEl(opts.icon, art ? 'u-insight-ico.u-art' : 'u-insight-ico', 3) : null,
    h('div.u-insight-text', {},
      h('div.u-insight-title', {}, opts.title),
      opts.body ? h('p.u-insight-body', {}, opts.body) : null,
      opts.action ? h('button.u-insight-act', { type: 'button', onclick: () => opts.action!.onClick() }, h('span', {}, opts.action.label), iconEl('arrow')) : null));
}

/** A rectangular, notched key that sinks when pressed. */
export function button(label: string, opts: { kind?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: string; onClick: () => void; wide?: boolean }): HTMLElement {
  return h(`button.u-btn.u-${opts.kind ?? 'primary'}${opts.wide ? '.u-wide' : ''}`, { type: 'button', onclick: () => opts.onClick() },
    opts.icon ? iconEl(opts.icon) : null, h('span.u-btn-label', {}, label));
}

/** A small square-cornered tag; a colored tone gets a pixel dot. */
export function chip(label: string, tone: Tone = 'plain'): HTMLElement {
  return h('span.u-chip', { 'data-tone': tone }, label);
}

// ---------- charts and lists ----------

/** A pixel block chart, oldest first. The last `highlightLast` columns (default 1) are lit brightest. */
export function bars(values: number[], opts: { labels?: string[]; tone?: Tone; highlightLast?: number } = {}): HTMLElement {
  const rows = 8, fill = barBlocks(values, rows), n = values.length, hi = opts.highlightLast ?? 1, L = opts.labels ?? [];
  const word = (v: number) => formatNumber(v, Number.isInteger(v) ? 0 : 1);
  const said = values.map((v, i) => (L[i] ? `${L[i]}: ${word(v)}` : word(v))).join(', ');
  // a label under every column fits up to 7; past that, the first and last
  const each = L.length > 0 && L.length <= 7;
  const cols = fill.map((f, i) => h('span.u-col' + (i >= n - hi ? '.u-hi' : ''), {},
    ...Array.from({ length: rows }, (_, r) => h('i' + (r < f ? '.u-on' : ''), { style: `--d:${Math.min(i, 16) * 30 + r * 40}ms` }))));
  const el = h('div.u-bars', { 'data-tone': opts.tone ?? 'you', role: 'img', 'aria-label': `Chart: ${said}` },
    h('div.u-bars-plot', {}, ...cols),
    L.length ? h('div.u-bars-labels' + (each ? '.u-each' : ''), { 'aria-hidden': 'true' },
      ...(each ? L.slice(0, n).map((l) => h('span', {}, l)) : [h('span', {}, L[0]), h('span', {}, L[Math.min(L.length, n) - 1])])) : null);
  if (!calm() && fill.some((f) => f > 0)) {
    el.classList.add('u-wait');
    whenSeen(el, () => { el.classList.remove('u-wait'); el.classList.add('u-go'); });
  }
  return el;
}

/** Steps joined by a dashed pixel line, like where the water goes. The last step is the answer. */
export function timeline(items: { tone: Tone; title: string; sub?: string; onClick?: () => void }[]): HTMLElement {
  return h('ol.u-tl', {}, ...items.map((it, i) => {
    const next = items[i + 1]?.tone ?? it.tone;
    const body = [h('span.u-tl-node', { 'aria-hidden': 'true' }), h('span.u-tl-text', {}, h('span.u-tl-title', {}, it.title), it.sub ? h('span.u-tl-sub', {}, it.sub) : null)];
    const row = it.onClick
      ? h('button.u-tl-row.u-tl-btn', { type: 'button', onclick: () => it.onClick!() }, ...body, iconEl('chevron', 'u-tl-chev'))
      : h('div.u-tl-row', {}, ...body);
    return h('li.u-tl-item' + (i === items.length - 1 ? '.u-last' : ''), { 'data-tone': it.tone, 'data-next': next }, row);
  }));
}

// ---------- motion ----------

/** Children slide in one after another, 50 ms apart. */
export function stagger(root: HTMLElement): HTMLElement {
  if (calm()) return root;
  root.classList.add('u-stagger');
  [...root.children].forEach((c, i) => (c as HTMLElement).style.setProperty('--i', String(Math.min(i, 12))));
  return root;
}

let toastTimer = 0;

/** A short note that slides up from the bottom, then leaves by itself. */
export function toast(msg: string, opts: { icon?: string; ms?: number } = {}): void {
  const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
  let box = host.querySelector<HTMLElement>(':scope > .u-toasts');
  if (!box) {
    box = h('div.u-toasts', { role: 'status', 'aria-live': 'polite' });
    host.append(box);
  }
  // phone: just above the tab bar
  const tabs = host.querySelector<HTMLElement>(':scope > .tabs');
  box.style.bottom = host.closest('.phone') && tabs ? `${tabs.offsetHeight + 16}px` : '';
  clearTimeout(toastTimer);
  const el = h('div.u-toast', {}, opts.icon ? iconEl(opts.icon) : null, h('span', {}, msg));
  box.replaceChildren(el);
  toastTimer = window.setTimeout(() => {
    el.classList.add('u-out');
    setTimeout(() => el.remove(), calm() ? 0 : 180);
  }, opts.ms ?? 2800);
}

// ---------- layout ----------

/**
 * Content for the map's card: a bottom sheet on the phone, a side panel over the map on the laptop.
 * Use it as app.setPanel(sheet([...], { title })).
 */
export function sheet(content: Kid[] | Node, opts: { eyebrow?: string; title?: string; onClose?: () => void; actions?: (Node | null)[] } = {}): HTMLElement {
  const head = opts.title || opts.eyebrow || opts.onClose
    ? h('div.u-sheet-head', {},
      h('div.u-sheet-titles', {},
        opts.eyebrow ? h('p.u-eyebrow', {}, opts.eyebrow) : null,
        opts.title ? h('h2.u-sheet-title', {}, opts.title) : null),
      opts.onClose ? h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => opts.onClose!() }, iconEl('x')) : null)
    : null;
  const acts = opts.actions?.filter((a): a is Node => !!a) ?? [];
  return h('div.u-sheet', {}, head, ...kids(content), acts.length ? h('div.u-sheet-foot', {}, ...acts) : null);
}

/** A full page in the app's page scroll: app.showPage(screen([...])). */
export function screen(content: Kid[] | Node, opts: { wide?: boolean } = {}): HTMLElement {
  return h('div.u-screen' + (opts.wide ? '.u-wide' : ''), {}, ...kids(content));
}
