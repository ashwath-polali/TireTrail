// The report's showpiece: the creek scene, tire dust and the gas line, and the reveal that plays them in order.
// Salmon first, then tire dust, then gas, then the one fix. A tap skips it; less motion shows the end at once.
import '../anim/anim.css';
import { h } from '../dom.ts';
import { every, type Show } from '../anim/clock.ts';
import { CreekScene, type CreekFish } from '../anim/creek.ts';
import { spritesReady } from '../anim/sprites.ts';
import { pumpMini, tireMini, type Mini } from '../anim/minis.ts';
import type { RevealPlan } from '../anim/plan.ts';
import { calm, formatNumber, glyph, meter, salmonSVG, score, tickAt } from '../ui/ui.ts';
import { centsAmount, type GasLine } from '../../drive/gas.ts';
import { creekWords, vsWord, type CreekIn } from './drive-words.ts';
import { gramsText } from '../../drive/dust.ts';

/** an element that slides in at `at` ms */
export type Beat = [HTMLElement, number];

export interface Part {
  el: HTMLElement;
  beats: Beat[];
  /** sets its numbers and pictures t ms in */
  draw(t: number, idle: boolean): void;
}

// ---------- the creek ----------

export interface CreekCardIn {
  /** streams crossed, or null with none (then `head` says what there is) */
  crossed: CreekIn | null;
  head: { line: string; sub: string } | null;
  fish: CreekFish[];
  plan: RevealPlan;
  onClick?: () => void;
}

export function creekCard(c: CreekCardIn): Part {
  const w = c.crossed ? creekWords(c.crossed) : null;
  const label = w ? `${w.n} ${w.k}. ${w.sub}.` : c.head ? `${c.head.line}. ${c.head.sub}` : 'Salmon streams';
  const scene = new CreekScene(c.fish, c.plan.fish, label);
  const head = w
    ? h('div.an-creek-head', {}, h('b.an-creek-n', { 'aria-hidden': 'true' }, w.n),
      h('span.an-creek-t', { 'aria-hidden': 'true' }, h('b', {}, w.k), h('span', { 'data-tone': w.tone }, w.sub)))
    : h('div.an-creek-head', {}, h('span.an-creek-ico', { 'aria-hidden': 'true', html: salmonSVG(2) }),
      h('span.an-creek-t', {}, h('b', {}, c.head?.line ?? 'Salmon streams'), c.head?.sub ? h('span', {}, c.head.sub) : null));
  const kids = [head, scene.el, c.onClick ? h('span.an-creek-go', { 'aria-hidden': 'true', html: glyph('chevron', 2) }) : null];
  const el = c.onClick
    ? h('button.an-card.an-creekcard', { type: 'button', onclick: () => c.onClick!() }, ...kids)
    : h('section.an-card.an-creekcard', { 'aria-label': 'Salmon streams' }, ...kids);
  // the count ticks up as each coho gets to its place
  const nEl = el.querySelector<HTMLElement>('.an-creek-n');
  return {
    el, beats: [[el, 0]],
    draw(t, idle) {
      scene.draw(t, idle);
      if (!nEl || !w) return;
      const shown = c.plan.fish.slice(0, c.fish.length), got = shown.filter((f) => t >= f.at - 120).length;
      nEl.textContent = got >= shown.length ? w.n : String(got);
    },
  };
}

// ---------- tire dust ----------

export interface DustCardIn {
  mg: number;
  typicalMg: number;
  pct: number;
  tone: 'money' | 'warn' | 'plain';
  plan: RevealPlan;
}

export function dustCard(c: DustCardIn): Part {
  const g = c.mg / 1000, d = g < 0.995 ? 2 : g < 9.95 ? 1 : 0, max = Math.max(c.mg, c.typicalMg, 1);
  const tire = tireMini(c.plan.tick);
  const sc = score(g, { label: 'TIRE DUST', suffix: 'g', decimals: d, tone: c.tone, countUp: false });
  const val = sc.querySelector<HTMLElement>('.u-score-val');
  const bar = (k: string, mg: number, t: 'money' | 'warn' | 'plain') => {
    const m = meter(mg, max, { blocks: 16, tone: t });
    m.setAttribute('aria-label', k);
    return h('div.dv-vs-row', {}, h('span.dv-vs-k', {}, k), m, h('b.dv-vs-v', {}, gramsText(mg)));
  };
  const vs = h('div.dv-vs.an-bars', {}, bar('You', c.mg, c.tone), bar('Typical here', c.typicalMg, 'plain'));
  const el = h('section.dv-board.dv-board-d.an-dust', { 'data-tone': c.tone },
    h('div.dv-dust-top', {}, sc, h('div.an-dust-r', {}, tire.el, h('b.dv-dust-vs', { 'data-tone': c.tone }, vsWord(c.pct)))), vs);
  return {
    el, beats: [[el, c.plan.dust], [vs, c.plan.bars]],
    draw(t) {
      tire.draw(t);
      if (val) val.textContent = formatNumber(tickAt(g, Math.round(((t - c.plan.tick[0]) / (c.plan.tick[1] - c.plan.tick[0])) * 8), 8, d), d);
    },
  };
}

