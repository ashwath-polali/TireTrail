// The Drive tab's map cards: one hard brake, a learned spot, recording, and the end of See it happen. The report is drive-report.ts.
import type { Stretch } from '../../drive/coach/replay.ts';
import { gramsText } from '../../drive/dust.ts';
import type { Spot } from '../../drive/spots.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { waterHTML } from '../anim/minis.ts';
import { clsArt, clsTone } from './drive-art.ts';
import type { BrakePin } from './drive-pins.ts';
import { button, chip, glyph, insight, meter, salmonSVG, scoreTone, sheet, stagger } from '../ui/ui.ts';
import { firstSentence, KIND_LABEL, stretchHead, stretchWhy } from './drive-coach.ts';
import { brakeDo, brakeKind, count, crossedWord, dustScale, endWords, pctVs, placeOf, rainHead, rainShort, rainWhy, REC, SHORT, shortRule, shortWhat, spotWords, vsTone, type BrakeView, type RainIn } from './drive-words.ts';

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
    eyebrow: 'NOT SAVED', title: SHORT.title, onClose: c.ok,
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
  done(): void;
}

export function spotSheet(c: SpotIn): HTMLElement {
  const s = c.spot, w = spotWords({ ...s, name: c.name });
  const rain: RainIn = c.drain ? { ...c.drain, mapped: true } : { cls: 'none', receiving: '', code: '', lengthM: 0, local: true, mapped: c.mapped };
  const body = h('div.dv-stop', {},
    insight({ icon: 'bell', tone: 'you', title: 'You brake hard here.', body: w.body }),
    h('section.dv-sec', {}, label('WHY IT MATTERS'), insight({ icon: clsArt(rain.cls, rain.code), tone: clsTone(rain.cls), title: rainHead(rain).replace('this stop', 'this spot'), body: rainWhy(rain) })),
    h('section.dv-sec', {}, label('WHAT TO DO HERE'), insight({ icon: 'clock', tone: 'you', title: 'Start slowing sooner as you come up to it.', body: 'Ease off the gas early and roll toward the stop. A gentle stop sheds the least tire dust.' })),
    h('div.dv-keys', {}, button('Done', { kind: 'secondary', onClick: c.done })));
  stagger(body);
  return sheet([body], { eyebrow: 'YOUR HARD-BRAKE SPOT', title: c.name ? cap(c.name) : 'A spot on your drives', onClose: c.done });
}

// ---------- recording ----------

