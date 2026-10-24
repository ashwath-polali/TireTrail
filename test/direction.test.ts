import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearing, leaving, portSays, settle, type DirLine } from '../scripts/sources/lib/direction.ts';
import type { Ground } from '../scripts/sources/lib/downhill.ts';
import type { SourceAsset } from '../src/county/source.ts';

test('bearing and leaving give compass degrees from a line end', () => {
  assert.ok(Math.abs(bearing([-122.2, 47.6], [-122.2, 47.601]) - 0) < 0.5);
  assert.ok(Math.abs(bearing([-122.2, 47.6], [-122.199, 47.6]) - 90) < 0.5);
  const line: [number, number][] = [[-122.2, 47.6], [-122.199, 47.6]];
  assert.ok(Math.abs(leaving(line, false) - 90) < 0.5);
  assert.ok(Math.abs(leaving(line, true) - 270) < 0.5);
});

test('portSays reads a basin port: out at the first vertex or in at the last means drawn in flow order', () => {
  const ports = [{ az: 90, out: true }, { az: 270, out: false }];
  assert.equal(portSays(ports, 85, true, 30), 1);
  assert.equal(portSays(ports, 275, false, 30), 1);
  assert.equal(portSays(ports, 85, false, 30), -1);
  assert.equal(portSays(ports, 180, true, 30), 0);
  // an in and an out port the same way say nothing
  assert.equal(portSays([{ az: 90, out: true }, { az: 100, out: false }], 95, true, 30), 0);
});

test('settle keeps lines the evidence backs, turns the ones it says are backward unless the ground says otherwise', () => {
  // ground falls 10 m per 0.001 degree east
  const g: Ground = { at: ([lon]) => -10000 * lon };
  const mk = (east: boolean): SourceAsset => ({ role: 'pipe', id: 'p', src: 't', trust: 'none', coords: east ? [[-122.2, 47.6], [-122.199, 47.6]] : [[-122.199, 47.6], [-122.2, 47.6]] });
  const lines: DirLine[] = [];
  for (let i = 0; i < 30; i++) lines.push({ asset: mk(true), says: 1 });
  const backward = { asset: mk(false), says: -1 };
  const groundWins = { asset: mk(true), says: -1 };
  const none = { asset: mk(true), says: 0 };
  lines.push(backward, groundWins, none);
  const extra: Record<string, number> = {};
  settle(lines, g, 'inverts', extra);
  assert.equal(lines[0].asset.trust, 'inverts');
  assert.deepEqual(backward.asset.coords[0], [-122.2, 47.6]);
  assert.equal(backward.asset.trust, 'inverts');
  assert.deepEqual(groundWins.asset.coords[0], [-122.2, 47.6]);
  assert.equal(groundWins.asset.trust, 'digitized');
  assert.equal(none.asset.trust, 'digitized');
  assert.equal(extra['dir.evidenceAgrees'], 30);
});
