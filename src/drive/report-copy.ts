// A drive's report as the phone that recorded it read it: its salmon creeks, its one fix, its miles and minutes.
// It rides along on the drive's summary, so another device, whose copy of the route has its ends trimmed, shows the same report. Pure.
import type { LngLat } from '../geo/geo.ts';

/** one salmon creek the report counted */
export interface CreekCopy {
  /** '' when unnamed, or near the start or end in the backup */
  name: string;
  gentle: boolean;
  /** where it was crossed; the backup leaves it out within HOME_M of the start or end */
  ll?: LngLat;
}

export interface ReportCopy {
  /** each salmon creek crossed, in drive order, as the headline counts them */
  creeks: CreekCopy[];
  /** the one fix as the report said it, '' when there was nothing to fix; the backup leaves out one near the start or end */
  fix?: string;
  /** where the fix was; this phone only */
  fixLl?: LngLat;
  /** miles and minutes as the report showed them */
  mi: number;
  min: number;
}

const MAX_CREEKS = 40, NAME_MAX = 80, FIX_MAX = 200;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

function point(x: unknown): LngLat | undefined {
  return Array.isArray(x) && x.length === 2 && fin(x[0]) && fin(x[1]) && Math.abs(x[0]) <= 180 && Math.abs(x[1]) <= 90 ? [r5(x[0]), r5(x[1])] : undefined;
}

/** The copy to keep: names and places as saved, rounded and capped. */
export function makeCopy(creeks: readonly { name: string; gentle: boolean; at?: readonly [number, number] | null }[], fix: string, fixLl: readonly [number, number] | null, miles: number, sec: number): ReportCopy {
  return readCopy({
    creeks: creeks.map((c) => ({ name: c.name, gentle: c.gentle, ...(c.at ? { ll: [c.at[0], c.at[1]] } : {}) })),
    fix,
    ...(fixLl ? { fixLl: [fixLl[0], fixLl[1]] } : {}),
    mi: Math.round(miles * 10) / 10,
    min: Math.max(1, Math.round(sec / 60)),
  })!;
}

/** A stored copy made safe, or undefined if there's none or it's damaged. */
export function readCopy(x: unknown): ReportCopy | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.creeks) || !fin(o.mi) || !fin(o.min) || o.mi < 0 || o.min < 0) return undefined;
  const creeks = o.creeks.slice(0, MAX_CREEKS).flatMap((c): CreekCopy[] => {
    const k = (c ?? {}) as Record<string, unknown>, ll = point(k.ll);
    return typeof k.gentle === 'boolean' ? [{ name: typeof k.name === 'string' ? k.name.slice(0, NAME_MAX) : '', gentle: k.gentle, ...(ll ? { ll } : {}) }] : [];
  });
  const fixLl = point(o.fixLl);
  return { creeks, ...(typeof o.fix === 'string' ? { fix: o.fix.slice(0, FIX_MAX) } : {}), ...(fixLl ? { fixLl } : {}), mi: o.mi, min: o.min };
}

/**
 * The copy that leaves the phone (cloudSummary, once): a creek near the start or end keeps only whether it was gentle,
 * and a fix near them, or naming a street there, is left out. The fix's place never leaves.
 */
export function trimCopy(c: ReportCopy, near: (p: LngLat) => boolean, hidden: ReadonlySet<string>): ReportCopy {
  const { fix, fixLl, ...rest } = c;
  const safe = fix === '' || (!!fix && !!fixLl && !near(fixLl) && ![...hidden].some((n) => n && fix.includes(n)));
  return { ...rest, creeks: c.creeks.map((k) => (k.ll && !near(k.ll) ? k : { name: '', gentle: k.gentle })), ...(safe ? { fix } : {}) };
}
