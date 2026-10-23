// Extra gas a drive's habits cost, always an estimate with a range. Shown as cents on every gallon (gas.ts).
//
// Gas from hard starts and stops. fueleconomy.gov, "Driving More Efficiently" (checked Oct 2026): aggressive driving
// (speeding, rapid acceleration and braking) "can lower your gas mileage by roughly 15% to 30% at highway speeds
// and 10% to 40% in stop-and-go traffic". Its sources: Oak Ridge National Laboratory (ORNL), "Sensible driving saves
// more gas than drivers think" (Sep 2017), and Thomas, Huff, West and Chambon, "Fuel Consumption Sensitivity of
// Conventional and Hybrid Electric Light-Duty Gasoline Vehicles to Driving Style", SAE Int. J. Fuels Lubr. 10(3), 2017,
// doi:10.4271/2017-01-9379. That paper also finds: on motorways with speed limits obeyed, hard acceleration alone
// costs 5% to 14% more fuel; 10 mph faster between 50 and 80 mph costs 11% to 21% more; and the two add up.
//
// How aggressive a drive was: its hard brakes and fast starts per mile, each counted as its mph per second / 8.
// ORNL's aggressive stop-and-go test is the US06 City cycle. By our 7 mph a second rule it has 1.1 hard starts a mile
// at standard intensity and 2.8 hard starts and stops a mile at 1.1 intensity, about 8 mph a second each. ORNL measured
// 42% and 66% more fuel there than at 0.8 intensity. The EPA city test (UDDS), a calm drive, has none.
// So 2 a mile counts as fully aggressive (1), none as 0, and in between in a straight line.
// Share of gas wasted = how aggressive x the published range for the road (low, central, high):
//   under 50 mph, stop-and-go: 10%, 25%, 40%.
//   50 mph and up, highway: the paper's hard acceleration part, 5%, 8.5%, 12% of the gas (5% to 14% more fuel).
//   Speeding is counted on its own, and on highways the two never pass 30%, the top of the highway range.
// The low end also uses 30 mpg and the high end 20 mpg, so the dollar range is wide. The share doesn't use mpg.
//
// Gas from speeding: over the posted limit at highway speed. fueleconomy.gov/feg/driveHabits.jsp (checked Oct 22 2026): slowing 5 to 10 mph
// saves 7 to 14% at $4.28 a gallon, and each 5 mph over 50 is like $0.30 more a gallon (7% of $4.28). So about 7% per 5 mph.
// Gas price: U.S. EIA weekly Washington regular (gas-price.json, scripts/fetch-gas-price.ts). Braking softer is never said to save gas; easing off sooner is.
import PRICE from './gas-price.json' with { type: 'json' };
import type { SpeedEvent } from './events.ts';
import type { Signals } from './signal.ts';
import type { Speeding } from './speeding.ts';

/** low, central and high */
export interface Range {
  low: number;
  typical: number;
  high: number;
}

/** US dollars */
export type Usd = Range;

/** The WA price the cents use (gas-price.json). */
export interface GasPrice {
  usdPerGal: number;
  /** the Monday EIA dates the week by, YYYY-MM-DD */
  weekOf: string;
  source: string;
  seriesId: string;
  fetchedAt: string;
}

export const GAS_PRICE: GasPrice = PRICE;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "week of Oct 19, 2026" */
export function weekOfText(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return y && m && d ? `week of ${MONTHS[m - 1]} ${d}, ${y}` : '';
}

export interface MoneyOptions {
  /** miles per gallon; the high end costs the least */
  mpg: Range;
  gasUsdPerGal: number;
  /** when that price was checked */
  gasPriceDate: string;
  /** mileage lost per 5 mph over 50 */
  lossPer5Mph: number;
  /** share of gas fully aggressive starts and stops waste in stop-and-go driving (fueleconomy.gov) */
  cityLoss: Range;
  /** the same on highways: hard speeding up alone, speed limits obeyed (Thomas 2017: 5 to 14% more fuel) */
  highwayLoss: Range;
  /** the most all aggressive driving wastes at highway speeds, speeding included (fueleconomy.gov) */
  highwayMax: number;
  /** at or above this, a mile counts as highway (where fueleconomy.gov says mileage drops fast) */
  highwayMph: number;
  /** hard starts and stops a mile that count as fully aggressive, like ORNL's aggressive city test */
  aggressivePerMi: number;
  /** a hard start or stop this many mph per second counts 1; harder ones count more, up to 2 */
  hardMphPerS: number;
  annualMi: number;
  /** shorter drives get no gas line and no monthly leaks */
  minMilesForYear: number;
}

