// A drive's route cut into colored stretches, each with what happened and what to do, in plain words with real numbers.
// smooth; firm = braking 4 to 7 mph per second; hard = a hard brake (7 or more); fast-start = speeding up 7 or more;
// speeding = more than 5 mph over a known posted limit.
import type { LngLat } from '../../geo/geo.ts';
import { soonerText } from '../advice.ts';
import { DEFAULT_DUST_OPTIONS, severity } from '../dust.ts';
import { HARD_MPS2, headingAt, rates } from '../events.ts';
import { DEFAULT_MONEY_OPTIONS, gasCost, tireCost, type MoneyOptions } from '../money.ts';
import type { MotionLookup } from '../motion.ts';
import { movingAt } from '../rate.ts';
import { buildSignals } from '../signal.ts';
import { GAS_FROM_MPH } from '../speeding.ts';
import { detectStops } from '../stops.ts';
import type { Fix } from '../types.ts';
import type { LimitLookup } from './live.ts';
import { distText } from './words.ts';

const MPH = 0.44704;
const M_PER_MI = 1609.344;
/** 4 mph per second, m/s² */
export const FIRM_MPS2 = 4 * MPH;
/** more than this many mph over counts */
export const REPLAY_OVER_MPH = 5;

export type StretchKind = 'smooth' | 'firm' | 'hard' | 'fast-start' | 'speeding';

export interface Stretch {
  kind: StretchKind;
  /** indexes into Replay.points, inclusive */
  from: number;
  to: number;
  /** one line: what happened */
  what: string;
  /** one line: what to do */
  todo: string;
  miles: number;
  seconds: number;
  /** mph at the start and end, and the top */
  fromMph: number;
  toMph: number;
  topMph: number;
  /** posted limit, speeding only */
  limitMph: number | null;
  /** route number or street, '' if unknown */
  road: string;
  /** typical dollars it cost: gas (speeding) or tire wear (a hard stop); 0 otherwise. Hard starts and stops' gas is in the report's money. */
  usd: number;
}

export interface Replay {
  /** every GPS reading used, in order */
  points: LngLat[];
  /** mph at each point */
  mph: number[];
  /** indexes where GPS picked up again after a pause (don't draw a line into them) */
  breaks: number[];
  stretches: Stretch[];
}

export interface ReplayOptions {
  limits?: LimitLookup | null;
  /** street name at a point, '' if none */
  nameOf?: (p: LngLat) => string;
  money?: MoneyOptions;
  /** the phone's motion sensor for this drive, if it had one */
  motion?: MotionLookup | null;
}

interface Run { kind: StretchKind; seg: number; from: number; to: number; limit: number | null; road: string }

const round = (x: number) => Math.round(x);

