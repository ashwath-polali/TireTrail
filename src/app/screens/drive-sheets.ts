// The Drive tab's map cards: the drive report, one hard brake, a learned spot, recording, and the end of See it happen.
import type { DriveReport } from '../../drive/analyze.ts';
import type { Stretch } from '../../drive/coach/replay.ts';
import { DEFAULT_DUST_OPTIONS, gramsText, microText, VEHICLES, type Vehicle } from '../../drive/dust.ts';
import { DEFAULT_MONEY_OPTIONS, moneyNote } from '../../drive/money.ts';
import type { Spot } from '../../drive/spots.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { button, chip, glyph, insight, meter, panel, salmonSVG, score, scoreTone, sheet, stagger, stat } from '../ui/ui.ts';
import { clsArt, clsTone } from './drive-art.ts';
import { firstSentence, KIND_LABEL, oneFix, stretchFacts, stretchHead, stretchSpeed, stretchWhy } from './drive-coach.ts';
import type { BrakePin } from './drive-pins.ts';
import {
  brakeDo, brakeKind, count, dayWord, dustVerdict, endWords, gasPct, gentleLine, gentleSalmonLine, milesWord, pctVs, placeOf, rainHead, rainShort, rainWhy, REC, salmonRow,
  SHORT, shortRule, shortWhat, spotWords, stripRows, timeWord, vsTone, vsWord, type BrakeView, type RainIn,
} from './drive-words.ts';
import { vehiclePicker } from './vehicle.ts';

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
  /** the coach's checking tools (drive-log.ts): a "not recorded" line, and Details items */
  extras?: { note: HTMLElement | null; details: HTMLElement[] } | null;
  /** "What do you drive?" was picked: the report figures again */
  onVehicle?: ((v: Vehicle) => void) | null;
  /** open Details (after a redraw from the picker) */
  openDetails?: boolean;
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

