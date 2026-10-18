/** hard-brake spots: learned from saved drives, warned about before the car gets there */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ahead, SpotAlarm, spotsFrom, type Spot } from '../src/drive/spots.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { P, T0 } from './engine-helpers.ts';

const brake = (xy: XY, heading: number | null, o: Partial<BrakePoint> = {}): BrakePoint => {
  const [lon, lat] = P.toLngLat(xy);
  return { t: T0, lat, lon, heading, veryHard: false, cls: 'ground', name: '', ...o };
};
const day = (n: number) => T0 + n * 86_400_000;
const at = (xy: XY, o: Partial<Fix> = {}): Fix => {
  const [lon, lat] = P.toLngLat(xy);
  return { t: T0, lat, lon, speed: 13.4, heading: 0, ...o };
};

describe('hard-brake spots', () => {
  test('2 hard brakes on 2 drives, within 60 m and going the same way, make a spot', () => {
    const spots = spotsFrom([
      { at: day(0), brakes: [brake([0, 0], 2, { t: day(0) })] },
      { at: day(1), brakes: [brake([30, 20], 358, { t: day(1), name: 'Main St', cls: 'creek' })] },
    ]);
    assert.equal(spots.length, 1);
    const s = spots[0];
    assert.equal(s.count, 2);
    assert.equal(s.drives, 2);
    assert.equal(s.last, day(1));
    assert.equal(s.name, 'Main St');
    assert.equal(s.salmon, true);
    assert.equal(s.example, false);
    assert.ok(s.heading != null && (s.heading < 5 || s.heading > 355), `${s.heading}`);
  });

  test('one drive, a far brake, or the other direction is not a spot', () => {
    // twice on the same drive
    assert.equal(spotsFrom([{ at: day(0), brakes: [brake([0, 0], 0), brake([10, 0], 0)] }]).length, 0);
    // 100 m apart
    assert.equal(spotsFrom([{ at: day(0), brakes: [brake([0, 0], 0)] }, { at: day(1), brakes: [brake([0, 100], 0)] }]).length, 0);
    // same place, opposite ways (two sides of an intersection)
    assert.equal(spotsFrom([{ at: day(0), brakes: [brake([0, 0], 0)] }, { at: day(1), brakes: [brake([5, 5], 180)] }]).length, 0);
  });

  test('one very hard brake (10 mph or more in one second) is a spot by itself', () => {
    const spots = spotsFrom([{ at: day(0), brakes: [brake([0, 0], 90, { veryHard: true })] }]);
    assert.equal(spots.length, 1);
    assert.equal(spots[0].veryHard, 1);
  });

  test('busier spots come first', () => {
    const drives = [0, 1, 2].map((d) => ({ at: day(d), brakes: [brake([0, 0], 0, { t: day(d) }), ...(d < 2 ? [brake([1000, 0], 0, { t: day(d) + 1 })] : [])] }));
    const spots = spotsFrom(drives);
    assert.deepEqual(spots.map((s) => s.count), [3, 2]);
  });
});

describe('warning ahead', () => {
  const spot: Spot = spotsFrom([{ at: day(0), brakes: [brake([0, 100], 0, { veryHard: true })] }])[0];

  test('warns about a spot about 10 seconds ahead', () => {
    // 30 mph, 100 m short of it: about 7 seconds away
    assert.equal(ahead([spot], at([0, 0]))?.id, spot.id);
    // a little to the side still counts
    assert.equal(ahead([spot], at([12, 0]))?.id, spot.id);
  });

  test('not when it is behind, too far, the wrong way, off to the side, or the car is slow', () => {
    assert.equal(ahead([spot], at([0, 150])), null, 'behind');
    assert.equal(ahead([spot], at([0, -200])), null, '300 m at 30 mph is over 20 s');
    assert.ok(ahead([spot], at([0, -200], { speed: 31 })), 'but at 70 mph it is under 10 s');
    assert.equal(ahead([spot], at([0, 0], { heading: 180 })), null, 'going away');
    assert.equal(ahead([spot], at([0, 200], { heading: 180 })), null, 'coming the other way');
    assert.equal(ahead([spot], at([80, 0], { heading: 0 })), null, 'a parallel street');
    assert.equal(ahead([spot], at([0, 0], { speed: 2 })), null, 'crawling');
  });

  test('works without phone speed and heading, from the reading before', () => {
    const prev = at([0, -13.4], { t: T0 - 1000, speed: null, heading: null });
    assert.equal(ahead([spot], at([0, 0], { speed: null, heading: null }), prev)?.id, spot.id);
    assert.equal(ahead([spot], at([0, 0], { speed: null, heading: null })), null, 'no way to tell the direction');
  });

  test('the alarm rings once per pass, and again on the next pass', () => {
    const alarm = new SpotAlarm([spot]);
    const pass = (t0: number) => {
      let rings = 0;
      for (let y = -300; y <= 400; y += 13.4) if (alarm.check(at([0, y], { t: t0 + y * 75 }))) rings++;
      return rings;
    };
    assert.equal(pass(0), 1);
    // drive away, then come back down the same road
    alarm.check(at([0, 2000]));
    assert.equal(pass(10_000_000), 1);
  });
});