export const DEFAULT_MONEY_OPTIONS: MoneyOptions = {
  mpg: { low: 20, typical: 25, high: 30 },
  gasUsdPerGal: GAS_PRICE.usdPerGal,
  gasPriceDate: weekOfText(GAS_PRICE.weekOf),
  lossPer5Mph: 0.07,
  cityLoss: { low: 0.1, typical: 0.25, high: 0.4 },
  highwayLoss: { low: 0.05, typical: 0.085, high: 0.12 },
  highwayMax: 0.3,
  highwayMph: 50,
  aggressivePerMi: 2,
  hardMphPerS: 8,
  // the 2023 US average per light-duty vehicle (FHWA)
  annualMi: 11_100,
  minMilesForYear: 2,
};

/**
 * Extra gas as a share of a calm drive's gas over the same miles (0.075 = 7.5% more). No units, so a new price never
 * makes an old drive wrong. speed: the speeding part, the same at each end; the rest is hard starts and stops.
 */
export interface GasShare extends Range {
  speed: number;
}

export interface DriveMoney {
  /** extra gas from hard brakes and fast starts */
  hardGas: Usd;
  /** extra gas from going over the limit above 50 mph */
  speedGas: Usd;
  total: Usd;
  /** central share of this drive's gas that hard starts and stops wasted (0 to 0.4) */
  hardShare: number;
  /** the extra gas as a share, for cents a gallon (gas.ts) */
  gasShare: GasShare;
  /** the share of gasCost(speeding) counted: 1 unless the 30% highway cap cut it */
  speedKept: number;
  /** gas per hard brake or fast start, typical, same order as the events given */
  perEvent: number[];
}

/** What gas from hard starts and stops needs from a drive: miles and hard starts and stops, on each kind of road. */
export interface Pace {
  /** miles under highwayMph (stop-and-go) and at it or over (highway) */
  cityMi: number;
  highwayMi: number;
  /** hard brakes and fast starts, each counted as its mph per second / hardMphPerS */
  cityHard: number;
  highwayHard: number;
  /** each event's count and road, in the order given */
  each: { w: number; highway: boolean }[];
}

export const NO_PACE: Pace = { cityMi: 0, highwayMi: 0, cityHard: 0, highwayHard: 0, each: [] };

