// The Drive tab's map cards: the drive report, one hard brake, a learned spot, recording, and the end of See it happen.
import type { DriveReport } from '../../drive/analyze.ts';
import { moneyNote, moneyText, rangeText } from '../../drive/money.ts';
import { PART_LABEL } from '../../drive/score.ts';
import type { Spot } from '../../drive/spots.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { button, chip, glyph, insight, meter, score, scoreTone, sheet, stagger, stat, timeline, type Tone } from '../ui/ui.ts';
import { clsArt, clsTone } from './drive-art.ts';
import { spotAt, type BrakePin } from './drive-pins.ts';
import {
  brakeDo, brakeKind, brakeWhat, count, dayWord, dustSummary, endWords, fixWords, gentleLine, moneyParts, moneySentence, placeOf,
  rainHead, rainShort, rainWhy, REC, scoreWord, spotWords, timeWord, yearFigure, type BrakeView, type RainIn,
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
  openStop(i: number): void;
  /** a stretch over the speed limit, by its index in report.speeding.stretches */
  openSpeed(i: number): void;
  watch(i: number): void;
  close(): void;
  remove: (() => void) | null;
}

/** The hardest hard brake: the most mph lost in one second. */
const hardestOf = (pins: BrakePin[]) => pins.reduce((best, p, i) => (best < 0 || p.b.mphPerS > pins[best].b.mphPerS ? i : best), -1);

