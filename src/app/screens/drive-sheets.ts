// The Drive tab's map cards: one hard brake, a learned spot, recording, and the end of See it happen. The report is drive-report.ts.
import type { Stretch } from '../../drive/coach/replay.ts';
import type { Spot } from '../../drive/spots.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { clsArt, clsTone } from './drive-art.ts';
import type { BrakePin } from './drive-pins.ts';
import { button, chip, glyph, insight, scoreTone, sheet, stagger } from '../ui/ui.ts';
import { firstSentence, KIND_LABEL, stretchHead, stretchWhy } from './drive-coach.ts';
import { brakeDo, brakeKind, count, endWords, placeOf, rainShort, REC, SHORT, shortRule, shortWhat, spotWhy, type BrakeView } from './drive-words.ts';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

/** A small eyebrow heading inside a card. */
const label = (text: string) => h('p.u-eyebrow.dv-label', {}, text);

// ---------- too short to score ----------

/** A drive under the minimum, ended by hand: what it was, the rule, OK. */
export function shortSheet(c: { mi: number; sec: number; ok(): void }): HTMLElement {
  return sheet([h('div.dv-short', {},
    h('p.dv-short-what', {}, shortWhat(c.mi, c.sec)),
    h('p.u-body', {}, shortRule(c.mi, c.sec)))], {
    title: SHORT.title, onClose: c.ok,
    actions: [button('OK', { kind: 'primary', icon: 'check', onClick: c.ok })],
  });
}

// ---------- one hard brake ----------

export interface StopIn {
  app: App;
  pin: BrakePin;
  total: number;
  sample: boolean;
  spot: Spot | null;
  watch: (() => void) | null;
  steps: (() => void) | null;
  prev: (() => void) | null;
  next: (() => void) | null;
  back(): void;
}

export function stopSheet(c: StopIn): HTMLElement {
  const b = c.pin.b;
  const what = b.stopped
    ? `You stopped from ${b.entryMph} mph in ${b.brakingFt.toLocaleString('en-US')} ft, slowing ${Math.round(b.mphPerS)} mph in one second.`
    : `You slowed ${Math.round(b.mphPerS)} mph in one second, from ${b.fromMph} mph.`;
  const remind = c.sample ? 'On your drives, the voice learns spots like this.' : c.spot ? 'Next time, the voice warns you here.' : 'Brake hard here again and the voice will warn you.';
  const body = h('div.rp', {},
    plainHead(cap(placeOf(b)), `${brakeKind(b)} ${b.n} of ${c.total}`, c.back),
    h('div.rp-lines', {},
      plainLine('pin', brakeDo(b), 'you'),
      plainLine('stop', what),
      plainLine(rainIcon(b.cls), rainShort(b)),
      plainLine('bell', remind)),
    h('div.rp-keys', {},
      c.watch ? button('See it happen', { kind: 'secondary', icon: 'play', onClick: c.watch }) : null,
      c.steps ? button('Step by step', { kind: 'secondary', icon: 'route', onClick: c.steps }) : null),
    c.total > 1 ? pager(c.prev, c.next, 'Earlier', 'Later', `${b.n} of ${c.total}`) : null);
  return body;
}

// ---------- one stretch of the replay ----------

export interface StretchIn {
  s: Stretch;
  /** its place among the worst stretches, with keys to step through them */
  pos: { n: number; of: number } | null;
  prev: (() => void) | null;
  next: (() => void) | null;
  /** a hard brake here: where its rain goes */
  rain: { b: BrakeView; open(): void } | null;
  back(): void;
}

export function stretchSheet(c: StretchIn): HTMLElement {
  const s = c.s, hd = stretchHead(s), why = stretchWhy(s), todo = firstSentence(s.todo);
  const what = s.road ? s.what.replace(` on ${s.road}`, '') : s.what;
  const body = h('div.rp', { 'data-kind': s.kind },
    plainHead(hd.title, cap(KIND_LABEL[s.kind].toLowerCase()) + (c.pos && c.pos.of > 1 ? ` · ${c.pos.n} of ${c.pos.of}` : ''), c.back),
    h('div.rp-lines', {},
      s.kind === 'smooth' ? plainLine('check', 'Smooth here. Nothing to change.', 'money') : plainLine('pin', todo, 'you'),
      plainLine(s.kind === 'speeding' ? 'gauge' : s.kind === 'fast-start' ? 'flame' : 'stop', what),
      why ? plainLine('info', why) : null,
      c.rain ? plainLine(rainIcon(c.rain.b.cls), rainShort(c.rain.b), undefined, c.rain.open) : null),
    c.pos && c.pos.of > 1 ? pager(c.prev, c.next, 'Previous', 'Next', `${c.pos.n} of ${c.pos.of}`) : null);
  return body;
}

/** Where the rain goes, as a small glyph: a coho, soaking in, or a drop. */
const rainIcon = (cls: BrakeView['cls']): string => (cls === 'creek' ? 'fish' : cls === 'ground' ? 'soak' : 'drop');

