// The Drive tab's map cards: the drive report, one hard brake, a learned spot, recording, and the end of See it happen.
import type { DriveReport } from '../../drive/analyze.ts';
import type { Stretch } from '../../drive/coach/replay.ts';
import { moneyNote, rangeText } from '../../drive/money.ts';
import { PART_LABEL } from '../../drive/score.ts';
import type { Spot } from '../../drive/spots.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { button, chip, glyph, insight, meter, panel, salmonSVG, score, scoreTone, sheet, stagger, stat } from '../ui/ui.ts';
import { clsArt, clsTone } from './drive-art.ts';
import { firstSentence, KIND_LABEL, oneFix, stretchFacts, stretchHead, stretchSpeed, stretchWhy } from './drive-coach.ts';
import type { BrakePin } from './drive-pins.ts';
import {
  brakeDo, brakeKind, count, dayWord, endWords, gentleLine, moneyRow, placeOf, rainHead, rainShort, rainWhy, REC, salmonRow, scoreWord,
  SHORT, shortRule, shortWhat, spotWords, timeWord, yearParts, type BrakeView, type RainIn,
} from './drive-words.ts';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });

/** Pixel rain over a header: a few drops that fall three times, then stop. */
function drops(n = 14): HTMLElement {
  return h('div.dv-drops', { 'aria-hidden': 'true' }, ...Array.from({ length: n }, (_, i) =>
    h('i', { style: `--x:${(i * 37) % 100}%;--d:${(i * 173) % 900}ms;--h:${8 + ((i * 5) % 3) * 4}px` })));
}

/** A coho that swims across once, for a smooth drive. */
function swimmer(): HTMLElement {
  return h('div.dv-swim', { 'aria-hidden': 'true' }, h('img', { src: 'sprites/salmon2.png', alt: '', width: '64', height: '64', draggable: 'false' }));
}

/** A small eyebrow heading inside a card. */
const label = (text: string) => h('p.u-eyebrow.dv-label', {}, text);

/** A delete key that asks first, in place. */
function confirmDelete(what: string, onYes: () => void): HTMLElement {
  const box = h('div.dv-confirm', {});
  const ask = () => box.replaceChildren(
    h('p.u-body.dv-confirm-q', {}, `Delete ${what}? It can't be undone.`),
    h('div.dv-confirm-keys', {}, button('Delete', { kind: 'danger', icon: 'trash', onClick: onYes }), button('Keep', { kind: 'secondary', onClick: idle })));
  const idle = () => box.replaceChildren(button(`Delete ${what}`, { kind: 'ghost', icon: 'trash', onClick: ask }));
  idle();
  return box;
}

// ---------- the drive report ----------

export interface ReportIn {
  app: App;
  report: DriveReport;
  sample: boolean;
  at: number;
  pins: BrakePin[];
  spots: Spot[];
  unsaved: boolean;
  /** a redraw (names arrived): no count-ups or slide-ins */
  quiet: boolean;
  /** the worst stretches of the replay, worst first, with their index in replay.stretches */
  worst: { s: Stretch; i: number }[];
  /** gentle stops whose rain reaches a salmon stream */
  gentleSalmon: number;
  openStretch(i: number): void;
  watch(i: number): void;
  close(): void;
  remove: (() => void) | null;
  /** the share key, for the user's own drives */
  share: HTMLElement | null;
}

/** One line with an icon, a short second line, and a chevron when it opens something. */
function line(icon: string, tone: string, text: string, sub: string, onClick?: () => void): HTMLElement {
  const kids = [
    h('span.dv-line-ico', { 'aria-hidden': 'true', html: icon.startsWith('<') ? icon : glyph(icon, 2) }),
    h('span.dv-line-text', {}, h('b', {}, text), h('span', {}, sub)),
    onClick ? ico('chevron') : null,
  ];
  return onClick
    ? h('button.dv-line', { type: 'button', 'data-tone': tone, onclick: () => onClick() }, ...kids)
    : h('div.dv-line', { 'data-tone': tone }, ...kids);
}

