// Stand-in for gasLine() in src/drive/gas.ts (the gas engine's). Same name; swap the import in drive-reveal.ts when it lands.
// The cents a drive's habits add to every gallon: extra share of gas x the Washington price (fueleconomy.gov's own convention).
import type { DriveReport } from '../../drive/analyze.ts';
import type { Vehicle } from '../../drive/dust.ts';
import { DEFAULT_MONEY_OPTIONS } from '../../drive/money.ts';

/** U.S. EIA weekly Washington regular, series EMM_EPMR_PTE_SWA_DPG, week of Oct 19 2026 */
export const WA_GAS = { usdPerGal: 5.332, week: 'Oct 19, 2026', source: 'U.S. EIA' } as const;

export interface GasLine {
  /** typical, whole cents a gallon, rounded (5¢ steps under $1) */
  cents: number;
  /** "35¢", "$1.10" */
  text: string;
  /** which habits: the ones that make up 25% or more */
  why: 'hard' | 'speed' | 'both';
  /** "Hard starts and stops" */
  cause: string;
  /** "Save gas: start gently and ease off sooner." */
  pitch: string;
  /** "25¢ to 40¢ a gallon" */
  range: string;
  /** "Washington regular gas: $5.332 a gallon, week of Oct 19, 2026 (U.S. EIA)." */
  price: string;
}

const round = (c: number): number => (c < 100 ? Math.round(c / 5) * 5 : Math.round(c / 10) * 10);
export const centsText = (c: number): string => (c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);

/** The gas line for a drive, or null: an EV, under 2 miles, or under 5¢. */
export function gasLine(r: Pick<DriveReport, 'miles' | 'money'>, vehicle: Vehicle, o = DEFAULT_MONEY_OPTIONS, P: number = WA_GAS.usdPerGal): GasLine | null {
  if (vehicle === 'ev' || !(r.miles >= o.minMilesForYear)) return null;
  // dollars saved at the old price back to a share of the gas (cheapest dollars go with the best mileage)
  const mpg = { low: o.mpg.high, typical: o.mpg.typical, high: o.mpg.low };
  const share = (usd: number, k: keyof typeof mpg) => (usd * mpg[k]) / (r.miles * o.gasUsdPerGal);
  const m = r.money, k3 = ['low', 'typical', 'high'] as const;
  const [lo, typ, hi] = k3.map((k) => 100 * P * (share(m.hardGas[k], k) + share(m.speedGas[k], k)));
  if (!(typ >= 5)) return null;
  const cents = round(typ);
  const hard = share(m.hardGas.typical, 'typical'), speed = share(m.speedGas.typical, 'typical'), all = hard + speed;
  const why = speed / all >= 0.25 && hard / all >= 0.25 ? 'both' : speed > hard ? 'speed' : 'hard';
  const p5 = round(100 * o.lossPer5Mph * P);
  const [a, b] = [round(lo), round(hi)];
  return {
    cents, text: centsText(cents), why,
    cause: why === 'both' ? 'Hard starts, stops and speeding' : why === 'speed' ? 'Speeding' : 'Hard starts and stops',
    pitch: why === 'speed' ? `Save gas: each 5 mph over 50 is like ${centsText(p5)} more a gallon.` : 'Save gas: start gently and ease off sooner.',
    range: a === b ? `${centsText(a)} a gallon` : `${centsText(a)} to ${centsText(b)} a gallon`,
    price: `Washington regular gas: $${P.toFixed(3)} a gallon, week of ${WA_GAS.week} (${WA_GAS.source}).`,
  };
}