/** The depth sheets' head: a title, one small line, and a back key. */
function plainHead(title: string, sub: string, back: () => void): HTMLElement {
  return h('div.rp-top', {},
    h('div.rp-titles', {}, h('h2.rp-title', {}, title), h('p.rp-when', {}, sub)),
    h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Back to the drive', title: 'Back', onclick: () => back() }, ico('back')));
}

/** One plain line with its glyph; with onClick it opens something. */
function plainLine(icon: string, text: string, tone?: 'you' | 'money', onClick?: () => void): HTMLElement {
  const kids = [
    h('span.rp-line-ico', { 'aria-hidden': 'true', 'data-tone': tone ?? '', html: glyph(icon, 2) }),
    h('span.rp-line-t', { 'data-tone': tone ?? '' }, text),
    onClick ? ico('chevron') : null,
  ];
  return onClick ? h('button.rp-line', { type: 'button', onclick: () => onClick() }, ...kids) : h('p.rp-line', {}, ...kids);
}

/** Earlier and later keys around "2 of 3". */
function pager(prev: (() => void) | null, next: (() => void) | null, back: string, on: string, n: string): HTMLElement {
  return h('div.dv-pager', {},
    prev ? button(back, { kind: 'ghost', icon: 'back', onClick: prev }) : h('span'),
    h('span.dv-pager-n', {}, n),
    next ? button(on, { kind: 'ghost', icon: 'chevron', onClick: next }) : h('span'));
}

// ---------- a learned spot ----------

export interface SpotIn {
  spot: Spot;
  name: string;
  drain: { cls: BrakeView['cls']; receiving: string; code: string; lengthM: number; local: boolean } | null;
  mapped: boolean;
  /** opened from My drives: a back key named for it, in place of the close key */
  back: string | null;
  done(): void;
}

/** A hard-brake spot in plain lines: what to do, the warning, and why it matters here. */
export function spotSheet(c: SpotIn): HTMLElement {
  const s = c.spot;
  const times = s.drives >= 2 ? `${count(s.count, 'hard brake')} on ${s.drives} drives` : count(s.count, 'hard brake');
  const w = spotWhy(c.drain ?? { cls: 'none', receiving: '', local: true });
  return h('div.rp', {},
    c.back ? h('button.rp-back', { type: 'button', onclick: () => c.done() }, ico('back'), h('span', {}, c.back)) : null,
    h('div.rp-top', {},
      h('div.rp-titles', {}, h('h2.rp-title', {}, c.name ? cap(c.name) : 'A spot on your drives'), h('p.rp-when', {}, `Your hard-brake spot · ${times}`)),
      c.back ? null : h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => c.done() }, ico('x'))),
    h('div.rp-lines', {},
      plainLine('clock', 'Start slowing sooner as you get close.', 'you'),
      plainLine('bell', 'The voice warns you before you get there.'),
      w.rain && c.drain ? plainLine(rainIcon(c.drain.cls), w.rain) : null,
      plainLine(c.drain?.cls === 'creek' ? 'fish' : 'gas', w.why)));
}

// ---------- recording: the live sheet is drive-live.ts ----------

/** Keep recording or End drive. paused: the app opened again on a drive that never ended. */
export function stillSheet(c: { keep(): void; end(): void; paused?: boolean }): HTMLElement {
  return sheet([h('p.u-body', {}, c.paused ? 'TireTrail closed in the middle of a drive. Keep recording, or end it and see the drive.' : 'Keep TireTrail open on screen, or recording stops.')], {
    title: c.paused ? 'Your drive is paused.' : 'Still recording.',
    actions: [button('Keep recording', { kind: 'primary', icon: 'record', onClick: c.keep }), button('End drive', { kind: 'secondary', icon: 'end', onClick: c.end })],
  });
}

// ---------- the end of See it happen ----------

export function endCard(c: { b: BrakeView; done(): void; again(): void }): HTMLElement {
  const e = endWords(c.b), tone = clsTone(c.b.cls);
  const title = h('h2.u-sheet-title', { tabindex: '-1' }, e.title);
  const body = h('div.dv-end', {},
    h('div.dv-end-head', { 'data-tone': tone }, title),
    insight({ icon: clsArt(c.b.cls, c.b.code), tone, title: e.why }),
    h('p.dv-end-do', {}, h('span.u-ico', { 'aria-hidden': 'true', html: glyph('clock') }), h('span', {}, e.todo)));
  stagger(body);
  return sheet([body], { actions: [button('Done', { kind: 'primary', icon: 'check', onClick: c.done }), button('Watch again', { kind: 'secondary', icon: 'play', onClick: c.again })] });
}

/** For My drives and home: chips that sum up a drive. withScore: lead with the score. */
export function driveChips(d: { score: number; hardBrakes: number; salmon: number }, withScore = true): HTMLElement {
  return h('span.dv-chips', {},
    withScore ? chip(`Score ${d.score}`, scoreTone(d.score)) : null,
    chip(d.hardBrakes ? count(d.hardBrakes, 'hard brake') : 'No hard brakes', d.hardBrakes ? 'warn' : 'money'),
    d.salmon ? chip(`${d.salmon} to a salmon stream`, 'salmon') : null);
}
