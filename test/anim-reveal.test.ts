/** the end-of-drive reveal on the map: the route drawing itself, its timing, the pixel art, and the report's words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DRAW_MS, LEAP_MS, leapAt, mapPlan, RouteDraw } from '../src/app/anim/route-reveal.ts';
import { frameAt, rowsSize } from '../src/app/anim/px.ts';
import { COHO, coinRows, PUFF, SPARKLE, SPRITES, tireRows } from '../src/app/anim/sprites.ts';
import { creekMarks, creekWord, crossedWord, driveTitle, driveWhen, dustScale, fixLine, gasShort, grayKey, reportHead } from '../src/app/screens/drive-words.ts';

describe('the route drawing itself', () => {
  // two stretches given out of order: 0 runs east 100 m, 1 runs north 100 m from there
  const lines = [{ i: 1, path: [[100, 0], [100, -100]] as [number, number][] }, { i: 0, path: [[0, 0], [50, 0], [100, 0]] as [number, number][] }];
  test('cuts the route in drive order', () => {
    const d = new RouteDraw(lines);
    assert.equal(d.total, 200);
    assert.equal(d.cut(0).size, 0);
    const q = d.cut(0.25);
    assert.deepEqual([...q.keys()], [0]);
    assert.deepEqual(q.get(0), [[0, 0], [50, 0]]);
    const h = d.cut(0.75);
    assert.deepEqual(h.get(0), lines[1].path);
    assert.deepEqual(h.get(1), [[100, 0], [100, -50]]);
    assert.equal(d.cut(1).get(1), lines[0].path);
  });
  test('knows how far along a point is', () => {
    const d = new RouteDraw(lines);
    assert.equal(d.reach([50, 3]), 0.25);
    assert.equal(d.reach([104, -100]), 1);
    assert.equal(new RouteDraw([]).reach([0, 0]), 1);
  });
  test('creeks leap as the route gets there, the fix pins last, all in under 4 s', () => {
    const p = mapPlan([0.2, 0.9], [0.5, 0.1]);
    assert.deepEqual(p.creeks, [0.2 * DRAW_MS, 0.9 * DRAW_MS]);
    assert.deepEqual(p.pins, [0.5 * DRAW_MS, 0.1 * DRAW_MS]);
    assert.ok(p.fix > DRAW_MS && p.end >= p.fix && p.end >= p.creeks[1] + LEAP_MS && p.end < 4000);
    assert.ok(mapPlan([], []).end > DRAW_MS);
  });
  test('a leap rises and comes down, left to right', () => {
    assert.deepEqual(leapAt(0), [-14, 0]);
    assert.ok(leapAt(0.5)[1] < -20);
    assert.equal(leapAt(1)[0], 14);
    assert.equal(leapAt(1)[1], 0);
  });
});

describe('pixel art', () => {
  test('frames in a set are all one size', () => {
    for (const set of [COHO, SPARKLE, PUFF]) {
      const [w, h] = rowsSize(set[0]);
      for (const f of set) assert.deepEqual(rowsSize(f), [w, h]);
    }
    for (const k of [0, 0.25, 0.5]) assert.deepEqual(rowsSize(tireRows(14, k)), [14, 14]);
    for (const half of [4, 3, 1]) assert.deepEqual(rowsSize(coinRows(half)), [8, 8]);
    // a tire that turns looks different, and stays round
    assert.notDeepEqual(tireRows(14, 0), tireRows(14, 0.5));
    assert.equal(tireRows(14, 0)[0][0], '.');
  });
  test('sheets match their PixelLab sizes', () => {
    assert.deepEqual([SPRITES.coho.w, SPRITES.coho.h, SPRITES.coho.n, SPRITES.coho.hi], [64, 32, 8, true]);
    assert.deepEqual([SPRITES.pump.w, SPRITES.pump.h], [48, 64]);
    assert.equal(frameAt({ n: 4, fps: 12 }, 1000), 0);
    assert.equal(frameAt({ n: 4, fps: 12 }, 84), 1);
  });
});

describe('the report words', () => {
  const t = { crossed: 3, gentle: 2, streams: [{ name: 'Clover Creek', at: [-122.43, 47.13] as const }, { name: 'Spanaway Creek', at: [-122.2, 47.2] as const }, { name: 'Morey Creek', at: [-122.1, 47.1] as const }] };
  test('each creek crossed, gentle unless a hard brake was within 150 m', () => {
    assert.deepEqual(creekMarks(t, [[-122.2001, 47.2001]]).map((c) => c.gentle), [true, false, true]);
    assert.ok(creekMarks({ ...t, gentle: 3 }, [[-122.2001, 47.2001]]).every((c) => c.gentle));
    assert.ok(creekMarks({ ...t, gentle: 0 }, []).every((c) => !c.gentle));
    assert.deepEqual(creekMarks(null, []), []);
    assert.deepEqual(creekMarks({ ...t, crossed: 0, gentle: 0, streams: [] }, []), []);
  });
  test('one headline: creeks first, else the most useful true line', () => {
    const c = (gentle: boolean[], name = '') => gentle.map((g) => ({ name, gentle: g }));
    assert.equal(reportHead(c([true, false, true]), 2, 1), 'Gentle at 2 of 3 salmon creeks');
    assert.equal(reportHead(c([true, true]), 0, 0), 'Gentle at all 2 salmon creeks');
    assert.equal(reportHead(c([true], 'Clover Creek'), 1, 0), 'Gentle at Clover Creek');
    assert.equal(reportHead(c([false], 'Clover Creek'), 1, 0), 'Hard brake near Clover Creek');
    assert.equal(reportHead([], 1, 0), '1 hard brake. Smooth otherwise.');
    assert.equal(reportHead([], 0, 0), 'Smooth drive. No hard brakes.');
    assert.equal(reportHead([], 0, 2), 'No hard brakes. 2 fast starts.');
    assert.equal(reportHead([], 3, 0), '3 hard brakes this drive');
    assert.equal(reportHead([], 2, 1), '2 hard brakes, 1 fast start');
  });
  test('the title, when, the fix and the gas line', () => {
    assert.equal(driveTitle([{ name: '' }, { name: 'Clover Creek' }], false), 'The Clover Creek drive');
    assert.equal(driveTitle([], true), 'The sample drive');
    assert.equal(driveTitle([], false), 'Your drive');
    assert.equal(driveWhen(0, true, 3.46, 400), 'Sample · 3.5 mi · 7 min');
    const at = new Date(2026, 9, 22, 17, 42).getTime();
    assert.equal(driveWhen(at, false, 12, 30, at + 60_000), 'Today 5:42 PM · 12.0 mi · 1 min');
    assert.equal(fixLine({ kind: 'hard', limitMph: null }, '138th St S at Pacific Ave S'), 'Brake earlier on 138th St S at Pacific Ave S.');
    assert.equal(fixLine({ kind: 'speeding', limitMph: 35 }, 'SR 7'), 'Keep to 35 mph on SR 7.');
    assert.equal(fixLine({ kind: 'fast-start', limitMph: null }, ''), 'Start slower at the marked spot.');
    assert.equal(fixLine({ kind: 'smooth', limitMph: null }, 'A St'), null);
    assert.equal(grayKey([{ name: 'Clover Creek', gentle: true }, { name: 'Spanaway Creek', gentle: false }]), 'Gray: a hard brake near Spanaway Creek.');
    assert.equal(grayKey([{ name: 'A', gentle: false }, { name: 'B', gentle: false }, { name: 'C', gentle: true }]), 'Gray: a hard brake near those creeks.');
    assert.equal(grayKey([{ name: 'A', gentle: true }]), null);
    assert.equal(grayKey([{ name: 'A', gentle: false }]), null);
    assert.equal(gasShort({ hard: true, speed: false, text: 'about 70¢' }), 'About 70¢ of each gallon went to hard brakes and fast starts.');
    assert.equal(gasShort({ hard: false, speed: true, text: 'about 40¢' }), 'About 40¢ of each gallon went to speeding.');
    assert.equal(gasShort({ hard: true, speed: true, text: 'about $1.10' }), 'About $1.10 of each gallon went to speeding, hard brakes and fast starts.');
    assert.equal(creekWord(false), 'Hard brake nearby');
    for (const w of [reportHead(c3(), 2, 1), driveWhen(0, true, 1, 60), gasShort({ hard: true, speed: true, text: 'about $1.10' })]) assert.ok(!/[–—]/.test(w));
  });
  const c3 = () => [{ name: 'A', gentle: true }, { name: 'B', gentle: false }];
  test('the live screens', () => {
    assert.equal(crossedWord(1), 'salmon stream crossed');
    assert.equal(crossedWord(0), 'salmon streams crossed');
    assert.deepEqual([0, 0.2, 0.5, 0.9, 1.4, 7, 140].map(dustScale), [0.5, 0.5, 1, 1, 2, 10, 200]);
  });
});
