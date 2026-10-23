/** My drives words: the sign-in pitch, trips, drive rows, salmon stops, streams crossed and the dust trend; no money */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { routesFrom, type RouteDrive } from '../src/drive/coach/routes.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import type { XY } from '../src/geo/geo.ts';
import { driveLine, dustTrend, NO_SPOTS, NO_TRIPS, progressSub, salmonLine, salmonStops, savedHere, SIGN_IN, splitDays, streamsWeek, streamsWord, tripNames, tripWords } from '../src/app/screens/history-words.ts';
import { P } from './engine-helpers.ts';

const DASHES = /[–—]/;
describe('My drives words', () => {
  test('signed out with drives here: how many, and that signing in keeps them', () => {
    assert.deepEqual(savedHere(3), { title: '3 drives on this phone', line: 'Sign in to see them and keep them on a new phone.' });
    assert.deepEqual(savedHere(1), { title: '1 drive on this phone', line: 'Sign in to see it and keep it on a new phone.' });
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
    assert.equal(driveLine({ mi: 3.1, hardBrakes: 2, streams: 2 }), '3.1 mi · 2 salmon streams · 2 hard brakes');
    assert.equal(driveLine({ mi: 3.1, hardBrakes: 0, streams: 1 }), '3.1 mi · 1 salmon stream · smooth');
    assert.equal(driveLine({ mi: 3.1, hardBrakes: 0, streams: 0 }), '3.1 mi · smooth');
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
    const all = [SIGN_IN.title, ...SIGN_IN.lines, SIGN_IN.privacy, ...Object.values(savedHere(4)), NO_TRIPS.title, NO_TRIPS.body, NO_SPOTS.title, NO_SPOTS.body, streamsWord(1), streamsWord(3)];
    // no money on My drives: no tire money, no dollars a month
    for (const s of all) assert.doesNotMatch(s, /\$|a month|tires last/, s);
    for (const s of all) assert.ok(!DASHES.test(s), s);
    // a line at 390 px holds about 60 characters at this size
    for (const s of all) assert.doesNotMatch(s, /GPS|GPX|sync/i, s);
    for (const s of [...SIGN_IN.lines, SIGN_IN.privacy, savedHere(12).line, NO_TRIPS.body, NO_SPOTS.body]) assert.ok(s.length <= 70, s);
    assert.match(SIGN_IN.lines[0], /^Your salmon streams/);
  });

  test('salmon streams crossed in the last 7 days, counting only drives that kept them', () => {
    const day = 86_400_000, now = Date.UTC(2026, 9, 22, 18);
    const w = streamsWeek([{ at: now - day, streams: 2 }, { at: now - 2 * day, streams: 0 }, { at: now - 3 * day }, { at: now - 9 * day, streams: 5 }], now);
    assert.deepEqual(w, { n: 2, drives: 3, known: 2 });
    assert.deepEqual(streamsWeek([], now), { n: 0, drives: 0, known: 0 });
    assert.equal(streamsWord(1), 'salmon stream crossed');
    assert.equal(streamsWord(0), 'salmon streams crossed');
  });

  test('the dust trend: percent vs typical on the last drives, oldest first', () => {
    const d = (at: number, dustMg?: number, typMg = 100) => ({ at, dustMg, typMg });
    assert.deepEqual(dustTrend([d(3, 90), d(1, 120), d(2), d(4, 100), d(5, 50, 0)]), [20, -10, 0]);
    assert.deepEqual(dustTrend(Array.from({ length: 20 }, (_, i) => d(i, 100 + i)), 3), [17, 18, 19]);
  });
});