export interface RecSheet {
  el: HTMLElement;
  /** seconds since the start, meters so far, and whether GPS has a fix yet */
  set(sec: number, meters: number, fix: boolean): void;
  /** the voice switch: off when muted, or while the phone won't let it speak yet */
  voice(muted: boolean, locked?: boolean): void;
  /** the big "tap to turn on the voice" key: only while parked, before the drive starts moving */
  ask(show: boolean): void;
  /** salmon streams crossed so far; a coho swims across once when it goes up */
  salmon(n: number): void;
  /** tire dust so far, mg, and typical driving over the same road */
  dust(mg: number, typicalMg: number): void;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const DUST_BLOCKS = 12;

export function recSheet(c: { autoEnds: boolean; muted: boolean; locked: boolean; end(): void; toggleVoice(): void; unlock(): void }): RecSheet {
  const time = h('b.dv-rec-big', {}, '0:00'), miles = h('b.dv-rec-big', {}, '0.0');
  // a switch, so it says both what it is and whether it's on
  const vk = h('button.u-btn.u-secondary.dv-voice', { type: 'button', role: 'switch', 'aria-label': 'Voice tips', onclick: () => c.toggleVoice() });
  // the voice can already talk when only the motion sensor still needs the tap
  const askT = h('b', {}, '');
  const ask = h('button.dv-rec-ask', { type: 'button', hidden: true, onclick: () => c.unlock() },
    ico('sound', 3), h('span', {}, askT, h('span', {}, 'Before you pull out.')));
  const voice = (muted: boolean, locked = false) => {
    const on = !muted && !locked;
    vk.setAttribute('aria-checked', String(on));
    vk.replaceChildren(h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')), h('span.u-btn-label', {}, 'Voice'), h('span.dv-voice-state', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'));
    askT.textContent = locked ? 'Tap to turn on the voice' : 'Tap once to sense hard brakes';
  };
  voice(c.muted, c.locked);
  // salmon streams crossed: the count, and a strip of creek a coho swims across when it goes up
  const fishN = h('b', {}, '0'), fishK = h('span', {}, crossedWord(0));
  const creek = h('span.dv-rec-creek', { html: waterHTML(false) });
  const fish = h('div.dv-rec-fish', { 'data-n': '0' }, h('span.dv-rec-fish-ico', { 'aria-hidden': 'true', html: salmonSVG(2) }), fishN, fishK, creek);
  // tire dust so far: blocks fill toward the next step up
  const blocks = Array.from({ length: DUST_BLOCKS }, () => h('i'));
  const dustV = h('b', {}, '0 g');
  const dustRow = h('div.dv-rec-dust', { role: 'meter', 'aria-label': 'Tire dust so far', 'aria-valuemin': '0', 'aria-valuenow': '0' },
    h('span.dv-rec-k', {}, 'TIRE DUST'), h('span.dv-rec-blocks', { 'aria-hidden': 'true' }, ...blocks), dustV);
  const el = h('div.dv-rec', {},
    h('div.dv-rec-top', {},
      h('span.dv-rec-dot', { 'aria-hidden': 'true' }), h('span.dv-rec-state', {}, 'REC'),
      h('img.dv-rec-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' })),
    ask,
    h('div.dv-rec-nums', {},
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'TIME'), time),
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'MILES'), miles)),
    h('div.dv-rec-live', {}, fish, dustRow),
    h('div.dv-rec-keys', {}, vk, button('End drive', { kind: 'primary', icon: 'end', onClick: c.end })),
    c.autoEnds ? h('p.u-caption.dv-rec-note', {}, REC.autoEnds) : null);
  let lastT = '', lastM = '', lastN = -1, lastLit = -1, swim = 0;
  return {
    el,
    set(sec, meters, fix) {
      const t = clock(sec), m = (meters / 1609.344).toFixed(1);
      if (t !== lastT) time.textContent = lastT = t;
      if (m !== lastM) miles.textContent = lastM = m;
      el.classList.toggle('dv-nofix', !fix);
    },
    voice,
    ask(show) { if (ask.hidden === show) ask.hidden = !show; },
    salmon(n) {
      if (n === lastN) return;
      fish.dataset.n = String(n);
      fishN.textContent = String(n);
      fishK.textContent = crossedWord(n);
      // one calm pass of a coho across the creek, never on a redraw
      if (n > lastN && lastN >= 0) {
        const ws = creek.firstElementChild as HTMLElement | null;
        ws?.classList.remove('an-go');
        void ws?.offsetWidth;
        ws?.classList.add('an-go');
        clearTimeout(swim);
        swim = window.setTimeout(() => ws?.classList.remove('an-go'), 6600);
      }
      lastN = n;
    },
    dust(mg, typicalMg) {
      const g = mg / 1000, lit = Math.min(DUST_BLOCKS, Math.round((g / dustScale(g)) * DUST_BLOCKS));
      dustV.textContent = gramsText(mg);
      dustRow.setAttribute('aria-valuenow', g.toFixed(2));
      dustRow.dataset.tone = vsTone(pctVs(mg, typicalMg));
      if (lit === lastLit) return;
      lastLit = lit;
      blocks.forEach((b, i) => b.classList.toggle('on', i < lit));
    },
  };
}

export function stillSheet(c: { keep(): void; end(): void }): HTMLElement {
  return sheet([h('p.u-body', {}, 'Keep TireTrail open on screen, or recording stops.')], {
    eyebrow: 'REC', title: 'Still recording.',
    actions: [button('Keep recording', { kind: 'primary', icon: 'record', onClick: c.keep }), button('End drive', { kind: 'secondary', icon: 'end', onClick: c.end })],
  });
}

// ---------- the end of See it happen ----------

export function endCard(c: { b: BrakeView; done(): void; again(): void }): HTMLElement {
  const e = endWords(c.b), tone = clsTone(c.b.cls);
  const title = h('h2.u-sheet-title', { tabindex: '-1' }, e.title);
  const body = h('div.dv-end', {},
    h('div.dv-end-head', { 'data-tone': tone }, h('p.u-eyebrow', {}, 'THE WHOLE TRIP'), title),
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
