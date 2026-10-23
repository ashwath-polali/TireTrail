// Salmon creeks across saved drives: each crossing, the creeks by place, and one week against the week before. No DOM.
import type { LngLat } from '../geo/geo.ts';
import { gasPrice, lineFor, shareOf, weekStart, type GasDrive, type GasLine } from './gas.ts';
import { DEFAULT_MONEY_OPTIONS } from './money.ts';

/** one salmon stream crossing on a drive; gentle: no hard brake within 150 m (src/salmon) */
export interface Crossing { name: string; ll: LngLat; gentle: boolean }

/** a drive's crossings by its id; null while not known */
export type CrossingsOf = (at: number) => readonly Crossing[] | null;

/** one creek crossing place across drives */
export interface Creek {
  /** '' when the stream has no name */
  name: string;
  ll: LngLat;
  times: number;
  gentle: number;
  /** ms, the latest drive over it */
  last: number;
}

/** crossings of a named creek this close are one place, m */
export const SAME_CREEK_M = 400;
/** unnamed ones, m */
export const SAME_SPOT_M = 120;

function meters(a: LngLat, b: LngLat): number {
  const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k), y = (b[1] - a[1]) * k;
  return Math.hypot(x, y) * 6_371_000;
}

/** The creeks crossed on these drives, most crossed first. */
export function creeksFrom(drives: readonly { at: number }[], of: CrossingsOf): Creek[] {
  const out: Creek[] = [];
  for (const d of [...drives].sort((a, b) => a.at - b.at)) {
    for (const c of of(d.at) ?? []) {
      const r = c.name ? SAME_CREEK_M : SAME_SPOT_M;
      let k = out.find((x) => x.name === c.name && meters(x.ll, c.ll) <= r);
      if (!k) out.push((k = { name: c.name, ll: c.ll, times: 0, gentle: 0, last: d.at }));
      k.times++;
      if (c.gentle) k.gentle++;
      k.last = d.at;
    }
  }
  return out.sort((a, b) => b.times - a.times || b.last - a.last);
}

/** green when every crossing was gentle, amber when a hard brake came near one */
export const creekTone = (c: Pick<Creek, 'times' | 'gentle'>): 'gentle' | 'mixed' => (c.gentle >= c.times ? 'gentle' : 'mixed');

/** Monday 00:00 the week before (local, so a time change can't shift it) */
export function weekBefore(start: number): number {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7).getTime();
}

/** Monday 00:00 the week after */
export function weekAfter(start: number): number {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
}

/** This week, then every earlier week with a drive, newest first. */
export function weeksOf(drives: readonly { at: number }[], now = Date.now()): number[] {
  const out = [weekStart(now)];
  for (const d of [...drives].sort((a, b) => b.at - a.at)) {
    const w = weekStart(d.at);
    if (w < out[out.length - 1]) out.push(w);
  }
  return out;
}

export interface WeekDrive extends GasDrive {
  at: number;
  mi: number;
  hardBrakes: number;
  fastStarts?: number;
  dustMg?: number;
  typMg?: number;
}

export interface Week {
  start: number;
  /** its drives, newest first */
  drives: WeekDrive[];
  /** drives whose crossings are known */
  known: number;
  crossed: number;
  gentle: number;
  hardBrakes: number;
  fastStarts: number;
  miles: number;
  /** tire dust and typical driving on the same roads, mg; null without it */
  dust: { mg: number; typMg: number } | null;
  /** the gas line for the week; null under 2 gas miles or 5 cents a gallon */
  gas: GasLine | null;
}

/** One week from Monday: its drives, crossings, hard brakes, tire dust and gas. */
export function weekStats<D extends WeekDrive>(drives: readonly D[], start: number, of: CrossingsOf): Week & { drives: D[] } {
  const end = weekAfter(start), wk = drives.filter((d) => d.at >= start && d.at < end).sort((a, b) => b.at - a.at);
  let known = 0, crossed = 0, gentle = 0, mg = 0, typ = 0, dusty = 0, gasMi = 0;
  const s = { low: 0, typical: 0, high: 0, speed: 0 };
  for (const d of wk) {
    const cs = of(d.at);
    if (cs) { known++; crossed += cs.length; gentle += cs.filter((c) => c.gentle).length; }
    if (typeof d.dustMg === 'number' && typeof d.typMg === 'number' && d.typMg > 0) { mg += d.dustMg; typ += d.typMg; dusty++; }
    const x = d.car === 'ev' ? null : shareOf(d);
    if (x) { for (const k of ['low', 'typical', 'high', 'speed'] as const) s[k] += x[k] * d.mi; gasMi += d.mi; }
  }
  const share = gasMi > 0 ? { low: s.low / gasMi, typical: s.typical / gasMi, high: s.high / gasMi, speed: s.speed / gasMi } : null;
  return {
    start, drives: wk, known, crossed, gentle,
    hardBrakes: wk.reduce((t, d) => t + d.hardBrakes, 0),
    fastStarts: wk.reduce((t, d) => t + (d.fastStarts ?? 0), 0),
    miles: wk.reduce((t, d) => t + d.mi, 0),
    dust: dusty ? { mg, typMg: typ } : null,
    gas: share && gasMi >= DEFAULT_MONEY_OPTIONS.minMilesForYear ? lineFor(share, 'week', gasPrice()) : null,
  };
}
