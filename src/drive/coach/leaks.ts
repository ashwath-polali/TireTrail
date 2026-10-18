// Money leaks: the habits and places costing the most, across saved drives, in dollars a month.
// A month = annualMi / 12 miles driven the way the saved drives were (the same projection as money.ts yearMoney).
// Only what money.ts prices: gas from speeding above 50 mph, tire wear from hard stops. Gentle braking is never said to save gas.
import { DEFAULT_MONEY_OPTIONS, gasCost, type MoneyOptions, type Usd } from '../money.ts';
import type { DriveSummary } from '../summary.ts';
import { monthRange, monthText, plural } from './words.ts';

export type LeakKind = 'speeding' | 'hard-stops';

export interface Leak {
  kind: LeakKind;
  /** road or street, '' if unknown */
  place: string;
  /** "Speeding on SR 410" */
  title: string;
  /** "Speeding on SR 410: about $6 a month" */
  line: string;
  /** the fix, one plain line */
  fix: string;
  /** why it costs, one plain line */
  why: string;
  /** dollars a month */
  month: Usd;
  /** "$3 to $9 a month" */
  range: string;
  /** how many times it happened (stretches or hard stops) */
  times: number;
  /** drives it happened on, of all drives counted */
  drives: number;
  of: number;
}

export interface Leaks {
  /** up to 3, biggest first; empty under 2 miles of driving or with nothing costing money */
  top: Leak[];
  drives: number;
  miles: number;
  /** what the figures are based on, one line */
  note: string;
}

/** what leaks need from a saved drive */
export type LeakDrive = Pick<DriveSummary, 'at' | 'mi' | 'gas' | 'tires' | 'stopPts' | 'speeds'>;

const ZERO: Usd = { low: 0, typical: 0, high: 0 };
const add = (a: Usd, b: Usd): Usd => ({ low: a.low + b.low, typical: a.typical + b.typical, high: a.high + b.high });
const scale = (a: Usd, k: number): Usd => ({ low: a.low * k, typical: a.typical * k, high: a.high * k });

interface Bucket { kind: LeakKind; place: string; usd: Usd; times: number; drives: Set<number>; limits: Map<number, number> }

/** The top money leaks across saved drives. */
export function leaksFrom(drives: readonly LeakDrive[], o: MoneyOptions = DEFAULT_MONEY_OPTIONS, n = 3): Leaks {
  const miles = drives.reduce((s, d) => s + (d.mi > 0 ? d.mi : 0), 0);
  const note = `From ${plural(drives.length, 'drive')} (${Math.round(miles * 10) / 10} miles), as if you drove ${Math.round(o.annualMi / 12).toLocaleString('en-US')} miles a month like this.`;
  if (!(miles >= o.minMilesForYear)) return { top: [], drives: drives.length, miles, note };
  const k = o.annualMi / 12 / miles;
  const buckets = new Map<string, Bucket>();
  const bucket = (kind: LeakKind, place: string) => {
    const key = `${kind}|${place}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { kind, place, usd: ZERO, times: 0, drives: new Set(), limits: new Map() }));
    return b;
  };

  for (const d of drives) {
    // speeding: per road when the drive kept its stretches, else the drive's total with no place
    if (d.speeds) {
      for (const sp of d.speeds) {
        const usd = gasCost({ gasSteps: sp.gasSteps }, o);
        if (!(usd.typical > 0)) continue;
        const b = bucket('speeding', sp.road);
        b.usd = add(b.usd, usd);
        b.times++;
        b.drives.add(d.at);
        b.limits.set(sp.limitMph, (b.limits.get(sp.limitMph) ?? 0) + sp.mi);
      }
    } else if (d.gas.typical > 0) {
      const b = bucket('speeding', '');
      b.usd = add(b.usd, d.gas);
      b.times++;
      b.drives.add(d.at);
    }
    // hard stops: per street, the drive's range spread by each stop's share
    if (d.stopPts) {
      const t = d.tires.typical;
      for (const st of d.stopPts) {
        if (!st.hard || !(st.usd > 0)) continue;
        const usd = t > 0 ? scale(d.tires, st.usd / t) : { low: st.usd, typical: st.usd, high: st.usd };
        const b = bucket('hard-stops', st.name);
        b.usd = add(b.usd, usd);
        b.times++;
        b.drives.add(d.at);
      }
    } else if (d.tires.typical > 0) {
      const b = bucket('hard-stops', '');
      b.usd = add(b.usd, d.tires);
      b.times++;
      b.drives.add(d.at);
    }
  }

  const top = [...buckets.values()].map((b): Leak => {
    const month = scale(b.usd, k);
    const limit = [...b.limits].sort((x, y) => y[1] - x[1])[0]?.[0];
    const title = b.kind === 'speeding' ? (b.place ? `Speeding on ${b.place}` : 'Speeding') : b.place ? `Hard stops at ${b.place}` : 'Hard stops';
    const fix = b.kind === 'speeding'
      ? limit ? `Keep to ${limit}${b.place ? ` on ${b.place}` : ''}.` : 'Keep to the posted limit on fast roads.'
      : `Start slowing sooner${b.place ? ` for ${b.place}` : ''} so you can stop gently.`;
    const why = b.kind === 'speeding'
      ? `Above 50 mph, each 5 mph faster burns about ${Math.round(o.lossPer5Mph * 100)}% more gas.`
      : 'Hard stops wear your tires faster than gentle ones.';
    return { kind: b.kind, place: b.place, title, line: `${title}: ${monthText(month.typical)} a month`, fix, why, month, range: monthRange(month), times: b.times, drives: b.drives.size, of: drives.length };
  }).filter((l) => l.month.typical > 0).sort((a, b) => b.month.typical - a.month.typical).slice(0, n);
  return { top, drives: drives.length, miles, note };
}
