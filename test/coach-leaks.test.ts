/** money leaks: the top habits and places, honest gas dollars a month with a range, from money.ts figures only */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { leaksFrom, type LeakDrive } from '../src/drive/coach/leaks.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { DEFAULT_MONEY_OPTIONS, gasCost, hardGasGuess } from '../src/drive/money.ts';
import { summarize, type BrakePoint, type SpeedPoint } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { NO_DRAINS } from './engine-helpers.ts';

const MONTH_MI = DEFAULT_MONEY_OPTIONS.annualMi / 12;
const ZERO = { low: 0, typical: 0, high: 0 };
const sp = (road: string, gasSteps: number, limitMph = 45): SpeedPoint => ({ road, limitMph, topMph: 58, mi: 0.6, gasSteps, lat: 47.17, lon: -122.17 });
const br = (name: string, gas?: number): BrakePoint => ({ t: 0, lat: 47.17, lon: -122.17, heading: 90, veryHard: false, cls: 'none', name, ...(gas == null ? {} : { gas }) });
const d = (at: number, o: Partial<LeakDrive> = {}): LeakDrive => ({ at, mi: 10, gas: ZERO, hardGas: ZERO, hardBrakes: 0, brakes: [], speeds: [], ...o });
const u = (typical: number) => ({ low: typical / 2, typical, high: typical * 4 });
const sum = (xs: readonly { month: { typical: number } }[]) => xs.reduce((t, l) => t + l.month.typical, 0);

