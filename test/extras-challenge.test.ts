/** weekly challenge and smooth-drive streaks */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { challengeOf, streaks, weekStart, type ChallengeDrive } from '../src/drive/challenge.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import type { LngLat, XY } from '../src/geo/geo.ts';
import { P } from './engine-helpers.ts';

// local time: Monday 12 Oct 2026 starts the week
const MON = new Date(2026, 9, 12).getTime();
const at = (day: number, hour = 9) => new Date(2026, 9, 12 + day, hour).getTime();

const brake = (xy: XY, heading: number | null, t: number, o: Partial<BrakePoint> = {}): BrakePoint => {
  const [lon, lat] = P.toLngLat(xy);
  return { t, lat, lon, heading, veryHard: false, cls: 'creek', name: '192nd Ave E', ...o };
};
/** a straight route through [0, 0], northbound unless south */
const route = (south = false): LngLat[] => Array.from({ length: 21 }, (_, k) => P.toLngLat([0, (south ? 200 : -200) + (south ? -20 : 20) * k]));
const drive = (t: number, o: Partial<ChallengeDrive> = {}): ChallengeDrive => ({ at: t, hardBrakes: o.brakes?.length ?? 0, brakes: [], track: route(), ...o });
// two hard brakes at [0, 0] on two drives last week make the spot
const lastWeek = [drive(at(-6), { brakes: [brake([0, 0], 0, at(-6))] }), drive(at(-4), { brakes: [brake([10, 5], 5, at(-4))] })];

describe('weeks', () => {
  test('a week starts Monday at midnight, local time', () => {
    assert.equal(weekStart(at(5, 15)), MON);
    assert.equal(weekStart(MON), MON);
    assert.equal(weekStart(new Date(2026, 9, 18, 23, 59).getTime()), MON);
    assert.equal(weekStart(new Date(2026, 9, 19, 0, 1).getTime()), new Date(2026, 9, 19).getTime());
  });
});

describe('streaks', () => {
  test('counts smooth drives in a row, and the best run', () => {
    const d = (n: number, hb: number) => ({ at: n, hardBrakes: hb });
    assert.deepEqual(streaks([d(1, 0), d(2, 0), d(3, 1), d(4, 0), d(5, 0), d(6, 0)]), { streak: 3, best: 3 });
    assert.deepEqual(streaks([d(5, 0), d(1, 0), d(2, 0), d(3, 0), d(4, 2)]), { streak: 1, best: 3 });
    assert.deepEqual(streaks([]), { streak: 0, best: 0 });
  });
});

describe('weekly challenge', () => {
  test('with no spot: three smooth drives this week', () => {
    const c = challengeOf([drive(at(-2)), drive(at(0)), drive(at(1), { hardBrakes: 1 }), drive(at(2))], at(5));
    assert.equal(c.kind, 'smooth');
    assert.equal(c.title, 'Three smooth drives this week');
    assert.equal(c.got, 2);
    assert.equal(c.state, 'open');
    assert.equal(c.daysLeft, 2);
    assert.equal(challengeOf([drive(at(0)), drive(at(1)), drive(at(2))], at(3)).state, 'done');
  });

  test('the top spot from earlier weeks sets the goal', () => {
    const c = challengeOf([...lastWeek, drive(at(0)), drive(at(1))], at(2));
    assert.equal(c.kind, 'spot');
    assert.equal(c.title, 'No hard stops at 192nd Ave E this week');
    assert.equal(c.got, 2);
    assert.equal(c.state, 'open');
  });

  test('three passes with no hard brake there is done', () => {
    const c = challengeOf([...lastWeek, drive(at(0)), drive(at(1)), drive(at(3))], at(4));
    assert.equal(c.got, 3);
    assert.equal(c.state, 'done');
  });

  test('a hard brake there misses it', () => {
    const c = challengeOf([...lastWeek, drive(at(0)), drive(at(1)), drive(at(2), { brakes: [brake([5, -10], 2, at(2))] })], at(3));
    assert.equal(c.state, 'missed');
    assert.equal(c.got, 2);
  });

  test('going the other way, or with no route kept, is not a pass', () => {
    const c = challengeOf([...lastWeek, drive(at(0), { track: route(true) }), drive(at(1), { track: null }), drive(at(2))], at(3));
    assert.equal(c.got, 1);
  });

  test("this week's hard brakes don't move the goal", () => {
    const c = challengeOf([drive(at(0), { brakes: [brake([0, 0], 0, at(0), { veryHard: true })] })], at(1));
    assert.equal(c.kind, 'smooth');
    assert.equal(c.streak, 0);
  });
});
