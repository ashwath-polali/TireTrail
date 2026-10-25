// The coach on the Drive screens: replay lines, colors and words, cue captions and the start-by-itself link. No DOM, so tests run it.
import type { Cue, CueKind } from '../../drive/coach/live.ts';
import type { Replay, Stretch, StretchKind } from '../../drive/coach/replay.ts';
import { nearestOnPolyline, type LngLat, type XY } from '../../geo/geo.ts';
import { distText } from '../../drive/coach/words.ts';
import { SALMON } from '../../salmon/watch.ts';

/** the design token each kind is drawn in */
export const KIND_TOKEN: Record<StretchKind, string> = { smooth: '--money', firm: '--you', hard: '--danger', 'fast-start': '--other', speeding: '--warn' };
/** the same colors, for when the tokens can't be read */
export const KIND_COLOR: Record<StretchKind, string> = { smooth: '#8fe38a', firm: '#ffd166', hard: '#ff7a66', 'fast-start': '#b6aaff', speeding: '#ffb547' };
/** the key's words */
export const KIND_LABEL: Record<StretchKind, string> = { smooth: 'Smooth', firm: 'Firm braking', hard: 'Hard brake', 'fast-start': 'Fast start', speeding: 'Over the limit' };
/** calm first, for the key */
const KEY_ORDER: StretchKind[] = ['smooth', 'firm', 'hard', 'fast-start', 'speeding'];
/** drawn in this order, so short events sit on top of smooth road */
const DRAW_ORDER: StretchKind[] = ['smooth', 'firm', 'speeding', 'fast-start', 'hard'];

export interface StretchLine {
  /** index in replay.stretches */
  i: number;
  kind: StretchKind;
  path: XY[];
}

/** Each stretch as a line, joined to the one before unless GPS paused there, short events drawn last. */
export function stretchLines(r: Replay, toWorld: (p: LngLat) => XY): StretchLine[] {
  const breaks = new Set(r.breaks);
  return r.stretches
    .map((s, i) => {
      const from = s.from > 0 && !breaks.has(s.from) ? s.from - 1 : s.from;
      return { i, kind: s.kind, path: r.points.slice(from, s.to + 1).map(toWorld) };
    })
    .sort((a, b) => DRAW_ORDER.indexOf(a.kind) - DRAW_ORDER.indexOf(b.kind) || a.i - b.i);
}

/** The kinds this drive has, calm first, for the map's key. */
export function keyKinds(r: Pick<Replay, 'stretches'>): StretchKind[] {
  const has = new Set(r.stretches.map((s) => s.kind));
  return KEY_ORDER.filter((k) => has.has(k));
}

/** The stretch under a tap: the nearest event within evPx CSS px, else the nearest smooth stretch within px, else -1. */
export function stretchAt(lines: readonly StretchLine[], p: XY, mpp: number, cssPerPx = 3, evPx = 18, px = 12): number {
  let ev = -1, evD = Infinity, sm = -1, smD = Infinity;
  for (const l of lines) {
    if (!l.path.length) continue;
    const d = (nearestOnPolyline(p, l.path).d / mpp) * cssPerPx;
    if (l.kind === 'smooth') { if (d < smD) [sm, smD] = [l.i, d]; }
    else if (d < evD) [ev, evD] = [l.i, d];
  }
  return evD <= evPx ? ev : smD <= px ? sm : -1;
}

/** The middle of a stretch, as lon/lat. */
export function stretchMid(r: Pick<Replay, 'points'>, s: Pick<Stretch, 'from' | 'to'>): LngLat {
  return r.points[(s.from + s.to) >> 1] ?? r.points[0];
}

/** The first sentence: "Start slowing about 3 seconds sooner here." */
export function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return m ? m[1] : s.trim();
}

