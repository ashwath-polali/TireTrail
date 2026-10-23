// The live road: its words, its distance scale, the next salmon crossing ahead and the learned spot ahead.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LiveCoach } from '../src/drive/coach/live.ts';
import type { Spot } from '../src/drive/spots.ts';
import type { XY } from '../src/geo/geo.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { COHO } from '../src/salmon/species.ts';
import { readTile, type RawTile, type Tile } from '../src/salmon/tiles.ts';
import { SalmonWatch } from '../src/salmon/watch.ts';
import { crossedLine, cueLine, gentleLabel, NEAR_M, ROAD_L, roadDist, roadLine, roadY } from '../src/app/screens/drive-coach.ts';
import { drive, MPH, P } from './engine-helpers.ts';

/** crossings at local meters [x, y] (y north) on roads running dir degrees from north */
function tileWith(list: { at: XY; dir: number; name: string }[]): Tile {
  const raw: RawTile = { v: 1, s: [], l: [], c: [], b: [] };
  for (const c of list) {
    const r = toRegion(P.toLngLat(c.at));
    let si = raw.s.findIndex((s) => s[0] === c.name);
    if (si < 0) si = raw.s.push([c.name, COHO, 3]) - 1;
    raw.c.push([Math.round(r[0]), Math.round(r[1]), si, c.dir, COHO]);
    raw.l.push([si, Math.round(r[0]) - 300, Math.round(r[1]), 600, 0]);
  }
  return readTile('0_0', raw)!;
}
const src = (t: Tile) => ({ near: () => [t] });

describe('live road: words', () => {
  test('distances read short: miles past a tenth, else feet', () => {
    assert.equal(roadDist(644), '0.4 mi');
    assert.equal(roadDist(1609.344), '1 mi');
    assert.equal(roadDist(NEAR_M), '500 ft');
    assert.equal(roadDist(30), '100 ft');
    assert.equal(roadDist(3), '50 ft');
  });

  test('the line: a spot first, then a creek close, a creek ahead, else the status', () => {
    assert.deepEqual(roadLine({ fish: { m: 644 }, status: 'Recording. Drive as usual.' }), { text: 'Salmon creek in 0.4 mi', tone: 'plain' });
    assert.deepEqual(roadLine({ fish: { m: 140 }, status: '' }), { text: 'Easy on the brakes.', tone: 'salmon' });
    assert.equal(roadLine({ fish: { m: 140 }, spot: { m: 200 }, status: '' }).text, 'Your hard-brake spot. Ease off early.');
    assert.equal(roadLine({ spot: { m: 900 }, status: 'Recording. Drive as usual.' }).text, 'Recording. Drive as usual.');
  });

  test('cues as lines; a creek ahead is already on the road', () => {
    assert.equal(cueLine({ kind: 'salmon-ahead', say: 'Clover Creek ahead. Coho stream.' }), null);
    assert.equal(cueLine({ kind: 'hard-brake', say: 'Hard brake.' })?.text, 'Ease off sooner.');
    assert.equal(cueLine({ kind: 'speeding', say: 'Limit 45. Ease off.' })?.text, 'Limit 45. Ease off.');
    assert.equal(crossedLine(true, 'Clover Creek').text, 'Crossed gently.');
    assert.equal(crossedLine(false, '').text, 'Crossed a salmon creek.');
    assert.equal(gentleLabel(1), '1 salmon creek crossed gently');
  });

  test('every line is short and plain: no dashes, no science', () => {
    const lines = [roadLine({ fish: { m: 644 }, status: '' }), roadLine({ fish: { m: 100 }, status: '' }), roadLine({ spot: { m: 10 }, status: '' }),
      ...(['hard-brake', 'fast-start', 'spot-ahead', 'coast'] as const).map((kind) => cueLine({ kind, say: '' })!), crossedLine(true, ''), crossedLine(false, 'Clover Creek')];
    for (const l of lines) {
      assert.ok(l.text.length > 0 && l.text.length <= 42, l.text);
      assert.doesNotMatch(l.text, /[–—]|µg|\bmg\b|6PPD|grams/);
    }
  });
});

