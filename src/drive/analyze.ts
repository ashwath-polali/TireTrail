// Runs on the phone after a recording or GPX import. Nothing leaves the device.
import type { LngLat } from '../geo/geo.ts';
import type { DrainInfo, DrainPath } from '../data/tiretrail.ts';
import { DEFAULT_DUST_OPTIONS, estimateDust, severity, wearVsGentleStop, type DustEstimate, type DustOptions } from './dust.ts';
import { buildSignals, DEFAULT_SIGNAL_OPTIONS, distanceM, type SignalOptions } from './signal.ts';
import { DEFAULT_STOP_OPTIONS, detectStops, type Stop, type StopOptions } from './stops.ts';
import { GENERAL_TIPS, stopClass, stopTip, type StopClass, type Tip } from './tips.ts';
import type { Fix } from './types.ts';

// subset of TireTrailData
export interface DrainLookup {
  nearestDrain(p: LngLat, maxM?: number): { drain: DrainInfo; distanceM: number } | null;
  path(drain: number): DrainPath;
}

export interface StopReport extends Stop {
  /** nearest drain within 50 m */
  drain: DrainInfo | null;
  drainDistanceM: number | null;
  path: DrainPath | null;
  cls: StopClass;
  /** false where TireTrail has no pipe maps at all */
  mapped: boolean;
  tip: string;
  /** share of trip wear during this stop's braking */
  wearShare: number;
  /** vs a gentle 1 m/s² stop from the same speed */
  wearVsGentle: number;
}

export interface DriveReport {
  fixes: number;
  usedFixes: number;
  durationS: number;
  distanceKm: number;
  speedSource: 'device' | 'positions';
  stops: Stop[];
  /** up to 3, hardest first */
  hardest: StopReport[];
  hardestWearShare: number;
  dust: DustEstimate;
  tips: readonly Tip[];
  warnings: string[];
}

export interface DriveOptions {
  signal?: SignalOptions;
  stops?: StopOptions;
  dust?: DustOptions;
  maxDrainM?: number;
  top?: number;
  /** a drain's class, when the data knows more classes than DrainInfo names */
  clsOf?: (drain: DrainInfo) => StopClass;
  /** false where TireTrail has no pipe maps at all */
  covered?: (p: LngLat) => boolean;
}

export function analyzeDrive(fixes: readonly Fix[], city: DrainLookup, options: DriveOptions = {}): DriveReport {
  const dustOpts = options.dust ?? DEFAULT_DUST_OPTIONS;
  const sig = buildSignals(fixes, options.signal ?? DEFAULT_SIGNAL_OPTIONS);
  const used = sig.segments.reduce((n, s) => n + s.t.length, 0);
  const warnings: string[] = [];
  if (used < 10) warnings.push('Too few GPS readings to analyze this drive.');
  if (used && sig.speedSource === 'positions') {
    warnings.push('This recording has no GPS speed readings, so speeds were worked out from positions and stop hardness is less precise.');
  }
  const gapS = sig.segments.slice(1).reduce((sum, s, k) => sum + (s.t[0] - sig.segments[k].t[sig.segments[k].t.length - 1]), 0);
  if (gapS > 0) warnings.push(`GPS paused for ${Math.round(gapS)} s (screen locked or app hidden). Those stretches can't be analyzed.`);

  const meters = distanceM(sig);
  const stops = detectStops(sig, options.stops ?? DEFAULT_STOP_OPTIONS);
  const dust = estimateDust(sig, meters, dustOpts);

  // each stop's wear as a share of the trip (central cornering weight)
  const { s, dm } = severity(sig, dustOpts);
  const lat = dustOpts.lateralWeight.central * dustOpts.refLatSD ** 2;
  let total = 0;
  s.forEach((seg, k) => seg.forEach((x, i) => (total += (x + lat) * dm[k][i])));
  const shareOf = (st: Stop) => {
    let part = 0;
    for (let i = st.from; i <= st.to; i++) part += (s[st.segment][i] + lat) * dm[st.segment][i];
    return total > 0 ? part / total : 0;
  };

  const hardest = [...stops]
    .sort((a, b) => b.peakDecel - a.peakDecel || a.t - b.t)
    .slice(0, options.top ?? 3)
    .map((st): StopReport => {
      const near = city.nearestDrain(st.lngLat, options.maxDrainM ?? 50);
      const cls: StopClass = near ? (options.clsOf?.(near.drain) ?? stopClass(near.drain.cls)) : 'none';
      const mapped = !!near || (options.covered?.(st.lngLat) ?? true);
      return {
        ...st,
        drain: near?.drain ?? null,
        drainDistanceM: near ? Math.round(near.distanceM * 10) / 10 : null,
        path: near ? city.path(near.drain.index) : null,
        cls,
        mapped,
        tip: stopTip(cls, st.hard, near?.drain.receiving ?? '', near?.drain.code ?? '', mapped),
        wearShare: shareOf(st),
        wearVsGentle: wearVsGentleStop(st.meanDecel, st.entrySpeed, dustOpts),
      };
    });

  const all = sig.segments.flatMap((x) => x.t);
  return {
    fixes: fixes.length,
    usedFixes: used,
    durationS: all.length ? all[all.length - 1] - all[0] : 0,
    distanceKm: meters / 1000,
    speedSource: sig.speedSource,
    stops,
    hardest,
    hardestWearShare: hardest.reduce((sum, h) => sum + h.wearShare, 0),
    dust,
    tips: GENERAL_TIPS,
    warnings,
  };
}
