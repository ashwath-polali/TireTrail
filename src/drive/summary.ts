// A drive in a few hundred bytes: what progress and hard-brake spots need, kept long after the full track is dropped.
import type { HardBrake, DriveReport } from './analyze.ts';
import type { Usd } from './money.ts';
import { stopClass, type StopClass } from './tips.ts';

/** one hard brake, as saved */
export interface BrakePoint {
  /** ms */
  t: number;
  lat: number;
  lon: number;
  /** degrees from north, null if unknown */
  heading: number | null;
  /** slowed 10 mph or more in one second */
  veryHard: boolean;
  /** where its rain goes; 'creek' = a salmon stream */
  cls: StopClass;
  /** street, '' if unknown */
  name: string;
}

export interface DriveSummary {
  v: 2;
  /** ms, when the drive started (the saved drive's id) */
  at: number;
  mi: number;
  min: number;
  /** smooth score 0 to 100 */
  score: number;
  /** points lost to each part */
  lost: { brakes: number; starts: number; speed: number };
  hardBrakes: number;
  fastStarts: number;
  /** miles over the posted limit */
  overMi: number;
  stops: number;
  hardStops: number;
  /** extra gas from speeding, dollars */
  gas: Usd;
  /** extra tire wear from hard stops, dollars */
  tires: Usd;
  /** hard brakes whose rain reaches a salmon stream */
  salmon: number;
  brakes: BrakePoint[];
}

const r = (x: number, k: number) => Math.round(x * 10 ** k) / 10 ** k;
const usd = (u: Usd): Usd => ({ low: r(u.low, 4), typical: r(u.typical, 4), high: r(u.high, 4) });

export function brakePoint(b: HardBrake): BrakePoint {
  return { t: b.t, lat: r(b.lngLat[1], 6), lon: r(b.lngLat[0], 6), heading: b.heading == null ? null : Math.round(b.heading), veryHard: b.veryHard, cls: b.cls, name: b.name };
}

/** The summary to save with a drive. */
export function summarize(report: DriveReport, at: number): DriveSummary {
  const { score, money } = report;
  return {
    v: 2,
    at,
    mi: r(report.miles, 3),
    min: r(report.durationS / 60, 1),
    score: score.score,
    lost: { brakes: score.parts.brakes.lost, starts: score.parts.starts.lost, speed: score.parts.speed.lost },
    hardBrakes: report.brakes.length,
    fastStarts: report.events.filter((e) => e.kind === 'start').length,
    overMi: r(report.speeding.overMi, 3),
    stops: report.stops.length,
    hardStops: report.stops.filter((s) => s.hard).length,
    gas: usd(money.gas),
    tires: usd(money.tires),
    salmon: report.brakes.filter((b) => b.salmon).length,
    brakes: report.brakes.map(brakePoint),
  };
}

const isUsd = (u: unknown): u is Usd => !!u && typeof u === 'object' && ['low', 'typical', 'high'].every((k) => Number.isFinite((u as Record<string, unknown>)[k]));
const ZERO: Usd = { low: 0, typical: 0, high: 0 };
const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/** A stored summary made safe to use (older or damaged ones get defaults), or null if it can't be. */
export function readSummary(x: unknown): DriveSummary | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (!Number.isFinite(o.at) || !Number.isFinite(o.mi) || !Number.isFinite(o.score)) return null;
  const lost = (o.lost ?? {}) as Record<string, unknown>;
  const brakes = (Array.isArray(o.brakes) ? o.brakes : []).filter((b): b is BrakePoint => !!b && Number.isFinite(b.lat) && Number.isFinite(b.lon) && Number.isFinite(b.t))
    .map((b) => ({ t: b.t, lat: b.lat, lon: b.lon, heading: Number.isFinite(b.heading) ? b.heading : null, veryHard: b.veryHard === true, cls: stopClass(b.cls), name: typeof b.name === 'string' ? b.name : '' }));
  return {
    v: 2,
    at: o.at as number,
    mi: o.mi as number,
    min: num(o.min),
    score: o.score as number,
    lost: { brakes: num(lost.brakes), starts: num(lost.starts), speed: num(lost.speed) },
    hardBrakes: num(o.hardBrakes, brakes.length),
    fastStarts: num(o.fastStarts),
    overMi: num(o.overMi),
    stops: num(o.stops),
    hardStops: num(o.hardStops),
    gas: isUsd(o.gas) ? o.gas : ZERO,
    tires: isUsd(o.tires) ? o.tires : ZERO,
    salmon: num(o.salmon),
    brakes,
  };
}
