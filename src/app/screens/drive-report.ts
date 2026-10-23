// The drive report. The map is the report: one headline over it (headHTML), and one small sheet with the fix, gas and two keys.
// More holds the rest as one plain list: creeks, tire dust, 6PPDQ, gas, every event, your car, sharing and sources.
import './report.css';
import type { DriveReport } from '../../drive/analyze.ts';
import { gramsText, microText, type Vehicle } from '../../drive/dust.ts';
import { centsAmount, gasLine, gasPrice } from '../../drive/gas.ts';
import { weekOfText } from '../../drive/money.ts';
import { h } from '../dom.ts';
import { COHO } from '../anim/sprites.ts';
import { button, glyph } from '../ui/ui.ts';
import { creekWord, driveTitle, driveWhen, fixLine, gasShort, pctVs, type CreekMark } from './drive-words.ts';
import { vehiclePicker } from './vehicle.ts';

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

/** The caption's markup: the headline, and a coho for each creek (up to 8). The reveal lights each as its creek comes up. */
export function headHTML(head: string, creeks: readonly Pick<CreekMark, 'gentle'>[]): string {
  const g = creeks.filter((c) => c.gentle).length;
  const pict = creeks.length && creeks.length <= 8
    ? `<span class="rp-pict" role="img" aria-label="${g} of ${creeks.length} crossed gently">${creeks.map((c) => `<i data-gentle="${c.gentle ? 1 : 0}">${cohoSVG(c.gentle)}</i>`).join('')}</span>`
    : '';
  return `<span class="say rp-head">${pict}<b class="rp-head-t">${esc(head)}</b></span>`;
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
  creeks: readonly CreekMark[];
  /** the one fix: its stretch kind and limit, and where */
  fix: { kind: string; limitMph: number | null; where: string } | null;
  unsaved: boolean;
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
  return h('div.rp', {},
    h('div.rp-top', {},
      h('div.rp-titles', {}, h('h2.rp-title', {}, driveTitle(c.creeks, c.sample)), h('p.rp-when', {}, driveWhen(c.at, c.sample, r.miles, r.durationS))),
      h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => c.close() }, ico('x'))),
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
  /** the map's colors this drive has: [label, css color] */
  key: [string, string][];
  /** from the backup: its first and last 300 m are left out */
  trimmed: boolean;
  /** the coach's checking tools (drive-log.ts): a "not recorded" line, every event and share drive data */
  extras: { note: HTMLElement | null; details: HTMLElement[] } | null;
  /** where a hard brake's rain goes, when its pipes are traced */
  rain: (() => void) | null;
  share: HTMLElement | null;
  onVehicle: ((v: Vehicle) => void) | null;
  remove: (() => void) | null;
  back(): void;
}

/** A name and its figure, then one plain line under it. */
const row = (k: string, v: string, why?: string) => h('div.rp-row', {},
  h('div.rp-row-kv', {}, h('span.rp-k', {}, k), h('b.rp-v', {}, v)),
  why ? h('p.rp-why', {}, why) : null);

const group = (title: string, ...kids: (HTMLElement | null)[]) => h('section.rp-group', {}, h('h3.rp-h', {}, title), ...kids);

export function moreSheet(c: MoreIn): HTMLElement {
  const r = c.report, d = r.dust, gas = gasLine(r), price = gasPrice(), pct = pctVs(d.mg.typical, d.typicalMg.typical);
  const vs = pct <= -3 ? `${-pct}% less than typical here.` : pct >= 3 ? `${pct}% more than typical here.` : 'About typical here.';
  const creeks = c.creeks.length
    ? group('Salmon creeks', ...c.creeks.map((k) => h('div.rp-row', { 'data-gentle': String(k.gentle) },
      h('div.rp-row-kv', {}, h('span.rp-k', {}, k.name || 'A salmon creek'), h('b.rp-v', {}, creekWord(k.gentle))))))
    : null;
  const habits = gas ? (gas.hard && gas.speed ? 'speeding, fast starts and hard brakes' : gas.speed ? 'speeding' : 'fast starts and hard brakes') : '';
  const nums = group('This drive, estimated',
    row('Tire dust', `about ${gramsText(d.mg.typical)}`, `${vs} Hard brakes and fast starts grind more rubber off.`),
    row('6PPDQ', `about ${microText(d.sixPpdqUg.typical)}`, 'A chemical in tire dust. In lab tests it killed coho within hours.'),
    gas ? row('Gas', `${gas.text} a gallon`, `Extra gas from ${habits}${price ? `, at $${price.usdPerGal.toFixed(2)} a gallon` : ''}. Likely ${centsAmount(gas.low)} to ${centsAmount(gas.high)}.`) : null);
  const key = c.key.length ? group('On the map', h('ul.rp-key', {}, ...c.key.map(([k, col]) => h('li', {}, h('i', { 'aria-hidden': 'true', style: `background:${col}` }), k)))) : null;
  const car = group('What do you drive?', c.onVehicle ? vehiclePicker((v) => c.onVehicle!(v)) : null, h('p.rp-why', {}, 'Heavier cars and EVs shed more tire dust.'));
  const acts = [
    c.rain ? h('button.rp-act', { type: 'button', onclick: () => c.rain!() }, ico('drop'), h('span', {}, 'Where the rain goes'), ico('chevron')) : null,
    c.share,
  ].filter((x): x is HTMLElement => !!x);
  const src = [
    'Salmon creeks: WDFW SWIFD.',
    'Tire dust: Giechaskiel 2024, UN R117.',
    '6PPDQ: UW Tacoma for WA Ecology 2024, Tian 2021.',
    `Gas: fueleconomy.gov, ORNL 2017${price ? `, U.S. EIA ${weekOfText(price.weekOf)}` : ''}.`,
  ].join(' ');
  return h('div.rp-more', {},
    h('div.rp-more-top', {},
      h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Back to the drive', title: 'Back', onclick: () => c.back() }, ico('back')),
      h('h2.rp-title', {}, 'More about this drive')),
    creeks, nums, key,
    c.extras?.note ?? null,
    ...(c.extras?.details ?? []).map((el) => { el.classList.add('rp-group'); return el; }),
    car,
    acts.length ? h('div.rp-acts', {}, ...acts) : null,
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