/** Stretches as keys: what happened, where, and what to do. */
function workList(c: ReportIn, list: ReportIn['worst']): HTMLElement {
  return h('div.dv-work', {}, ...list.map(({ s, i }) => {
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

/** Two lines of label and value, for Details. */
const part = (k: string, v: string) => h('div.dv-part', {}, h('span', {}, k), h('i', { 'aria-hidden': 'true' }), h('b', {}, v));

/** Everything past the main things, behind one disclosure: this drive in numbers, tire life, your car, more places, how we figure, delete. */
function details(c: ReportIn, skipFirst: boolean): HTMLElement {
  const r = c.report, d = r.dust, tap = c.app.layout === 'laptop' ? 'Click' : 'Tap', o = DEFAULT_MONEY_OPTIONS;
  // the first place is already the one fix above
  const rest = skipFirst ? c.worst.slice(1) : c.worst;
  const places = rest.length ? h('section.dv-sec', {},
    label(rest.length > 1 ? `${rest.length} MORE PLACES` : 'ONE MORE PLACE'), workList(c, rest),
    h('p.u-caption', {}, `${tap} the colored route to see any part of it.`)) : null;
  const hardGas = gasPct(r.money.hardGas.typical, r.miles, o.mpg.typical, o.gasUsdPerGal), speedGas = gasPct(r.money.speedGas.typical, r.miles, o.mpg.typical, o.gasUsdPerGal);
  const nums = h('section.dv-sec.dv-d-money', {}, label('THIS DRIVE'),
    h('div.dv-parts', {},
      part('6PPDQ in the dust', `about ${microText(d.sixPpdqUg.typical)}`),
      part('Tire dust a mile', `${Math.round(d.mgPerMi)} mg`),
      part('Stops', String(r.stops.length)),
      hardGas ? part('Gas lost to hard starts and stops', `${hardGas}%`) : null,
      speedGas ? part('Gas lost to speeding', `${speedGas}%`) : null),
    h('p.u-caption', {}, `Estimates. 6PPDQ likely ${microText(d.sixPpdqUg.low)} to ${microText(d.sixPpdqUg.high)}.`));
  const life = h('section.dv-sec', {}, label('YOUR TIRES'),
    insight({ icon: 'tire', tone: d.styleFactor.typical <= 0.97 ? 'money' : d.styleFactor.typical >= 1.03 ? 'warn' : 'plain', title: `At this rate your tires last about ${milesWord(d.tireLifeMi)}`, body: `Typical: ${milesWord(d.tireLifeMi * d.styleFactor.typical)}. Your tires turn into this dust.` }));
  const car = h('section.dv-sec', {}, label('WHAT DO YOU DRIVE?'),
    c.onVehicle ? vehiclePicker((v) => c.onVehicle!(v)) : null,
    h('p.u-caption', {}, 'Heavier cars and EVs shed more tire dust.'));
  const why = h('section.dv-sec', {}, label('WHY SALMON'), h('p.dv-d-why', {}, 'A chemical from tire dust can kill coho salmon within hours of a storm.'));
  const box = h('details.dv-how.dv-details', c.openDetails ? { open: true } : {},
    h('summary', {}, ico('list'), h('span', {}, 'Details'), ico('chevron')),
    h('div.dv-details-body', {}, nums, life, car, places, ...(c.extras?.details ?? []), why, howWeFigure(r), c.remove ? confirmDelete('this drive', c.remove) : null));
  return box;
}

const STRIP_ICON = { brakes: 'stop', starts: 'flame', turns: 'route' } as const;

export function reportSheet(c: ReportIn): HTMLElement {
  const r = c.report, d = r.dust, live = !c.quiet;
  const pct = pctVs(d.mg.typical, d.typicalMg.typical), tone = vsTone(pct);
  const happy = !c.worst.length;

  // the head: grams this drive, against typical driving on the same route
  const g = d.mg.typical / 1000, max = Math.max(d.mg.typical, d.typicalMg.typical, 1);
  const vs = (k: string, mg: number, t: 'money' | 'warn' | 'plain') => h('div.dv-vs-row', {},
    h('span.dv-vs-k', {}, k), meter(mg, max, { blocks: 16, tone: t, label: k }), h('b.dv-vs-v', {}, gramsText(mg)));
  const board = h('div.dv-board.dv-board-d', { 'data-tone': tone },
    live ? drops(10) : null,
    h('div.dv-dust-top', {},
      score(g, { label: 'TIRE DUST', suffix: 'g', decimals: g < 0.995 ? 2 : g < 9.95 ? 1 : 0, tone, countUp: live }),
      h('b.dv-dust-vs', { 'data-tone': tone }, vsWord(pct))),
    h('div.dv-vs', {}, vs('You', d.mg.typical, tone === 'plain' ? 'plain' : tone), vs('Typical here', d.typicalMg.typical, 'plain')),
    live && pct <= -3 ? swimmer() : null);

  // the smoothness strip: how many of each, and their weight in the dust
  const n = { brakes: r.brakes.length, starts: r.events.filter((e) => e.kind === 'start').length, turns: d.turns.length };
  const strip = h('section.dv-strip', { 'aria-label': 'Smoothness' },
    h('div.dv-strip-head', {}, label('SMOOTHNESS'), h('span.dv-strip-cap', {}, 'share of dust')),
    ...stripRows(n, d.share).map((x) => h('div.dv-strip-row', { 'data-on': String(x.n > 0) },
      h('span.dv-strip-ico', { 'aria-hidden': 'true', html: glyph(STRIP_ICON[x.key], 2) }),
      h('span.dv-strip-k', {}, x.label),
      h('b.dv-strip-n', {}, String(x.n)),
      meter(x.pct, 100, { blocks: 10, tone: x.n ? 'warn' : 'money', label: `${x.label}, share of dust` }),
      h('span.dv-strip-p', {}, x.n ? `${x.pct}%` : '0'))));

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

  // SALMON SLOT: src/salmon exports salmonRow(report) on another branch; swap it in here at the merge
  const creekAt = c.pins.findIndex((p) => p.b.cls === 'creek' && p.drain !== null);
  const playAt = creekAt >= 0 ? creekAt : c.pins.findIndex((p) => p.drain !== null);
  const rain = playAt >= 0 ? () => c.watch(playAt) : undefined;
  const sal = salmonRow(c.pins.map((p) => p.b), c.gentleSalmon);
  const salmonIcon = sal && (creekAt >= 0 || c.gentleSalmon > 0 || !c.pins.length) ? salmonSVG(2) : 'fish';
  const salmon = sal ? h('div.dv-lines.dv-salmon', {}, line(salmonIcon, 'salmon', sal.line, sal.sub, rain)) : null;
  const more = details(c, !happy);

  // the sample leads on to where the rain goes, and on a laptop to the phone
  const laptop = c.app.layout === 'laptop';
  const keys = !c.sample ? [button('Done', { kind: 'primary', icon: 'check', onClick: c.close }), c.share]
    : rain ? [button('See where the rain goes', { kind: 'primary', icon: 'play', onClick: rain }),
      laptop ? button('Try it on your phone', { kind: 'secondary', icon: 'phone', onClick: c.close }) : button('Close the sample', { kind: 'secondary', icon: 'x', onClick: c.close })]
      : [button('Close the sample', { kind: 'primary', icon: 'x', onClick: c.close })];
  const foot = h('div.dv-foot', {},
    c.unsaved ? h('p.u-caption', {}, "This drive couldn't be saved on this device.") : null,
    h(c.sample ? 'div.dv-keys.dv-keys-stack' : 'div.dv-keys', {}, ...keys));

  const mi = r.miles.toFixed(1);
  const eyebrow = c.sample ? `SAMPLE · ${mi} MI` : `${dayWord(c.at).toUpperCase()}, ${timeWord(c.at).toUpperCase()} · ${mi} MI`;
  const body = h('div.dv-report', {}, board, strip, salmon, fix, c.extras?.note ?? null, more, foot);
  if (live) stagger(body);
  const el = sheet([body], { eyebrow, title: dustVerdict(pct), onClose: c.close });
  if (c.openDetails) requestAnimationFrame(() => more.querySelector('.dv-car')?.scrollIntoView({ block: 'center' }));
  return el;
}

/** "How we figure this": the rules, the sources and the ranges, closed until asked. */
function howWeFigure(r: DriveReport): HTMLElement {
  const m = r.money, d = r.dust, o = DEFAULT_DUST_OPTIONS, li = (t: string) => h('li', {}, t);
  const rows = [
    `Tire dust is the tread your tires wear off. Estimate: ${gramsText(d.mg.typical)}, likely ${gramsText(d.mg.low)} to ${gramsText(d.mg.high)}.`,
    'Wear grows with the square of the force on your tires, braking, speeding up and turning (Pohrt, 2019).',
    'Typical driving wears about 68 mg a km for each tonne of car (Giechaskiel and others, 2024, about 300 road tests). We scale it by the forces of the UN tire wear test route (UN R117, 2025).',
    '"Typical here" is the same route and turns, driven like that test route.',
    `Heavier cars shed more, in step with weight. EVs shed about 15% more (California Air Resources Board, 2025). Yours: ${VEHICLES[d.vehicle].label.toLowerCase()}.`,
    'A hard brake or fast start is speed changing 7 mph or more in one second, the way insurance driving apps count it. A sharp turn pushes sideways at 0.4 g or more, our cutoff.',
    `6PPDQ: tire tread holds about ${o.sixPpdqUgPerG.typical} µg per gram, ${o.sixPpdqUgPerG.low} to ${o.sixPpdqUgPerG.high} (UW Tacoma for WA Ecology, 2024).`,
    `A tire can lose about 1 to 1.5 kg of tread before it's worn out (European Environment Agency). A set lasts about ${(o.treadLifeMi / 1000).toFixed(0)},000 miles (NHTSA).`,
    'Hard starts and stops waste gas: about 10 to 40% in stop-and-go traffic and 15 to 30% on highways (fueleconomy.gov, from Oak Ridge National Laboratory tests, 2017).',
    r.limitsChecked
      ? 'Speeding is checked against posted limits on big roads, from OpenStreetMap. Above 50 mph, each 5 mph faster lowers gas mileage about 7% (fueleconomy.gov).'
      : "Posted speed limits didn't load, so speeding wasn't checked on this drive.",
    m.hardShare >= 0.005 ? `About ${Math.round(m.hardShare * 100)}% of this drive's gas went to hard starts and stops.` : null,
    moneyNote(),
    "Parking lot turns aren't counted. Speeds and turns come from your phone, so they're estimates too.",
    'Drives under half a mile or 2 minutes get no report.',
    'Tire dust carries 6PPDQ, which forms from a chemical added to tires. In studies it killed coho salmon within hours (Tian and others, Science, 2021).',
    'Where rain goes comes from city and county storm pipe maps. Where a map has a gap, TireTrail says so instead of guessing.',
    ...r.warnings,
  ];
  return h('details.dv-how.dv-how-in', {},
    h('summary', {}, ico('info'), h('span', {}, 'How we figure this'), ico('chevron')),
    h('ul', {}, ...rows.filter((t): t is string => !!t).map(li)));
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
      stat('Time', s.seconds < 90 ? `${Math.max(1, Math.round(s.seconds))} sec` : `${Math.round(s.seconds / 60)} min`)),
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
  /** the voice switch: off when muted, or while the phone won't let it speak yet */
  voice(muted: boolean, locked?: boolean): void;
  /** the big "tap to turn on the voice" key: only while parked, before the drive starts moving */
  ask(show: boolean): void;
  /** gentle stops whose rain drains to a salmon stream, so far */
  salmon(n: number): void;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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
  const fishN = h('b', {}, '0'), fishK = h('span', {}, '');
  const fish = h('p.dv-rec-fish', { hidden: true }, h('span.dv-rec-fish-ico', { 'aria-hidden': 'true', html: salmonSVG(2) }), fishN, fishK);
  const el = h('div.dv-rec', {},
    h('div.dv-rec-top', {},
      h('span.dv-rec-dot', { 'aria-hidden': 'true' }), h('span.dv-rec-state', {}, 'REC'),
      h('img.dv-rec-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' })),
    ask,
    h('div.dv-rec-nums', {},
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'TIME'), time),
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'MILES'), miles)),
    fish,
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
    ask(show) { if (ask.hidden === show) ask.hidden = !show; },
    salmon(n) {
      fish.hidden = n < 1;
      fishN.textContent = String(n);
      fishK.textContent = gentleSalmonLine(n).replace(/^\d+ /, '');
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
