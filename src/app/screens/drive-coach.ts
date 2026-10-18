// The coach on the Drive screens: replay lines, colors and words, cue captions, this week's money. No DOM, so tests run it.
import { weekStart } from '../../drive/challenge.ts';
import type { Cue, CueKind } from '../../drive/coach/live.ts';
import type { Replay, Stretch, StretchKind } from '../../drive/coach/replay.ts';
import type { Usd } from '../../drive/money.ts';
import { nearestOnPolyline, type LngLat, type XY } from '../../geo/geo.ts';
import { distText } from '../../drive/coach/words.ts';

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

/** What a stretch cost, estimated: { label: "Tire wear", value: "under 1¢" }, or null when it cost nothing. */
export function stretchCost(s: Pick<Stretch, 'kind' | 'usd'>): { label: string; value: string } | null {
  if (!(s.usd > 0)) return null;
  const value = s.usd < 0.005 ? 'under 1¢' : s.usd < 0.995 ? `about ${Math.round(s.usd * 100)}¢` : `about $${s.usd.toFixed(2)}`;
  return { label: s.kind === 'speeding' ? 'Extra gas' : 'Extra tire wear', value };
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

/** Why a stretch matters, in one line; '' when it doesn't. Gas only for speed, never for braking. */
export function stretchWhy(s: Pick<Stretch, 'kind' | 'topMph'>): string {
  switch (s.kind) {
    case 'hard': return 'Hard stops wear extra tread off your tires and leave more tire dust on the road.';
    case 'fast-start': return 'Speeding up fast uses more gas than pulling away gently.';
    case 'speeding': return s.topMph > 50 ? 'Above 50 mph, every 5 mph faster burns about 7% more gas.' : 'Going over the limit costs points on your score.';
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

const TONE: Record<CueKind, CueTone> = { 'spot-ahead': 'warn', coast: 'you', speeding: 'warn', 'hard-brake': 'danger', 'fast-start': 'other' };
// a tone-only cue still gets words on screen
const TONE_WORDS: Partial<Record<CueKind, [string, string]>> = {
  'hard-brake': ['Hard brake.', 'Ease off sooner next time.'],
  'fast-start': ['Fast start.', 'Press the gas more slowly.'],
};

/** The big caption for a live cue: the spoken words split in two, or short words for a tone. */
export function cueView(c: Pick<Cue, 'kind' | 'say'>): CueView {
  const words = c.say ? splitSay(c.say) : TONE_WORDS[c.kind] ?? ['', ''];
  return { head: words[0], todo: words[1], tone: TONE[c.kind], ms: c.say ? 7000 : 4000 };
}

/** "Stop ahead. Coast." -> ["Stop ahead.", "Coast."] */
export function splitSay(say: string): [string, string] {
  const head = firstSentence(say);
  return [head, say.trim().slice(head.length).trim()];
}

/** The reminder before a street whose rain reaches a salmon stream (salmon) or a creek that flows down to one, said and shown the same way. */
export function creekCue(salmon: boolean): { say: string; view: CueView } {
  const head = salmon ? 'The street ahead drains to a salmon stream.' : 'The street ahead drains to a creek.';
  return { say: `${head} Brake gently.`, view: { head, todo: 'Brake gently.', tone: 'salmon', ms: 7000 } };
}

// ---------- home ----------

/** Money lost in drives since Monday. */
export function weekUsd(sums: readonly { at: number; gas: Usd; tires: Usd }[], now = Date.now()): number {
  const from = weekStart(now);
  return sums.filter((s) => s.at >= from).reduce((t, s) => t + s.gas.typical + s.tires.typical, 0);
}

/** The link a phone opens to start recording: this page with #autostart. */
export function autostartLink(origin: string, pathname: string): string {
  return `${origin}${pathname}#autostart`;
}
