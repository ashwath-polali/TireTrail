/** a hard brake's learned spot: same place, going the same way */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { metersBetween, spotAt } from '../src/app/screens/drive-pins.ts';
import type { Spot } from '../src/drive/spots.ts';
import type { LngLat } from '../src/geo/geo.ts';

const spot = (lngLat: LngLat, heading: number | null): Spot => ({
  id: 'a', lngLat, heading, count: 3, drives: 2, veryHard: 0, last: 0, name: '192nd Ave E', cls: 'creek', salmon: true, example: false,
});
const AT: LngLat = [-122.1768, 47.1708];
// about 11 m per 0.0001 degree of latitude here
const north = (m: number): LngLat => [AT[0], AT[1] + m / 110_540];

describe('spotAt', () => {
  test('meters between nearby points', () => {
    assert.ok(Math.abs(metersBetween(AT, north(50)) - 50) < 0.5);
  });

  test('a hard brake within 60 m, going the same way, is at the spot', () => {
    assert.equal(spotAt([spot(AT, 90)], north(40), 100)?.id, 'a');
    assert.equal(spotAt([spot(AT, null)], north(40), 270)?.id, 'a');
    assert.equal(spotAt([spot(AT, 90)], north(40), null)?.id, 'a');
  });

  test('farther away, or going the other way, is not', () => {
    assert.equal(spotAt([spot(AT, 90)], north(80), 90), null);
    assert.equal(spotAt([spot(AT, 90)], north(10), 270), null);
    assert.equal(spotAt([], AT, 90), null);
  });
});
