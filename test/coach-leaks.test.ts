/** money leaks: the top habits and places, honest dollars a month with a range, from money.ts figures only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { leaksFrom, type LeakDrive } from '../src/drive/coach/leaks.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { DEFAULT_MONEY_OPTIONS, gasCost } from '../src/drive/money.ts';
import { summarize, type SpeedPoint, type StopPoint } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { NO_DRAINS } from './engine-helpers.ts';

const MONTH_MI = DEFAULT_MONEY_OPTIONS.annualMi / 12;
const sp = (road: string, gasSteps: number, limitMph = 45): SpeedPoint => ({ road, limitMph, topMph: 58, mi: 0.6, gasSteps, lat: 47.17, lon: -122.17 });
const hs = (name: string, usd: number, hard = true): StopPoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, hard, usd, name });
const d = (at: number, o: Partial<LeakDrive> = {}): LeakDrive => ({ at, mi: 10, gas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0, high: 0 }, stopPts: [], speeds: [], ...o });

describe('money leaks', () => {
  const drives = [
    d(1, { speeds: [sp('SR 410', 5)], stopPts: [hs('192nd Ave E', 0.002), hs('Main St', 0.001), hs('192nd Ave E', 0, false)], tires: { low: 0.0003, typical: 0.003, high: 0.015 } }),
    d(2, { speeds: [sp('SR 410', 7), sp('SR 167', 0.1, 55)], stopPts: [hs('192nd Ave E', 0.002)], tires: { low: 0.0002, typical: 0.002, high: 0.01 } }),
    d(3),
  ];
  const L = leaksFrom(drives);

  test('ranked by dollars a month, projected per mile driven', () => {
    assert.deepEqual(L.top.map((l) => l.title), ['Speeding on SR 410', 'Hard stops at 192nd Ave E', 'Speeding on SR 167']);
    const k = MONTH_MI / 30;
    const gas = gasCost({ gasSteps: 12 }).typical * k;
    assert.ok(Math.abs(L.top[0].month.typical - gas) < 1e-9);
    assert.ok(Math.abs(L.top[1].month.typical - 0.004 * k) < 1e-9);
    assert.equal(L.top[0].line, 'Speeding on SR 410: about $6 a month');
    assert.equal(L.top[1].line, 'Hard stops at 192nd Ave E: under $1 a month');
    assert.deepEqual([L.top[0].times, L.top[0].drives, L.top[0].of], [2, 2, 3]);
    assert.deepEqual([L.top[1].times, L.top[1].drives], [2, 2]);
    assert.equal(L.drives, 3);
    assert.equal(L.miles, 30);
    assert.equal(L.note, 'From 3 drives (30 miles), as if you drove 925 miles a month like this.');
  });

  test('a range, and one plain fix each; gentle braking is never said to save gas', () => {
    const [speed, stops] = L.top;
    assert.ok(speed.month.low < speed.month.typical && speed.month.typical < speed.month.high);
    assert.match(speed.range, /^(\$\d+|up to \$\d+|under \$1) (to \$\d+ )?a month$|^\$\d+ to \$\d+ a month$/);
    assert.equal(speed.fix, 'Keep to 45 on SR 410.');
    assert.equal(speed.why, 'Above 50 mph, each 5 mph faster burns about 7% more gas.');
    assert.equal(stops.fix, 'Start slowing sooner for 192nd Ave E so you can stop gently.');
    assert.ok(!/gas/i.test(stops.fix + stops.why + stops.line));
    // the tire range follows the drive's range
    assert.ok(stops.month.high / stops.month.typical > 4);
    for (const l of L.top) assert.ok(!/[–—]/.test(l.line + l.fix + l.why + l.range));
  });

  test('drives saved before the coach still count, with no place', () => {
    const old = leaksFrom([d(1, { speeds: undefined, stopPts: undefined, gas: { low: 0.1, typical: 0.12, high: 0.15 }, tires: { low: 0, typical: 0.01, high: 0.03 } })]);
    assert.deepEqual(old.top.map((l) => [l.title, l.place]), [['Speeding', ''], ['Hard stops', '']]);
    assert.equal(old.top[0].fix, 'Keep to the posted limit on fast roads.');
    assert.equal(old.top[1].fix, 'Start slowing sooner so you can stop gently.');
  });

  test('nothing under 2 miles, and nothing that costs nothing', () => {
    assert.deepEqual(leaksFrom([d(1, { mi: 1, speeds: [sp('SR 410', 1)] })]).top, []);
    assert.deepEqual(leaksFrom([d(1, { speeds: [sp('SR 410', 0)], stopPts: [hs('A', 0)] })]).top, []);
    assert.deepEqual(leaksFrom([]).top, []);
  });

  test('the sample drive: speeding on SR 410, then its hard stops', () => {
    const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
    const fixes = read('sample-drive.json') as Fix[];
    const r = analyzeDrive(fixes, NO_DRAINS, { limits: new SpeedLimits(read('majorroads.json')), nameOf: () => 'SR 410' });
    const s = leaksFrom([summarize(r, 1, { fixes, nameOf: () => 'SR 410' })]);
    assert.deepEqual(s.top.map((l) => l.title), ['Speeding on SR 410', 'Hard stops at SR 410']);
    assert.equal(s.top[1].times, 3);
  });
});