/** The worst stretches as keys: what happened, where, and what to do. */
function workList(c: ReportIn): HTMLElement {
  return h('div.dv-work', {}, ...c.worst.map(({ s, i }) => {
    const el = panel([
      h('span.dv-work-sw', { 'aria-hidden': 'true' }),
      h('span.dv-work-text', {},
        h('span.dv-work-k', {}, KIND_LABEL[s.kind]),
        h('span.dv-work-t', {}, s.road || stretchSpeed(s)),
        h('span.dv-work-s', {}, firstSentence(s.todo))),
      h('span.dv-work-end', {}, ico('chevron')),
    ], { pad: 's', onClick: () => c.openStretch(i) });
    el.classList.add('dv-work-row');
    el.dataset.kind = s.kind;
    return el;
  }));
}

/** Everything past the main things, behind one disclosure: the places, the year in parts, why salmon, how we figure, delete. */
function details(c: ReportIn): HTMLElement {
  const r = c.report, parts = yearParts(r.money), tap = c.app.layout === 'laptop' ? 'Click' : 'Tap';
  const places = c.worst.length ? h('section.dv-sec', {},
    label(c.worst.length > 1 ? `${c.worst.length} PLACES TO DRIVE SMOOTHER` : 'ONE PLACE TO DRIVE SMOOTHER'), workList(c),
    h('p.u-caption', {}, `${tap} the colored route to see any part of it.`)) : null;
  const money = parts.length ? h('section.dv-sec.dv-d-money', {}, label('A YEAR, ESTIMATED'),
    h('div.dv-parts', {}, ...parts.map(([k, v]) => h('div.dv-part', {}, h('span', {}, k), h('i', { 'aria-hidden': 'true' }), h('b', {}, v))))) : null;
  const why = h('section.dv-sec', {}, label('WHY SALMON'), h('p.dv-d-why', {}, 'A chemical from tire dust can kill coho salmon within hours of a storm.'));
  const box = h('details.dv-how.dv-details', {},
    h('summary', {}, ico('list'), h('span', {}, 'Details'), ico('chevron')),
    h('div.dv-details-body', {}, places, money, why, howWeFigure(r), c.remove ? confirmDelete('this drive', c.remove) : null));
  return box;
}

