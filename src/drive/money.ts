// What a drive cost, always an estimate with a range.
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
// The low end also uses 30 mpg and the high end 20 mpg, so the range is wide. A smooth drive wastes about none.
//
// Gas from speeding: over the posted limit at highway speed. fueleconomy.gov/feg/driveHabits.jsp (checked Oct 22 2026): slowing 5 to 10 mph
// saves 7 to 14% at $4.28 a gallon, and each 5 mph over 50 is like $0.30 more a gallon (7% of $4.28). So about 7% per 5 mph.
// Tires: extra tread from hard stops, vs a gentle 1.4 m/s² stop (Pohrt 2019) over the same stretch of road.
// Brakes are left out (no sourced estimate). Braking softer is never said to save gas; easing off sooner is.
import { DEFAULT_DUST_OPTIONS, resistance, type DustOptions } from './dust.ts';
import type { SpeedEvent } from './events.ts';
import type { Signals } from './signal.ts';
import type { Speeding } from './speeding.ts';
import type { Stop } from './stops.ts';

/** low, central and high */
export interface Range {
  low: number;
  typical: number;
  high: number;
}

/** US dollars */
export type Usd = Range;

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
  /** installed price of 4 tires */
  tireSetUsd: Range;
  /** miles a set lasts with typical driving */
  treadLifeMi: Range;
  annualMi: number;
  /** m/s², the gentle stop a hard stop is compared with */
  gentleDecel: number;
  /** shorter drives get no yearly figure */
  minMilesForYear: number;
  /** a monthly figure needs this many drives and miles */
  minDrivesForMonth: number;
  minMilesForMonth: number;
}

export const DEFAULT_MONEY_OPTIONS: MoneyOptions = {
  mpg: { low: 20, typical: 25, high: 30 },
  // AAA Washington average regular, checked Oct 22 2026 (gasprices.aaa.com/?state=WA: $5.342)
  gasUsdPerGal: 5.34,
  gasPriceDate: 'Oct 2026',
  lossPer5Mph: 0.07,
  cityLoss: { low: 0.1, typical: 0.25, high: 0.4 },
  highwayLoss: { low: 0.05, typical: 0.085, high: 0.12 },
  highwayMax: 0.3,
  highwayMph: 50,
  aggressivePerMi: 2,
  hardMphPerS: 8,
  tireSetUsd: { low: 450, typical: 700, high: 1000 },
  treadLifeMi: { low: 35_000, typical: 45_000, high: 60_000 },
  // the 2023 US average per light-duty vehicle (FHWA)
  annualMi: 11_100,
  gentleDecel: 1.4,
  minMilesForYear: 2,
  minDrivesForMonth: 3,
  minMilesForMonth: 10,
};

/** Raw sums one drive adds to a pooled yearly figure. */
export interface MoneyPool {
  mi: number;
  hardGas: Usd;
  speedGas: Usd;
  tires: Usd;
}

export interface YearMoney {
  /** gas from hard starts and stops */
  hardGas: Usd;
  /** gas from speeding */
  speedGas: Usd;
  tires: Usd;
  total: Usd;
  /** the miles of driving it is based on */
  fromMi: number;
}

