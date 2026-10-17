/** basemap: which OSM roads and buildings get drawn, and the tile loader */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Footprints, Known, normName, overlaps } from '../scripts/basemap/match.ts';
import { Basemap, decode } from '../src/app/map/basemap.ts';
import type { XY } from '../src/geo/geo.ts';

describe('street names', () => {
  test('OSM, city and county spellings of one street match', () => {
    assert.equal(normName('Elhi Rim Road East'), normName('Elhi Rim Rd'));
    assert.equal(normName('State Route 410 East'), normName('SR 410 E'));
    assert.equal(normName('SR 410'), 'sr 410');
    assert.equal(normName('Sumner-Buckley Highway East'), normName('Sumner Buckley Hwy E'));
    assert.notEqual(normName('North Island Drive East'), normName('South Island Dr E'));
  });
});

describe('OSM roads against the known streets', () => {
  const known = new Known([
    { line: [[0, 0], [200, 0]], name: 'Elhi Rim Rd', county: false },
    { line: [[0, 500], [200, 500]], name: '162nd Ave E', county: true },
  ]);
  const elhi = [normName('Elhi Rim Road East')];

  test('any road close to a street is covered, by the city or the county', () => {
    assert.equal(known.at([50, 8], []), 1);
    assert.equal(known.at([50, 508], []), 2);
    assert.equal(known.at([50, 30], []), 0);
  });

  test('a copy of the same name beside a street is covered, its carry-on past a dead end is not', () => {
    assert.equal(known.at([100, 30], elhi), 1);
    assert.equal(known.at([100, 30], [normName('Other Street')]), 0);
    assert.equal(known.at([230, 0], elhi), 0);
    assert.equal(known.at([100, 530], [normName('162nd Avenue East')]), 2);
    assert.ok(Math.abs(known.dist([100, 530], 45, true) - 30) < 1e-9);
  });

  test('where two runs of one street meet, the outside of the bend is still beside the street', () => {
    const p: XY = [110, -10], name = [normName('A Street')];
    const bend = new Known([
      { line: [[0, 0], [100, 0]], name: 'A St', county: false },
      { line: [[100, 0], [100, 100]], name: 'A St', county: false },
    ]);
    assert.equal(bend.at(p, name), 1);
    assert.equal(new Known([{ line: [[0, 0], [100, 0]], name: 'A St', county: false }]).at(p, name), 0);
  });
});

describe('buildings from two sources', () => {
  const sq = (x: number, y: number, s: number): XY[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

  test('the same house a meter off overlaps; next-door houses do not', () => {
    assert.ok(overlaps(sq(0, 0, 12), sq(1, 1, 12)));
    assert.ok(!overlaps(sq(0, 0, 12), sq(12, 0, 12)));
    assert.ok(!overlaps(sq(0, 0, 12), sq(11.7, 0, 12)));
    assert.ok(!overlaps(sq(0, 0, 12), sq(40, 0, 12)));
    assert.ok(overlaps(sq(0, 0, 40), sq(10, 10, 5)));
  });

  test('a second source only adds what is not drawn yet', () => {
    const f = new Footprints();
    f.add(sq(0, 0, 12));
    assert.ok(f.hits(sq(2, 0, 12)));
    assert.ok(!f.hits(sq(30, 0, 12)));
  });
});

describe('basemap tiles', () => {
  const real = globalThis.fetch;
  after(() => { globalThis.fetch = real; });

  test('road flags, names and old tiles without names decode', () => {
    // 100 m east from the tile corner, in half meters; major, a county copy hidden within 12 m
    const t = decode({ b: [], c: [], r: [[1 + 2 * 12, 0, 0, 200, 0], [0, 0, 0, 0, 100]], rn: [1, 0], n: ['Rim Road East'] }, 2000, 0, .5);
    assert.deepEqual(t.roads.map((r) => [r.major, r.near, r.name]), [[true, 12, 'Rim Road East'], [false, 0, '']]);
    assert.deepEqual(t.roads[0].mid, [2050, 0]);
    assert.equal(decode({ b: [], c: [], r: [[1, 0, 0, 10, 0]] }, 0, 0, .5).roads[0].name, '');
  });

  test('every tile in view stays loaded, even past the usual cap, and a tap finds its road', async () => {
    const list: string[] = [];
    for (let ty = 0; ty < 12; ty++) for (let tx = 0; tx < 12; tx++) list.push(`${tx}_${ty}`);
    let fetches = 0;
    globalThis.fetch = (async (url: string) => {
      fetches++;
      const body = url.endsWith('index.json') ? { tile: 2000, unit: .5, tiles: list } : { b: [], c: [], r: [[0, 0, 0, 200, 0]], rn: [1], n: ['Test Road'] };
      return { ok: true, json: async () => body } as unknown as Response;
    }) as typeof fetch;
    const bm = new Basemap('x/');
    const tick = () => new Promise((ok) => setTimeout(ok, 0));
    const view = () => bm.near(0, 0, 23999, 23999);
    view();
    for (let k = 0; k < 100 && view().length < list.length; k++) await tick();
    assert.equal(view().length, list.length);
    const done = fetches;
    for (let k = 0; k < 5; k++) { view(); await tick(); }
    assert.equal(fetches, done);
    assert.equal(bm.roadAt(2050, 3, 10), 'Test Road');
    assert.equal(bm.roadAt(2050, 30, 10), null);
  });
});