export function reportSheet(c: ReportIn): HTMLElement {
  const r = c.report, s = r.score.score, tone = scoreTone(s), n = c.pins.length, live = !c.quiet;
  const happy = s >= 100 || !c.worst.length;

  // the score, its meter and what cost points
  const lost = (['brakes', 'starts', 'speed'] as const).map((k) => r.score.parts[k]).filter((p) => p.lost > 0);
  const board = h('div.dv-board.dv-board-s', { 'data-tone': tone },
    live ? drops(10) : null,
    score(s, { label: 'SMOOTH SCORE', suffix: '/100', tone, countUp: live }),
    meter(s, 100, { blocks: 20, tone }),
    h('div.dv-lost-pts', { 'aria-label': 'Points lost' }, ...(lost.length ? lost.map((p) => chip(`-${p.lost} ${PART_LABEL[p.key].toLowerCase()}`, 'warn')) : [chip('No points lost', 'money')])),
    live && s >= 80 ? swimmer() : null);

  // the one most useful change, at a real place; it opens its stretch on the map
  let fix: HTMLElement;
  if (happy) fix = insight({ icon: 'check', tone: 'money', title: 'Nothing to work on' });
  else {
    const w = c.worst[0], f = oneFix(w.s);
    fix = h('button.dv-fix', { type: 'button', 'data-kind': w.s.kind, onclick: () => c.openStretch(w.i) },
      h('span.u-eyebrow', {}, 'YOUR ONE FIX'),
      h('b.dv-fix-do', {}, f.title),
      h('span.dv-fix-at', {}, ico('pin'), h('span', {}, f.where || 'See it on the map'), ico('chevron')));
  }

  // money and salmon, one line each
  const creekAt = c.pins.findIndex((p) => p.b.cls === 'creek' && p.drain !== null);
  const playAt = creekAt >= 0 ? creekAt : c.pins.findIndex((p) => p.drain !== null);
  const more = details(c);
  const events = n + (r.speeding.overMi > 0.05 ? 1 : 0);
  const m = happy ? null : moneyRow(r.money, events);
  const sal = salmonRow(c.pins.map((p) => p.b), c.gentleSalmon);
  const salmonIcon = sal && (creekAt >= 0 || c.gentleSalmon > 0 || !n) ? salmonSVG(2) : 'fish';
  const openMore = () => {
    (more as HTMLDetailsElement).open = true;
    (more.querySelector('.dv-d-money') ?? more).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const rows = h('div.dv-lines', {},
    m ? line('coin', 'money', m.line, m.sub, openMore) : null,
    sal ? line(salmonIcon, 'salmon', sal.line, sal.sub, playAt >= 0 ? () => c.watch(playAt) : undefined) : null);

  const done = c.sample ? button('Close the sample', { kind: 'primary', icon: 'x', onClick: c.close }) : button('Done', { kind: 'primary', icon: 'check', onClick: c.close });
  const foot = h('div.dv-foot', {},
    c.unsaved ? h('p.u-caption', {}, "This drive couldn't be saved on this device.") : null,
    h('div.dv-keys', {}, done, c.share));

  const mi = r.miles.toFixed(1);
  const eyebrow = c.sample ? `SAMPLE · ${mi} MI` : `${dayWord(c.at).toUpperCase()}, ${timeWord(c.at).toUpperCase()} · ${mi} MI`;
  const body = h('div.dv-report', {}, board, fix, rows.childElementCount ? rows : null, more, foot);
  if (live) stagger(body);
  return sheet([body], { eyebrow, title: scoreWord(s), onClose: c.close });
}

/** "How we figure this": the rules, the sources and the ranges, closed until asked. */
function howWeFigure(r: DriveReport): HTMLElement {
  const m = r.money, li = (t: string) => h('li', {}, t);
  const rows = [
    'A hard brake is slowing 7 mph or more in one second, the way insurance driving apps count it.',
    r.limitsChecked
      ? 'Speeding is checked against posted limits on big roads, from OpenStreetMap. Above 50 mph, each 5 mph faster lowers gas mileage about 7% (fueleconomy.gov).'
      : "Posted speed limits didn't load, so speeding wasn't checked on this drive.",
    m.year ? `A year of driving like this: ${rangeText(m.year.total, 'year')}.` : 'A yearly figure needs a drive of 2 miles or more.',
    'Hard stops wear more tread than easing to a stop over the same stretch, because wear grows with braking force (Pohrt, 2019). A gentle stop slows about 3 mph each second.',
    moneyNote(),
    "Turning isn't measured. Speeds come from your phone's GPS, so they're estimates too.",
    'Drives under half a mile or 2 minutes get no score.',
    'Tire dust carries 6PPD-quinone, which forms from a chemical added to tires. In studies it killed coho salmon within hours (Tian and others, Science, 2021).',
    'Where rain goes comes from city and county storm pipe maps. Where a map has a gap, TireTrail says so instead of guessing.',
    ...r.warnings,
  ];
  return h('details.dv-how.dv-how-in', {},
    h('summary', {}, ico('info'), h('span', {}, 'How we figure this'), ico('chevron')),
    h('ul', {}, ...rows.map(li)));
}

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
  const slowed = stat('In 1 second', `-${Math.round(b.mphPerS)} mph`, { tone: 'warn' });
  const facts = b.stopped
    ? [stat('Speed', `${b.entryMph} mph`), stat('Stopped in', `${b.brakingFt.toLocaleString('en-US')} ft`), slowed]
    : [stat('Speed', `${b.fromMph} mph`), slowed, stat('Ended in', 'No stop')];
  const remind = c.sample ? 'On your own drives, TireTrail learns places like this and tells you before you get there.'
    : c.spot ? "TireTrail will tell you before you get here next time."
      : 'Brake hard here again and TireTrail will tell you before you get here next time.';
  const gentle = gentleLine(b);
  const body = h('div.dv-stop', {},
    h('div.u-grid3.dv-facts', {}, ...facts),
    h('p.dv-what', {}, 'Slowing 7 mph or more in one second counts as a hard brake.'),
    h('section.dv-sec', {}, label('WHY IT MATTERS'),
      insight({ icon: clsArt(b.cls, b.code), tone: clsTone(b.cls), title: rainHead(b), body: rainWhy(b) })),
    h('section.dv-sec', {}, label('WHAT TO DO HERE'),
      insight({ icon: 'clock', tone: 'you', title: brakeDo(b), body: [gentle, remind].filter(Boolean).join(' ') })),
    h('div.dv-keys', {},
      c.watch ? button('See it happen', { kind: 'primary', icon: 'play', onClick: c.watch }) : null,
      c.steps ? button('Step by step', { kind: 'secondary', icon: 'route', onClick: c.steps }) : null),
    c.total > 1 ? h('div.dv-pager', {},
      c.prev ? button('Earlier', { kind: 'ghost', icon: 'back', onClick: c.prev }) : h('span'),
      h('span.dv-pager-n', {}, `${b.n} of ${c.total}`),
      c.next ? button('Later', { kind: 'ghost', icon: 'chevron', onClick: c.next }) : h('span')) : null);
  stagger(body);
  return sheet([body], { eyebrow: `${brakeKind(b).toUpperCase()} ${b.n} OF ${c.total}`, title: cap(placeOf(b)), onClose: c.back });
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
  const s = c.s, hd = stretchHead(s), why = stretchWhy(s);
  const body = h('div.dv-stop.dv-stretch', { 'data-kind': s.kind },
    h('div.u-grid3.dv-facts', {}, ...stretchFacts(s).map(([k, v], i) => stat(k, v, { tone: i === 0 && s.kind !== 'smooth' ? 'warn' : 'plain' })),
      stat('Time', s.seconds < 90 ? `${Math.max(1, Math.round(s.seconds))} s` : `${Math.round(s.seconds / 60)} min`)),
    h('section.dv-sec', {}, label('WHAT HAPPENED'), h('p.dv-what', {}, s.road ? s.what.replace(` on ${s.road}`, '') : s.what), why ? h('p.u-body', {}, why) : null),
    h('section.dv-sec', {}, label('WHAT TO DO'),
      insight({ icon: s.kind === 'smooth' ? 'check' : s.kind === 'speeding' ? 'gauge' : s.kind === 'fast-start' ? 'flame' : 'clock', tone: s.kind === 'smooth' ? 'money' : 'you', title: firstSentence(s.todo), body: s.todo.slice(firstSentence(s.todo).length).trim() || undefined })),
    c.rain ? h('section.dv-sec', {}, label('WHERE ITS TIRE DUST GOES'),
      insight({ icon: clsArt(c.rain.b.cls, c.rain.b.code), tone: clsTone(c.rain.b.cls), title: rainShort(c.rain.b), action: { label: 'See where its rain goes', onClick: c.rain.open } })) : null,
    c.pos && c.pos.of > 1 ? h('div.dv-pager', {},
      c.prev ? button('Previous', { kind: 'ghost', icon: 'back', onClick: c.prev }) : h('span'),
      h('span.dv-pager-n', {}, `${c.pos.n} of ${c.pos.of}`),
      c.next ? button('Next', { kind: 'ghost', icon: 'chevron', onClick: c.next }) : h('span')) : null,
    h('div.dv-keys', {}, button('Back to the drive', { kind: 'secondary', icon: 'back', onClick: c.back })));
  stagger(body);
  return sheet([body], { eyebrow: hd.eyebrow, title: hd.title, onClose: c.back });
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
    h('section.dv-sec', {}, label('WHAT TO DO HERE'), insight({ icon: 'clock', tone: 'you', title: 'Start slowing sooner as you come up to it.', body: 'Ease off the gas early and roll toward the stop. A gentle stop wears your tires least.' })),
    h('div.dv-keys', {}, button('Done', { kind: 'secondary', onClick: c.done })));
  stagger(body);
  return sheet([body], { eyebrow: 'YOUR HARD-BRAKE SPOT', title: c.name ? cap(c.name) : 'A spot on your drives', onClose: c.done });
}