// ---------- gas ----------

export function gasCard(gl: GasLine, plan: RevealPlan): Part {
  const p = plan.gas!, pump = pumpMini(p.coins);
  const num = h('b', {}, `+${gl.amount}`);
  const el = h('section.an-card.an-gas', {},
    pump.el,
    h('div.an-gas-t', {},
      h('span.u-sr', {}, `${gl.words} Estimate.`),
      h('p.an-gas-num', { 'aria-hidden': 'true' }, h('span.an-gas-win', {}, num), h('span.an-gas-per', {}, 'a gallon')),
      h('p.an-gas-why', { 'aria-hidden': 'true' }, `Estimate · ${gl.habits.toLowerCase()}`),
      h('p.an-gas-save', {}, gl.pitch)));
  return {
    el, beats: [[el, p.in]],
    draw(t) {
      pump.draw(t);
      const k = Math.min(1, Math.max(0, (t - p.tick[0]) / (p.tick[1] - p.tick[0])));
      // from 5¢ up, never +0¢
      const c = Math.max(5, Math.round((gl.cents * k) / 5) * 5);
      num.textContent = `+${k >= 1 ? gl.amount : centsAmount(c)}`;
    },
  };
}

// ---------- the reveal ----------

/**
 * Plays the parts on show's clock; null or less motion: the end at once. The creek keeps running after, calmly,
 * while it's on screen. A tap or a key during the reveal skips to the end (and does nothing else).
 */
export function runReveal(root: HTMLElement, show: Show | null, plan: RevealPlan, parts: Part[], beats: Beat[] = []): void {
  const all = [...beats, ...parts.flatMap((p) => p.beats)];
  const still = calm();
  const born = performance.now();
  const at = () => (show && !still ? show.at() : plan.end + (performance.now() - born));
  let ended = false;
  const apply = (t: number, idle: boolean) => {
    for (const [el, b] of all) el.classList.toggle('rv-on', t >= b);
    for (const p of parts) p.draw(t, idle);
  };
  if (show && !still) {
    show.end = plan.end;
    root.classList.add('rv-play');
    for (const [el] of all) el.classList.add('rv');
  }
  apply(at(), false);
  // the sprite sheets may still be coming: draw again once they're in
  void spritesReady().then(() => { if (root.isConnected || !root.parentNode) apply(at(), ended || !show || still); });
  if (still) return;
  // tapping during the reveal skips it, and that tap does nothing more
  let eat = false;
  const skip = (e: Event) => {
    if (!show || show.done) return;
    show.skip();
    eat = e.type === 'pointerdown';
    if (e.type === 'keydown') e.preventDefault();
    tick(performance.now());
  };
  const swallow = (e: Event) => { if (eat) { eat = false; e.preventDefault(); e.stopPropagation(); } };
  if (show && !show.done) {
    root.addEventListener('pointerdown', skip, { capture: true });
    root.addEventListener('click', swallow, { capture: true });
    root.addEventListener('keydown', (e) => { if (['Enter', ' ', 'Escape'].includes((e as KeyboardEvent).key)) skip(e); }, { capture: true });
  }
  // the creek keeps running after the reveal while it's in view, at half speed
  let seen = true, odd = false;
  if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver((es) => { seen = es.some((e) => e.isIntersecting); }).observe(root);
  const tick = (_now: number): boolean => {
    if (!root.isConnected) return false;
    const t = at();
    if (!ended && t >= plan.end) {
      ended = true;
      root.classList.remove('rv-play');
      root.classList.add('rv-done');
    }
    if (ended) {
      odd = !odd;
      if (odd || !seen) return true;
    }
    apply(t, ended);
    return true;
  };
  every(tick);
}
