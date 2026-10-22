// Runs on the phone after a recording or GPX import. Nothing leaves the device.
import type { LngLat } from '../geo/geo.ts';
import type { DrainInfo, DrainPath } from '../data/tiretrail.ts';
import { gentleStopFt, soonerS } from './advice.ts';
import { DEFAULT_DUST_OPTIONS, estimateDust, severity, wearVsGentleStop, type DustEstimate, type DustOptions, type Vehicle } from './dust.ts';
import { linkStops, speedEvents, type SpeedEvent } from './events.ts';
import type { SpeedLimits } from './limits.ts';
import type { MotionLookup } from './motion.ts';
import { DEFAULT_MONEY_OPTIONS, driveMoney, paceOf, type DriveMoney, type MoneyOptions } from './money.ts';
import { scoreDrive, type Score } from './score.ts';
import { buildSignals, DEFAULT_SIGNAL_OPTIONS, distanceM, type SignalOptions } from './signal.ts';
import { findSpeeding, type Speeding } from './speeding.ts';
import { DEFAULT_STOP_OPTIONS, detectStops, type Stop, type StopOptions } from './stops.ts';
import { GENERAL_TIPS, stopClass, stopTip, type StopClass, type Tip } from './tips.ts';
import type { Fix } from './types.ts';

const M_PER_MI = 1609.344;

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
  /** @deprecated overstates the wear (money spec 7); don't show it. Kept until drive-screen.ts stops using it. */
  wearVsGentle: number;
  /** extra tire wear from this stop, typical dollars (0 unless hard) */
  tiresUsd: number;
  /** seconds sooner to start slowing for a gentle stop; 0 if it was gentle */
  soonerS: number;
  /** feet a gentle stop takes from this stop's speed */
  gentleFt: number;
}

/** a hard brake, with where its rain goes */
export interface HardBrake extends SpeedEvent {
  kind: 'brake';
  cls: StopClass;
  /** the water its drain reaches, '' if none */
  receiving: string;
  /** its rain reaches a salmon stream */
  salmon: boolean;
  /** false where TireTrail has no pipe maps at all */
  mapped: boolean;
  /** street, '' if unknown */
  name: string;
  /** gas this hard brake wasted, typical dollars (money.ts) */
  gasUsd: number;
}

export interface DriveReport {
  fixes: number;
  usedFixes: number;
  durationS: number;
  distanceKm: number;
  /** distanceKm in miles */
  miles: number;
  speedSource: 'device' | 'positions';
  /** every full stop; each has hard (slowed 7 mph or more in one second) */
  stops: Stop[];
  /** up to 3, hardest first */
  hardest: StopReport[];
  /** every hard stop with its drain, in the order driven */
  hardStops: StopReport[];
  /** every hard brake (with or without a stop after it), in the order driven */
  brakes: HardBrake[];
  /** hard brakes and fast starts, in the order driven */
  events: SpeedEvent[];
  /** where it went over the posted limit; empty if limits weren't loaded */
  speeding: Speeding;
  /** false when no posted limits were given, so speeding wasn't checked */
  limitsChecked: boolean;
  /** the motion sensor checked hard brakes and fast starts on this drive */
  sensor: boolean;
  /** what the drive cost: gas from hard starts and stops and from speeding, and tire wear from hard stops, with ranges */
  money: DriveMoney;
  /** smooth score 0 to 100, its parts, and the one thing to fix */
  score: Score;
  hardestWearShare: number;
  dust: DustEstimate;
  tips: readonly Tip[];
  warnings: string[];
}

export interface DriveOptions {
  signal?: SignalOptions;
  stops?: StopOptions;
  dust?: DustOptions;
  money?: MoneyOptions;
  /** posted limits (limits.ts loadLimits); without them speeding isn't checked */
  limits?: SpeedLimits | null;
  maxDrainM?: number;
  top?: number;
  /** a drain's class, when the data knows more classes than DrainInfo names */
  clsOf?: (drain: DrainInfo) => StopClass;
  /** false where TireTrail has no pipe maps at all */
  covered?: (p: LngLat) => boolean;
  /** street name at a point, '' if none */
  nameOf?: (p: LngLat) => string;
  /** the phone's motion sensor for this drive (motion.ts), if it had one */
  motion?: MotionLookup | null;
  /** what the driver said they drive; a typical car without it */
  vehicle?: Vehicle;
}

