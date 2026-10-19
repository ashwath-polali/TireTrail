// Progress over saved drives: scores, money, hard brakes per 10 miles, a no-hard-brake streak and an honest verdict.
import { yearMoney, type MoneyPool, type YearMoney } from './money.ts';
import { hardGasOf, type DriveSummary } from './summary.ts';

/** short drives count as this long, as in the score, so one brake on a tiny drive isn't a huge rate */
const MIN_MI = 2;
/** a verdict needs this many drives */
export const VERDICT_DRIVES = 4;
/** score points between first and latest drives that count as a real change */
const CHANGE = 5;

export type Verdict = 'smoother' | 'same' | 'rougher';

export const VERDICT_TEXT: Record<Verdict, string> = {
  smoother: 'Smoother than your first drives',
  same: 'About the same',
  rougher: 'Rougher than your first drives',
};

export interface ProgressDrive {
  at: number;
  mi: number;
  score: number;
  /** gas from hard starts and stops and from speeding, and tire wear, typical dollars */
  usd: number;
  hardBrakes: number;
  /** hard brakes per 10 miles */
  per10: number;
}

export interface Progress {
  /** all drives counted */
  drives: number;
  /** the last n drives, oldest first (for bars) */
  recent: ProgressDrive[];
  /** latest drives in a row with no hard brakes */
  streak: number;
  /** average score of the latest 3 drives, null with none */
  avgScore: number | null;
  /** hard brakes per 10 miles: first drives vs latest drives (same counts as the verdict), null with too few */
  per10: { first: number; latest: number } | null;
  /** null with fewer than 4 drives */
  verdict: Verdict | null;
  verdictText: string | null;
  /** drives still needed for a verdict */
  needMore: number;
  /** a year of driving like all saved drives together; null under 2 miles */
  year: YearMoney | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pool = (s: DriveSummary): MoneyPool => ({ mi: s.mi, hardGas: hardGasOf(s), speedGas: s.gas, tires: s.tires });

/** sums: saved drive summaries in any order. n: how many recent drives to return. */
export function progressOf(sums: readonly DriveSummary[], n = 12): Progress {
  const all = [...sums].sort((a, b) => a.at - b.at).map((s): ProgressDrive => ({
    at: s.at, mi: s.mi, score: s.score, usd: hardGasOf(s).typical + s.gas.typical + s.tires.typical, hardBrakes: s.hardBrakes, per10: (s.hardBrakes / Math.max(s.mi, MIN_MI)) * 10,
  }));
  let streak = 0;
  for (let i = all.length - 1; i >= 0 && all[i].hardBrakes === 0; i--) streak++;
  const N = all.length, k = Math.min(3, Math.floor(N / 2));
  let verdict: Verdict | null = null, per10: Progress['per10'] = null;
  if (N >= VERDICT_DRIVES) {
    const first = all.slice(0, k), latest = all.slice(N - k);
    const d = mean(latest.map((x) => x.score)) - mean(first.map((x) => x.score));
    verdict = d >= CHANGE ? 'smoother' : d <= -CHANGE ? 'rougher' : 'same';
    per10 = { first: mean(first.map((x) => x.per10)), latest: mean(latest.map((x) => x.per10)) };
  }
  return {
    drives: N,
    recent: all.slice(-n),
    streak,
    avgScore: N ? Math.round(mean(all.slice(-3).map((x) => x.score))) : null,
    per10,
    verdict,
    verdictText: verdict ? VERDICT_TEXT[verdict] : null,
    needMore: Math.max(VERDICT_DRIVES - N, 0),
    year: yearMoney(sums.map(pool)),
  };
}
