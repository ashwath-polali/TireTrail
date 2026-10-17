/** merged area bundles keep every drain's path and street link */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { decodePath, type Bundle } from '../src/data/bundle.ts';
import { keepRuns, mergeBundles } from '../src/data/merge.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';

const shipped = () => JSON.parse(readFileSync(new URL('../public/data/tiretrail.json', import.meta.url), 'utf8')) as Bundle;

describe('merging area bundles', () => {
  const a = shipped(), b = shipped();
  const one = new TireTrailData(a), both = new TireTrailData(mergeBundles(a, b));
  const D = one.drainCount, R = one.streetRunCount;

  test('counts add up and the first area is untouched', () => {
    assert.equal(both.drainCount, 2 * D);
    assert.equal(both.streetRunCount, 2 * R);
    for (const i of [0, 7, D - 1]) assert.deepEqual(both.drain(i), one.drain(i));
  });

  test('every appended drain decodes to the same path as its original', () => {
    for (let i = 0; i < D; i++) {
      assert.deepEqual(both.path(i + D).assets, one.path(i).assets);
      const d = both.drain(i + D), o = one.drain(i);
      assert.equal(d.id, o.id);
      assert.equal(d.cls, o.cls);
      assert.equal(d.exitId, o.exitId);
    }
  });

  test('appended street runs point at the appended drains', () => {
    for (let r = 0; r < R; r++) {
      const s = both.street(r + R), o = one.street(r);
      assert.equal(s.name, o.name);
      assert.equal(s.drain, o.drain === null ? null : o.drain + D);
    }
  });

  test('explicit paths are shifted too', () => {
    const merged = mergeBundles(a, b);
    for (const k of Object.keys(b.drains.explicitPaths)) {
      const i = Number(k) + D;
      assert.deepEqual(decodePath(merged, i).map((x) => merged.assets.key[x]), decodePath(b, Number(k)).map((x) => b.assets.key[x]));
    }
  });

  test('keepRuns drops runs but keeps their drains', () => {
    const half = keepRuns(a, (r) => r % 2 === 0);
    const d = new TireTrailData(half);
    assert.equal(d.streetRunCount, Math.ceil(R / 2));
    assert.equal(d.street(1).name, one.street(2).name);
    assert.equal(d.drainCount, D);
  });
});
