// The drive report. The map is the report: one headline over it (headHTML), and one small sheet with the fix, gas and two keys.
// More holds the rest as one plain list: creeks, every event, tire dust and 6PPDQ, sharing and sources.
import './report.css';
import type { DriveReport } from '../../drive/analyze.ts';
import { gramsText, microText } from '../../drive/dust.ts';
import { centsAmount, gasLine, gasPrice } from '../../drive/gas.ts';
import { weekOfText } from '../../drive/money.ts';
import { h } from '../dom.ts';
import { COHO } from '../anim/sprites.ts';
import { button, glyph } from '../ui/ui.ts';
import { creekWord, fixLine, gasShort, grayKey, pctVs, type CreekMark } from './drive-words.ts';

const ico = (name: string) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, 2) });

// ---------- the headline over the map ----------

const FISH_INK: Record<'on' | 'off', Record<string, string>> = {
  on: { G: '#4f9ea3', R: '#e3503f', W: '#f1ece4', E: '#0b0f0d' },
  off: { G: '#5d6762', R: '#7d8580', W: '#a9b0ab', E: '#0b0f0d' },
};

/** One coho from the reveal's own art, 2 css px a pixel: bright for gentle, gray for a hard brake. */
function cohoSVG(gentle: boolean): string {
  const rows = COHO[0], ink = FISH_INK[gentle ? 'on' : 'off'];
  let px = '';
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (ink[c]) px += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ink[c]}"/>`; }));
  return `<svg width="32" height="14" viewBox="0 0 16 7" shape-rendering="crispEdges" aria-hidden="true">${px}</svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The caption's markup: the headline, a coho for each creek (up to 8), and what a gray one means. The reveal lights each as its creek comes up. */
export function headHTML(head: string, creeks: readonly Pick<CreekMark, 'gentle' | 'name'>[]): string {
  const g = creeks.filter((c) => c.gentle).length;
  const pict = creeks.length && creeks.length <= 8
    ? `<span class="rp-pict" role="img" aria-label="${g} of ${creeks.length} crossed gently">${creeks.map((c) => `<i data-gentle="${c.gentle ? 1 : 0}">${cohoSVG(c.gentle)}</i>`).join('')}</span>`
    : '';
  return `<span class="say rp-head">${pict}<b class="rp-head-t">${esc(head)}</b>${grayKey(creeks) ? `<span class="rp-head-k">${esc(grayKey(creeks)!)}</span>` : ''}</span>`;
}

/** Lights the first n coho of the headline (the reveal); all with n = Infinity. */
export function lightCoho(n: number): void {
  document.querySelectorAll<HTMLElement>('.rp-pict i').forEach((el, k) => { const on = String(k < n); if (el.dataset.on !== on) el.dataset.on = on; });
}

// ---------- the sheet ----------

export interface ReportIn {
  report: DriveReport;
  sample: boolean;
  at: number;
  /** "Tuesday, 1:59 PM" and "Your 138th St S trip": a small line, so the map's headline is the only headline */
  name: { when: string; what: string };
  creeks: readonly CreekMark[];
  /** the one fix: its stretch kind and limit, and where */
  fix: { kind: string; limitMph: number | null; where: string } | null;
  unsaved: boolean;
  /** opened from My drives: a back key named for it, in place of the close key */
  back: string | null;
  openFix(): void;
  replay(): void;
  more(): void;
  close(): void;
}

export function reportSheet(c: ReportIn): HTMLElement {
  const r = c.report, gas = gasLine(r), fix = c.fix ? fixLine(c.fix, c.fix.where) : null;
  const fixEl = fix
    ? h('button.rp-line.rp-fix', { type: 'button', onclick: () => c.openFix() },
      h('span.rp-line-ico', { 'aria-hidden': 'true', html: glyph('pin', 2) }), h('span.rp-line-t', {}, fix), ico('chevron'))
    : h('p.rp-line.rp-fix', { 'data-ok': '' }, h('span.rp-line-ico', { 'aria-hidden': 'true', html: glyph('check', 2) }), h('span.rp-line-t', {}, 'Nothing to fix on this drive.'));
  const gasEl = gas ? h('p.rp-line.rp-gas', {}, h('span.rp-line-ico', { 'aria-hidden': 'true', html: glyph('gas', 2) }), h('span.rp-line-t', {}, gasShort(gas))) : null;
  const min = Math.max(1, Math.round(r.durationS / 60));
  return h('div.rp', {},
    c.back ? h('button.rp-back', { type: 'button', onclick: () => c.close() }, ico('back'), h('span', {}, c.back)) : null,
    h('div.rp-top', {},
      h('div.rp-titles', {},
        h('h2.rp-name', {}, c.name.what ? `${c.name.when} · ${c.name.what}` : c.name.when),
        h('p.rp-when', {}, `${r.miles.toFixed(1)} mi · ${min} min`)),
      c.back ? null : h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => c.close() }, ico('x'))),
    h('div.rp-lines', {}, fixEl, gasEl),
    c.unsaved ? h('p.rp-note', {}, "This drive couldn't be saved on this device.") : null,
    h('div.rp-keys', {},
      button('Replay', { kind: 'secondary', icon: 'play', onClick: c.replay }),
      button('More', { kind: 'secondary', icon: 'list', onClick: c.more })));
}

// ---------- More ----------

export interface MoreIn {
  report: DriveReport;
  creeks: readonly CreekMark[];
  /** from the backup: its first and last 300 m are left out */
  trimmed: boolean;
  /** the coach's checking tools (drive-log.ts): a "not recorded" line, every event and share drive data */
  extras: { note: HTMLElement | null; details: HTMLElement[] } | null;
  /** where a hard brake's rain goes, when its pipes are traced */
  rain: (() => void) | null;
  share: HTMLElement | null;
  remove: (() => void) | null;
  back(): void;
}

/** A name and its figure, then one plain line under it. */
const row = (k: string, v: string, why?: string) => h('div.rp-row', {},
  h('div.rp-row-kv', {}, h('span.rp-k', {}, k), h('b.rp-v', {}, v)),
  why ? h('p.rp-why', {}, why) : null);

const group = (title: string, ...kids: (HTMLElement | null)[]) => h('section.rp-group', {}, h('h3.rp-h', {}, title), ...kids);

/** More: the creeks, every event (a tap shows it on the map), the science as estimates, then the sources. */
export function moreSheet(c: MoreIn): HTMLElement {
  const r = c.report, d = r.dust, gas = gasLine(r), price = gasPrice(), pct = pctVs(d.mg.typical, d.typicalMg.typical);
  const vs = pct <= -3 ? `${-pct}% less than our typical-driving estimate for these roads.` : pct >= 3 ? `${pct}% more than our typical-driving estimate for these roads.` : 'About the same as our typical-driving estimate for these roads.';
  const creeks = c.creeks.length
    ? group('Salmon creeks', ...c.creeks.map((k) => h('div.rp-row', { 'data-gentle': String(k.gentle) },
      h('div.rp-row-kv', {}, h('span.rp-k', {}, k.name || 'A salmon creek'), h('b.rp-v', {}, creekWord(k.gentle))))))
    : null;
  const nums = group('This drive, estimated',
    row('Tire dust', `about ${gramsText(d.mg.typical)}`, `${vs} Hard brakes and fast starts grind more rubber off.`),
    row('6PPDQ', `about ${microText(d.sixPpdqUg.typical)}`, 'A chemical in tire dust. In lab tests it killed coho within hours.'));
  const acts = [
    c.rain ? h('button.rp-act', { type: 'button', onclick: () => c.rain!() }, ico('drop'), h('span', {}, 'Where the rain goes'), ico('chevron')) : null,
    c.share,
  ].filter((x): x is HTMLElement => !!x);
  // the gas line's price and range live here, with its sources
  const gasSrc = gas && price ? `Gas: an estimated ${centsAmount(gas.low)} to ${centsAmount(gas.high)} of each $${price.usdPerGal.toFixed(2)} gallon (fueleconomy.gov, ORNL 2017, U.S. EIA ${weekOfText(price.weekOf)}).` : `Gas: fueleconomy.gov, ORNL 2017${price ? `, U.S. EIA ${weekOfText(price.weekOf)}` : ''}.`;
  const src = ['Salmon creeks: WDFW SWIFD.', 'Tire dust: Giechaskiel 2024, UN R117.', '6PPDQ: UW Tacoma for WA Ecology 2024, Tian 2021.', gasSrc].join(' ');
  return h('div.rp-more', {},
    h('div.rp-more-top', {},
      h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Back to the drive', title: 'Back', onclick: () => c.back() }, ico('back')),
      h('h2.rp-title', {}, 'More about this drive')),
    creeks,
    c.extras?.note ?? null,
    ...(c.extras?.details ?? []).slice(0, 1).map((el) => { el.classList.add('rp-group'); return el; }),
    nums,
    acts.length ? h('div.rp-acts', {}, ...acts) : null,
    ...(c.extras?.details ?? []).slice(1).map((el) => { el.classList.add('rp-group'); return el; }),
    c.trimmed ? h('p.rp-why', {}, 'From your backup. The first and last 300 m are left out.') : null,
    c.remove ? deleteKey(c.remove) : null,
    h('p.rp-src', {}, src));
}

/** Delete, asked first in place. */
function deleteKey(onYes: () => void): HTMLElement {
  const box = h('div.rp-del', {});
  const ask = () => box.replaceChildren(
    h('p.rp-why', {}, "Delete this drive? It can't be undone."),
    h('div.rp-keys', {}, button('Delete', { kind: 'danger', icon: 'trash', onClick: onYes }), button('Keep', { kind: 'secondary', onClick: idle })));
  const idle = () => box.replaceChildren(button('Delete this drive', { kind: 'ghost', icon: 'trash', onClick: ask }));
  idle();
  return box;
}
