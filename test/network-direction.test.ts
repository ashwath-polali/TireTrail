import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ground } from '../scripts/sources/lib/downhill.ts';
import { networkSays, type NetLine } from '../scripts/sources/lib/network.ts';

type P = [number, number];
// ground rises 10 m per 0.001 degree north near 47.30, falls 10 m per 0.001 degree east near 47.31
const g: Ground = { at: ([lon, lat]) => (lat > 47.305 ? -10000 * (lon + 122) : 10000 * (lat - 47.3)) };
const O: P = [-122, 47.3], A: P = [-122, 47.3005], B: P = [-122.0005, 47.301], C: P = [-121.9995, 47.301];
const D: P = [-122, 47.31], E: P = [-121.9995, 47.31], F: P = [-121.999, 47.31];

test('networkSays sends each piece to its outfall, or else to its lowest loose end', () => {
  const lines: NetLine[] = [
    { coords: [O, A] }, // drawn up from the outfall
    { coords: [B, A] },
    { coords: [A, C] },
    { coords: [D, E] }, // a piece with no outfall: it drains east, to F
    { coords: [F, E] },
  ];
  const r = networkSays(lines, [A, B, C, D, E, F], [O], g, [-122, 47.3]);
  assert.deepEqual([...r.says], [-1, 1, -1, 1, -1]);
  assert.equal(r.pieces, 2);
  assert.equal(r.withOutfall, 1);
});

test('networkSays lets water through a line of known direction only first to last', () => {
  // B -> A is known; A -> B would be against it, so C's water can't reach the outfall through B
  const known: NetLine[] = [{ coords: [O, A] }, { coords: [B, A], fixed: true }, { coords: [A, C] }];
  assert.deepEqual([...networkSays(known, [A, B, C], [O], g, O).says], [-1, 0, -1]);
  const against: NetLine[] = [{ coords: [O, B], fixed: true }, { coords: [C, B] }];
  assert.deepEqual([...networkSays(against, [B, C], [O], g, O).says], [0, 0]);
});
