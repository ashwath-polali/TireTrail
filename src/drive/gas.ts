// The gas line: the cents a drive's habits add to every gallon. Always an estimate.
// Extra gas is a share s of a calm drive's gas over the same miles (money.ts), and paying for it is like paying
// s x price more on every gallon. fueleconomy.gov uses this for its own per-gallon figures (10% to 40% of $4.28 = $0.43 to $1.71).
// mpg cancels out, so the cents don't depend on the car's mileage. No line for EVs, short drives or under 5¢.
import type { DriveReport } from './analyze.ts';
import type { Vehicle } from './dust.ts';
import { DEFAULT_MONEY_OPTIONS, GAS_PRICE, mpgFor, weekOfText, type GasPrice, type GasShare, type MoneyOptions, type Range } from './money.ts';
import { hardGasOf, type HardGasDrive } from './summary.ts';

/** under this many typical cents a gallon, no line */
export const MIN_CENTS = 5;
/** a habit is named when it's at least this share of the cents */
const NAME_SHARE = 0.25;
/** what drives saved before gasShare were priced at: $5.40 until Oct 22 2026, then $5.34 (AAA) */
const oldPrice = (at = Infinity) => (at < Date.UTC(2026, 9, 22, 23) ? 5.4 : 5.34);
const DAY = 86_400_000;

export const GAS_WORDS = {
  hard: 'Your fast starts and hard brakes added {c} to every gallon',
  speed: 'Your speeding added {c} to every gallon',
  both: 'Your fast starts, hard brakes and speeding added {c} to every gallon',
  drive: 'on this drive.',
  week: 'this week.',
  lastWeek: 'last week.',
  pitchHard: 'Save gas: start gently and ease off sooner.',
  pitchSpeed: 'Save gas: each 5 mph over 50 is like {p5} more a gallon.',
} as const;

/** The price to use, or null if it's missing or not believable. */
export function gasPrice(p: Partial<GasPrice> | null = GAS_PRICE): GasPrice | null {
  return p && typeof p.usdPerGal === 'number' && p.usdPerGal >= 2 && p.usdPerGal <= 10 && typeof p.weekOf === 'string' ? (p as GasPrice) : null;
}

/** days since the price's week began */
export const priceAgeDays = (p: GasPrice, now = Date.now()): number => Math.floor((now - Date.parse(`${p.weekOf}T00:00:00`)) / DAY);

const round5 = (c: number) => Math.round(c / 5) * 5, round10 = (c: number) => Math.round(c / 10) * 10;

/** Cents a gallon as shown: nearest 5¢ under $1, nearest 10¢ from there. */
export const roundCents = (c: number): number => (round5(c) < 100 ? round5(c) : round10(c));

/** "40¢", "$1.10" */
export function centsAmount(c: number): string {
  const r = roundCents(c);
  return r < 100 ? `${r}¢` : `$${(r / 100).toFixed(2)}`;
}

/** "about 40¢", "about $1.10" */
export const centsText = (c: number): string => `about ${centsAmount(c)}`;

/** the speed pitch's figure: 7% of the price, "about 35¢" */
export const per5MphText = (price = GAS_PRICE.usdPerGal, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): string => centsText(100 * o.lossPer5Mph * price);

/** what the gas line needs from a saved drive */
export type GasDrive = HardGasDrive & {
  car?: Vehicle;
  gasShare?: GasShare;
  /** speeding gas, dollars (DriveSummary.gas) */
  gas?: Range;
  speeds?: readonly { gasSteps: number }[];
  at?: number;
};

/**
 * A saved drive's extra gas share. Drives saved before gasShare: speeding from its stretches (their gasSteps already count
 * the 30% cap), hard starts and stops from their dollars at the price they were saved with.
 */