describe('money leaks', () => {
  const drives = [
    d(1, { speeds: [sp('SR 410', 5)], hardBrakes: 2, hardGas: u(0.003), brakes: [br('192nd Ave E', 0.002), br('Main St', 0.001)] }),
    d(2, { speeds: [sp('SR 410', 7), sp('SR 167', 0.1, 55)], hardBrakes: 1, hardGas: u(0.002), brakes: [br('192nd Ave E', 0.002)] }),
    d(3),
  ];
  const L = leaksFrom(drives);

  test('ranked by dollars a month, projected per mile driven', () => {
    assert.deepEqual(L.top.map((l) => l.title), ['Speeding on SR 410', 'Hard brakes at 192nd Ave E', 'Speeding on SR 167']);
    const k = MONTH_MI / 30;
    const gas = gasCost({ gasSteps: 12 }).typical * k;
    assert.ok(Math.abs(L.top[0].month.typical - gas) < 1e-9);
    assert.ok(Math.abs(L.top[1].month.typical - 0.004 * k) < 1e-9);
    assert.equal(L.top[0].line, 'Speeding on SR 410: about $6 a month');
    assert.equal(L.top[1].line, 'Hard brakes at 192nd Ave E: under $1 a month');
    assert.deepEqual([L.top[0].times, L.top[0].drives, L.top[0].of], [2, 2, 3]);
    assert.deepEqual([L.top[1].times, L.top[1].drives], [2, 2]);
    assert.equal(L.drives, 3);
    assert.equal(L.miles, 30);
    assert.equal(L.note, 'From 3 drives (30 miles), as if you drove 925 miles a month like this.');
  });

  test('a range, and one plain fix each; hard brakes say gas, never tires, and the fix never says brake softer', () => {
    const [speed, stops] = L.top;
    assert.ok(speed.month.low < speed.month.typical && speed.month.typical < speed.month.high);
    assert.match(speed.range, /^(\$\d+|up to \$\d+|under \$1) (to \$\d+ )?a month$|^\$\d+ to \$\d+ a month$/);
    assert.equal(speed.fix, 'Keep to 45 on SR 410.');
    assert.equal(speed.why, 'Above 50 mph, each 5 mph faster burns about 7% more gas.');
    assert.equal(stops.fix, 'Start slowing sooner for 192nd Ave E so you can stop gently.');
    assert.equal(stops.why, 'Starting to slow sooner means fewer hard stops, which saves gas.');
    // the range follows the drive's range
    assert.ok(stops.month.high / stops.month.typical > 3);
    for (const l of L.top) assert.ok(!/[–—]|tire/.test(l.line + l.fix + l.why + l.range));
  });

  test("hard brakes' gas goes to their street, fast starts' to one more row, and nothing is left over", () => {
    const hardGas = { low: 0.01, typical: 0.03, high: 0.06 };
    const x = d(1, { hardBrakes: 2, fastStarts: 1, hardGas, brakes: [br('Main St', 0.012), br('Main St', 0.008)], speeds: [sp('SR 410', 0.5)] });
    const all = leaksFrom([x], undefined, 10), k = MONTH_MI / 10;
    assert.deepEqual(all.top.map((l) => l.title), ['Hard brakes at Main St', 'Other hard starts and stops', 'Speeding on SR 410']);
    const [main, rest] = all.top;
    assert.ok(Math.abs(main.month.typical - 0.02 * k) < 1e-9);
    assert.ok(Math.abs(rest.month.typical - 0.01 * k) < 1e-9);
    assert.equal(main.times, 2);
    assert.equal(rest.times, 1);
    assert.equal(rest.fix, 'Ease off sooner, and press the gas slowly as you pull away.');
    assert.equal(rest.why, 'Hard starts and stops waste gas, up to 40% in stop-and-go traffic.');
    // the gas range follows the drive's range
    assert.ok(Math.abs(rest.month.high / rest.month.typical - 2) < 1e-9);
    // every leak together is the drive's gas, a month; hard is every one but speeding
    assert.ok(Math.abs(sum(all.top) - (hardGas.typical + gasCost({ gasSteps: 0.5 }).typical) * k) < 1e-9);
    assert.ok(Math.abs(all.hard.typical - hardGas.typical * k) < 1e-9);
  });

  test('drives saved before the coach still count, with no place; before hard gas was kept, it is estimated', () => {
    const old = leaksFrom([d(1, { speeds: undefined, hardGas: undefined, hardBrakes: 1, brakes: [br('')], gas: { low: 0.1, typical: 0.12, high: 0.15 } })]);
    assert.deepEqual(old.top.map((l) => [l.title, l.place]), [['Speeding', ''], ['Hard brakes', '']]);
    assert.equal(old.top[0].fix, 'Keep to the posted limit on fast roads.');
    assert.equal(old.top[1].fix, 'Start slowing sooner so you can stop gently.');
    // 2 hard brakes and a fast start, no gas kept: the estimate, shared evenly
    const est = leaksFrom([d(1, { hardGas: undefined, hardBrakes: 2, fastStarts: 1, brakes: [br('Main St'), br('Main St')] })], undefined, 10);
    const g = hardGasGuess(10, 3).typical * (MONTH_MI / 10);
    assert.ok(g > 0);
    assert.deepEqual(est.top.map((l) => l.title), ['Hard brakes at Main St', 'Other hard starts and stops']);
    assert.ok(Math.abs(est.top[0].month.typical - (g * 2) / 3) < 1e-9);
    assert.ok(Math.abs(est.top[1].month.typical - g / 3) < 1e-9);
  });

  test('nothing under 2 miles, and nothing that costs nothing', () => {
    assert.deepEqual(leaksFrom([d(1, { mi: 1, speeds: [sp('SR 410', 1)] })]).top, []);
    assert.deepEqual(leaksFrom([d(1, { speeds: [sp('SR 410', 0)] })]).top, []);
    assert.deepEqual(leaksFrom([]).top, []);
    assert.equal(leaksFrom([]).hard.typical, 0);
  });

  test("the sample drive: its hard brakes lead, then its fast start, and they add up to its report's gas", () => {
    const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
    const fixes = read('sample-drive.json') as Fix[];
    const r = analyzeDrive(fixes, NO_DRAINS, { limits: new SpeedLimits(read('majorroads.json')), nameOf: () => '138th St' });
    const s = leaksFrom([summarize(r, 1, { fixes, nameOf: () => '138th St' })]);
    assert.deepEqual(s.top.map((l) => l.title), ['Hard brakes at 138th St', 'Other hard starts and stops']);
    assert.equal(s.top[0].times, 2);
    // a month of leaks is the drive's gas, scaled to a month (saved figures are rounded a little)
    const month = sum(s.top), want = (r.money.total.typical * MONTH_MI) / r.miles;
    assert.ok(Math.abs(month - want) / want < 0.01, `${month} vs ${want}`);
  });
});