const M_PER_MI = 1609.344;
const MPH = 0.44704;
const ZERO: Usd = { low: 0, typical: 0, high: 0 };
const KEYS = ['low', 'typical', 'high'] as const;
const add = (a: Usd, b: Usd): Usd => ({ low: a.low + b.low, typical: a.typical + b.typical, high: a.high + b.high });
const scale = (a: Usd, k: number): Usd => ({ low: a.low * k, typical: a.typical * k, high: a.high * k });
/** the mpg each end uses: the low dollar figure comes from the best mileage */
export const mpgFor = (o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Range => ({ low: o.mpg.high, typical: o.mpg.typical, high: o.mpg.low });

/** How much one hard start or stop counts: its mph per second / hardMphPerS, at most 2. */
export const hardWeight = (mphPerS: number, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): number =>
  Number.isFinite(mphPerS) && mphPerS > 0 ? Math.min(mphPerS / o.hardMphPerS, 2) : 0;

/** 0 (smooth) to 1 (as aggressive as the study, or more): counted hard starts and stops per mile / aggressivePerMi. */
export function aggressiveness(hard: number, mi: number, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): number {
  if (!(hard > 0) || !(mi > 0)) return 0;
  return Math.min(hard / (o.aggressivePerMi * mi), 1);
}

/**
 * Miles on each kind of road and the drive's hard starts and stops, counted.
 * Miles per reading as in speeding.ts, so every mile that costs speeding gas is a highway mile.
 */
export function paceOf(sig: Signals, events: readonly Pick<SpeedEvent, 'mphPerS' | 'fromMps' | 'toMps'>[], o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Pace {
  let cityM = 0, highwayM = 0;
  for (const s of sig.segments) {
    for (let i = 0; i < s.t.length; i++) {
      const dm = (s.v[i] * ((i + 1 < s.t.length ? s.t[i + 1] : s.t[i]) - (i > 0 ? s.t[i - 1] : s.t[i]))) / 2;
      if (s.v[i] / MPH >= o.highwayMph) highwayM += dm;
      else cityM += dm;
    }
  }
  const each = events.map((e) => ({ w: hardWeight(e.mphPerS, o), highway: Math.max(e.fromMps, e.toMps) / MPH >= o.highwayMph }));
  const sum = (hw: boolean) => each.reduce((t, e) => t + (e.highway === hw ? e.w : 0), 0);
  return { cityMi: cityM / M_PER_MI, highwayMi: highwayM / M_PER_MI, cityHard: sum(false), highwayHard: sum(true), each };
}

/** Speeding's share of the highway gas, before the cap. */
const speedShareOf = (p: Pace, gasSteps: number, o: MoneyOptions) => (p.highwayMi > 0 ? (gasSteps * o.lossPer5Mph) / p.highwayMi : 0);

/**
 * Gas wasted by hard starts and stops: how aggressive each kind of road was x its published range, as a share of the gas used there.
 * On highways it never takes the total with speeding past highwayMax. gasSteps: the drive's Speeding.gasSteps.
 * share: of the whole drive's gas, for each end.
 */
export function hardGasCost(p: Pace, gasSteps = 0, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): { usd: Usd; perEvent: number[]; share: Range } {
  const aCity = aggressiveness(p.cityHard, p.cityMi, o), aHwy = aggressiveness(p.highwayHard, p.highwayMi, o);
  const speed = Math.min(speedShareOf(p, gasSteps, o), o.highwayMax);
  const mpg = mpgFor(o);
  const part = (k: (typeof KEYS)[number]) => {
    const city = aCity * o.cityLoss[k], hwy = Math.min(aHwy * o.highwayLoss[k], Math.max(o.highwayMax - speed, 0));
    return { city: ((city * p.cityMi) / mpg[k]) * o.gasUsdPerGal, hwy: ((hwy * p.highwayMi) / mpg[k]) * o.gasUsdPerGal, share: city * p.cityMi + hwy * p.highwayMi };
  };
  const [lo, mid, hi] = KEYS.map(part);
  const perEvent = p.each.map((e) => {
    const total = e.highway ? p.highwayHard : p.cityHard;
    return total > 0 ? ((e.highway ? mid.hwy : mid.city) * e.w) / total : 0;
  });
  const mi = p.cityMi + p.highwayMi, of = (x: { share: number }) => (mi > 0 ? x.share / mi : 0);
  return { usd: { low: lo.city + lo.hwy, typical: mid.city + mid.hwy, high: hi.city + hi.hwy }, perEvent, share: { low: of(lo), typical: of(mid), high: of(hi) } };
}

/** For a drive saved before this was counted: all of it stop-and-go, each hard start or stop counted 1. */
export function hardGasGuess(mi: number, hardEvents: number, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Usd {
  if (!(mi > 0) || !(hardEvents > 0)) return ZERO;
  return hardGasCost({ cityMi: mi, highwayMi: 0, cityHard: hardEvents, highwayHard: 0, each: [] }, 0, o).usd;
}

/** Gas cost of speeding: gallons used there x 7% per 5 mph over the higher of the limit and 50. Takes a drive's Speeding or one stretch. */
export function gasCost(sp: { gasSteps: number }, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Usd {
  const usd = (mpg: number) => ((sp.gasSteps * o.lossPer5Mph) / mpg) * o.gasUsdPerGal;
  return { low: usd(o.mpg.high), typical: usd(o.mpg.typical), high: usd(o.mpg.low) };
}

/** pace: the drive's miles and hard starts and stops (paceOf); without it hard starts and stops cost no gas. */
export function driveMoney(sp: Pick<Speeding, 'gasSteps'>, pace: Pace = NO_PACE, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): DriveMoney {
  // speeding alone never takes the highway gas past highwayMax
  const raw = speedShareOf(pace, sp.gasSteps, o), speedKept = raw > o.highwayMax ? o.highwayMax / raw : 1;
  const speedGas = scale(gasCost(sp, o), speedKept);
  const hard = hardGasCost(pace, sp.gasSteps, o);
  const mi = pace.cityMi + pace.highwayMi, speed = mi > 0 ? (sp.gasSteps * o.lossPer5Mph * speedKept) / mi : 0;
  const gasShare: GasShare = { low: hard.share.low + speed, typical: hard.share.typical + speed, high: hard.share.high + speed, speed };
  return { hardGas: hard.usd, speedGas, total: add(hard.usd, speedGas), hardShare: hard.share.typical, gasShare, speedKept, perEvent: hard.perEvent };
}

/** Plain money words for a drive: "about 4¢", "under 1¢", "about $1.20"; "$0" for nothing. */
export function moneyText(usd: number): string {
  if (!(usd > 0)) return '$0';
  const c = Math.round(usd * 100);
  if (c < 1) return 'under 1¢';
  return c < 100 ? `about ${c}¢` : `about $${(c / 100).toFixed(2)}`;
}

/** The assumptions behind every dollar figure, for the details page. */
export function moneyNote(o: MoneyOptions = DEFAULT_MONEY_OPTIONS): string {
  return `Estimates, not measurements. Dollars use ${o.mpg.typical} mpg and Washington regular gas at $${o.gasUsdPerGal.toFixed(2)} a gallon (${o.gasPriceDate}, U.S. EIA).`;
}

/** "about 2¢ to 9¢", for a range in details. */
export function rangeText(r: Usd): string {
  const lo = moneyText(r.low).replace(/^about /, ''), hi = moneyText(r.high).replace(/^about /, '');
  return lo === hi ? moneyText(r.typical) : `${lo} to ${hi}`;
}