/** The report's one fix for a stretch: what to do, in a few words, and where. */
export function oneFix(s: Pick<Stretch, 'kind' | 'todo' | 'road' | 'limitMph'>): { title: string; where: string } {
  let title: string;
  switch (s.kind) {
    case 'speeding': title = s.limitMph ? `Keep to ${s.limitMph} mph` : 'Keep to the speed limit'; break;
    case 'fast-start': title = 'Press the gas more slowly'; break;
    case 'firm': title = 'Lift off the gas a little sooner'; break;
    case 'smooth': title = 'Nothing to change'; break;
    default: title = firstSentence(s.todo).replace(/( here)?\.$/, '');
  }
  return { title, where: s.road };
}

/** The speed part of a stretch: "30 to 0 mph", "55 in a 45", "up to 42 mph". */
export function stretchSpeed(s: Pick<Stretch, 'kind' | 'fromMph' | 'toMph' | 'topMph' | 'limitMph'>): string {
  const r = Math.round;
  if (s.kind === 'speeding' && s.limitMph) return `${r(s.topMph)} in a ${s.limitMph}`;
  if (s.kind === 'smooth') return `Up to ${r(s.topMph)} mph`;
  return `${r(s.fromMph)} to ${r(s.toMph)} mph`;
}

/** Two short facts for a stretch's card, [label, value], short enough for a third of a phone. */
export function stretchFacts(s: Pick<Stretch, 'kind' | 'fromMph' | 'toMph' | 'topMph' | 'limitMph' | 'miles'>): [string, string][] {
  const r = Math.round, far = distText(s.miles);
  switch (s.kind) {
    case 'speeding': return [['Speed limit', `${s.limitMph ?? '?'} mph`], ['Your speed', `${r(s.topMph)} mph`]];
    case 'fast-start': return [['Sped up to', `${r(s.toMph)} mph`], ['Distance', far]];
    case 'smooth': return [['Top speed', `${r(s.topMph)} mph`], ['Distance', far]];
    default: return [['Braked from', `${r(s.fromMph)} mph`], ['Distance', far]];
  }
}

/** Why a stretch matters, in one line; '' when it doesn't. Gas for hard starts and stops (fueleconomy.gov) and speed above 50 mph, never for firm braking. */
export function stretchWhy(s: Pick<Stretch, 'kind' | 'topMph'>): string {
  switch (s.kind) {
    case 'hard': return 'Hard brakes waste gas and leave extra tire dust on the road.';
    case 'fast-start': return 'Speeding up fast uses more gas than pulling away gently.';
    case 'speeding': return s.topMph > 50 ? 'Above 50 mph, every 5 mph faster burns about 7% more gas.' : 'Going faster puts more force on your tires, so more tire dust.';
    default: return '';
  }
}

/** The card's eyebrow and heading for a stretch: "HARD BRAKE", "On SR 410". */
export function stretchHead(s: Pick<Stretch, 'kind' | 'road'>): { eyebrow: string; title: string } {
  return { eyebrow: KIND_LABEL[s.kind].toUpperCase(), title: s.road ? `On ${s.road}` : 'On your drive' };
}

// ---------- live cues ----------

export type CueTone = 'warn' | 'you' | 'danger' | 'other' | 'salmon';

export interface CueView {
  head: string;
  todo: string;
  tone: CueTone;
  /** how long the big caption stays, ms */
  ms: number;
}

const TONE: Record<CueKind, CueTone> = { 'spot-ahead': 'warn', coast: 'you', speeding: 'warn', 'hard-brake': 'danger', 'fast-start': 'other', 'salmon-ahead': 'salmon' };
// what happened gets what to do next time, on screen only
const EVENT_TODO: Partial<Record<CueKind, string>> = { 'hard-brake': 'Ease off sooner next time.', 'fast-start': 'Press the gas more slowly.' };

