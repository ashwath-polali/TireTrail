import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceAsset } from '../src/county/source.ts';
import { orient, type LineCheck, type Say } from '../scripts/sources/lib/orient.ts';
import { bearing, flagToward } from '../scripts/sources/normandy-park.ts';
import { catchmentRole } from '../scripts/sources/des-moines.ts';

const line = (): SourceAsset => ({ role: 'pipe', id: 'p', src: 't', coords: [[0, 0], [1, 0]], trust: 'none' });
const many = (n: number, type: string, ground: Say, more: Partial<LineCheck> = {}): LineCheck[] => Array.from({ length: n }, () => ({ asset: line(), type, ground, ...more }));
const opts = { ownTrust: 'node-flags' as const, drawnOk: 0.75, ownOk: 0.8 };

test('orient keeps a line type drawn downhill and reverses one drawn uphill', () => {
  const down = [...many(18, 'ditch', 'down'), ...many(2, 'ditch', 'up'), ...many(5, 'ditch', undefined)];
  const up = [...many(19, 'pipe', 'up'), ...many(1, 'pipe', 'down'), ...many(5, 'pipe', undefined)];
  const r = orient([...down, ...up], opts);
  assert.deepEqual(r.drawnOkTypes, ['ditch']);
  assert.deepEqual(r.reversedTypes, ['pipe']);
  assert.ok(down.every((c) => c.asset.coords[0][0] === 0 && c.asset.trust === 'digitized'));
  assert.ok(up.every((c) => c.asset.coords[0][0] === 1));
  assert.equal(r.final.down, 37);
});

test('orient uses the city\'s own evidence only when it agrees with the ground', () => {
  const agree = [...many(25, 'pipe', 'up', { own: 'up' }), ...many(5, 'pipe', undefined, { own: 'up' })];
  const r = orient(agree, opts);
  assert.ok(r.ownUsed);
  assert.ok(agree.every((c) => c.asset.coords[0][0] === 1 && c.asset.trust === 'node-flags'));
  const disagree = many(25, 'pipe', 'down', { own: 'up' });
  assert.equal(orient(disagree, opts).ownUsed, false);
  assert.ok(disagree.every((c) => c.asset.coords[0][0] === 0));
});

test('Normandy Park basin flags: the entry on the side a line leaves toward', () => {
  const entries = [{ deg: 270, flow: 'IN' }, { deg: 135, flow: 'OUT' }];
  assert.equal(flagToward(entries, 280), 'IN');
  assert.equal(flagToward(entries, 150), 'OUT');
  assert.equal(flagToward(entries, 30), undefined);
  assert.ok(Math.abs(bearing([-122.3, 47.4], [-122.3, 47.41])) < 1);
  assert.ok(Math.abs(bearing([-122.3, 47.4], [-122.31, 47.4]) - 270) < 1);
});

test('Des Moines catchments: solid lids and manholes take no street water', () => {
  assert.equal(catchmentRole({ CatchmentSubType: 1, StructureType: 'CB1', GrateType: 'FlatVaned' }), 'drain');
  assert.equal(catchmentRole({ CatchmentSubType: 1, StructureType: 'CB2', GrateType: 'SolidCircular' }), 'junction');
  assert.equal(catchmentRole({ CatchmentSubType: 2, StructureType: 'MH1' }), 'junction');
  assert.equal(catchmentRole({ CatchmentSubType: 1, StructureType: 'CB1', SolidLid: 'Yes' }), 'junction');
});
