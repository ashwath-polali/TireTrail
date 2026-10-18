// What a tap on the map answers: the first thing found at that spot, in a fixed order, so no tap is silent.
import { dist, nearestOnPolyline, type LngLat, type XY } from '../../geo/geo.ts';
import type { Box } from '../areas.ts';
import type { Place, Region } from '../map/region.ts';
import type { Run, Water, World } from '../map/world.ts';

export type Answer =
  | { kind: 'zoom'; to: number }
  | { kind: 'loading'; box: Box }
  | { kind: 'street'; run: Run }
  | { kind: 'water'; water: Water | null; name: string; coho: boolean }
  | { kind: 'city'; place: Place; road: string | null; nearest: Run | null }
  | { kind: 'road'; road: { name: string; d: number; pts?: Float32Array }; nearest: Run | null }
  | { kind: 'drain'; drain: number; d: number; near: Run | null }
  | { kind: 'near'; run: Run; d: number }
  | { kind: 'far'; nearest: Run | null }
  | { kind: 'outside'; county: string | null };

/** Everything the resolver reads. */
export interface TapState {
  world: World;
  region: Region | null;
  /** OSM roads and water around the camera; null when there is no base map */
  basemap: {
    roadNear(x: number, y: number, r: number): { name: string; d: number; major: boolean; pts: Float32Array } | null;
    waterAt(x: number, y: number): { name: string } | null;
  } | null;
  /** county area files touching a lon/lat box that aren't loaded yet */
  missing(box: Box): readonly unknown[];
  mpp: number;
}

export const REGION_MPP = 24;
/** a drain this close answers for the spot itself */
export const DRAIN_M = 15;
/** a house or yard this close to a street gets that street, labeled as near */
export const NEAR_M = 150;
// class indexes that are a real ending: creek, ground, other water, treatment plant
const ANSWERS = new Set([0, 1, 2, 5]);

/** How far from the finger a street still counts, in meters (at least 22 CSS px). */
export const reach = (mpp: number): number => Math.max(6 * mpp + 8, 7.4 * mpp);

export function resolve(st: TapState, p: XY): Answer {
  const { world: w, region: R, basemap: B, mpp } = st;
  if (mpp > REGION_MPP) return { kind: 'zoom', to: mpp / 4 };
  const r1 = reach(mpp), town = mpp <= 2.6;
  // drawn half widths, m: streets are stamped 6 m wide each side up close, roads a little less
  const half = town ? 6 : 2 * mpp;
  let road = B?.roadNear(p[0], p[1], r1) ?? null;
  // past block zoom only major roads are drawn
  if (road && !road.major && mpp > 12) road = null;
  const roadHalf = town ? (road?.major ? 7 : 5) : 1.5 * mpp;
  const onRoad = !!road && road.d <= roadHalf;
  const run = w.runAtDrawn(p, r1, half);
  if (run) {
    const d = nearestOnPolyline(p, run.line).d;
    // a gray road under the finger wins over a traced street beside it
    if (!(onRoad && road!.d < d && d > half)) return { kind: 'street', run };
  }
  if (mpp > 16) return { kind: 'zoom', to: Math.max(6, mpp / 3) };
  const ll = lngLat(w, p);
  const box: Box = [ll[0] - .004, ll[1] - .004, ll[0] + .004, ll[1] + .004];
  if (st.missing(box).length) return { kind: 'loading', box };
  // water: inside a lake, on OSM water, or on a creek line closer than any road
  if (!onRoad) {
    const lake = lakeAt(w, p);
    if (lake) return water(w, lake);
    if (B?.waterAt(p[0], p[1])) return { kind: 'water', water: null, name: '', coho: false };
  }
  const creek = creekNear(w, p, Math.max(8, 2 * mpp));
  if (creek && (!road || creek.d < road.d)) return water(w, creek.w);
  if (R) {
    const pl = R.placeAt(p);
    if (pl && !R.isMapped(pl)) return { kind: 'city', place: pl, road: road?.name || null, nearest: nearestRun(w, p, true) };
  }
  const drain = nearestDrain(w, p, DRAIN_M);
  if (road) {
    if (drain) return { kind: 'drain', drain: drain.i, d: drain.d, near: runWithin(w, p, NEAR_M) };
    return { kind: 'road', road: { name: road.name, d: road.d, pts: road.pts }, nearest: nearestRun(w, p, true) };
  }
  if (drain) return { kind: 'drain', drain: drain.i, d: drain.d, near: runWithin(w, p, NEAR_M) };
  const near = runWithin(w, p, NEAR_M);
  if (near) return { kind: 'near', run: near, d: nearestOnPolyline(p, near.line).d };
  const county = R?.countyAt(p) ?? null;
  if (county ? R!.covered(county) : !R && runWithin(w, p, 5000)) return { kind: 'far', nearest: nearestRun(w, p, true) ?? nearestRun(w, p, false) };
  return { kind: 'outside', county: county?.name ?? null };
}