export function reportSheet(c: ReportIn): HTMLElement {
  const r = c.report, s = r.score.score, tone = scoreTone(s), n = c.pins.length, live = !c.quiet;
  const mi = r.miles, min = Math.max(1, Math.round(r.durationS / 60));
  const year = yearFigure(r.money);

  // the scoreboard: score and what smoother driving would save in a year
  const right = year !== null && year >= 5
    ? score(year, { label: 'COULD SAVE', prefix: '$', caption: 'a year, estimated', tone: 'money', countUp: live })
    : score(n, { label: n === 1 ? 'HARD BRAKE' : 'HARD BRAKES', caption: 'this drive', tone: n ? 'warn' : 'money', countUp: live });
  // what cost points, like a game's tally
  const lost = (['brakes', 'starts', 'speed'] as const).map((k) => r.score.parts[k]).filter((p) => p.lost > 0);
  const board = h('div.dv-board', { 'data-tone': tone },
    live ? drops() : null,
    h('div.dv-board-cells', {}, score(s, { label: 'SMOOTH SCORE', caption: 'out of 100', tone, countUp: live }), right),
    meter(s, 100, { blocks: 20, tone }),
    h('div.dv-lost-pts', { 'aria-label': 'Points lost' }, ...(lost.length ? lost.map((p) => chip(`-${p.lost} ${PART_LABEL[p.key].toLowerCase()}`, 'warn')) : [chip('No points lost', 'money')])),
    live && s >= 80 ? swimmer() : null);

  const events = n + (r.speeding.overMi > 0.05 ? 1 : 0);
  const parts = moneyParts(r.money);
  const money = h('div.dv-money', {},
    h('p.dv-money-line', {}, moneySentence(r.money, events)),
    parts.length ? h('div.dv-parts', {}, ...parts.map(([k, v]) => h('div.dv-part', {}, h('span', {}, k), h('i', { 'aria-hidden': 'true' }), h('b', {}, v)))) : null);

  // the one thing to fix, at a real place
  const hi = hardestOf(c.pins), hp = hi >= 0 ? c.pins[hi] : null;
  const fixKey = r.score.fix?.key ?? null;
  const worst = [...r.speeding.stretches].sort((a, b) => b.gasSteps - a.gasSteps || b.miles - a.miles)[0];
  const gasOf = (steps: number) => (r.speeding.gasSteps > 0 ? (r.money.gas.typical * steps) / r.speeding.gasSteps : 0);
  const remind = c.sample ? 'sample' : hp && spotAt(c.spots, hp.lngLat, hp.heading) ? 'spot' : 'again';
  const fw = fixWords({
    key: fixKey,
    hardest: hp?.b ?? null,
    fastStarts: r.events.filter((e) => e.kind === 'start').length,
    over: worst ? { road: worst.road, limitMph: worst.limitMph, topMph: worst.topMph, gas: gasOf(worst.gasSteps) } : null,
    remind,
  });
  const fixIcon = fixKey === 'brakes' ? 'stop' : fixKey === 'speed' ? 'gauge' : fixKey === 'starts' ? 'flame' : 'check';
  const fix = insight({
    icon: fixIcon, tone: fixKey ? 'warn' : 'money', title: fw.title, body: fw.body,
    action: fixKey === 'brakes' && hi >= 0 ? { label: 'Show me on the map', onClick: () => c.openStop(hi) } : undefined,
  });

  // the drive in order: start, each hard brake and speeding stretch, the end
  type Ev = { t: number; item: Parameters<typeof timeline>[0][number] };
  const evs: Ev[] = c.pins.map((p, i) => ({
    t: r.brakes[i]?.t ?? 0,
    item: { tone: clsTone(p.b.cls), title: `${p.b.n}. ${brakeKind(p.b)} at ${placeOf(p.b)}`, sub: `${brakeWhat(p.b)} ${rainShort(p.b)}`, onClick: () => c.openStop(i) },
  }));
  r.speeding.stretches.forEach((st, si) => {
    const g = gasOf(st.gasSteps);
    evs.push({ t: st.from, item: { onClick: () => c.openSpeed(si), tone: 'warn', title: `${Math.round(st.topMph)} mph in a ${st.limitMph}${st.road ? ` on ${st.road}` : ''}`, sub: `${st.miles < 0.1 ? 'A short stretch' : `${st.miles.toFixed(1)} mi`} over the limit.${g >= 0.005 ? ` About ${Math.round(g * 100)}¢ of gas.` : ''}` } });
  });
  evs.sort((a, b) => a.t - b.t);
  const shown = evs.slice(0, 12);
  const items = [
    { tone: 'plain' as Tone, title: c.sample ? 'Start' : `Start, ${timeWord(c.at)}` },
    ...shown.map((e) => e.item),
    { tone: 'you' as Tone, title: `End: ${mi.toFixed(1)} mi in ${min} min`, sub: n ? undefined : 'No hard brakes on the way.' },
  ];
  const order = h('section.dv-sec', {}, label('YOUR DRIVE, IN ORDER'), timeline(items),
    evs.length > shown.length ? h('p.u-caption', {}, `And ${count(evs.length - shown.length, 'more')} on the map.`) : null);

  // where the dust goes, why it matters, and the story
  const rains: (RainIn & { stopped: boolean })[] = c.pins.map((p) => p.b);
  const creekAt = c.pins.findIndex((p) => p.b.cls === 'creek' && p.drain !== null);
  const playAt = creekAt >= 0 ? creekAt : c.pins.findIndex((p) => p.drain !== null);
  const lead = creekAt >= 0 ? c.pins[creekAt].b : c.pins.find((p) => p.b.cls === 'ground')?.b ?? c.pins[0]?.b ?? null;
  const dust = h('section.dv-sec', {}, label('WHERE YOUR TIRE DUST GOES'),
    insight({
      icon: lead ? clsArt(lead.cls, lead.code) : 'leaf', tone: lead ? clsTone(lead.cls) : 'money',
      title: dustSummary(rains),
      body: lead ? `Why it matters: ${rainWhy(lead).charAt(0).toLowerCase()}${rainWhy(lead).slice(1)}` : undefined,
      action: playAt >= 0 ? { label: 'See it happen', onClick: () => c.watch(playAt) } : undefined,
    }));

  const how = howWeFigure(r);
  const foot = h('div.dv-foot', {},
    c.unsaved ? h('p.u-caption', {}, "This drive couldn't be saved on this device.") : null,
    c.remove ? confirmDelete('this drive', c.remove) : button('Close the sample', { kind: 'secondary', icon: 'x', onClick: c.close, wide: true }));

  const eyebrow = c.sample ? `SAMPLE DRIVE · ${mi.toFixed(1)} MI` : `${dayWord(c.at).toUpperCase()}, ${timeWord(c.at).toUpperCase()} · ${mi.toFixed(1)} MI`;
  const body = h('div.dv-report', {}, board, money, fix, order, dust, how, foot);
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
    `Gas this drive: ${rangeText(m.gas, 'drive')}. Tire wear from hard stops: ${rangeText(m.tires, 'drive')}.`,
    m.year ? `A year of driving like this: ${rangeText(m.year.total, 'year')}.` : 'A yearly figure needs a drive of 2 miles or more.',
    'Hard stops wear more tread than easing to a stop over the same stretch, because wear grows with braking force (Pohrt, 2019). A gentle stop slows about 3 mph each second.',
    moneyNote(),
    "Turning isn't measured. Speeds come from your phone's GPS, so they're estimates too.",
    'Tire dust carries 6PPD-quinone, which forms from a chemical added to tires. In studies it killed coho salmon within hours (Tian and others, Science, 2021).',
    'Where rain goes comes from city and county storm pipe maps. Where a map has a gap, TireTrail says so instead of guessing.',
    ...r.warnings,
  ];
  return h('details.dv-how', {},
    h('summary', {}, ico('info'), h('span', {}, 'How we figure this'), ico('chevron')),
    h('ul', {}, ...rows.map(li)));
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
  const remind = c.sample ? 'On your own drives, TireTrail learns places like this and chimes before you get there.'
    : c.spot ? "TireTrail will chime before you get here next time."
      : 'Brake hard here again and TireTrail will chime before you get here next time.';
  const gentle = gentleLine(b);
  const body = h('div.dv-stop', {},
    h('div.u-grid3.dv-facts', {}, ...facts),
    h('p.dv-what', {}, `You slowed ${Math.round(b.mphPerS)} mph in one second. Slowing 7 mph or more in one second counts as a hard brake.`),
    h('section.dv-sec', {}, label('WHY IT MATTERS'),
      insight({ icon: clsArt(b.cls, b.code), tone: clsTone(b.cls), title: rainHead(b), body: `${rainWhy(b)} Hard stops also wear extra tread off your tires, which costs you money.` })),
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

// ---------- a stretch over the speed limit ----------

export interface SpeedIn {
  limitMph: number;
  topMph: number;
  miles: number;
  road: string;
  /** dollars of gas this stretch cost, typical */
  gas: number;
  back(): void;
}

export function speedSheet(c: SpeedIn): HTMLElement {
  const top = Math.round(c.topMph), priced = c.gas >= 0.005 || top > 50;
  const body = h('div.dv-stop', {},
    h('div.u-grid3.dv-facts', {},
      stat('Speed limit', `${c.limitMph} mph`),
      stat('Your speed', `${top} mph`, { tone: 'warn' }),
      stat('Over for', c.miles < 0.1 ? 'Under 0.1 mi' : `${c.miles.toFixed(1)} mi`)),
    h('section.dv-sec', {}, label('WHY IT MATTERS'),
      insight({
        icon: 'gas', tone: 'money',
        title: priced ? 'Above 50 mph, every 5 mph faster burns about 7% more gas.' : 'Going over the limit costs points on your score.',
        body: priced ? `This stretch cost ${moneyText(c.gas, 'drive')} of gas.` : 'TireTrail only puts a gas price on speed above 50 mph, so this stretch adds nothing to your money total.',
      })),
    h('section.dv-sec', {}, label('WHAT TO DO HERE'),
      insight({ icon: 'gauge', tone: 'you', title: `Keep to ${c.limitMph} mph here.`, body: 'Ease off the gas when you pass the speed limit sign.' })),
    h('div.dv-keys', {}, button('Back to the drive', { kind: 'secondary', icon: 'back', onClick: c.back })));
  stagger(body);
  return sheet([body], { eyebrow: 'OVER THE SPEED LIMIT', title: `${top} mph in a ${c.limitMph}${c.road ? ` on ${c.road}` : ''}`, onClose: c.back });
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
  warn(kind: 'spot' | 'creek', head: string, todo: string, name: string): void;
  calm(): void;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function recSheet(c: { autoStarted: boolean; end(): void; center(): void }): RecSheet {
  const time = h('b.dv-rec-big', {}, '0:00'), miles = h('b.dv-rec-big', {}, '0.0');
  const state = h('span.dv-rec-state', {}, 'REC');
  const warnBox = h('div.dv-rec-warn', { role: 'alert', hidden: true });
  const el = h('div.dv-rec', {},
    h('div.dv-rec-top', {},
      h('span.dv-rec-dot', { 'aria-hidden': 'true' }), state,
      h('img.dv-rec-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' })),
    h('div.dv-rec-nums', {},
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'TIME'), time),
      h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'MILES'), miles)),
    warnBox,
    button('End drive', { kind: 'primary', icon: 'end', wide: true, onClick: c.end }),
    c.autoStarted ? h('p.u-caption.dv-rec-note', {}, REC.autoEnds) : null);
  let lastT = '', lastM = '';
  return {
    el,
    set(sec, meters, fix) {
      const t = clock(sec), m = (meters / 1609.344).toFixed(1);
      if (t !== lastT) time.textContent = lastT = t;
      if (m !== lastM) miles.textContent = lastM = m;
      el.classList.toggle('dv-nofix', !fix);
    },
    warn(kind, head, todo, name) {
      warnBox.replaceChildren(
        h('span.dv-rec-warn-ico', { 'aria-hidden': 'true', html: glyph(kind === 'spot' ? 'bell' : 'fish', 3) }),
        h('span.dv-rec-warn-text', {}, h('b', {}, head), h('span', {}, todo), name ? h('small', {}, name) : null));
      warnBox.dataset.kind = kind;
      warnBox.hidden = false;
      el.classList.add('dv-warning');
    },
    calm() {
      warnBox.hidden = true;
      el.classList.remove('dv-warning');
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
