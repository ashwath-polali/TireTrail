// A drive in a few hundred bytes: what progress and hard-brake spots need, kept long after the full track is dropped.
import { dist, localProjection, type LngLat } from '../geo/geo.ts';
import type { HardBrake, DriveReport } from './analyze.ts';
import { DEFAULT_MONEY_OPTIONS, hardGasGuess, type MoneyOptions, type Usd } from './money.ts';
import { stopClass, type StopClass } from './tips.ts';
import type { Fix } from './types.ts';

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
  /** gas it wasted, typical dollars; missing on drives saved before that was counted (brakeGas shares it out) */
  gas?: number;
}

/** one full stop, as saved (for stop spots and money leaks) */
export interface StopPoint {
  /** ms */
  t: number;
  lat: number;
  lon: number;
  /** degrees from north, null if unknown */
  heading: number | null;
  /** slowed 7 mph or more in one second */
  hard: boolean;
  /** extra tire wear, typical dollars (0 unless hard) */
  usd: number;
  /** street, '' if unknown */
  name: string;
}

/** one stretch over the posted limit, as saved */
export interface SpeedPoint {
  /** route number or street, '' if none */
  road: string;
  limitMph: number;
  topMph: number;
  mi: number;
  /** for money.ts gasCost */
  gasSteps: number;
  /** where it started */
  lat: number;
  lon: number;
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
  /** extra gas from speeding, dollars (the name is kept so older saved drives still read) */
  gas: Usd;
  /** gas wasted by hard brakes and fast starts, dollars; missing on older drives (hardGasOf estimates it) */
  hardGas?: Usd;
  /** extra tire wear from hard stops, dollars */
  tires: Usd;
  /** hard brakes whose rain reaches a salmon stream */
  salmon: number;
  brakes: BrakePoint[];
  /** every full stop; missing on drives saved before the coach */
  stopPts?: StopPoint[];
  /** stretches over the limit; missing on older drives */
  speeds?: SpeedPoint[];
  /** street names along the route, most driven first; missing on older drives */
  ways?: string[];
  /** coarse route, flat [lon, lat, lon, lat, ...]; kept on this phone only (readSummary drops it) */
  path?: number[];
  /** streets within HOME_M of the start or end; this phone only */
  near?: string[];
  /** the copy that left the phone (cloudSummary): nothing near the start or end */
  trim?: true;
}

const r = (x: number, k: number) => Math.round(x * 10 ** k) / 10 ** k;
const usd = (u: Usd): Usd => ({ low: r(u.low, 4), typical: r(u.typical, 4), high: r(u.high, 4) });

export function brakePoint(b: HardBrake): BrakePoint {
  return { t: b.t, lat: r(b.lngLat[1], 6), lon: r(b.lngLat[0], 6), heading: b.heading == null ? null : Math.round(b.heading), veryHard: b.veryHard, cls: b.cls, name: b.name, gas: r(b.gasUsd, 5) };
}

const P = localProjection();

/** A coarse route: a point every 100 m or more, at most about 60, as flat [lon, lat, ...] to 5 decimals. */
export function coarsePath(fixes: readonly Fix[]): number[] {
  const pts = fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && !(typeof f.accuracy === 'number' && f.accuracy > 50)).map((f) => P.toXY([f.lon, f.lat]));
  if (!pts.length) return [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  const gap = Math.max(100, len / 60);
  const keep = [pts[0]];
  for (const p of pts) if (dist(keep[keep.length - 1], p) >= gap) keep.push(p);
  const last = pts[pts.length - 1];
  if (keep.length === 1 || dist(keep[keep.length - 1], last) > 20) keep.push(last);
  return keep.flatMap((p) => P.toLngLat(p).map((x) => r(x, 5)));
}

/** The backup leaves out everything within this many meters of where a drive starts or ends (usually home). */
export const HOME_M = 300;

function meters(a: LngLat, b: LngLat): number {
  const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k), y = (b[1] - a[1]) * k;
  return Math.hypot(x, y) * 6_371_000;
}

