// Each saved drive's salmon creek crossings, found once from its route on this phone and kept, for My drives.
import type { Crossing } from '../../drive/creeks.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import { pathPoints } from '../../drive/summary.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import { salmonData } from '../../salmon/index.ts';
import { fromRegion, toRegion } from '../../salmon/proj.ts';
import { routeTiles } from '../../salmon/row.ts';
import { SALMON, SalmonWatch, type SalmonSource } from '../../salmon/watch.ts';
import type { Tile } from '../../salmon/tiles.ts';
import { allSummaries, saveSummary, trackOf, unpack } from './saved.ts';

// v2 keeps each crossing's species; the first list (no species) is found again
const KEY = 'tt-creeks-2', OLD = 'tt-creeks';
type Store = Record<string, [string, number, number, 0 | 1, number?][]>;

function read(): Store {
  try {
    localStorage.removeItem(OLD);
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Store) : {};
  } catch { return {}; }
}

let store: Store | null = null;

/** A drive's crossings, or null while not found. */
export function crossingsOf(at: number): Crossing[] | null {
  const s = (store ??= read())[at];
  return Array.isArray(s) ? s.map(([name, lon, lat, g, sp]) => ({ name, ll: [lon, lat] as LngLat, gentle: g === 1, sp: sp ?? 0 })) : null;
}

function keep(at: number, cs: Crossing[], ats: Set<number>): void {
  const s = (store ??= read());
  s[at] = cs.map((c) => [c.name, +c.ll[0].toFixed(5), +c.ll[1].toFixed(5), c.gentle ? 1 : 0, c.sp ?? 0]);
  // only drives still saved
  for (const k of Object.keys(s)) if (!ats.has(+k)) delete s[k];
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* full or blocked: found again next time */ }
}

/** Points every 40 m or closer, so a coarse route can't step over a crossing. */
function dense(pts: readonly LngLat[]): { ll: LngLat; t: number }[] {
  const out: { ll: LngLat; t: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const a = toRegion(pts[i - 1]), b = toRegion(pts[i]), n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 40);
      for (let k = 1; k < n; k++) out.push({ ll: fromRegion([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]), t: 0 });
    }
    out.push({ ll: pts[i], t: 0 });
  }
  return out.map((p, i) => ({ ...p, t: i * 1000 }));
}

/** The crossings a route drove over, each gentle when no hard brake was within 150 m. */
export function crossingsOver(tiles: readonly Tile[], route: readonly { ll: LngLat; t: number }[], brakes: readonly LngLat[]): Crossing[] {
  const src: SalmonSource = { near: () => tiles as Tile[] }, w = new SalmonWatch(), bs = brakes.map((b) => toRegion(b));
  let prev: XY | null = null, heading: number | null = null;
  for (const f of route) {
    const p = toRegion(f.ll);
    // heading from the last 15 m or more
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 15) {
      heading = ((Math.atan2(p[0] - prev[0], -(p[1] - prev[1])) * 180) / Math.PI + 360) % 360;
      prev = p;
    } else if (!prev) prev = p;
    w.move(src, f.ll, f.t, heading);
  }
  return w.passed.map((c) => ({
    name: c.name, ll: fromRegion(c.at), sp: c.sp,
    gentle: !bs.some((b) => Math.hypot(b[0] - c.at[0], b[1] - c.at[1]) <= SALMON.brakeM),
  }));
}

/** A drive's route: its track on this phone, else its coarse route, else null. */
function routeOf(s: DriveSummary): { ll: LngLat; t: number }[] | null {
  const d = trackOf(s.at);
  if (d?.fixes.length) return d.fixes.map(unpack).filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon)).map((f) => ({ ll: [f.lon, f.lat] as LngLat, t: f.t }));
  const p = pathPoints(s.path);
  return p.length > 1 ? dense(p) : null;
}

const tried = new Set<number>();
/** checks running now */
let busy = 0;
/** the salmon streams didn't load on the last check (offline) */
let offline = false;

/** Some of these drives may still have crossings to find. */
export function needsCrossings(sums: readonly DriveSummary[], most = 40): boolean {
  return sums.slice(0, most).some((s) => !crossingsOf(s.at) && !tried.has(s.at));
}

/** A drive's crossings: found, still being checked, or can't be checked (no route on this device, or offline). */
export function crossingState(at: number): 'known' | 'checking' | 'none' {
  if (crossingsOf(at)) return 'known';
  return !tried.has(at) || busy > 0 ? 'checking' : 'none';
}

/** The last check couldn't load the salmon streams. */
export const creeksOffline = (): boolean => offline;

/** Finds crossings for drives that don't have them yet, newest first. True if any were found. */
export async function findCrossings(sums: readonly DriveSummary[], most = 40): Promise<boolean> {
  const ats = new Set(sums.map((s) => s.at));
  const counts = new Map<number, number>();
  let found = false;
  busy++;
  try {
    for (const s of sums.slice(0, most)) {
      if (crossingsOf(s.at) || tried.has(s.at)) continue;
      tried.add(s.at);
      const route = routeOf(s);
      if (!route) continue;
      try {
        const tiles = await salmonData.some(routeTiles(route.map((f) => toRegion(f.ll))));
        // the streams didn't load (offline): tried again after a reload
        if (!salmonData.ready) { offline = true; for (const x of sums) tried.add(x.at); break; }
        offline = false;
        const cs = crossingsOver(tiles, route, s.brakes.map((b) => [b.lon, b.lat]));
        keep(s.at, cs, ats);
        found = true;
        if (s.streams == null) counts.set(s.at, cs.length);
      } catch { /* this drive just shows no creeks */ }
    }
  } finally { busy--; }
  // the counts on the summaries too, for home; quietly, as the caller redraws once
  for (const s of allSummaries()) {
    const n = counts.get(s.at);
    if (n != null && s.streams == null) saveSummary({ ...s, streams: n });
  }
  return found;
}