describe('live road: distance scale', () => {
  test('true to scale at the car, squeezed toward the horizon, never past it', () => {
    const a = 600;
    assert.equal(roadY(0, a), 0);
    assert.ok(Math.abs(roadY(1, a) - a / ROAD_L) < 0.01);
    assert.equal(roadY(-10, a), (-10 * a) / ROAD_L);
    let last = 0;
    for (const d of [50, 150, 400, 800, 1600, 5000]) {
      const y = roadY(d, a);
      assert.ok(y > last && y < a);
      last = y;
    }
    // 0.4 mi ahead sits well up the road, 500 ft in the lower third
    assert.ok(roadY(644, a) > a * 0.6 && roadY(NEAR_M, a) < a * 0.3);
  });
});

describe('live road: what is ahead', () => {
  test('the next crossing on this road comes closer, then goes once driven over', () => {
    const t = tileWith([{ at: [0, 0], dir: 0, name: 'Clover Creek' }]), coach = new LiveCoach({ salmon: src(t) });
    const seen: number[] = [];
    for (const f of drive(35 * MPH, [[90, 0]], { heading: 0, start: [0, -1200] })) {
      coach.update(f);
      const r = coach.road();
      if (r.fish) { assert.equal(r.fish.c.stream.name, 'Clover Creek'); seen.push(r.fish.m); }
    }
    assert.ok(seen.length > 40, `seen ${seen.length}`);
    assert.ok(seen[0] > 1000 && seen.at(-1)! < 60, `${seen[0]} ${seen.at(-1)}`);
    for (let k = 1; k < seen.length; k++) assert.ok(seen[k] <= seen[k - 1] + 1);
    assert.equal(coach.salmon.passed.length, 1);
    assert.equal(coach.road().fish, null);
  });

  test('a creek under a cross street, or behind, or over a mile out is not next', () => {
    const w = new SalmonWatch(), car = toRegion(P.toLngLat([0, 0]));
    const t = tileWith([{ at: [0, 2000], dir: 0, name: 'Far Creek' }, { at: [0, 300], dir: 90, name: 'Cross Creek' }, { at: [0, -200], dir: 0, name: 'Back Creek' }]);
    assert.equal(w.next(src(t), car, 0), null);
  });

  test('the shown crossing stays through a small bend; a nearer one ahead takes over', () => {
    const w = new SalmonWatch();
    const t = tileWith([{ at: [0, 600], dir: 0, name: 'Clover Creek' }]);
    const car = toRegion(P.toLngLat([0, 0]));
    assert.equal(w.next(src(t), car, 0)?.c.stream.name, 'Clover Creek');
    // 12 degrees off: outside the narrow cone, still roughly ahead
    assert.equal(w.next(src(t), car, 12)?.c.stream.name, 'Clover Creek');
    assert.equal(new SalmonWatch().next(src(t), car, 12), null);
    const t2 = tileWith([{ at: [0, 600], dir: 0, name: 'Clover Creek' }, { at: [0, 200], dir: 0, name: 'Morey Creek' }]);
    assert.equal(w.next(src(t2), car, 0)?.c.stream.name, 'Morey Creek');
  });

  test('a learned spot ahead on this road shows within 400 m', () => {
    const spot = (y: number, heading: number | null = 0): Spot => ({ id: `s${y}`, lngLat: P.toLngLat([0, y]), heading, count: 3, drives: 2, veryHard: 0, last: 0 } as unknown as Spot);
    const coach = new LiveCoach({ spots: [spot(900), spot(380), spot(200, 180)] });
    for (const f of drive(30 * MPH, [[3, 0]], { heading: 0, start: [0, -40] })) coach.update(f);
    const r = coach.road();
    assert.equal(r.spot?.spot.id, 's380');
    assert.ok(r.spot!.m > 350 && r.spot!.m < 400);
  });
});