const endsOf = (path: readonly number[] | undefined): LngLat[] => {
  const p = pathPoints(path);
  return p.length ? [p[0], p[p.length - 1]] : [];
};

/** where each drive started and ended (drives that kept their route) */
export const driveEnds = (drives: readonly Pick<DriveSummary, 'path'>[]): LngLat[] => drives.flatMap((d) => endsOf(d.path));

/** within HOME_M of either end */
export const nearEnds = (p: LngLat, ends: readonly LngLat[]): boolean => ends.some((e) => meters(e, p) <= HOME_M);

/** flat path to points */
export function pathPoints(path: readonly number[] | undefined): LngLat[] {
  const out: LngLat[] = [];
  if (!path) return out;
  for (let i = 0; i + 1 < path.length; i += 2) out.push([path[i], path[i + 1]]);
  return out;
}

export interface SummaryExtras {
  /** the drive's GPS fixes, for the coarse route */
  fixes?: readonly Fix[];
  /** street name at a point, '' if none */
  nameOf?: (p: LngLat) => string;
}

/** The summary to save with a drive. With fixes and nameOf it also keeps what the coach needs. */
export function summarize(report: DriveReport, at: number, extras: SummaryExtras = {}): DriveSummary {
  const { score, money } = report;
  const nameOf = (p: LngLat) => { try { return extras.nameOf?.(p) ?? ''; } catch { return ''; } };
  const path = extras.fixes ? coarsePath(extras.fixes) : [];
  const tally = new Map<string, number>();
  for (const p of pathPoints(path)) { const n = nameOf(p); if (n) tally.set(n, (tally.get(n) ?? 0) + 1); }
  for (const s of report.speeding.stretches) if (s.road) tally.set(s.road, (tally.get(s.road) ?? 0) + 1);
  const ends = endsOf(path), near = new Set<string>();
  for (const p of pathPoints(path)) if (nearEnds(p, ends)) { const n = nameOf(p); if (n) near.add(n); }
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
    gas: usd(money.speedGas),
    hardGas: usd(money.hardGas),
    tires: usd(money.tires),
    salmon: report.brakes.filter((b) => b.salmon).length,
    brakes: report.brakes.map(brakePoint),
    stopPts: report.stops.map((s): StopPoint => ({
      t: s.t, lat: r(s.lngLat[1], 5), lon: r(s.lngLat[0], 5), heading: s.heading == null ? null : Math.round(s.heading), hard: s.hard,
      usd: r(money.perStop[s.index] ?? 0, 5), name: report.brakes.find((b) => b.stop === s.index)?.name || nameOf(s.lngLat),
    })),
    speeds: report.speeding.stretches.map((s): SpeedPoint => ({
      // the steps money counted, so a stretch's gas matches the drive's
      road: s.road, limitMph: s.limitMph, topMph: r(s.topMph, 1), mi: r(s.miles, 3), gasSteps: r(s.gasSteps * money.speedKept, 5), lat: r(s.path[0]?.[1] ?? 0, 5), lon: r(s.path[0]?.[0] ?? 0, 5),
    })),
    ways: [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
    ...(path.length ? { path, near: [...near] } : {}),
  };
}

/**
 * The copy that leaves the phone: no route, and no brake, stop, speeding spot or street within HOME_M of the start or end.
 * A drive without its route keeps no places at all. The phone keeps the full summary.
 */
