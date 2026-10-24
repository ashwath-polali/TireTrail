import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundSign, type Ground } from '../scripts/sources/lib/downhill.ts';
import { boundaryBox } from '../scripts/sources/mercer-island.ts';

test('groundSign says which way the ground falls along a line, and stays out of flat or unknown ground', () => {
  // ground falls 10 m per 0.001 degree east
  const g: Ground = { at: ([lon]) => (lon < -123 ? NaN : -10000 * lon) };
  assert.equal(groundSign(g, [[-122.2, 47.5], [-122.199, 47.5]]), 1);
  assert.equal(groundSign(g, [[-122.199, 47.5], [-122.2, 47.5]]), -1);
  assert.equal(groundSign(g, [[-122.2, 47.5], [-122.19999, 47.5]]), 0);
  assert.equal(groundSign(g, [[-124, 47.5], [-122.2, 47.5]]), 0);
});

test('boundaryBox pads a city outline', () => {
  const [w, s, e, n] = boundaryBox([[[[-122.25, 47.52], [-122.2, 47.52], [-122.2, 47.6], [-122.25, 47.52]]]]);
  assert.ok(w < -122.25 && s < 47.52 && e > -122.2 && n > 47.6);
});
