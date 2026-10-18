/** posted speed limits: OSM km/h to mph, and snapping a GPS point to the road it is on */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { limitMph } from '../scripts/build-majorroads.ts';
import { bearing, SpeedLimits, turnBetween } from '../src/drive/limits.ts';
import { P, roads } from './engine-helpers.ts';

describe('speed limits', () => {
  test('OSM km/h becomes the posted mph, and odd values are dropped', () => {
    // Geofabrik stores "35 mph" as 56 km/h
    assert.equal(limitMph(56), 35);
    assert.equal(limitMph(40), 25);
    assert.equal(limitMph(96), 60);
    assert.equal(limitMph(112), 70);
    assert.equal(limitMph(97), 60);
    assert.equal(limitMph(0), 0);
    assert.equal(limitMph(null), 0);
    // 50 km/h is 31 mph: not a US limit
    assert.equal(limitMph(50), 0);
    assert.equal(limitMph(200), 0);
  });

  test('headings', () => {
    assert.equal(bearing([0, 0], [0, 10]), 0);
    assert.equal(bearing([0, 0], [10, 0]), 90);
    assert.equal(turnBetween(350, 10), 20);
    assert.equal(turnBetween(90, 270), 180);
  });

  const L = new SpeedLimits(roads([[55, [0, 0], [0, 2000]], [35, [-500, 1000], [500, 1000]], [0, [2000, 0], [2000, 2000]]]));

  test('a point snaps to the nearest road within 25 m that runs the same way', () => {
    assert.equal(L.size, 2);
    // on the north-south 55 mph road, going north or south
    assert.equal(L.at(P.toLngLat([10, 500]), 0)?.mph, 55);
    assert.equal(L.at(P.toLngLat([10, 500]), 180)?.mph, 55);
    assert.equal(L.at(P.toLngLat([10, 500]))?.name, 'Road 1');
    // 30 m off: no road
    assert.equal(L.at(P.toLngLat([30, 500]), 0), null);
    // going east across it: not on it
    assert.equal(L.at(P.toLngLat([10, 500]), 90), null);
    // at the crossing, the heading picks the road
    assert.equal(L.at(P.toLngLat([5, 1005]), 90)?.mph, 35);
    assert.equal(L.at(P.toLngLat([5, 1005]), 0)?.mph, 55);
    // roads with no known limit are left out
    assert.equal(L.at(P.toLngLat([2000, 500]), 0), null);
  });
});
