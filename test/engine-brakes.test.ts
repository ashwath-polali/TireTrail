/** hard brakes and fast starts: 7 mph or more in one second, from GPS speed */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HARD_MPS2, linkStops, speedEvents, VERY_HARD_MPS2 } from '../src/drive/events.ts';
import { buildSignals } from '../src/drive/signal.ts';
import { detectStops } from '../src/drive/stops.ts';
import { drive, MPH } from './engine-helpers.ts';

const stopAt = (decel: number, v0 = 13.4) => drive(v0, [[10, 0], [v0 / decel, -decel], [8, 0]]);
const brakes = (fixes: ReturnType<typeof drive>) => speedEvents(buildSignals(fixes)).filter((e) => e.kind === 'brake');

describe('hard brakes', () => {
  test('the line is 7 mph in one second', () => {
    assert.ok(Math.abs(HARD_MPS2 - 3.129) < 0.001);
    assert.ok(Math.abs(VERY_HARD_MPS2 - 4.470) < 0.001);
  });

  test('a stop slowing 7.8 mph a second is hard, 6.3 is not, 10.3 is very hard', () => {
    const [firm] = detectStops(buildSignals(stopAt(3.5)));
    assert.ok(firm.hard && !firm.veryHard, `${firm.drop1s / MPH} mph/s`);
    assert.ok(Math.abs(firm.drop1s - 3.5) < 0.2);
    const [normal] = detectStops(buildSignals(stopAt(2.8)));
    assert.ok(!normal.hard, `${normal.drop1s / MPH} mph/s`);
    const [panic] = detectStops(buildSignals(stopAt(4.6)));
    assert.ok(panic.hard && panic.veryHard);
    // an average driver stops at about 1.9 m/s²: never hard
    assert.ok(!detectStops(buildSignals(stopAt(1.9)))[0].hard);
  });

  test('one bad speed reading is not a hard brake', () => {
    // cruising at 30 mph, one reading says 18 mph
    const fixes = drive(13.4, [[60, 0]], { noise: (k) => (k === 30 ? -5.4 : 0) });
    assert.equal(brakes(fixes).length, 0);
    // two bad readings in a row still are not
    const two = drive(13.4, [[60, 0]], { noise: (k) => (k === 30 || k === 31 ? -4 : 0) });
    assert.equal(brakes(two).length, 0);
  });

  test('normal GPS speed noise does not make events', () => {
    let seed = 1;
    const gauss = () => { seed = (seed * 16807) % 2147483647; const u = seed / 2147483647; seed = (seed * 16807) % 2147483647; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (seed / 2147483647)); };
    const fixes = drive(13.4, [[300, 0], [13.4 / 1.5, -1.5], [10, 0], [9, 1.5], [200, 0]], { noise: () => gauss() * 0.3 });
    assert.equal(speedEvents(buildSignals(fixes)).length, 0);
  });

  test('slowing hard without stopping still counts as a hard brake, not a stop', () => {
    const fixes = drive(20, [[10, 0], [2.5, -4], [20, 0]]);
    const sig = buildSignals(fixes);
    assert.equal(detectStops(sig).length, 0);
    const [b] = brakes(fixes);
    assert.ok(b && Math.abs(b.rate - 4) < 0.3 && b.stop === -1);
    assert.ok(Math.abs(b.mphPerS - 4 / MPH) < 0.7);
  });

  test('a hard stop has one hard brake, linked to it', () => {
    const fixes = stopAt(4);
    const sig = buildSignals(fixes);
    const stops = detectStops(sig);
    const events = linkStops(speedEvents(sig), stops);
    assert.equal(events.length, 1);
    assert.equal(events[0].stop, 0);
    assert.ok(events[0].heading != null && Math.abs(events[0].heading) < 5);
  });

  test('fast starts: 7 mph or more in one second', () => {
    const fast = speedEvents(buildSignals(drive(0, [[5, 0], [4, 3.6], [20, 0]])));
    assert.deepEqual(fast.map((e) => e.kind), ['start']);
    const calm = speedEvents(buildSignals(drive(0, [[5, 0], [9, 1.5], [20, 0]])));
    assert.equal(calm.length, 0);
  });

  test('GPS wobble while parked is not an event', () => {
    const fixes = drive(0, [[60, 0]], { noise: (k) => (k % 2 ? 1.2 : 0) });
    assert.equal(speedEvents(buildSignals(fixes)).length, 0);
  });

  test('readings every 2 seconds still measure the rate', () => {
    const fixes = drive(13.4, [[10, 0], [13.4 / 4, -4], [8, 0]], { every: 2 });
    const [b] = brakes(fixes);
    assert.ok(b && b.rate > HARD_MPS2, `${b?.rate}`);
  });
});
