/** checks on the shipped county area files (npm run build:county) */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';

const DIR = new URL('../public/data/areas/', import.meta.url);
const INDEX = new URL('index.json', DIR);
type Entry = { id: string; name: string; bbox: [number, number, number, number]; drains: number; byClass: Record<string, number>; bytes: number };

describe('county area files', { skip: !existsSync(INDEX) && 'no area files built' }, () => {
  const index = existsSync(INDEX) ? (JSON.parse(readFileSync(INDEX, 'utf8')) as Entry[]) : [];

  test('every listed area loads in the app and every path decodes', () => {
    assert.ok(index.length > 0);
    for (const a of index) {
      const text = readFileSync(new URL(`${a.id}.json`, DIR), 'utf8');
      assert.equal(Buffer.byteLength(text), a.bytes, a.id);
      assert.ok(a.bytes <= 1.5e6, `${a.id} is ${a.bytes} bytes`);
      const data = new TireTrailData(JSON.parse(text) as Bundle);
      assert.ok(data.drainCount >= a.drains, a.id);
      for (let i = 0; i < data.drainCount; i++) {
        const p = data.path(i);
        assert.equal(p.assets[0], data.drain(i).id);
        assert.equal(p.assets[p.assets.length - 1], data.drain(i).terminalId);
      }
      for (let r = 0; r < data.streetRunCount; r++) assert.deepEqual(data.street(r).terrain, { cls: 'unknown', name: '' });
    }
  });

  test('ids and names are unique, classes add up', () => {
    assert.equal(new Set(index.map((a) => a.id)).size, index.length);
    assert.equal(new Set(index.map((a) => a.name)).size, index.length);
    for (const a of index) assert.equal(Object.values(a.byClass).reduce((s, n) => s + n, 0), a.drains, a.id);
  });

  test("Tehaleh is covered, and the County's no-warranty note ships", () => {
    const home = index.find((a) => a.bbox[0] <= -122.16 && a.bbox[2] >= -122.16 && a.bbox[1] <= 47.14 && a.bbox[3] >= 47.14);
    assert.ok(home && /Tehaleh/.test(home.name), 'an area holds lon -122.16, lat 47.14');
    const b = JSON.parse(readFileSync(new URL(`${home.id}.json`, DIR), 'utf8')) as Bundle;
    assert.ok(b.credits.some((c) => /without warranty/.test(c)));
    assert.match(b.disclaimer, /Not made, reviewed or endorsed by Pierce County/);
  });
});
