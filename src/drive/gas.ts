// The cents a week's driving habits add to every gallon (fueleconomy.gov's own per-gallon convention: share x price).
// Stand-in for the gas module: it reads the dollars saved drives already keep. The gas module replaces this file.
import { weekStart } from './challenge.ts';
import type { Range } from './dust.ts';
import { DEFAULT_MONEY_OPTIONS } from './money.ts';
import { hardGasOf, type DriveSummary } from './summary.ts';

/** Washington regular, U.S. EIA weekly series EMM_EPMR_PTE_SWA_DPG */
export const WA_GAS = { usdPerGal: 5.332, weekOf: '2026-10-19', source: 'U.S. EIA' } as const;

/** the price saved drives' dollars were figured at, and the mpg behind each end of the range */
const SAVED_PRICE = DEFAULT_MONEY_OPTIONS.gasUsdPerGal;
const MPG_FOR: Range = { low: 30, typical: 25, high: 20 };

export interface GasWeek {
  /** cents added to every gallon */
  cents: Range;
  /** the typical cents from hard starts and stops, and from speeding */
  hard: number;
  speed: number;
  /** this week had too few gas miles, so this is last week */
  last: boolean;
  mi: number;
}

type GasDrive = Pick<DriveSummary, 'at' | 'mi' | 'gas' | 'car'> & Parameters<typeof hardGasOf>[0];

const keys = ['low', 'typical', 'high'] as const;

function over(sums: readonly GasDrive[], from: number, to: number, P: number): GasWeek | null {
  const wk = sums.filter((s) => s.at >= from && s.at < to && s.car !== 'ev' && s.mi > 0);
  const mi = wk.reduce((t, s) => t + s.mi, 0);
  if (!(mi >= 2)) return null;
  // the share of extra gas, weighted by miles: (dollars x mpg / price) / miles, summed over miles
  const share = (k: (typeof keys)[number], part: 'hard' | 'speed' | 'both') => wk.reduce((t, s) => {
    const usd = (part !== 'speed' ? hardGasOf(s)[k] : 0) + (part !== 'hard' ? s.gas[k] : 0);
    return t + (usd * MPG_FOR[k]) / SAVED_PRICE;
  }, 0) / mi;
  const cents = { low: 100 * share('low', 'both') * P, typical: 100 * share('typical', 'both') * P, high: 100 * share('high', 'both') * P };
  return { cents, hard: 100 * share('typical', 'hard') * P, speed: 100 * share('typical', 'speed') * P, last: false, mi };
}

/** This week (from Monday), or last week when this one has under 2 gas miles; null with too little or under 5 cents. EVs never count. */
export function gasWeek(sums: readonly GasDrive[], now = Date.now(), P: number = WA_GAS.usdPerGal): GasWeek | null {
  const from = weekStart(now);
  let w = over(sums, from, now + 1, P);
  if (!w) {
    w = over(sums, weekStart(from - 1), from, P);
    if (w) w.last = true;
  }
  return w && w.cents.typical >= 5 ? w : null;
}

/** "about 40¢", "about $1.10" */
export function centsText(c: number): string {
  return c < 97.5 ? `about ${Math.round(c / 5) * 5}¢` : `about $${(Math.round(c / 10) / 10).toFixed(2)}`;
}

/** Which habits to name: each one that makes up a quarter or more. */
export function gasHabits(w: Pick<GasWeek, 'hard' | 'speed'>): string {
  const all = w.hard + w.speed, hard = w.hard >= all / 4, speed = w.speed >= all / 4 && w.speed > 0;
  return hard && speed ? 'hard starts, stops and speeding' : speed ? 'speeding' : 'hard starts and stops';
}

/** "Your hard starts and stops added about 35¢ to every gallon this week." */
export function gasWeekLine(w: GasWeek): string {
  return `Your ${gasHabits(w)} added ${centsText(w.cents.typical)} to every gallon ${w.last ? 'last week' : 'this week'}.`;
}
