// The cents a week's driving habits add to every gallon (fueleconomy.gov's own per-gallon convention: share x price).
// Stand-in for the gas module, with the same names and fields home and My drives use. The gas module replaces this file.
import { weekStart } from './challenge.ts';
import type { Range } from './dust.ts';
import { DEFAULT_MONEY_OPTIONS } from './money.ts';
import { hardGasOf, type DriveSummary } from './summary.ts';

/** Washington regular, U.S. EIA weekly series EMM_EPMR_PTE_SWA_DPG */
export const GAS_PRICE = { usdPerGal: 5.332, weekOf: '2026-10-19', source: 'U.S. EIA' } as const;
export const MIN_CENTS = 5;

/** the price saved drives' dollars were figured at, and the mpg behind each end of the range */
const SAVED_PRICE = DEFAULT_MONEY_OPTIONS.gasUsdPerGal;
const MPG_FOR: Range = { low: 30, typical: 25, high: 20 };

export interface GasWeek {
  /** typical cents a gallon, rounded as shown */
  cents: number;
  /** "40¢" */
  amount: string;
  /** "about 40¢" */
  text: string;
  /** the whole line */
  words: string;
  /** which habits it names */
  hard: boolean;
  speed: boolean;
  /** this week had under 2 gas miles, so this is last week */
  lastWeek: boolean;
  drives: number;
  miles: number;
}

type GasDrive = Pick<DriveSummary, 'at' | 'mi' | 'gas' | 'car'> & Parameters<typeof hardGasOf>[0];

const round5 = (c: number) => Math.round(c / 5) * 5, round10 = (c: number) => Math.round(c / 10) * 10;
/** under a dollar to 5 cents, past it to 10 */
export const roundCents = (c: number): number => (round5(c) < 100 ? round5(c) : round10(c));
/** "40¢", "$1.10" */
export const centsAmount = (c: number): string => { const r = roundCents(c); return r < 100 ? `${r}¢` : `$${(r / 100).toFixed(2)}`; };
/** "about 40¢" */
export const centsText = (c: number): string => `about ${centsAmount(c)}`;

/** This week (from Monday), or last week while this one has under 2 gas miles; null with too little or under 5 cents. EVs never count. */
export function gasWeek(sums: readonly GasDrive[], now = Date.now(), P: number = GAS_PRICE.usdPerGal): GasWeek | null {
  const from = weekStart(now);
  const pool = (a: number, b: number) => {
    const wk = sums.filter((s) => s.at >= a && s.at < b && s.car !== 'ev' && s.mi > 0), mi = wk.reduce((t, s) => t + s.mi, 0);
    // each drive's extra share of gas, weighted by miles: dollars x mpg / price
    const part = (k: keyof Range, hard: boolean, speed: boolean) => wk.reduce((t, s) => t + ((hard ? hardGasOf(s)[k] : 0) + (speed ? s.gas[k] : 0)) * MPG_FOR[k] / SAVED_PRICE, 0) / (mi || 1);
    return { n: wk.length, mi, typ: part('typical', true, true), speedPart: part('typical', false, true) };
  };
  let w = pool(from, Infinity), lastWeek = false;
  if (!(w.mi >= 2)) [w, lastWeek] = [pool(weekStart(from - 1), from), true];
  const typ = 100 * w.typ * P;
  if (!(w.mi >= 2) || !(typ >= MIN_CENTS)) return null;
  // name a habit when it makes up a quarter or more
  const sp = w.typ > 0 ? w.speedPart / w.typ : 0, speed = sp >= 0.25 && w.speedPart > 0, hard = 1 - sp >= 0.25;
  const who = hard && speed ? 'hard starts, stops and speeding' : speed ? 'speeding' : 'hard starts and stops';
  return {
    cents: roundCents(typ), amount: centsAmount(typ), text: centsText(typ),
    words: `Your ${who} added ${centsText(typ)} to every gallon ${lastWeek ? 'last week' : 'this week'}.`,
    hard, speed, lastWeek, drives: w.n, miles: w.mi,
  };
}