export function shareOf(d: GasDrive, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): GasShare | null {
  if (!(d.mi > 0)) return null;
  if (d.gasShare) return d.gasShare;
  const mpg = mpgFor(o);
  const steps = d.speeds?.reduce((t, s) => t + (s.gasSteps > 0 ? s.gasSteps : 0), 0);
  const speed = steps != null ? (steps * o.lossPer5Mph) / d.mi : ((d.gas?.typical ?? 0) * mpg.typical) / (d.mi * oldPrice(d.at));
  // hardGasOf guesses at today's price when the drive kept no dollars
  const hard = hardGasOf(d, o), was = d.hardGas ? oldPrice(d.at) : o.gasUsdPerGal;
  const at = (k: keyof Range) => (hard[k] * mpg[k]) / (d.mi * was) + speed;
  return { low: at('low'), typical: at('typical'), high: at('high'), speed };
}

export interface GasLine {
  /** typical cents a gallon, rounded as shown */
  cents: number;
  /** "40¢" */
  amount: string;
  /** "about 40¢" */
  text: string;
  /** the whole line */
  words: string;
  /** rounded low and high cents */
  low: number;
  high: number;
  /** "Range: 25¢ to 40¢ a gallon.", or null when both ends round the same */
  range: string | null;
  /** "Washington regular gas: $5.33 a gallon, week of Oct 19, 2026 (U.S. EIA)." */
  price: string;
  /** "Save gas: ..." for the bigger part */
  pitch: string;
  /** which habits it names */
  hard: boolean;
  speed: boolean;
  /** the share it came from, unrounded */
  share: GasShare;
}

/** The line for a share: null under MIN_CENTS or with no price. */
export function lineFor(share: GasShare, when: 'drive' | 'week' | 'lastWeek', p: GasPrice | null = gasPrice(), o: MoneyOptions = DEFAULT_MONEY_OPTIONS): GasLine | null {
  if (!p) return null;
  const c = (s: number) => 100 * s * p.usdPerGal, typ = c(share.typical);
  if (!(typ >= MIN_CENTS)) return null;
  const speedPart = share.typical > 0 ? share.speed / share.typical : 0;
  // never "speeding" without speed data (its part is 0 then)
  const speed = share.speed > 0 && speedPart >= NAME_SHARE, hard = 1 - speedPart >= NAME_SHARE;
  const lead = GAS_WORDS[hard && speed ? 'both' : speed ? 'speed' : 'hard'].replace('{c}', centsText(typ));
  const lo = centsAmount(c(share.low)), hi = centsAmount(c(share.high));
  return {
    cents: roundCents(typ), amount: centsAmount(typ), text: centsText(typ),
    words: `${lead} ${GAS_WORDS[when]}`,
    low: roundCents(c(share.low)), high: roundCents(c(share.high)),
    range: lo === hi ? null : `Range: ${lo} to ${hi} a gallon.`,
    price: `Washington regular gas: $${p.usdPerGal.toFixed(2)} a gallon, ${weekOfText(p.weekOf)} (${p.source}).`,
    pitch: speedPart > 0.5 ? GAS_WORDS.pitchSpeed.replace('{p5}', per5MphText(p.usdPerGal, o)) : GAS_WORDS.pitchHard,
    hard, speed, share,
  };
}

const isReport = (d: DriveReport | GasDrive): d is DriveReport => 'money' in d && 'dust' in d;

/** One drive's gas line, from its report or its saved summary. Null for EVs, under 2 miles, or under 5¢ a gallon. */
export function gasLine(d: DriveReport | GasDrive, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): GasLine | null {
  const [mi, car, share] = isReport(d) ? [d.miles, d.dust.vehicle, d.money.gasShare] : [d.mi, d.car, shareOf(d, o)];
  if (car === 'ev' || !(mi >= o.minMilesForYear) || !share) return null;
  return lineFor(share, 'drive', gasPrice(), o);
}

