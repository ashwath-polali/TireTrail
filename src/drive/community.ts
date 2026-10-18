// What one drive adds to the shared community totals, and the scoreboard words. No names, no places.
import type { LngLat } from '../geo/geo.ts';
import type { DriveReport } from './analyze.ts';
import type { StopClass } from './tips.ts';

/** the most one drive may add; firestore.rules checks the same numbers */
export const MAX_ADD = { smoothStops: 60, salmonSmoothStops: 60, miles: 300 } as const;

export interface CommunityAdd {
  smoothStops: number;
  /** gentle stops whose drain reaches a salmon stream */
  salmonSmoothStops: number;
  miles: number;
}

export interface CommunityTotals extends CommunityAdd {
  drives: number;
  /** ms, null if unknown */
  updated: number | null;
}

/**
 * One drive's share. clsAt: where rain at a point goes (pass the app's drain lookup);
 * without it only the gentle stops among the report's hardest have a known drain.
 * Null for a drive too short to count.
 */
export function driveAdd(report: DriveReport, clsAt?: (p: LngLat) => StopClass): CommunityAdd | null {
  if (report.usedFixes < 10 || !(report.miles > 0)) return null;
  const gentle = report.stops.filter((s) => !s.hard);
  const salmon = clsAt
    ? gentle.filter((s) => clsAt(s.lngLat) === 'creek').length
    : report.hardest.filter((s) => !s.hard && s.cls === 'creek').length;
  return {
    smoothStops: Math.min(gentle.length, MAX_ADD.smoothStops),
    salmonSmoothStops: Math.min(salmon, gentle.length, MAX_ADD.salmonSmoothStops),
    miles: Math.min(Math.round(report.miles * 100) / 100, MAX_ADD.miles),
  };
}

type Value = { integerValue?: string; doubleValue?: number; timestampValue?: string };
const n = (v: Value | undefined) => {
  const x = Number(v?.integerValue ?? v?.doubleValue);
  return Number.isFinite(x) && x >= 0 ? x : 0;
};

/** Totals from a Firestore REST document, or null if it isn't one. */
export function totalsFromRest(doc: unknown): CommunityTotals | null {
  const f = (doc as { fields?: Record<string, Value> } | null)?.fields;
  if (!f || typeof f !== 'object') return null;
  const t = Date.parse(f.updated?.timestampValue ?? '');
  return { drives: n(f.drives), smoothStops: n(f.smoothStops), salmonSmoothStops: n(f.salmonSmoothStops), miles: n(f.miles), updated: Number.isFinite(t) ? t : null };
}

const num = (x: number) => Math.round(x).toLocaleString('en-US');
const many = (x: number, one: string, more: string) => `${num(x)} ${Math.round(x) === 1 ? one : more}`;

/** "TireTrail drivers so far: 1,240 drives, 3,812 smooth stops above salmon streams". Null when empty. */
export function scoreboardLine(t: CommunityTotals | null): string | null {
  if (!t || t.drives < 1) return null;
  const stops = t.salmonSmoothStops > 0
    ? many(t.salmonSmoothStops, 'smooth stop above a salmon stream', 'smooth stops above salmon streams')
    : many(t.smoothStops, 'smooth stop', 'smooth stops');
  return `TireTrail drivers so far: ${many(t.drives, 'drive', 'drives')}, ${stops}`;
}