export function replayDrive(fixes: readonly Fix[], o: ReplayOptions = {}): Replay {
  const sig = buildSignals(fixes, undefined, o.motion ?? null);
  const money = o.money ?? DEFAULT_MONEY_OPTIONS;
  const stops = detectStops(sig);
  const { s: sev, dm } = severity(sig, DEFAULT_DUST_OPTIONS);
  const perStop = tireCost(stops, sev, dm, money).perStop;
  const nameOf = (p: LngLat) => { try { return o.nameOf?.(p) ?? ''; } catch { return ''; } };

  const points: LngLat[] = [], mph: number[] = [], breaks: number[] = [], stretches: Stretch[] = [];
  let base = 0;
  sig.segments.forEach((s, seg) => {
    const n = s.t.length, r = rates(s);
    if (seg > 0) breaks.push(base);
    for (let i = 0; i < n; i++) {
      points.push(sig.projection.toLngLat(s.xy[i]));
      mph.push(s.v[i] / MPH);
    }
    const moving = (i: number) => movingAt(s.v, i);
    const kind: (StretchKind | null)[] = new Array(n).fill(null);

    // braking and speeding-up runs, named by their peak
    for (const sign of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        if (!(sign * r[i] >= FIRM_MPS2 && moving(i))) continue;
        let j = i, peak = 0;
        while (j < n && sign * r[j] >= FIRM_MPS2 && moving(j)) peak = Math.max(peak, sign * r[j++]);
        const k: StretchKind | null = sign < 0 ? (peak >= HARD_MPS2 ? 'hard' : 'firm') : peak >= HARD_MPS2 ? 'fast-start' : null;
        if (k) for (let x = i; x < j; x++) kind[x] = k;
        i = j - 1;
      }
    }

    // speeding where a limit is known
    const lim: ({ mph: number; road: string } | null)[] = new Array(n).fill(null);
    if (o.limits) {
      for (let i = 0; i < n; i++) {
        const m = s.v[i] / MPH;
        if (m < 10) continue;
        const l = o.limits.at(sig.projection.toLngLat(s.xy[i]), headingAt(s, i, 30));
        if (l && m > l.mph + REPLAY_OVER_MPH) lim[i] = { mph: l.mph, road: l.ref || l.name };
      }
      // a dip of 5 s or less under the limit doesn't split a stretch
      let last = -1;
      for (let i = 0; i < n; i++) {
        if (!lim[i]) continue;
        if (last >= 0 && i - last > 1 && s.t[i] - s.t[last] <= 6 && lim[last]!.mph === lim[i]!.mph) for (let x = last + 1; x < i; x++) if (!kind[x]) lim[x] = lim[i];
        last = i;
      }
      for (let i = 0; i < n; i++) if (!kind[i] && lim[i]) kind[i] = 'speeding';
    }

    // runs of the same kind (and the same limit)
    const runs: Run[] = [];
    for (let i = 0; i < n; i++) {
      const k = kind[i] ?? 'smooth', l = k === 'speeding' ? lim[i] : null, cur = runs[runs.length - 1];
      if (cur && cur.kind === k && cur.limit === (l?.mph ?? null)) cur.to = i;
      else runs.push({ kind: k, seg, from: i, to: i, limit: l?.mph ?? null, road: l?.road ?? '' });
    }

    for (const run of runs) {
      const { from, to } = run;
      let m = 0;
      for (let i = from + 1; i <= to; i++) m += ((s.v[i] + s.v[i - 1]) / 2) * (s.t[i] - s.t[i - 1]);
      // a run's speed change includes the reading just before and after it
      const a = Math.max(from - 1, 0), b = Math.min(to + 1, n - 1);
      const vs = s.v.slice(from, to + 1), top = Math.max(...vs) / MPH;
      const fromMph = run.kind === 'hard' || run.kind === 'firm' ? Math.max(s.v[a], s.v[from]) / MPH : run.kind === 'fast-start' ? Math.min(s.v[a], s.v[from]) / MPH : s.v[from] / MPH;
      const toMph = run.kind === 'hard' || run.kind === 'firm' ? Math.min(s.v[b], s.v[to]) / MPH : run.kind === 'fast-start' ? Math.max(s.v[b], s.v[to]) / MPH : s.v[to] / MPH;
      const peak = Math.max(...r.slice(from, to + 1).map((x) => Math.abs(x))) / MPH;
      const mid = sig.projection.toLngLat(s.xy[(from + to) >> 1]);
      const road = run.road || nameOf(mid);
      const st = run.kind === 'hard' || run.kind === 'firm' ? stops.find((x) => x.segment === seg && x.to >= from && x.from <= to + 2) : undefined;
      const miles = m / M_PER_MI;
      let usd = 0, what = '', todo = '';
      const at = road ? ` on ${road}` : '';
      switch (run.kind) {
        case 'smooth':
          what = `Smooth for ${distText(miles)}${at}.`;
          todo = 'Nothing to change here.';
          break;
        case 'firm':
          what = st ? `Firm stop from ${round(fromMph)} mph${at}, about ${round(peak)} mph slower each second.` : `Firm braking from ${round(fromMph)} to ${round(toMph)} mph${at}.`;
          todo = 'Fine. Lifting off the gas a little sooner makes it gentle.';
          break;
        case 'hard': {
          what = st && st.hard ? `You braked hard to a stop from ${round(fromMph)} mph${at}, losing ${round(peak)} mph in one second.` : `You braked hard from ${round(fromMph)} to ${round(toMph)} mph${at}, losing ${round(peak)} mph in one second.`;
          usd = st ? perStop[st.index] ?? 0 : 0;
          const sooner = st ? soonerText(st.entrySpeed, st.brakingM) : null;
          todo = sooner ? `${sooner} It saves gas and tire wear.` : 'Leave more room ahead and ease off sooner here.';
          break;
        }
        case 'fast-start':
          what = `You sped up fast from ${round(fromMph)} to ${round(toMph)} mph${at}, gaining ${round(peak)} mph in one second.`;
          todo = 'Press the gas more slowly as you pull away.';
          break;
        case 'speeding': {
          const limit = run.limit!;
          // gas counts only above both the limit and 50 mph, as in speeding.ts
          let steps = 0;
          for (let i = from; i <= to; i++) {
            const dmi = (s.v[i] * ((i + 1 < n ? s.t[i + 1] : s.t[i]) - (i > 0 ? s.t[i - 1] : s.t[i]))) / 2 / M_PER_MI;
            steps += dmi * (Math.max(s.v[i] / MPH - Math.max(limit, GAS_FROM_MPH), 0) / 5);
          }
          usd = gasCost({ gasSteps: steps }, money).typical;
          what = `You went ${round(top)} in a ${limit}${at} for ${distText(miles)}.`;
          todo = usd > 0 ? `Easing off to ${limit} here saves gas.` : `Ease off to ${limit} here.`;
          break;
        }
      }
      stretches.push({ kind: run.kind, from: base + from, to: base + to, what, todo, miles, seconds: s.t[to] - s.t[from], fromMph, toMph, topMph: top, limitMph: run.limit, road, usd });
    }
    base += n;
  });
  return { points, mph, breaks, stretches };
}

/** The stretches worth a look (not smooth), worst first: hard, fast starts, speeding by cost, then firm. */
export function worstStretches(r: Replay, n = 3): Stretch[] {
  const rank: Record<StretchKind, number> = { hard: 0, 'fast-start': 1, speeding: 2, firm: 3, smooth: 4 };
  return r.stretches.filter((s) => s.kind !== 'smooth').sort((a, b) => rank[a.kind] - rank[b.kind] || b.usd - a.usd || a.from - b.from).slice(0, n);
}