/** Monday 00:00 this week, local time */
export function weekStart(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

export interface GasWeek extends GasLine {
  lastWeek: boolean;
  drives: number;
  miles: number;
}

/**
 * The week's gas line: each gas drive's share weighted by its miles, at the latest price. This week from Monday,
 * or last week while this week has under 2 gas miles. EV drives are left out. Null when neither week has enough.
 */
export function gasWeek(drives: readonly GasDrive[], now = Date.now(), o: MoneyOptions = DEFAULT_MONEY_OPTIONS): GasWeek | null {
  const start = weekStart(now), before = new Date(start);
  const lastStart = new Date(before.getFullYear(), before.getMonth(), before.getDate() - 7).getTime();
  const pool = (from: number, to: number) => {
    let mi = 0, n = 0;
    const s = { low: 0, typical: 0, high: 0, speed: 0 };
    for (const d of drives) {
      if (d.car === 'ev' || d.at == null || d.at < from || d.at >= to) continue;
      const x = shareOf(d, o);
      if (!x) continue;
      for (const k of ['low', 'typical', 'high', 'speed'] as const) s[k] += x[k] * d.mi;
      mi += d.mi;
      n++;
    }
    return mi > 0 ? { mi, n, share: { low: s.low / mi, typical: s.typical / mi, high: s.high / mi, speed: s.speed / mi } } : null;
  };
  let w = pool(start, Infinity), last = false;
  if (!w || w.mi < o.minMilesForYear) [w, last] = [pool(lastStart, start), true];
  if (!w || w.mi < o.minMilesForYear) return null;
  const line = lineFor(w.share, last ? 'lastWeek' : 'week', gasPrice(), o);
  return line ? { ...line, lastWeek: last, drives: w.n, miles: w.mi } : null;
}

/** "How we figure this" for the gas line, with sources. Null for EVs. */
export function gasHow(car?: Vehicle, p: GasPrice | null = gasPrice()): { heading: string; body: string[]; sources: string[] } | null {
  if (car === 'ev') return null;
  const price = p ? `$${p.usdPerGal.toFixed(2)}` : 'the current price';
  return {
    heading: 'How we figure this',
    body: [
      'Fast starts, hard brakes and speeding make a car burn more gas for the same miles. We count yours on each drive.',
      'Stop-and-go: driving as hard as a government test of aggressive driving (about 2 fast starts or hard brakes a mile) uses about 25% more gas, and anywhere from 10% to 40%. Fewer count for less. (fueleconomy.gov; Oak Ridge National Laboratory)',
      'Highway: speeding up hard uses 5% to 14% more gas, even at the speed limit (Thomas et al., 2017). Each 5 mph over the limit and over 50 mph adds about 7% (fueleconomy.gov). On highways we never count more than 30%, the top of the published range.',
      `Then we multiply that extra share by Washington's average price for regular gas (U.S. EIA, updated weekly). For example, 7.5% extra at ${price} is ${p ? centsText(7.5 * p.usdPerGal) : 'about 40¢'} a gallon. For a week, each drive counts by its miles.`,
      "Your car's mpg doesn't change the cents per gallon, only the dollars. This is an estimate, not a measurement. Electric cars don't get a gas line.",
    ],
    sources: [
      "U.S. DOE/EPA, fueleconomy.gov, 'Driving More Efficiently', https://www.fueleconomy.gov/feg/driveHabits.jsp",
      "Oak Ridge National Laboratory, 'Sensible driving saves more gas than drivers think', Sept 2017, https://www.ornl.gov/news/sensible-driving-saves-more-gas-drivers-think",
      "Thomas, Huff, West, Chambon, 'Fuel Consumption Sensitivity of Conventional and Hybrid Electric Light-Duty Gasoline Vehicles to Driving Style', SAE Int. J. Fuels Lubr. 10(3), 2017, doi:10.4271/2017-01-9379",
      "Thomas, Hwang, West, Huff, 'Predicting Light-Duty Vehicle Fuel Economy as a Function of Highway Speed', SAE Int. J. Passeng. Cars 6(2), 2013, doi:10.4271/2013-01-1113",
      `U.S. EIA, Weekly Washington Regular All Formulations Retail Gasoline Prices, series ${p?.seriesId ?? GAS_PRICE.seriesId}`,
    ],
  };
}
