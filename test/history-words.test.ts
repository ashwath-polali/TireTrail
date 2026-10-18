/** My drives words: the sign-in pitch, money leaks as rows, trips, drive rows and salmon stops */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { leaksFrom, type LeakDrive } from '../src/drive/coach/leaks.ts';
import { routesFrom, type RouteDrive } from '../src/drive/coach/routes.ts';
import type { BrakePoint, SpeedPoint, StopPoint } from '../src/drive/summary.ts';
import type { XY } from '../src/geo/geo.ts';
import { driveLine, leakNote, leakRow, moneySaid, moneyTag, NO_SPOTS, noLeaks, NO_TRIPS, progressSub, salmonLine, salmonStops, savedHere, SIGN_IN, spotLine, spotMonth, splitDays, tripNames, tripWords } from '../src/app/screens/history-words.ts';
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

  test('a money leak is a short row: dollars a month, what, and the tip behind a tap', () => {
    const [speed, stops] = L.top.map(leakRow);
    assert.deepEqual(speed, { icon: 'gas', amount: '$8 a month', title: 'Speeding on SR 410', tip: 'Keep to 45 on SR 410. Above 50 mph, each 5 mph faster burns about 7% more gas.' });
    assert.equal(stops.icon, 'tire');
    assert.equal(stops.title, 'Hard brakes at 192nd Ave E');
    // under a dollar still reads a month, never cents
    assert.match(stops.amount, /^(\$\d+ a month|under \$1 a month)$/);
    // the title names the place, so the tip doesn't again
    assert.equal(stops.tip, 'Start slowing sooner so you can stop gently. Hard brakes wear your tires faster than gentle ones.');
    // gentle braking is never said to save gas
    assert.ok(!/gas/i.test(stops.title + stops.tip));
    // a leak with no place keeps its fix as it is
    const old = leaksFrom([ld(1, { speeds: undefined, stopPts: undefined, tires: { low: 0, typical: 0.01, high: 0.03 } })]).top.map(leakRow);
    assert.equal(old[0].tip, 'Start slowing sooner so you can stop gently. Hard brakes wear your tires faster than gentle ones.');
  });

  test('money tags: always a month, never cents', () => {
    assert.equal(moneyTag(8.4), '$8 a month');
    assert.equal(moneyTag(1), '$1 a month');
    assert.equal(moneyTag(0.6), '$1 a month');
    assert.equal(moneyTag(0.42), 'under $1 a month');
    assert.equal(moneyTag(0), '$0 a month');
    for (const x of [0.001, 0.02, 0.3, 0.9, 3, 40]) assert.match(moneyTag(x), /a month$/), assert.doesNotMatch(moneyTag(x), /¢|\.\d|year/);
    assert.equal(moneySaid(8.4), 'about 8 dollars a month');
    assert.equal(moneySaid(0.05), 'under 1 dollar a month');
  });

  test('a spot: its hard brakes and their tire wear a month, projected like the report', () => {
    const at: [number, number] = [-122.17, 47.17];
    const near = { lat: 47.17, lon: -122.1701, hard: true, usd: 0.01 }, far = { lat: 47.18, lon: -122.17, hard: true, usd: 5 }, gentle = { ...near, hard: false, usd: 3 };
    // 0.02 over 20 miles, at 925 miles a month
    const m = spotMonth(at, [{ mi: 10, stopPts: [near, far, gentle] }, { mi: 10, stopPts: [near] }]);
    assert.ok(m !== null && Math.abs(m - 0.925) < 1e-9, String(m));
    assert.equal(spotMonth(at, [{ mi: 1, stopPts: [near] }]), null);
    assert.equal(spotLine(2, m), '2 hard brakes · $1 a month');
    assert.equal(spotLine(1, 0.1), '1 hard brake · under $1 a month');
    assert.equal(spotLine(3, null), '3 hard brakes');
  });

  test('signed out with drives here: how many, and that signing in keeps them', () => {
    assert.deepEqual(savedHere(3), { title: '3 drives on this phone', line: 'Sign in to see them and keep them on a new phone.' });
    assert.deepEqual(savedHere(1), { title: '1 drive on this phone', line: 'Sign in to see it and keep it on a new phone.' });
  });

  test('the monthly figures say they are estimates, and how they are projected', () => {
    assert.equal(leakNote(L), 'Estimates from 2 drives (20 miles), as if you drove 925 miles a month like this.');
  });

  test('no leaks: too little driving, or nothing cost extra', () => {
    assert.equal(noLeaks(leaksFrom([ld(1, { mi: 1.2 })])).title, 'Not enough driving yet.');
    assert.match(noLeaks(leaksFrom([ld(1, { mi: 1.2 })])).body, /^After 2 miles,/);
    assert.equal(noLeaks(leaksFrom([ld(1), ld(2)])).title, 'No money leaks right now.');
  });

  test('a day-to-day line splits into its two days', () => {
    assert.deepEqual(splitDays('Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E.'), ['Monday: 0 hard brakes.', 'Tuesday: 3, all at 192nd Ave E.']);
    assert.deepEqual(splitDays('8:00 AM: 2 hard brakes, both at Main St. 3:00 PM: 1 at SR 410.'), ['8:00 AM: 2 hard brakes, both at Main St.', '3:00 PM: 1 at SR 410.']);
    assert.deepEqual(splitDays('Mon Oct 12: 1 hard brake at Main St. Mon Oct 19: 0.'), ['Mon Oct 12: 1 hard brake at Main St.', 'Mon Oct 19: 0.']);
    assert.deepEqual(splitDays('Something else'), ['Something else']);
  });

  test('a regular trip: name and drives, then each day', () => {
    const flat = (pts: XY[]) => pts.flatMap((p) => P.toLngLat(p));
    const line = (a: XY, b: XY, n = 20): XY[] => Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    const brake = (name: string): BrakePoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, veryHard: false, cls: 'ground', name });
    const trip = (at: number, o: Partial<RouteDrive> = {}): RouteDrive => ({
      at, mi: 2, score: 80, hardBrakes: 0, gas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0, high: 0 }, brakes: [], ways: ['192nd Ave E'], path: flat(line([0, 0], [3000, 0])), ...o,
    });
    const [r] = routesFrom([trip(new Date(2026, 9, 12, 8).getTime(), { score: 90 }), trip(new Date(2026, 9, 13, 8).getTime(), { score: 71, hardBrakes: 3, brakes: [brake('192nd Ave E'), brake('192nd Ave E'), brake('192nd Ave E')] })]);
    assert.deepEqual(tripWords(r), { title: 'Your 192nd Ave E trip', sub: '2 drives', days: ['Monday: 0 hard brakes.', 'Tuesday: 3, all at 192nd Ave E.'] });
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

  test('the progress line and drive rows', () => {
    assert.equal(progressSub(4, 23.2), '4 drives · 23 mi');
    assert.equal(progressSub(1, 3.25), '1 drive · 3.3 mi');
    assert.equal(driveLine({ mi: 3.1, hardBrakes: 2 }), '3.1 mi · 2 hard brakes');
    assert.equal(driveLine({ mi: 12.6, hardBrakes: 1 }), '13 mi · 1 hard brake');
    assert.equal(driveLine({ mi: 0.3, hardBrakes: 0 }), '0.3 mi · smooth');
  });

  test('gentle stops where rain flows to salmon streams, and the stream most reach', () => {
    const stop = (lon: number, hard = false) => ({ lat: 47.17, lon, hard });
    const drains: Record<number, { cls: string; receiving: string } | null> = {
      1: { cls: 'creek', receiving: 'Fennel Creek' },
      2: { cls: 'creek', receiving: 'Fennel Creek' },
      3: { cls: 'creek', receiving: 'Unnamed stream' },
      4: { cls: 'ground', receiving: '' },
      5: null,
    };
    const at = (ll: [number, number]) => drains[ll[0]] ?? null;
    const x = salmonStops([{ stopPts: [stop(1), stop(2), stop(1, true), stop(4)] }, { stopPts: [stop(3), stop(5)] }, {}], at);
    // hard stops and stops above other water don't count
    assert.deepEqual(x, { gentle: 3, water: 'Fennel Creek', local: true });
    // Bonney Lake's streams flow down to where coho spawn, as the report and the map say; never "home to" or "live"
    assert.equal(salmonLine(x), 'Most of that rain drains to Fennel Creek. Coho salmon spawn downstream.');
    assert.equal(salmonLine({ gentle: 1, water: 'Fennel Creek', local: true }), 'That rain drains to Fennel Creek. Coho salmon spawn downstream.');
    assert.equal(salmonLine({ gentle: 2, water: null, local: true }), 'Their rain reaches salmon streams.');
    // Debra Jane Lake is part of the Fennel Creek system
    assert.equal(salmonStops([{ stopPts: [stop(6)] }], () => ({ cls: 'creek', receiving: 'Debra Jane Lake', local: true })).water, 'Fennel Creek');
    // county streams: the state's records, and tributaries said plainly
    const county = salmonStops([{ stopPts: [stop(7), stop(7)] }], () => ({ cls: 'creek', receiving: 'North Fork Clover Creek Tributary 5', local: false }));
    assert.deepEqual(county, { gentle: 2, water: 'a stream that feeds North Fork Clover Creek', local: false });
    assert.equal(salmonLine({ gentle: 2, water: 'Clover Creek', local: false }), 'Most of that rain drains to Clover Creek. The state records coho salmon there.');
    // a stream with no name is never named
    assert.deepEqual(salmonStops([{ stopPts: [stop(3)] }], at), { gentle: 1, water: null, local: true });
    assert.equal(salmonLine({ gentle: 0, water: null, local: true }), 'Gentle stops near salmon streams count here.');
    for (const l of [salmonLine(x), salmonLine(county)]) assert.doesNotMatch(l, /home to|coho salmon live/i);
  });

  test('plain words, no dashes, short enough for a phone line', () => {
    const all = [SIGN_IN.title, ...SIGN_IN.lines, SIGN_IN.privacy, ...Object.values(savedHere(4)), NO_TRIPS.title, NO_TRIPS.body, NO_SPOTS.title, NO_SPOTS.body, leakNote(L), ...Object.values(noLeaks(L)), ...Object.values(noLeaks(leaksFrom([ld(1, { mi: 1 })])))];
    for (const s of all) assert.ok(!DASHES.test(s), s);
    // a line at 390 px holds about 60 characters at this size
    for (const s of all) assert.doesNotMatch(s, /GPS|GPX|sync/i, s);
    for (const s of [...SIGN_IN.lines, SIGN_IN.privacy, savedHere(12).line, NO_TRIPS.body, NO_SPOTS.body, ...Object.values(noLeaks(L))]) assert.ok(s.length <= 70, s);
  });
});