export function cloudSummary(s: DriveSummary): DriveSummary {
  const { path, near, ...rest } = s;
  if (s.trim) return rest;
  const ends = endsOf(path), hide = new Set(near);
  const keep = <T extends { lat: number; lon: number }>(xs: T[], name: (x: T) => string): T[] =>
    xs.filter((x) => {
      if (ends.length && !nearEnds([x.lon, x.lat], ends)) return true;
      hide.add(name(x));
      return false;
    });
  return {
    ...rest,
    brakes: keep(s.brakes, (b) => b.name),
    ...(s.stopPts ? { stopPts: keep(s.stopPts, (p) => p.name) } : {}),
    ...(s.speeds ? { speeds: keep(s.speeds, (p) => p.road) } : {}),
    ...(s.ways ? { ways: ends.length ? s.ways.filter((w) => !hide.has(w)) : [] } : {}),
    trim: true,
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
    .map((b) => ({
      t: b.t, lat: b.lat, lon: b.lon, heading: Number.isFinite(b.heading) ? b.heading : null, veryHard: b.veryHard === true, cls: stopClass(b.cls), name: typeof b.name === 'string' ? b.name : '',
      ...(typeof b.gas === 'number' && Number.isFinite(b.gas) && b.gas >= 0 ? { gas: b.gas } : {}),
    }));
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
    ...(isUsd(o.hardGas) ? { hardGas: o.hardGas } : {}),
    tires: isUsd(o.tires) ? o.tires : ZERO,
    salmon: num(o.salmon),
    brakes,
    ...extrasOf(o),
    ...(o.trim === true ? { trim: true as const } : {}),
  };
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown) => (typeof x === 'string' ? x : '');

// the coach's fields, cleaned; left out when the drive was saved without them. path is never read back here (it stays on the phone).
function extrasOf(o: Record<string, unknown>): Pick<DriveSummary, 'stopPts' | 'speeds' | 'ways' | 'near'> {
  const out: Pick<DriveSummary, 'stopPts' | 'speeds' | 'ways' | 'near'> = {};
  if (Array.isArray(o.stopPts)) {
    out.stopPts = o.stopPts.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && fin(p.lat) && fin(p.lon) && fin(p.t))
      .map((p) => ({ t: p.t as number, lat: p.lat as number, lon: p.lon as number, heading: fin(p.heading) ? p.heading : null, hard: p.hard === true, usd: Math.max(num(p.usd), 0), name: str(p.name) }));
  }
  if (Array.isArray(o.speeds)) {
    out.speeds = o.speeds.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && fin(p.limitMph) && fin(p.mi))
      .map((p) => ({ road: str(p.road), limitMph: p.limitMph as number, topMph: num(p.topMph), mi: p.mi as number, gasSteps: Math.max(num(p.gasSteps), 0), lat: num(p.lat), lon: num(p.lon) }));
  }
  if (Array.isArray(o.ways)) out.ways = o.ways.filter((w): w is string => typeof w === 'string' && !!w);
  if (Array.isArray(o.near)) out.near = o.near.filter((w): w is string => typeof w === 'string' && !!w);
  return out;
}

/** A flat path made safe, or undefined. */
export function readPath(x: unknown): number[] | undefined {
  return Array.isArray(x) && x.length >= 2 && x.length % 2 === 0 && x.every(fin) ? (x as number[]) : undefined;
}

/** what hardGasOf and brakeGas need from a saved drive */
export interface HardGasDrive {
  mi: number;
  hardBrakes?: number;
  fastStarts?: number;
  hardGas?: Usd;
  brakes?: readonly unknown[];
}

const hardCount = (s: HardGasDrive) => (s.hardBrakes ?? s.brakes?.length ?? 0) + (s.fastStarts ?? 0);

/** Gas wasted by hard starts and stops on a saved drive: as kept, or estimated from its counts for drives saved before. */
export function hardGasOf(s: HardGasDrive, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): Usd {
  return s.hardGas ?? hardGasGuess(s.mi, hardCount(s), o);
}

/** Gas one hard brake wasted, typical dollars: as kept, or an even share of the drive's for drives saved before. */
export function brakeGas(s: HardGasDrive, b: { gas?: number }, o: MoneyOptions = DEFAULT_MONEY_OPTIONS): number {
  if (typeof b.gas === 'number') return b.gas;
  const n = hardCount(s);
  return n > 0 ? hardGasOf(s, o).typical / n : 0;
}