/** The big caption for a live cue: the spoken words split in two; an event line gets what to do next time. */
export function cueView(c: Pick<Cue, 'kind' | 'say'>): CueView {
  const todo = EVENT_TODO[c.kind];
  if (todo) return { head: c.say || (c.kind === 'hard-brake' ? 'Hard brake.' : 'Fast start.'), todo, tone: TONE[c.kind], ms: 5000 };
  const words = splitSay(c.say);
  return { head: words[0], todo: words[1], tone: TONE[c.kind], ms: 7000 };
}

/** "Stop ahead. Coast." -> ["Stop ahead.", "Coast."] */
export function splitSay(say: string): [string, string] {
  const head = firstSentence(say);
  return [head, say.trim().slice(head.length).trim()];
}

/** The reminder before a street whose rain reaches a salmon stream (salmon) or a creek that flows down to one, said and shown the same way. */
export function creekCue(salmon: boolean): { say: string; view: CueView; line: RoadLine } {
  const head = salmon ? 'The street ahead drains to a salmon stream.' : 'The street ahead drains to a creek.';
  const line: RoadLine = { text: salmon ? 'This street drains to a salmon stream.' : 'This street drains to a creek.', tone: 'salmon' };
  return { say: `${head} Brake gently.`, view: { head, todo: 'Brake gently.', tone: 'salmon', ms: 7000 }, line };
}

// ---------- the live drive: the banner over the map and the creek chip ----------

export type LineTone = 'plain' | 'salmon' | 'money' | 'danger' | 'warn' | 'you' | 'other';
export interface RoadLine { text: string; tone: LineTone }

/** a creek turns salmon this close, m (500 ft) */
export const NEAR_M = 152.4;
/** a learned spot shows this close, m */
export const SPOT_SHOW_M = 300;
/** a spoken line stays in the banner at least this long, ms */
export const SPOKEN_MS = 6000;

/** How long a cue holds the banner: its own time, and never under 6 s once it was spoken. */
export function holdMs(ms: number, spoken: boolean): number {
  return spoken ? Math.max(SPOKEN_MS, ms) : ms;
}
/** "0.4 mi", "500 ft" */
export function roadDist(m: number): string {
  const mi = m / 1609.344;
  if (mi >= 0.1) return `${mi < 10 ? Math.round(mi * 10) / 10 : Math.round(mi)} mi`;
  return `${Math.max(50, Math.round(m * 3.28084 / 50) * 50)} ft`;
}

/** once up, the salmon line stays until the creek is farther than this, m (about 600 ft), so a distance near 500 ft can't flicker */
export const NEAR_OFF_M = 185;

/**
 * The banner when no cue holds it: a learned spot, a salmon creek close, else the status. A creek further off is the chip's.
 * held: the salmon line is already up for this same creek.
 */
export function roadLine(s: { fish?: { m: number } | null; spot?: { m: number } | null; status: string }, held = false): RoadLine {
  if (s.spot && s.spot.m <= SPOT_SHOW_M) return { text: 'Your hard-brake spot. Ease off early.', tone: 'warn' };
  if (s.fish && s.fish.m <= (held ? NEAR_OFF_M : NEAR_M)) return { text: 'Easy on the brakes.', tone: 'salmon' };
  return { text: s.status, tone: 'plain' };
}

/** past a creek: within 150 m of a hard brake, gentle once the car is this far past with none, else still to tell */
export const CLEAR_M = SALMON.brakeM + 40;
export function crossState(at: XY, brakes: readonly XY[], here: XY | undefined): 'gentle' | 'hard' | 'wait' {
  if (brakes.some((b) => Math.hypot(b[0] - at[0], b[1] - at[1]) <= SALMON.brakeM)) return 'hard';
  return here && Math.hypot(here[0] - at[0], here[1] - at[1]) > CLEAR_M ? 'gentle' : 'wait';
}

// ---------- the link ----------

/** The link a phone opens to start recording: this page with #autostart. */
export function autostartLink(origin: string, pathname: string): string {
  return `${origin}${pathname}#autostart`;
}