// ---------- recording ----------

export interface RecSheet {
  el: HTMLElement;
  /** seconds since the start, meters so far, and whether GPS has a fix yet */
  set(sec: number, meters: number, fix: boolean): void;
  /** the voice switch */
  voice(muted: boolean): void;
  /** "tap the screen once to turn on the voice" */
  hint(show: boolean): void;
  /** gentle stops above salmon streams so far */
  salmon(n: number): void;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function recSheet(c: { autoEnds: boolean; muted: boolean; hint: boolean; end(): void; toggleVoice(): void }): RecSheet {
  const time = h('b.dv-rec-big', {}, '0:00'), miles = h('b.dv-rec-big', {}, '0.0');
  // a switch, so it says both what it is and whether it's on
  const vk = h('button.u-btn.u-secondary.dv-voice', { type: 'button', role: 'switch', 'aria-label': 'Voice tips', onclick: () => c.toggleVoice() });
  const voice = (muted: boolean) => {
    vk.setAttribute('aria-checked', String(!muted));
    vk.replaceChildren(h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')), h('span.u-btn-label', {}, 'Voice'), h('span.dv-voice-state', { 'aria-hidden': 'true' }, muted ? 'Off' : 'On'));
  };
  voice(c.muted);
  const hint = h('p.dv-rec-hint', {}, ico('sound'), h('span', {}, 'Tap the screen once to turn on the voice.'));
  hint.hidden = !c.hint;
  const fishN = h('b', {}, '0'), fishK = h('span', {}, '');
  const fish = h('p.dv-rec-fish', { hidden: true }, h('span.dv-rec-fish-ico', { 'aria-hidden': 'true', html: salmonSVG(2) }), fishN, fishK);
  const el = h('div.dv-rec', {},
    h('div.dv-rec-top', {},
      h('span.dv-rec-dot', { 'aria-hidden': 'true' }), h('span.dv-rec-state', {}, 'REC'),
      h('img.dv-rec-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' })),
    h('div.dv-rec-nums', {},
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'TIME'), time),
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'MILES'), miles)),
    fish,
    hint,
    h('div.dv-rec-keys', {}, vk, button('End drive', { kind: 'primary', icon: 'end', onClick: c.end })),
    c.autoEnds ? h('p.u-caption.dv-rec-note', {}, REC.autoEnds) : null);
  let lastT = '', lastM = '';
  return {
    el,
    set(sec, meters, fix) {
      const t = clock(sec), m = (meters / 1609.344).toFixed(1);
      if (t !== lastT) time.textContent = lastT = t;
      if (m !== lastM) miles.textContent = lastM = m;
      el.classList.toggle('dv-nofix', !fix);
    },
    voice,
    hint(show) { hint.hidden = !show; },
    salmon(n) {
      fish.hidden = n < 1;
      fishN.textContent = String(n);
      fishK.textContent = n === 1 ? 'gentle stop above a salmon stream' : 'gentle stops above salmon streams';
    },
  };
}

export function stillSheet(c: { keep(): void; end(): void }): HTMLElement {
  return sheet([h('p.u-body', {}, 'Keep TireTrail open on screen. GPS stops when the screen locks.')], {
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
