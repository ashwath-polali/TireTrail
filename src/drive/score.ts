// Smooth score, 0 to 100. Starts at 100 and loses points for three things, each with a cap:
// hard brakes per 10 miles (up to 45 points), fast starts per 10 miles (up to 20), share of miles over the posted limit (up to 35).
// Points lost = cap x rate / (rate + half): more often always costs more, but never past the cap.
// Calibrated so a calm driver (about 1 hard brake and 1 fast start in 20 miles, 5% of miles a little over) scores about 87.

export type ScoreKey = 'brakes' | 'starts' | 'speed';

/** each part's name on screen */
export const PART_LABEL: Record<ScoreKey, string> = { brakes: 'Hard brakes', starts: 'Fast starts', speed: 'Over the speed limit' };

export interface ScorePart {
  key: ScoreKey;
  /** points lost, whole; the parts add up to 100 minus the score */
  lost: number;
  /** most points this part can lose */
  max: number;
  /** how many times (brakes, starts) or miles over the limit (speed) */
  count: number;
  /** per 10 miles (brakes, starts), or share of miles 0 to 1 (speed) */
  rate: number;
}

export interface Score {
  /** 0 to 100, whole number */
  score: number;
  parts: Record<ScoreKey, ScorePart>;
  /** the one thing that cost the most points; null when nothing cost a point */
  fix: { key: ScoreKey; title: string; text: string } | null;
}

export interface ScoreInput {
  miles: number;
  hardBrakes: number;
  fastStarts: number;
  /** miles more than 2 mph over the posted limit */
  overMi: number;
}

const CURVE: Record<ScoreKey, { max: number; half: number }> = {
  brakes: { max: 45, half: 5 },
  starts: { max: 20, half: 5 },
  speed: { max: 35, half: 0.2 },
};
/** short drives count as this long, so one event on a tiny drive isn't the whole score */
const MIN_MI = 2;

const lose = (k: ScoreKey, rate: number) => (rate > 0 ? (CURVE[k].max * rate) / (rate + CURVE[k].half) : 0);
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Whole points lost per part that add up to exactly total: floors, then the biggest leftovers get a point. */
function splitLost(raw: Record<ScoreKey, number>, total: number): Record<ScoreKey, number> {
  const keys = ['brakes', 'starts', 'speed'] as const, out = { brakes: 0, starts: 0, speed: 0 };
  for (const k of keys) out[k] = Math.floor(raw[k]);
  let left = total - keys.reduce((t, k) => t + out[k], 0);
  for (const k of [...keys].filter((k) => raw[k] > out[k]).sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]))) {
    if (left <= 0) break;
    out[k]++;
    left--;
  }
  return out;
}

export function scoreDrive(x: ScoreInput): Score {
  const mi = Math.max(x.miles, MIN_MI);
  const rate = { brakes: (x.hardBrakes / mi) * 10, starts: (x.fastStarts / mi) * 10, speed: x.miles > 0 ? Math.min(x.overMi / x.miles, 1) : 0 };
  const count = { brakes: x.hardBrakes, starts: x.fastStarts, speed: x.overMi };
  const raw = { brakes: lose('brakes', rate.brakes), starts: lose('starts', rate.starts), speed: lose('speed', rate.speed) };
  const score = Math.max(0, Math.min(100, Math.round(100 - raw.brakes - raw.starts - raw.speed)));
  const lost = splitLost(raw, 100 - score);
  const parts = {} as Record<ScoreKey, ScorePart>;
  for (const k of ['brakes', 'starts', 'speed'] as const) parts[k] = { key: k, lost: lost[k], max: CURVE[k].max, count: count[k], rate: rate[k] };
  const worst = (['brakes', 'starts', 'speed'] as const).reduce((a, b) => (raw[b] > raw[a] ? b : a));
  return { score, parts, fix: raw[worst] >= 0.5 ? fixFor(worst, x) : null };
}

function fixFor(k: ScoreKey, x: ScoreInput): { key: ScoreKey; title: string; text: string } {
  switch (k) {
    case 'brakes':
      return { key: k, title: 'Brake earlier', text: `You braked hard ${times(x.hardBrakes)}. Start slowing sooner so you can stop gently.` };
    case 'starts':
      return { key: k, title: 'Speed up gently', text: `You sped up fast ${times(x.fastStarts)}. Press the gas slowly when you pull away.` };
    case 'speed': {
      const pct = Math.max(1, Math.round((Math.min(x.overMi / Math.max(x.miles, 1e-9), 1)) * 100));
      return { key: k, title: 'Keep to the speed limit', text: `You were over the speed limit for ${pct}% of the drive. On the highway, going faster burns more gas.` };
    }
  }
}
