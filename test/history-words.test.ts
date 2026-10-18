/** My drives words: the sign-in panel, money leaks as insights, regular trips day to day */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { leaksFrom, type LeakDrive } from '../src/drive/coach/leaks.ts';
import { routesFrom, type RouteDrive } from '../src/drive/coach/routes.ts';
import type { BrakePoint, SpeedPoint, StopPoint } from '../src/drive/summary.ts';
import type { XY } from '../src/geo/geo.ts';
import { leakNote, leakWords, noLeaks, NO_TRIPS, progressSub, SIGN_IN, splitDays, tripNames, tripWords } from '../src/app/screens/history-words.ts';
import { P } from './engine-helpers.ts';

const DASHES = /[–—]/;
const sp = (road: string, gasSteps: number, limitMph = 45): SpeedPoint => ({ road, limitMph, topMph: 58, mi: 0.6, gasSteps, lat: 47.17, lon: -122.17 });
const hs = (name: string, usd: number): StopPoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, hard: true, usd, name });
const ld = (at: number, o: Partial<LeakDrive> = {}): LeakDrive => ({ at, mi: 10, gas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0, high: 0 }, stopPts: [], speeds: [], ...o });

describe('My drives words', () => {
  const L = leaksFrom([
    ld(1, { speeds: [sp('SR 410', 5)], stopPts: [hs('192nd Ave E', 0.002)], tires: { low: 0.0003, typical: 0.002, high: 0.01 } }),
    ld(2, { speeds: [sp('SR 410', 7)] }),
  ]);

  test('a money leak reads as dollars a month, then the fix and why', () => {
    const [speed, stops] = L.top.map(leakWords);
    assert.deepEqual(speed, { icon: 'gas', title: 'Speeding on SR 410: about $8 a month', body: 'Keep to 45 on SR 410. Above 50 mph, each 5 mph faster burns about 7% more gas.' });
    assert.equal(stops.icon, 'tire');
    assert.equal(stops.title, 'Hard stops at 192nd Ave E: under $1 a month');
    // the title names the place, so the fix doesn't again
    assert.equal(stops.body, 'Start slowing sooner so you can stop gently. Hard stops wear your tires faster than gentle ones.');
    // gentle braking is never said to save gas
    assert.ok(!/gas/i.test(stops.title + stops.body));
    // a leak with no place keeps its fix as it is
    const old = leaksFrom([ld(1, { speeds: undefined, stopPts: undefined, tires: { low: 0, typical: 0.01, high: 0.03 } })]).top.map(leakWords);
    assert.equal(old[0].body, 'Start slowing sooner so you can stop gently. Hard stops wear your tires faster than gentle ones.');
  });

  test('the monthly figures say they are estimates, and how they are projected', () => {
    assert.equal(leakNote(L), 'Estimates from 2 drives (20 miles), as if you drove 925 miles a month like this.');
  });

  test('no leaks: too little driving, or nothing cost extra', () => {
    assert.equal(noLeaks(leaksFrom([ld(1, { mi: 1.2 })])).title, 'Drive a little more to see your money leaks.');
    assert.match(noLeaks(leaksFrom([ld(1, { mi: 1.2 })])).body, /^After 2 miles,/);
    assert.equal(noLeaks(leaksFrom([ld(1), ld(2)])).title, 'No money leaks right now.');
  });

  test('a day-to-day line splits into its two days', () => {
    assert.deepEqual(splitDays('Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E.'), ['Monday: 0 hard brakes.', 'Tuesday: 3, all at 192nd Ave E.']);
    assert.deepEqual(splitDays('8:00 AM: 2 hard brakes, both at Main St. 3:00 PM: 1 at SR 410.'), ['8:00 AM: 2 hard brakes, both at Main St.', '3:00 PM: 1 at SR 410.']);
    assert.deepEqual(splitDays('Mon Oct 12: 1 hard brake at Main St. Mon Oct 19: 0.'), ['Mon Oct 12: 1 hard brake at Main St.', 'Mon Oct 19: 0.']);
    assert.deepEqual(splitDays('Something else'), ['Something else']);
  });

  test('a regular trip: name, drives and average score, then each day', () => {
    const flat = (pts: XY[]) => pts.flatMap((p) => P.toLngLat(p));
    const line = (a: XY, b: XY, n = 20): XY[] => Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    const brake = (name: string): BrakePoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, veryHard: false, cls: 'ground', name });
    const trip = (at: number, o: Partial<RouteDrive> = {}): RouteDrive => ({
      at, mi: 2, score: 80, hardBrakes: 0, gas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0, high: 0 }, brakes: [], ways: ['192nd Ave E'], path: flat(line([0, 0], [3000, 0])), ...o,
    });
    const [r] = routesFrom([trip(new Date(2026, 9, 12, 8).getTime(), { score: 90 }), trip(new Date(2026, 9, 13, 8).getTime(), { score: 71, hardBrakes: 3, brakes: [brake('192nd Ave E'), brake('192nd Ave E'), brake('192nd Ave E')] })]);
    assert.deepEqual(tripWords(r), { title: 'Your 192nd Ave E trip', sub: '2 drives · average score 81', days: ['Monday: 0 hard brakes.', 'Tuesday: 3, all at 192nd Ave E.'] });
  });

  test('two trips with one name are told apart by time of day, then by number', () => {
    const at = (d: number, hr: number) => new Date(2026, 9, d, hr, 5).getTime();
    const there = { name: 'Your SR 410 E trip', ats: [at(12, 8), at(13, 7), at(14, 8)] };
    const back = { name: 'Your SR 410 E trip', ats: [at(12, 15), at(15, 16)] };
    const school = { name: 'Home to Bonney Lake High School', ats: [at(12, 7)] };
    assert.deepEqual(tripNames([there, back, school]), ['Your SR 410 E trip in the morning', 'Your SR 410 E trip in the afternoon', 'Home to Bonney Lake High School']);
    assert.deepEqual(tripNames([there, { ...back, ats: [at(12, 19)] }]), ['Your SR 410 E trip in the morning', 'Your SR 410 E trip in the evening']);
    assert.deepEqual(tripNames([there, { ...there }]), ['Your SR 410 E trip in the morning', 'Your SR 410 E trip in the morning (2)']);
    assert.deepEqual(tripNames([school]), ['Home to Bonney Lake High School']);
  });

  test('the progress line', () => {
    assert.equal(progressSub(4, 23.2), '4 drives and 23 miles so far.');
    assert.equal(progressSub(1, 3.25), '1 drive and 3.3 miles so far.');
  });

  test('plain words, no dashes', () => {
    for (const s of [SIGN_IN.value, SIGN_IN.free, NO_TRIPS.title, NO_TRIPS.body, leakNote(L), ...Object.values(noLeaks(L))]) assert.ok(!DASHES.test(s), s);
  });
});
