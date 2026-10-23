/** My drives words: trips, the progress line, salmon stops and streams crossed */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { routesFrom, type RouteDrive } from '../src/drive/coach/routes.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import type { XY } from '../src/geo/geo.ts';
import { progressSub, salmonLine, salmonStops, splitDays, streamsWeek, tripNames, tripWords } from '../src/app/screens/history-words.ts';
import { P } from './engine-helpers.ts';

describe('My drives words', () => {
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
      at, mi: 2, score: 80, hardBrakes: 0, gas: { low: 0, typical: 0, high: 0 }, brakes: [], ways: ['192nd Ave E'], path: flat(line([0, 0], [3000, 0])), ...o,
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

  test('the progress line', () => {
    assert.equal(progressSub(4, 23.2), '4 drives · 23 mi');
    assert.equal(progressSub(1, 3.25), '1 drive · 3.3 mi');
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
    // one plain sentence: how many times, and the stream; never "home to" or "live"
    assert.equal(salmonLine(x), 'You stopped gently 3 times on streets that drain to Fennel Creek.');
    assert.equal(salmonLine({ gentle: 1, water: 'Fennel Creek', local: true }), 'You stopped gently once on streets that drain to Fennel Creek.');
    assert.equal(salmonLine({ gentle: 2, water: null, local: true }), 'You stopped gently 2 times on streets that drain to a salmon creek.');
    // Debra Jane Lake is part of the Fennel Creek system
    assert.equal(salmonStops([{ stopPts: [stop(6)] }], () => ({ cls: 'creek', receiving: 'Debra Jane Lake', local: true })).water, 'Fennel Creek');
    // county streams: the state's records, and tributaries said plainly
    const county = salmonStops([{ stopPts: [stop(7), stop(7)] }], () => ({ cls: 'creek', receiving: 'North Fork Clover Creek Tributary 5', local: false }));
    assert.deepEqual(county, { gentle: 2, water: 'a stream that feeds North Fork Clover Creek', local: false });
    assert.equal(salmonLine({ gentle: 2, water: 'Clover Creek', local: false }), 'You stopped gently 2 times on streets that drain to Clover Creek.');
    // a stream with no name is never named
    assert.deepEqual(salmonStops([{ stopPts: [stop(3)] }], at), { gentle: 1, water: null, local: true });
    assert.equal(salmonLine({ gentle: 0, water: null, local: true }), 'Gentle stops near salmon streams count here.');
    for (const l of [salmonLine(x), salmonLine(county)]) assert.doesNotMatch(l, /home to|coho salmon live/i);
  });

  test('salmon streams crossed in the last 7 days, counting only drives that kept them', () => {
    const day = 86_400_000, now = Date.UTC(2026, 9, 22, 18);
    const w = streamsWeek([{ at: now - day, streams: 2 }, { at: now - 2 * day, streams: 0 }, { at: now - 3 * day }, { at: now - 9 * day, streams: 5 }], now);
    assert.deepEqual(w, { n: 2, drives: 3, known: 2 });
    assert.deepEqual(streamsWeek([], now), { n: 0, drives: 0, known: 0 });
  });
});
