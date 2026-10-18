// What a drive cost, always an estimate with a range. Sources: drive-v2 money spec.
// Gas: driving over the posted limit at highway speed. fueleconomy.gov: each 5 mph over 50 mph lowers mileage about 7%.
// Tires: extra tread from hard stops, vs a gentle 1.4 m/s² stop (Pohrt 2019) over the same stretch of road.
// Brakes are left out (no sourced estimate). Gentle braking is never said to save gas.
import { DEFAULT_DUST_OPTIONS, resistance, type DustOptions } from './dust.ts';
import type { Speeding } from './speeding.ts';
import type { Stop } from './stops.ts';

/** US dollars */
export interface Usd {
  low: number;
  typical: number;
  high: number;
}

export interface MoneyOptions {
  /** miles per gallon; the high end costs the least */
  mpg: Usd;
  gasUsdPerGal: number;
  /** when that price was checked */
  gasPriceDate: string;
  /** mileage lost per 5 mph over 50 */
  lossPer5Mph: number;
  /** installed price of 4 tires */
  tireSetUsd: Usd;
  /** miles a set lasts with typical driving */
  treadLifeMi: Usd;
  annualMi: number;
  /** m/s², the gentle stop a hard stop is compared with */
  gentleDecel: number;
  /** shorter drives get no yearly figure */
  minMilesForYear: number;
}

export const DEFAULT_MONEY_OPTIONS: MoneyOptions = {
  mpg: { low: 20, typical: 25, high: 30 },
  gasUsdPerGal: 5.4,
  gasPriceDate: 'Oct 2026',
  lossPer5Mph: 0.07,
  tireSetUsd: { low: 450, typical: 700, high: 1000 },
  treadLifeMi: { low: 35_000, typical: 45_000, high: 60_000 },
  annualMi: 11_100,
  gentleDecel: 1.4,
  minMilesForYear: 2,
};

/** Raw sums one drive adds to a pooled yearly figure. */
export interface MoneyPool {
  mi: number;
  gas: Usd;
  tires: Usd;
}

export interface YearMoney {
  gas: Usd;
  tires: Usd;
  total: Usd;
  /** the miles of driving it is based on */
  fromMi: number;
}

export interface DriveMoney {
  /** extra gas from going over the limit above 50 mph */
  gas: Usd;
  /** extra tire wear from hard stops */
  tires: Usd;
  total: Usd;
  /** if every mile for a year were like this drive; null under 2 miles */
  year: YearMoney | null;
  /** extra tire wear per stop, typical (0 if it wasn't hard), same order as the stops */
  perStop: number[];
  pool: MoneyPool;
}

const M_PER_MI = 1609.344;
const ZERO: Usd = { low: 0, typical: 0, high: 0 };
const add = (a: Usd, b: Usd): Usd => ({ low: a.low + b.low, typical: a.typical + b.typical, high: a.high + b.high });
const scale = (a: Usd, k: number): Usd => ({ low: a.low * k, typical: a.typical * k, high: a.high * k });

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
  const gas = scale(pools.reduce((a, p) => add(a, p.gas), ZERO), k);
  const tires = scale(pools.reduce((a, p) => add(a, p.tires), ZERO), k);
  return { gas, tires, total: add(gas, tires), fromMi: mi };
}

export function driveMoney(stops: readonly Stop[], s: number[][], dm: number[][], distanceM: number, sp: Speeding, o: MoneyOptions = DEFAULT_MONEY_OPTIONS, d: DustOptions = DEFAULT_DUST_OPTIONS): DriveMoney {
  const gas = gasCost(sp, o);
  const t = tireCost(stops, s, dm, o, d);
  const pool: MoneyPool = { mi: distanceM / M_PER_MI, gas, tires: t.total };
  return { gas, tires: t.total, total: add(gas, t.total), year: yearMoney([pool], o), perStop: t.perStop, pool };
}

/** nearest $5, for yearly figures */
export const roundYear = (usd: number): number => Math.round(usd / 5) * 5;

/** Plain money words: "about 4¢", "under 1¢", "about $1.20" for a drive; "about $45", "under $5" for a year; "$0" for nothing. */
export function moneyText(usd: number, per: 'drive' | 'year'): string {
  if (!(usd > 0)) return '$0';
  if (per === 'year') return usd < 2.5 ? 'under $5' : `about $${roundYear(usd)}`;
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
