// My drives, the week road: the week's score and verdict, where its points went, passes by the spot, cents a drive,
// and one sign a drive (or a day when the week is full). No DOM, so tests run it.
import { brakedAt, passes } from '../../drive/challenge.ts';
import { gasPrice, roundCents, shareOf, type GasDrive } from '../../drive/gas.ts';
import { DEFAULT_MONEY_OPTIONS, type GasPrice } from '../../drive/money.ts';
import type { ScoreKey } from '../../drive/score.ts';
import type { Spot } from '../../drive/spots.ts';
import { pathPoints, type BrakePoint } from '../../drive/summary.ts';

/** this many points up or down is a real change, week to week */
export const WEEK_CHANGE = 3;
/** blocks in the points bar, 4 points each */
export const BLOCKS = 25;
/** drives one sign each up to this many in a week; more and each day gets one sign */
export const MAX_SIGNS = { phone: 7, laptop: 10 } as const;

export type Lost = Record<ScoreKey, number>;
const KEYS = ['brakes', 'starts', 'speed'] as const;

/** The week's smooth score: the mean of its drives', whole. Null with none. */
export function weekScore(drives: readonly { score: number }[]): number | null {
  if (!drives.length) return null;
  return Math.round(drives.reduce((t, d) => t + d.score, 0) / drives.length);
}

export type Verdict = 'up' | 'same' | 'down' | 'first' | 'none';

/** Smoother, about the same or rougher than the week before; 'first' with no week before, 'none' with no drives. */
export function weekVerdict(score: number | null, last: number | null): Verdict {
  if (score == null) return 'none';
  if (last == null) return 'first';
  return score - last >= WEEK_CHANGE ? 'up' : last - score >= WEEK_CHANGE ? 'down' : 'same';
}

/** Whole numbers that add up to exactly total: floors, then the biggest leftovers get one each. */
function split<K extends string>(raw: Record<K, number>, total: number, keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = Math.max(0, Math.floor(raw[k]));
  let left = total - keys.reduce((t, k) => t + out[k], 0);
  for (const k of [...keys].sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]))) {
    if (left <= 0) break;
    out[k]++;
    left--;
  }
  return out;
}

/** The points the week lost to each part: the mean of its drives', whole, adding up to 100 minus the week's score. */
export function weekLost(drives: readonly { score: number; lost?: Partial<Lost> }[]): Lost | null {
  const s = weekScore(drives);
  if (s == null) return null;
  const n = drives.length, raw = { brakes: 0, starts: 0, speed: 0 };
  for (const d of drives) for (const k of KEYS) raw[k] += (d.lost?.[k] ?? 0) / n;
  const total = KEYS.reduce((t, k) => t + raw[k], 0);
  // the means can drift a little from 100 minus the rounded score: scale to it
  const want = 100 - s, f = total > 0 ? want / total : 0;
  if (!total) return { brakes: 0, starts: 0, speed: 0 };
  return split({ brakes: raw.brakes * f, starts: raw.starts * f, speed: raw.speed * f }, want, KEYS);
}

/** The points bar: how many of n blocks the kept points and each part fill, adding up to n. */
export function blocks(score: number, lost: Lost, n = BLOCKS): { kept: number } & Lost {
  const per = 100 / n;
  return split({ kept: score / per, brakes: lost.brakes / per, starts: lost.starts / per, speed: lost.speed / per }, n, ['kept', ...KEYS] as const);
}

/** The part that cost the most points, or null when none cost any. */
export function biggest(lost: Lost | null): ScoreKey | null {
  if (!lost) return null;
  const k = KEYS.reduce((a, b) => (lost[b] > lost[a] ? b : a));
  return lost[k] > 0 ? k : null;
}

// ---------- the spot ----------

export type Pass = 'hard' | 'calm';

/** The last n passes by the spot, newest first: a hard brake there, or a drive past it (from tracks on this phone). */
export function spotPasses(spot: Spot, drives: readonly { at: number; brakes: readonly BrakePoint[]; path?: number[] }[], n = 5): Pass[] {
  const out: Pass[] = [];
  for (const d of [...drives].sort((a, b) => b.at - a.at)) {
    if (out.length >= n) break;
    if (brakedAt(spot, d.brakes)) out.push('hard');
    else if (d.path && passes(spot, pathPoints(d.path))) out.push('calm');
  }
  return out;
}

/** Calm passes in a row, newest back; -1 when the newest was a hard brake, 0 with none. */
export function calmRun(ps: readonly Pass[]): number {
  if (ps[0] === 'hard') return -1;
  let k = 0;
  while (k < ps.length && ps[k] === 'calm') k++;
  return k;
}

/** This week's hard brakes at the spot. */
export const brakesHere = (spot: Spot, drives: readonly { brakes: readonly BrakePoint[] }[]): number =>
  drives.reduce((t, d) => t + d.brakes.filter((b) => brakedAt(spot, [b])).length, 0);

/** A spot's saved place, "Pacific Ave S at 138th St S", as its street and the cross street it is at ('' when only near one). */
export function spotParts(name: string): { street: string; cross: string } {
  const m = /^(.+?) (at|near) (.+)$/.exec(name);
  return m ? { street: m[1], cross: m[2] === 'at' ? m[3] : '' } : { street: name, cross: '' };
}

/** The cross street: the nearest street with another name within maxM, else ''. */
export function crossPick(name: string, near: readonly { name: string; d: number }[], maxM = 40): string {
  let best = '', bd = maxM;
  for (const c of near) if (c.name && c.name !== name && c.d <= bd) [best, bd] = [c.name, c.d];
  return best;
}