export function lngLat(w: World, p: XY): LngLat {
  return w.P.toLngLat([p[0], -p[1]]);
}

function water(w: World, wt: Water): Answer {
  return { kind: 'water', water: wt, name: named(wt.name) ? wt.name : '', coho: cohoWater(w, wt) };
}

const named = (s: string) => !!s && !/unnamed/i.test(s);

/** Coho live here: the stream is flagged, or another piece with its name is (Fennel Creek comes both ways). */
export function cohoWater(w: World, wt: Water): boolean {
  if (!wt.line || /^fennel creek tributary/i.test(wt.name)) return false;
  if (w.isCoho(wt)) return true;
  return named(wt.name) && w.waters.some((o) => o.name === wt.name && w.isCoho(o));
}

// Bonney Lake's own waters load first; its "coho" flag means the whole Fennel Creek system, upstream of where coho spawn
let cityWaterN = -1;

/** Remembers how many waters came from Bonney Lake's own file (call before county areas load). */
export function noteCityWaters(w: World): void {
  if (cityWaterN < 0) cityWaterN = w.waters.length;
}

/** What the data says about coho in a tapped stream: WDFW records them here, they spawn downstream, or farther along. */
export function cohoHere(w: World, wt: Water): 'here' | 'spawn' | 'along' | null {
  if (!cohoWater(w, wt)) return null;
  const city = cityWaterN >= 0 && w.waters.indexOf(wt) < cityWaterN;
  if (w.isCoho(wt) && !city) return 'here';
  return /^fennel creek$/i.test(wt.name.trim()) ? 'spawn' : 'along';
}

function lakeAt(w: World, p: XY): Water | null {
  let best: Water | null = null;
  for (const i of w.watersNear(p, 0)) {
    const wt = w.waters[i];
    if (!wt.ring || !inRing(p, wt.ring)) continue;
    // copies of one lake: the named one
    if (!best || (named(wt.name) && !named(best.name))) best = wt;
  }
  return best;
}

function creekNear(w: World, p: XY, r: number): { w: Water; d: number } | null {
  let best: { w: Water; d: number } | null = null;
  for (const i of w.watersNear(p, r)) {
    const wt = w.waters[i];
    if (!wt.line) continue;
    const d = nearestOnPolyline(p, wt.line).d;
    if (d <= r && (!best || d < best.d || (d === best.d && named(wt.name) && !named(best.w.name)))) best = { w: wt, d };
  }
  return best;
}

function nearestDrain(w: World, p: XY, r: number): { i: number; d: number } | null {
  let best: { i: number; d: number } | null = null;
  for (const i of w.drainsNear(p, r)) {
    const d = dist(p, w.drains[i]);
    if (d <= r && (!best || d < best.d)) best = { i, d };
  }
  return best;
}

/** The nearest street run within r m, or null. */
export function runWithin(w: World, p: XY, r: number, ok: (run: Run) => boolean = () => true): Run | null {
  let best: Run | null = null, bd = r;
  for (const i of w.runsNear(p, r)) {
    const run = w.runs[i];
    if (!ok(run)) continue;
    const d = nearestOnPolyline(p, run.line).d;
    if (d <= bd) [best, bd] = [run, d];
  }
  return best;
}

/** The nearest street with a real ending (answer) or any traced street, looking farther out step by step. */
export function nearestRun(w: World, p: XY, answer: boolean): Run | null {
  const ok = answer ? (r: Run) => r.drain !== null && ANSWERS.has(r.k) : () => true;
  for (const r of [300, 1000, 3000, 8000, 20000]) {
    const run = runWithin(w, p, r, ok);
    if (run) return run;
  }
  return null;
}

function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Is a run's class a real ending? */
export const hasAnswer = (run: Run): boolean => run.drain !== null && ANSWERS.has(run.k);