export function analyzeDrive(fixes: readonly Fix[], city: DrainLookup, options: DriveOptions = {}): DriveReport {
  const dustOpts = options.dust ?? DEFAULT_DUST_OPTIONS;
  const sig = buildSignals(fixes, options.signal ?? DEFAULT_SIGNAL_OPTIONS, options.motion ?? null);
  const used = sig.segments.reduce((n, s) => n + s.t.length, 0);
  const warnings: string[] = [];
  if (used < 10) warnings.push('Too few location readings to check this drive.');
  if (used && sig.speedSource === 'positions') {
    warnings.push('This drive has no speed readings, so speeds come from positions and hard brakes are less exact.');
  }
  const gapS = sig.segments.slice(1).reduce((sum, s, k) => sum + (s.t[0] - sig.segments[k].t[sig.segments[k].t.length - 1]), 0);
  if (gapS > 0) warnings.push(`Recording paused for ${Math.round(gapS)} sec while the screen was off or TireTrail was hidden. Those parts aren't checked.`);

  const meters = distanceM(sig);
  const stops = detectStops(sig, options.stops ?? DEFAULT_STOP_OPTIONS);
  const events = linkStops(speedEvents(sig), stops);
  const dust = estimateDust(sig, meters, dustOpts, events, options.motion ?? null, options.vehicle ?? dustOpts.vehicle);
  const speeding = findSpeeding(sig, options.limits, meters);

  // each stop's wear as a share of the trip (central cornering weight)
  const { s, dm } = severity(sig, dustOpts);
  const moneyOpts = options.money ?? DEFAULT_MONEY_OPTIONS;
  const money = driveMoney(stops, s, dm, meters, speeding, paceOf(sig, events, moneyOpts), moneyOpts, dustOpts);
  const lat = dustOpts.lateralWeight.central * dustOpts.refLatSD ** 2;
  let total = 0;
  s.forEach((seg, k) => seg.forEach((x, i) => (total += (x + lat) * dm[k][i])));
  const shareOf = (st: Stop) => {
    let part = 0;
    for (let i = st.from; i <= st.to; i++) part += (s[st.segment][i] + lat) * dm[st.segment][i];
    return total > 0 ? part / total : 0;
  };

  const where = (p: LngLat) => {
    const near = city.nearestDrain(p, options.maxDrainM ?? 50);
    const cls: StopClass = near ? (options.clsOf?.(near.drain) ?? stopClass(near.drain.cls)) : 'none';
    return { near, cls, mapped: !!near || (options.covered?.(p) ?? true) };
  };
  const report = (st: Stop): StopReport => {
    const { near, cls, mapped } = where(st.lngLat);
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
      tiresUsd: money.perStop[st.index] ?? 0,
      soonerS: st.hard ? soonerS(st.entrySpeed, st.brakingM) : 0,
      gentleFt: gentleStopFt(st.entrySpeed),
    };
  };

  const hardest = [...stops]
    .sort((a, b) => b.peakDecel - a.peakDecel || a.t - b.t)
    .slice(0, options.top ?? 3)
    .map(report);
  const hardStops = stops.filter((st) => st.hard).map((st) => hardest.find((h) => h.index === st.index) ?? report(st));

  // a brake that ended in a stop shares that stop's drain, like its pin
  const brakes = events.flatMap((e, k): HardBrake[] => {
    if (e.kind !== 'brake') return [];
    const st = e.stop >= 0 ? hardStops.find((h) => h.index === e.stop) ?? report(stops[e.stop]) : null;
    const w = st ? { near: st.drain ? { drain: st.drain } : null, cls: st.cls, mapped: st.mapped } : where(e.lngLat);
    return [{ ...e, kind: 'brake', cls: w.cls, receiving: w.near?.drain.receiving ?? '', salmon: w.cls === 'creek', mapped: w.mapped, name: options.nameOf?.(st?.lngLat ?? e.lngLat) ?? '', gasUsd: money.perEvent[k] ?? 0 }];
  });

  const miles = meters / M_PER_MI;
  const score = scoreDrive({ miles, hardBrakes: brakes.length, fastStarts: events.filter((e) => e.kind === 'start').length, overMi: speeding.overMi });
  const all = sig.segments.flatMap((x) => x.t);
  return {
    fixes: fixes.length,
    usedFixes: used,
    durationS: all.length ? all[all.length - 1] - all[0] : 0,
    distanceKm: meters / 1000,
    miles,
    speedSource: sig.speedSource,
    stops,
    hardest,
    hardStops,
    brakes,
    events,
    speeding,
    limitsChecked: !!options.limits,
    sensor: sig.sensorReadings > 0,
    money,
    score,
    hardestWearShare: hardest.reduce((sum, h) => sum + h.wearShare, 0),
    dust,
    tips: GENERAL_TIPS,
    warnings,
  };
}
