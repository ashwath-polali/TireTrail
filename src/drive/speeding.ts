// Where the drive went faster than the posted limit (limits.ts knows big roads only).
import type { LngLat } from '../geo/geo.ts';
import { headingAt } from './events.ts';
import type { SpeedLimits } from './limits.ts';
import type { Signals } from './signal.ts';

const MPH = 0.44704;
const M_PER_MI = 1609.344;
/** GPS speed can be a little off, so "over" means more than this many mph over */
export const OVER_MPH = 2;
/** fueleconomy.gov: mileage drops above 50 mph */
export const GAS_FROM_MPH = 50;

export interface SpeedingStretch {
  /** ms */
  from: number;
  to: number;
  limitMph: number;
  topMph: number;
  miles: number;
  /** this stretch's share of Speeding.gasSteps */
  gasSteps: number;
  /** route number or street name, '' if none */
  road: string;
  /** for drawing it on the map */
  path: LngLat[];
}

export interface Speeding {
  /** miles on roads with a known posted limit */
  knownMi: number;
  /** miles more than 2 mph over the posted limit */
  overMi: number;
  /** overMi as a share of the whole drive (0 to 1) */
  share: number;
  /** sum of miles x (mph over the higher of the limit and 50) / 5, for the gas cost */
  gasSteps: number;
  stretches: SpeedingStretch[];
}

export const NO_SPEEDING: Speeding = { knownMi: 0, overMi: 0, share: 0, gasSteps: 0, stretches: [] };

export function findSpeeding(sig: Signals, limits: SpeedLimits | null | undefined, totalM: number): Speeding {
  if (!limits) return NO_SPEEDING;
  let known = 0, over = 0, gasSteps = 0;
  const stretches: SpeedingStretch[] = [];
  for (const s of sig.segments) {
    let cur: SpeedingStretch | null = null;
    for (let i = 0; i < s.t.length; i++) {
      // meters this reading covers: half the gap to each neighbor
      const dm = (s.v[i] * ((i + 1 < s.t.length ? s.t[i + 1] : s.t[i]) - (i > 0 ? s.t[i - 1] : s.t[i]))) / 2;
      const mph = s.v[i] / MPH;
      const lim = mph >= 10 ? limits.at(sig.projection.toLngLat(s.xy[i]), headingAt(s, i, 30)) : null;
      const isOver = !!lim && mph > lim.mph + OVER_MPH;
      if (lim) known += dm;
      if (isOver) {
        over += dm;
        // gas: only the part above both the limit and 50 mph
        const steps = (dm / M_PER_MI) * (Math.max(mph - Math.max(lim.mph, GAS_FROM_MPH), 0) / 5);
        gasSteps += steps;
        const t = sig.t0 + s.t[i] * 1000;
        // a short dip under the limit (or a missed road match) doesn't split a stretch
        if (!cur || t - cur.to > 5000 || cur.limitMph !== lim.mph) stretches.push((cur = { from: t, to: t, limitMph: lim.mph, topMph: mph, miles: 0, gasSteps: 0, road: lim.ref || lim.name, path: [] }));
        cur.gasSteps += steps;
        cur.to = t;
        cur.topMph = Math.max(cur.topMph, mph);
        cur.miles += dm / M_PER_MI;
        cur.path.push(sig.projection.toLngLat(s.xy[i]));
      }
    }
  }
  return { knownMi: known / M_PER_MI, overMi: over / M_PER_MI, share: totalM > 0 ? Math.min(over / totalM, 1) : 0, gasSteps, stretches };
}
