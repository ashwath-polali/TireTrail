/** base map tiles: optional names and classes, far-view copies without buildings, and big builds on big screens */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Basemap, COVER_SEA, COVER_WATER, decode } from '../src/app/map/basemap.ts';

// one 2 km tile in 0.5 m units: a building, a lake, the sea, a named primary road with a route number, a plain street
const tile = () => ({
  b: [4, 100, 100, 40, 0, 0, 40, -40, 0],
  c: [[3, [200, 200, 400, 0, 0, 400, -400, 0]], [4, [2000, 2000, 1000, 0, 0, 1000, -1000, 0]]] as [number, ...number[][]][],
  r: [[1, 0, 1000, 2000, 0], [0, 0, 1600, 2000, 0]],
  rn: [1, 0],
  n: ['Main St', 'Lake Tapps', 'SR 410'],
  cn: [2, 0],
  rc: [4, 1],
  rf: [3, 0],
});

describe('tile fields', () => {
  test('water names, road classes and route numbers come through when a tile has them', () => {
    const t = decode(tile(), 0, 0, 0.5);
    assert.deepEqual(t.cover.map((c) => [c.cls, c.name]), [[COVER_WATER, 'Lake Tapps'], [COVER_SEA, '']]);
    assert.deepEqual(t.roads.map((r) => [r.name, r.cls, r.ref, r.major]), [['Main St', 4, 'SR 410', true], ['', 1, '', false]]);
    assert.equal(t.tone.length, 1);
    assert.equal(t.lite, false);
  });

  test('older tiles without them still read', () => {
    const { cn, rc, rf, ...old } = tile();
    void [cn, rc, rf];
    const t = decode(old, 0, 0, 0.5);
    assert.deepEqual(t.cover.map((c) => c.name), ['', '']);
    assert.deepEqual(t.roads.map((r) => [r.name, r.cls, r.ref]), [['Main St', 0, ''], ['', 0, '']]);
  });

  test('a far view copy leaves the buildings out and is smaller', () => {
    const full = decode(tile(), 0, 0, 0.5), lite = decode(tile(), 0, 0, 0.5, true);
    assert.equal(lite.lite, true);
    assert.equal(lite.tone.length, 0);
    assert.equal(lite.bs.length, 1);
    assert.equal(lite.cover.length, 2);
    assert.equal(lite.roads.length, 2);
    assert.ok(lite.bytes < full.bytes);
  });

  test('waterAt names the water and counts the sea', () => {
    const bm = new Basemap();
    (bm as unknown as { tiles: Map<string, unknown> }).tiles.set('0_0', decode(tile(), 0, 0, 0.5));
    assert.deepEqual(bm.waterAt(150, 150), { name: 'Lake Tapps' });
    assert.deepEqual(bm.waterAt(1200, 1200), { name: '' });
    assert.equal(bm.waterAt(50, 50), null);
  });
});

describe('loading on big screens', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  // a Pierce and King sized build: 2,731 tiles in a 61-wide block
  const KEYS = Array.from({ length: 2731 }, (_, i) => `${i % 61}_${Math.floor(i / 61)}`);
  const fakeFetch = (asked: string[]) => (async (url: string | URL | Request) => {
    const u = String(url);
    asked.push(u);
    const body = u.endsWith('index.json') ? { tile: 2000, unit: 0.5, tiles: KEYS } : tile();
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  const settle = () => new Promise((r) => setImmediate(r));

  /** Frames until nothing is loading, as the draw loop would; the loaded tiles in view. */
  async function frames(bm: Basemap, box: [number, number, number, number], full: boolean, n = 400): Promise<number> {
    let got = 0;
    for (let k = 0; k < n; k++) {
      got = bm.near(...box, full).length;
      await settle();
      if ((bm as unknown as { loading: Set<string> }).loading.size === 0 && k > 2 && got === bm.near(...box, full).length) break;
    }
    return got;
  }

  test('every tile in a 600-tile view loads, as far-view copies', async () => {
    const asked: string[] = [];
    globalThis.fetch = fakeFetch(asked);
    const bm = new Basemap();
    bm.near(0, 0, 1, 1);
    await settle();
    // 30 x 20 tiles in view, past the old 256 limit
    const box: [number, number, number, number] = [10, 10, 30 * 2000 - 10, 20 * 2000 - 10];
    assert.equal(await frames(bm, box, false, 200), 600);
    const tiles = [...(bm as unknown as { tiles: Map<string, { lite: boolean }> }).tiles.values()];
    assert.ok(tiles.every((t) => t.lite));
    // each tile asked for once
    assert.equal(new Set(asked).size, asked.length);
  });

  test('zooming in brings back the buildings; tiles out of view give way, tiles in view never do', async () => {
    globalThis.fetch = fakeFetch([]);
    const bm = new Basemap();
    bm.near(0, 0, 1, 1);
    await settle();
    await frames(bm, [10, 10, 30 * 2000 - 10, 20 * 2000 - 10], false, 200);
    // a close view of 2 x 2 tiles: whole tiles now
    const close: [number, number, number, number] = [10, 10, 2 * 2000 - 10, 2 * 2000 - 10];
    const near = await frames(bm, close, true, 10);
    assert.equal(near, 4);
    const map = (bm as unknown as { tiles: Map<string, { lite: boolean }> }).tiles;
    for (const k of ['0_0', '1_0', '0_1', '1_1']) assert.equal(map.get(k)?.lite, false, k);
    // somewhere else far out: the old far-view copies are dropped down to the spare 96
    const other: [number, number, number, number] = [40 * 2000 + 10, 30 * 2000 + 10, 60 * 2000 - 10, 44 * 2000 - 10];
    const inView = await frames(bm, other, false, 120);
    assert.equal(inView, 20 * 14);
    assert.ok(map.size <= inView + 96, `${map.size} tiles kept`);
    for (let ty = 30; ty < 44; ty++) for (let tx = 40; tx < 60; tx++) assert.ok(map.has(`${tx}_${ty}`), `${tx}_${ty} in view`);
  });
});
