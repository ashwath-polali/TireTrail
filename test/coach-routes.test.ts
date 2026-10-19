/** regular trips: grouped by ends and path, named from places or streets, with per-trip stats and a day-to-day line */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { compareLine, dayLabels, placesFromLabels, routeName, routeOf, routesFrom, sameTrip, type RouteDrive } from '../src/drive/coach/routes.ts';
import { hardGasGuess } from '../src/drive/money.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import type { XY } from '../src/geo/geo.ts';
import { P } from './engine-helpers.ts';

// Monday Oct 12 2026 to Thursday, 8 AM local time
const mon = new Date(2026, 9, 12, 8, 0).getTime();
const day = (n: number, h = 8) => new Date(2026, 9, 12 + n, h, 0).getTime();
const flat = (pts: XY[]) => pts.flatMap((p) => P.toLngLat(p));
const line = (a: XY, b: XY, n = 20, wobble = 0): XY[] => Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n + (k % 2 ? wobble : -wobble)]);
const brake = (name: string): BrakePoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, veryHard: false, cls: 'ground', name });
const trip = (at: number, pts: XY[], o: Partial<RouteDrive> = {}): RouteDrive => ({
  at, mi: 2, score: 80, hardBrakes: 0, gas: { low: 0, typical: 0.01, high: 0.02 }, tires: { low: 0, typical: 0.002, high: 0.004 }, brakes: [], ways: ['192nd Ave E', 'SR 410'], path: flat(pts), ...o,
});

const school = line([0, 0], [3000, 0]);
const drives = [
  trip(mon, school, { score: 90 }),
  trip(day(1), line([120, 80], [2900, -100], 25, 30), { score: 70, hardBrakes: 3, brakes: [brake('192nd Ave E'), brake('192nd Ave E'), brake('192nd Ave E')] }),
  // the way back is its own trip
  trip(day(1, 15), line([3000, 0], [0, 0])),
  // same ends, different path (a big loop north)
  trip(day(2), [...line([0, 0], [0, 2000], 10), ...line([0, 2000], [3000, 2000], 10).slice(1), ...line([3000, 2000], [3000, 0], 10).slice(1)]),
  // saved before the coach: no path
  trip(day(3), [], { path: undefined }),
];

describe('regular trips', () => {
  test('same ends within 300 m and a similar path are one trip; the way back, another path or no path are not', () => {
    assert.equal(sameTrip(drives[0], drives[1]), true);
    assert.equal(sameTrip(drives[0], drives[2]), false);
    assert.equal(sameTrip(drives[0], drives[3]), false);
    assert.equal(sameTrip(drives[0], drives[4]), false);
    assert.equal(sameTrip(drives[0], trip(day(5), line([0, 400], [3000, 0]))), false);
  });

  test('stats per trip, and a day-to-day line', () => {
    const routes = routesFrom(drives);
    assert.equal(routes.length, 1);
    const r = routes[0];
    assert.deepEqual(r.ats, [mon, day(1)]);
    assert.equal(r.drives, 2);
    assert.equal(r.avgScore, 80);
    assert.equal(r.hardBrakesPerDrive, 1.5);
    // speeding and tires, and the 3 hard brakes' gas, estimated (these drives kept no hard gas)
    assert.ok(Math.abs(r.usdPerDrive - (0.012 + hardGasGuess(2, 3).typical / 2)) < 1e-9);
    assert.equal(r.name, 'Your 192nd Ave E trip');
    assert.equal(r.compare, 'Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E.');
    assert.equal(routeOf(drives[1], drives)?.id, r.id);
    assert.equal(routeOf(drives[2], drives), null);
  });

  test('named from known places at both ends, else a street, else its length', () => {
    const places = [{ name: 'Home', lngLat: P.toLngLat([40, -30]) }, { name: 'Bonney Lake High School', lngLat: P.toLngLat([2950, 60]) }];
    assert.equal(routeName(drives.slice(0, 2), places), 'Home to Bonney Lake High School');
    assert.equal(routeName(drives.slice(0, 2), places.slice(1)), 'Your trip to Bonney Lake High School');
    assert.equal(routeName(drives.slice(0, 2), places.slice(0, 1)), 'Your trip from Home');
    assert.equal(routeName([trip(mon, school, { ways: [], mi: 1.86 })]), 'Your 1.9 mile trip');
  });

  test('places from labels.json: schools and parks', () => {
    const labels = JSON.parse(readFileSync(new URL('../public/data/labels.json', import.meta.url), 'utf8'));
    const places = placesFromLabels(labels);
    assert.ok(places.some((p) => p.name === 'Bonney Lake High School'));
    assert.deepEqual(placesFromLabels(null), []);
    assert.deepEqual(placesFromLabels({ schools: [['x'], null, ['A', -122, 47]] }), [{ name: 'A', lngLat: [-122, 47] }]);
  });

  test('day words: weekdays, a date when the weekday repeats, times on the same day', () => {
    assert.deepEqual(dayLabels(mon, day(1)), ['Monday', 'Tuesday']);
    assert.deepEqual(dayLabels(mon, day(7)), ['Mon Oct 12', 'Mon Oct 19']);
    assert.deepEqual(dayLabels(mon, day(0, 15)), ['8:00 AM', '3:00 PM']);
  });

  test('the day-to-day line names where the hard brakes were', () => {
    const a = trip(mon, school, { hardBrakes: 2, brakes: [brake('Main St'), brake('Main St')] });
    const b = trip(day(1), school, { hardBrakes: 1, brakes: [brake('')] });
    assert.equal(compareLine(a, b), 'Monday: 2 hard brakes, both at Main St. Tuesday: 1.');
    assert.equal(compareLine(b, a), compareLine(a, b));
    assert.equal(compareLine(trip(mon, school, { hardBrakes: 1, brakes: [brake('Main St')] }), b), 'Monday: 1 hard brake at Main St. Tuesday: 1.');
  });
});