export interface DriveMoney {
  /** extra gas from hard brakes and fast starts */
  hardGas: Usd;
  /** extra gas from going over the limit above 50 mph */
  speedGas: Usd;
  /** extra tire wear from hard stops */
  tires: Usd;
  total: Usd;
  /** if every mile for a year were like this drive; null under 2 miles */
  year: YearMoney | null;
  /** central share of this drive's gas that hard starts and stops wasted (0 to 0.4) */
  hardShare: number;
  /** the share of gasCost(speeding) counted: 1 unless the 30% highway cap cut it */
  speedKept: number;
  /** extra tire wear per stop, typical (0 if it wasn't hard), same order as the stops */
  perStop: number[];
  /** gas per hard brake or fast start, typical, same order as the events given */
  perEvent: number[];
  pool: MoneyPool;
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
const mpgFor = (o: MoneyOptions) => ({ low: o.mpg.high, typical: o.mpg.typical, high: o.mpg.low });

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
 */
export function hardGasCost(p: Pace, gasSteps = 0, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): { usd: Usd; perEvent: number[]; share: number } {
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
  const mi = p.cityMi + p.highwayMi;
  return { usd: { low: lo.city + lo.hwy, typical: mid.city + mid.hwy, high: hi.city + hi.hwy }, perEvent, share: mi > 0 ? mid.share / mi : 0 };
}

/** For a drive saved before this was counted: all of it stop-and-go, each hard start or stop counted 1. */
export function hardGasGuess(mi: number, hardEvents: number, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Usd {
  if (!(mi > 0) || !(hardEvents > 0)) return ZERO;
  return hardGasCost({ cityMi: mi, highwayMi: 0, cityHard: hardEvents, highwayHard: 0, each: [] }, 0, o).usd;
}

/** severity-meters of a steady stop from v0 at g (force² per mass², times meters) */
function gentleStopSeverity(v0: number, g: number, d: DustOptions, n = 200): number {
  const len = (v0 * v0) / (2 * g);
  let S = 0;
  for (let k = 0; k < n; k++) {
    const v = Math.sqrt(Math.max(v0 * v0 - 2 * g * (((k + 0.5) / n) * len), 0));
    S += Math.max(g - resistance(v, d), 0) ** 2 * (len / n);
  }
  return S;
}

/** Gas cost of speeding: gallons used there x 7% per 5 mph over the higher of the limit and 50. Takes a drive's Speeding or one stretch. */
export function gasCost(sp: { gasSteps: number }, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Usd {
  const usd = (mpg: number) => ((sp.gasSteps * o.lossPer5Mph) / mpg) * o.gasUsdPerGal;
  return { low: usd(o.mpg.high), typical: usd(o.mpg.typical), high: usd(o.mpg.low) };
}

/**
 * Extra tire wear from hard stops. s, dm: per-reading severity and meters from dust.ts severity().
 * Cornering cancels out on the same stretch; its weight only changes how much a mile of normal driving wears.
 */
export function tireCost(stops: readonly Stop[], s: number[][], dm: number[][], o: MoneyOptions = DEFAULT_MONEY_OPTIONS, d: DustOptions = DEFAULT_DUST_OPTIONS): { total: Usd; perStop: number[] } {
  const lat = d.refLatSD ** 2;
  // severity of one mile of typical driving, per meter, for low, central and high cornering weight
  const sRef = (L: number) => resistance(d.refSpeedMps, d) ** 2 + d.refLongSD ** 2 + L * lat;
  const perMi = { low: o.tireSetUsd.low / o.treadLifeMi.high, typical: o.tireSetUsd.typical / o.treadLifeMi.typical, high: o.tireSetUsd.high / o.treadLifeMi.low };
  const extra: number[] = [];
  let prevSeg = -1, floor = -1;
  for (const st of stops) {
    if (st.segment !== prevSeg) [prevSeg, floor] = [st.segment, -1];
    let E = 0;
    if (st.hard) {
      const v0 = st.entrySpeed, dg = (v0 * v0) / (2 * o.gentleDecel);
      let S = 0, covered = 0;
      for (let i = st.to; i > floor && covered < dg; i--) {
        const take = Math.min(dm[st.segment][i], dg - covered);
        S += s[st.segment][i] * take;
        covered += take;
      }
      // the gentle stretch must fit after the previous stop, or don't guess
      if (st.brakingM < dg && covered >= 0.9 * dg) E = Math.max(S - gentleStopSeverity(v0, o.gentleDecel, d), 0);
    }
    extra.push(E);
    floor = st.to;
  }
  const sum = extra.reduce((a, b) => a + b, 0);
  // extra severity / severity of a typical mile = extra miles of normal wear
  const usd = (L: number, cpm: number) => (sum / sRef(L) / M_PER_MI) * cpm;
  return {
    total: { low: usd(d.lateralWeight.high, perMi.low), typical: usd(d.lateralWeight.central, perMi.typical), high: usd(d.lateralWeight.low, perMi.high) },
    perStop: extra.map((E) => (E / sRef(d.lateralWeight.central) / M_PER_MI) * perMi.typical),
  };
}

/** A year at annualMi, from one or more drives' pools. null under 2 miles of driving. */
export function yearMoney(pools: readonly MoneyPool[], o: MoneyOptions = DEFAULT_MONEY_OPTIONS): YearMoney | null {
  const mi = pools.reduce((n, p) => n + p.mi, 0);
  if (!(mi >= o.minMilesForYear)) return null;
  const k = o.annualMi / mi;
  const sum = (f: (p: MoneyPool) => Usd) => scale(pools.reduce((a, p) => add(a, f(p)), ZERO), k);
  const hardGas = sum((p) => p.hardGas), speedGas = sum((p) => p.speedGas), tires = sum((p) => p.tires);
  return { hardGas, speedGas, tires, total: add(add(hardGas, speedGas), tires), fromMi: mi };
}

/** a month of the driver's own pace */
export interface MonthMoney {
  /** gas from hard starts, stops and speeding */
  gas: Usd;
  tires: Usd;
  total: Usd;
  fromMi: number;
  drives: number;
}

/**
 * A month at annualMi / 12 (925 miles), from saved drives. Null under minDrivesForMonth drives or minMilesForMonth miles,
 * so one drive never becomes a big figure.
 */
export function monthMoney(pools: readonly MoneyPool[], o: MoneyOptions = DEFAULT_MONEY_OPTIONS): MonthMoney | null {
  const mi = pools.reduce((n, p) => n + p.mi, 0);
  if (pools.length < o.minDrivesForMonth || !(mi >= o.minMilesForMonth)) return null;
  const k = o.annualMi / 12 / mi;
  const sum = (f: (p: MoneyPool) => Usd) => scale(pools.reduce((a, p) => add(a, f(p)), ZERO), k);
  const gas = add(sum((p) => p.hardGas), sum((p) => p.speedGas)), tires = sum((p) => p.tires);
  return { gas, tires, total: add(gas, tires), fromMi: mi, drives: pools.length };
}

/** "about $12 a month", "under $1 a month" */
export function monthText(usd: number): string {
  if (!(usd >= 0.5)) return 'under $1 a month';
  return `about $${usd < 20 ? Math.round(usd) : Math.round(usd / 5) * 5} a month`;
}

/** pace: the drive's miles and hard starts and stops (paceOf); without it hard starts and stops cost no gas. */
export function driveMoney(stops: readonly Stop[], s: number[][], dm: number[][], distanceM: number, sp: Speeding, pace: Pace = NO_PACE, o: MoneyOptions = DEFAULT_MONEY_OPTIONS, d: DustOptions = DEFAULT_DUST_OPTIONS): DriveMoney {
  // speeding alone never takes the highway gas past highwayMax
  const raw = speedShareOf(pace, sp.gasSteps, o), speedKept = raw > o.highwayMax ? o.highwayMax / raw : 1;
  const speedGas = scale(gasCost(sp, o), speedKept);
  const hard = hardGasCost(pace, sp.gasSteps, o);
  const t = tireCost(stops, s, dm, o, d);
  const pool: MoneyPool = { mi: distanceM / M_PER_MI, hardGas: hard.usd, speedGas, tires: t.total };
  return {
    hardGas: hard.usd, speedGas, tires: t.total, total: add(add(hard.usd, speedGas), t.total), year: yearMoney([pool], o),
    hardShare: hard.share, speedKept, perStop: t.perStop, perEvent: hard.perEvent, pool,
  };
}

/** Yearly figures: nearest $5 under $100, nearest $10 from there. */
export const roundYear = (usd: number): number => (usd < 97.5 ? Math.round(usd / 5) * 5 : Math.round(usd / 10) * 10);

/** Plain money words: "about 4¢", "under 1¢", "about $1.20" for a drive; "about $45", "about $380", "under $5" for a year; "$0" for nothing. */
export function moneyText(usd: number, per: 'drive' | 'year'): string {
  if (!(usd > 0)) return '$0';
  if (per === 'year') return usd < 2.5 ? 'under $5' : `about $${roundYear(usd).toLocaleString('en-US')}`;
  const c = Math.round(usd * 100);
  if (c < 1) return 'under 1¢';
  return c < 100 ? `about ${c}¢` : `about $${(c / 100).toFixed(2)}`;
}

/** The assumptions behind every dollar figure, for the details page. */
export function moneyNote(o: MoneyOptions = DEFAULT_MONEY_OPTIONS): string {
  return `Estimates, not measurements. They use ${o.mpg.typical} mpg, Washington regular gas at $${o.gasUsdPerGal.toFixed(2)} a gallon (${o.gasPriceDate}), `
    + `a $${o.tireSetUsd.typical} set of tires that lasts ${(o.treadLifeMi.typical / 1000).toFixed(0)},000 miles, and ${o.annualMi.toLocaleString('en-US')} miles a year.`;
}

/** "about $2 to $9", for the range in details. */
export function rangeText(r: Usd, per: 'drive' | 'year'): string {
  const lo = moneyText(r.low, per).replace(/^about /, ''), hi = moneyText(r.high, per).replace(/^about /, '');
  return lo === hi ? moneyText(r.typical, per) : `${lo} to ${hi}`;
}