// ---------- gas ----------

/** A drive's extra cents a gallon, unrounded. Null for EVs, under 2 miles or without a price. */
export function centsRaw(d: GasDrive, p: GasPrice | null = gasPrice()): number | null {
  if (d.car === 'ev' || !(d.mi >= DEFAULT_MONEY_OPTIONS.minMilesForYear) || !p) return null;
  const s = shareOf(d);
  return s ? 100 * s.typical * p.usdPerGal : null;
}

/** A drive's extra cents a gallon as shown (nearest 5¢). */
export function centsOf(d: GasDrive, p: GasPrice | null = gasPrice()): number | null {
  const c = centsRaw(d, p);
  return c == null ? null : roundCents(c);
}

/** Why a week has no gas line: every drive electric, or under 2 gas miles. Null when it can have one. */
export function gasWhyNot(drives: readonly { mi: number; car?: string }[]): 'ev' | 'short' | null {
  if (drives.length && drives.every((d) => d.car === 'ev')) return 'ev';
  const mi = drives.filter((d) => d.car !== 'ev').reduce((t, d) => t + d.mi, 0);
  return mi >= DEFAULT_MONEY_OPTIONS.minMilesForYear ? null : 'short';
}

// ---------- the signs ----------

export interface SignIn {
  at: number;
  mi: number;
  score: number;
  hardBrakes: number;
  fastStarts?: number;
  /** extra cents a gallon, unrounded; null for none */
  cents: number | null;
  /** salmon creek crossings, null while not known */
  crossed: number | null;
  gentle: number;
}

export interface Sign {
  /** its drives, oldest first */
  ats: number[];
  /** 0 Monday to 6 Sunday */
  day: number;
  mi: number;
  score: number;
  hardBrakes: number;
  /** rounded as shown; null when none of its drives has a figure */
  cents: number | null;
  crossed: number | null;
  gentle: number;
}

/** Monday 0 to Sunday 6 */
export const dayOf = (t: number): number => (new Date(t).getDay() + 6) % 7;
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function signOf(ds: readonly SignIn[]): Sign {
  const n = ds.length, mi = ds.reduce((t, d) => t + d.mi, 0);
  const gas = ds.filter((d) => d.cents != null), gasMi = gas.reduce((t, d) => t + d.mi, 0);
  const known = ds.every((d) => d.crossed != null);
  return {
    ats: ds.map((d) => d.at), day: dayOf(ds[0].at), mi,
    score: Math.round(ds.reduce((t, d) => t + d.score, 0) / n),
    hardBrakes: ds.reduce((t, d) => t + d.hardBrakes, 0),
    // a day's cents: each drive by its miles
    cents: gas.length && gasMi > 0 ? roundCents(gas.reduce((t, d) => t + d.cents! * d.mi, 0) / gasMi) : null,
    crossed: known ? ds.reduce((t, d) => t + d.crossed!, 0) : null,
    gentle: ds.reduce((t, d) => t + d.gentle, 0),
  };
}

/** One sign a drive, oldest first; with more than max drives, one a day (its mean score, summed brakes, mile-weighted cents). */
export function signsOf(drives: readonly SignIn[], max: number): Sign[] {
  const ds = [...drives].sort((a, b) => a.at - b.at);
  if (ds.length <= max) return ds.map((d) => signOf([d]));
  const days = new Map<string, SignIn[]>();
  for (const d of ds) { const k = dayKey(d.at); days.set(k, [...(days.get(k) ?? []), d]); }
  return [...days.values()].map(signOf);
}

/** The roughest and smoothest signs for the score lens; null when there is no difference to show. */
export function scoreEnds(signs: readonly Pick<Sign, 'score'>[]): { hard: number; best: number } | null {
  if (signs.length < 2) return null;
  let hard = 0, best = 0;
  signs.forEach((s, i) => {
    if (s.score < signs[hard].score) hard = i;
    // the latest of equal bests
    if (s.score >= signs[best].score) best = i;
  });
  return signs[hard].score < signs[best].score ? { hard, best } : null;
}

/** The latest signs in a row with no extra cost; 0 when the latest had some. */
export function freeRun(signs: readonly Pick<Sign, 'cents'>[]): number {
  let k = 0;
  for (let i = signs.length - 1; i >= 0 && signs[i].cents === 0; i--) k++;
  return k;
}

/** The sign with the most cents, for the red face; -1 with none above 0. */
export function costliest(signs: readonly Pick<Sign, 'cents'>[]): number {
  let k = -1;
  signs.forEach((s, i) => { if ((s.cents ?? 0) > 0 && (k < 0 || s.cents! > signs[k].cents!)) k = i; });
  return k;
}

/** The drive to open for the coach's action: the most of what cost the points, the latest on a tie. */
export function worstDrive<D extends { at: number; hardBrakes: number; fastStarts?: number; overMi?: number }>(drives: readonly D[], key: ScoreKey): D | null {
  const v = (d: D) => (key === 'brakes' ? d.hardBrakes : key === 'starts' ? d.fastStarts ?? 0 : d.overMi ?? 0);
  let best: D | null = null;
  for (const d of drives) if (v(d) > 0 && (!best || v(d) > v(best) || (v(d) === v(best) && d.at > best.at))) best = d;
  return best;
}

/** The road with the most miles over the limit this week, '' if none is named. */
export function speedRoad(drives: readonly { speeds?: readonly { road: string; mi: number }[] }[]): string {
  const m = new Map<string, number>();
  for (const d of drives) for (const s of d.speeds ?? []) if (s.road) m.set(s.road, (m.get(s.road) ?? 0) + s.mi);
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}
