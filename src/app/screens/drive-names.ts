// A saved drive's name: when it was and which regular trip. Trips come from the coach (routes.ts); schools and parks
// from labels.json name their ends once loaded, else the most driven street does.
import { placesFromLabels, routesFrom, type Place } from '../../drive/coach/index.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import { driveWhat, tripNames, whenName } from './history-words.ts';

let places: Place[] | null = null;
let asked = false;
const waiting: (() => void)[] = [];

/** Schools and parks, loaded once; then runs a redraw. Null until they're in. */
export function loadPlaces(then?: () => void): Place[] | null {
  if (places) return places;
  if (then) waiting.push(then);
  if (!asked) {
    asked = true;
    fetch('data/labels.json').then((r) => (r.ok ? r.json() : null)).then((j: unknown) => {
      places = placesFromLabels(j as Parameters<typeof placesFromLabels>[0]);
    }).catch(() => { places = []; }).finally(() => { for (const f of waiting.splice(0)) f(); });
  }
  return null;
}

let memo: { key: string; trips: Map<number, string> } = { key: '', trips: new Map() };

/** Each regular trip's name, by drive time. */
export function tripsOf(sums: readonly DriveSummary[]): Map<number, string> {
  const key = `${sums.map((s) => s.at).join(',')}|${places?.length ?? -1}`;
  if (memo.key === key) return memo.trips;
  const routes = routesFrom(sums, places ?? []), names = tripNames(routes), trips = new Map<number, string>();
  routes.forEach((r, i) => { for (const at of r.ats) trips.set(at, names[i]); });
  memo = { key, trips };
  return trips;
}

/** "Tuesday, 1:59 PM" and "Your 138th St S trip" for a saved drive. */
export function driveName(d: Pick<DriveSummary, 'at' | 'mi' | 'ways'>, sums: readonly DriveSummary[], now = Date.now()): { when: string; what: string } {
  return { when: whenName(d.at, now), what: driveWhat(d, tripsOf(sums).get(d.at) ?? null) };
}
