/** watersheds where there's no pipe map: the file, which one holds a spot, the stream it's named for, and the card words */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { encodeArc, thin, topology } from '../scripts/build-watersheds.ts';
import { Region, type Place } from '../src/app/map/region.ts';
import type { Run } from '../src/app/map/world.ts';
import { shedFor, type Answer } from '../src/app/screens/resolve.ts';
import { project } from '../scripts/lib/lcc.ts';
import { mainStream, readWatersheds, WatershedData, watershedAt, type RawWatersheds } from '../src/app/map/watersheds.ts';
import { fishWords, shedLines, shedName } from '../src/app/screens/common.ts';
import { CHINOOK, CHUM, COHO, PINK, SOCKEYE, STEELHEAD } from '../src/salmon/species.ts';
import type { LngLat, XY } from '../src/geo/geo.ts';

// two squares side by side sharing one border (arc 0), the right one with a square hole that is a third watershed
const RAW: RawWatersheds = {
  v: 1, q: 5, source: 'test', built: '2026-10-24',
  arcs: [
    [200, 0, 0, 200], // the shared border, (1000, 0) down to (1000, 1000), in steps of 5 m
    [200, 200, -200, 0, 0, -200, 200, 0], // the left square's other three sides
    [200, 0, 200, 0, 0, 200, -200, 0], // the right square's other three sides
    [260, 60, 40, 0, 0, 40, -40, 0, 0, -40], // the hole, (1300, 300) to (1500, 500)
  ],
  w: [
    ['171100120201', 'Issaquah Creek', 'Issaquah Creek', COHO | CHINOOK, [[0, 1]]],
    ['171100190303', 'Chambers Creek', '', 0, [[~0, 2], [3]]],
    ['171100190402', 'Anderson Island', '', 0, [[~3]]],
  ],
};

describe('watersheds: the file and the lookup', () => {
  const list = readWatersheds(RAW)!;

  test('arcs come back as rings in meters, shared borders the same on both sides', () => {
    assert.equal(list.length, 3);
    assert.deepEqual(list[0].rings[0], [[1000, 0], [1000, 1000], [0, 1000], [0, 0], [1000, 0]]);
    assert.deepEqual(list[1].rings[0].slice(0, 2), [[1000, 1000], [1000, 0]]);
    assert.deepEqual(list[0].box, [0, 0, 1000, 1000]);
    assert.equal(readWatersheds({ v: 2 }), null);
    assert.equal(readWatersheds(null), null);
  });

  test('a point is in the watershed whose outline holds it, and not in one with a hole there', () => {
    assert.equal(watershedAt(list, [500, 500])?.name, 'Issaquah Creek');
    assert.equal(watershedAt(list, [1800, 200])?.name, 'Chambers Creek');
    // inside the hole: the island, not the watershed around it
    assert.equal(watershedAt(list, [1400, 400])?.name, 'Anderson Island');
    assert.equal(watershedAt(list, [2500, 500]), null);
    assert.equal(watershedAt(list, [500, -10]), null);
  });

  test('the file loads once, on the first ask, and tries again after a failure', async () => {
    let asks = 0, fail = true;
    const data = new WatershedData('w.json', async () => { asks++; if (fail) throw new Error('offline'); return RAW; });
    assert.equal(asks, 0);
    assert.equal(data.ready, null);
    assert.equal(await data.at([500, 500]), null);
    fail = false;
    const [a, b] = await Promise.all([data.at([500, 500]), data.at([1800, 200])]);
    assert.equal(asks, 2);
    assert.equal(a?.huc12, '171100120201');
    assert.equal(b?.huc12, '171100190303');
    assert.ok(data.ready);
    await data.at([500, 500]);
    assert.equal(asks, 2);
  });
});

describe('watersheds: the stream a watershed is named for', () => {
  test('the stream, without upper or lower, and the tributary before the main stem', () => {
    assert.equal(mainStream('Issaquah Creek'), 'Issaquah Creek');
    assert.equal(mainStream('Upper Issaquah Creek'), 'Issaquah Creek');
    assert.equal(mainStream('Headwaters Cedar River'), 'Cedar River');
    assert.equal(mainStream('Lower Little Wenatchee River'), 'Little Wenatchee River');
    assert.equal(mainStream('Bear Creek-Sammamish River'), 'Bear Creek');
    assert.equal(mainStream('Lake Washington-Sammamish River'), 'Sammamish River');
    assert.equal(mainStream('Ollala Canyon-Wenatchee River'), 'Wenatchee River');
    assert.equal(mainStream('Hylebos Creek-Frontal Commencement Bay'), 'Hylebos Creek');
    assert.equal(mainStream('Joe Leary Slough-Frontal Padilla Bay'), 'Joe Leary Slough');
  });

  test('"Middle Fork" is part of a name, and lakes, islands and towns are no stream', () => {
    assert.equal(mainStream('Middle Fork Snoqualmie River'), 'Middle Fork Snoqualmie River');
    assert.equal(mainStream('Upper Middle Fork Snoqualmie River'), 'Middle Fork Snoqualmie River');
    assert.equal(mainStream('Lake Wenatchee'), '');
    assert.equal(mainStream('Anderson Island'), '');
    assert.equal(mainStream('City of Tacoma-Frontal Commencement Bay'), '');
  });
});

describe('watersheds: which cards name one', () => {
  // the traced area: everything west of x = 0
  const R = { inCoverage: (p: XY) => p[0] < 0 };
  const run = {} as Run, place = {} as Place;

  test('only where no pipe map has the spot', () => {
    assert.deepEqual(shedFor({ kind: 'city', place, road: 'Front Street North', nearest: null }, R, [-5, 0]), { street: true });
    assert.deepEqual(shedFor({ kind: 'city', place, road: null, nearest: null }, R, [5, 0]), { street: false });
    assert.deepEqual(shedFor({ kind: 'outside', county: 'Chelan' }, R, [5, 0]), { street: false });
    assert.deepEqual(shedFor({ kind: 'road', road: { name: 'SR 410', d: 2 }, nearest: null }, R, [5, 0]), { street: true });
    assert.deepEqual(shedFor({ kind: 'far', nearest: null }, R, [5, 0]), { street: false });
  });

  test('traced streets, drains, waters and the traced area never', () => {
    for (const a of [{ kind: 'street', run }, { kind: 'near', run, d: 30 }, { kind: 'drain', drain: 0, d: 5, near: null }, { kind: 'water', water: null, name: '', coho: false },
      { kind: 'loading', box: [0, 0, 1, 1] }, { kind: 'zoom', to: 4 }] as Answer[]) {
      assert.equal(shedFor(a, R, [5, 0]), null, a.kind);
      assert.equal(shedFor(a, R, [-5, 0]), null, a.kind);
    }
    // a road or field inside the traced area keeps its card as it was
    assert.equal(shedFor({ kind: 'road', road: { name: 'SR 410', d: 2 }, nearest: null }, R, [-5, 0]), null);
    assert.equal(shedFor({ kind: 'far', nearest: null }, R, [-5, 0]), null);
    assert.equal(shedFor({ kind: 'far', nearest: null }, null, [5, 0]), null);
  });
});

describe('watersheds: card words', () => {
  test('the species WDFW records, coho first, Chinook capitalized', () => {
    assert.equal(fishWords(COHO | CHINOOK), 'coho and Chinook salmon');
    assert.equal(fishWords(COHO), 'coho salmon');
    assert.equal(fishWords(COHO | CHINOOK | SOCKEYE | STEELHEAD), 'coho, Chinook and sockeye salmon and steelhead');
    assert.equal(fishWords(COHO | CHINOOK | CHUM | PINK | SOCKEYE), 'all five kinds of salmon');
    assert.equal(fishWords(COHO | CHINOOK | CHUM | PINK | SOCKEYE | STEELHEAD), 'all five kinds of salmon and steelhead');
    assert.equal(fishWords(STEELHEAD), 'steelhead');
    assert.equal(fishWords(0), '');
  });

  test('the watershed line, then the salmon line, and never where the drains go', () => {
    assert.deepEqual(shedLines({ name: 'Issaquah Creek', stream: 'Issaquah Creek', sp: COHO | CHINOOK }, true),
      ['This street is in the Issaquah Creek watershed.', 'WDFW records coho and Chinook salmon in Issaquah Creek.']);
    assert.deepEqual(shedLines({ name: 'Lake Washington-Sammamish River', stream: 'Sammamish River', sp: COHO | SOCKEYE }, true),
      ['This street is in the Lake Washington-Sammamish River watershed.', 'WDFW records coho and sockeye salmon in the Sammamish River.']);
    // no road under the finger, and no salmon stream to name
    assert.deepEqual(shedLines({ name: 'City of Tacoma-Frontal Commencement Bay', stream: '', sp: 0 }, false), ['This spot is in the City of Tacoma-Commencement Bay watershed.']);
    for (const t of shedLines({ name: 'Chambers Creek', stream: 'Chambers Creek', sp: COHO | CHUM | STEELHEAD }, true)) {
      assert.doesNotMatch(t, /drain|pipe|flows|goes to|ends up|[–—]/);
      assert.ok(t.length <= 90, t);
    }
  });

  test('"Frontal" is left out of names', () => {
    assert.equal(shedName('Hylebos Creek-Frontal Commencement Bay'), 'Hylebos Creek-Commencement Bay');
    assert.equal(shedName('Issaquah Creek'), 'Issaquah Creek');
  });
});

describe('watersheds: building the file', () => {
  test('two squares share one border arc, used forward by one and backward by the other', () => {
    const sq = (x0: number, x1: number) => [[[x0, 0], [x1, 0], [x1, 10], [x0, 10], [x0, 0]]];
    const t = topology([{ rings: sq(0, 10) }, { rings: sq(10, 20) }], (x, y) => [x, y]);
    assert.equal(t.arcs.length, 3);
    const shared = t.shapes[0][0].map((i) => (i < 0 ? ~i : i)).find((i) => t.shapes[1][0].some((j) => (j < 0 ? ~j : j) === i))!;
    assert.deepEqual([...t.arcs[shared]].map((i) => [t.xy[2 * i], t.xy[2 * i + 1]]).sort((a, b) => a[1] - b[1]), [[10, 0], [10, 10]]);
    // one side runs it one way, the other the other way
    assert.notEqual(t.shapes[0][0].includes(shared), t.shapes[1][0].includes(shared));
  });

  test('a loose shape keeps its own ring, apart from the shared borders', () => {
    const sq = (x0: number, x1: number) => [[[x0, 0], [x1, 0], [x1, 10], [x0, 10], [x0, 0]]];
    const t = topology([{ rings: sq(0, 10) }, { rings: sq(10, 20), loose: true }], (x, y) => [x, y]);
    assert.equal(t.arcs.length, 2);
    assert.equal(t.shapes[1][0].length, 1);
  });

  test('borders are thinned to the tolerance and stored as steps', () => {
    const pts: XY[] = [[0, 0], [100, 10], [200, 40], [300, 10], [400, 0]];
    const xy = new Float64Array(pts.flat()), arc = Int32Array.from([0, 1, 2, 3, 4]);
    assert.deepEqual(thin(xy, arc, 25), [0, 2, 4]);
    assert.deepEqual(thin(xy, arc, 50), [0, 4]);
    assert.deepEqual(encodeArc([[0, 0], [12, 1], [11, -1], [100, 52]], 5), [0, 0, 2, 0, 18, 10]);
  });
});

describe('watersheds.json', () => {
  const url = new URL('../public/data/state/watersheds.json', import.meta.url);
  const text = readFileSync(url, 'utf8');
  const raw = JSON.parse(text) as RawWatersheds;
  const list = readWatersheds(raw)!;
  const at = (ll: LngLat) => watershedAt(list, project(ll));

  test('has the schema, credits USGS, and stays small', () => {
    assert.equal(raw.v, 1);
    assert.match(raw.source, /^USGS Watershed Boundary Dataset \(public domain\)/);
    assert.match(raw.built, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(statSync(url).size <= 1.5e6, `${statSync(url).size} bytes`);
    assert.ok(gzipSync(text).length <= 500_000);
    for (const [huc12, name, stream, sp, rings] of raw.w) {
      assert.match(huc12, /^17\d{10}$/);
      assert.ok(name && rings.length, huc12);
      assert.equal(!!stream, sp > 0, name);
      for (const r of rings) for (const i of r) assert.ok(raw.arcs[i < 0 ? ~i : i], `${name}: arc ${i}`);
    }
    for (const a of raw.arcs) assert.ok(a.length >= 2 && a.length % 2 === 0 && a.every(Number.isInteger));
  });

  test('Front St N in Issaquah is in the Issaquah Creek watershed, whose creek has coho and Chinook', () => {
    const w = at([-122.0355, 47.5335])!;
    assert.equal(w.huc12, '171100120201');
    assert.equal(w.name, 'Issaquah Creek');
    assert.equal(w.stream, 'Issaquah Creek');
    assert.ok(w.sp & COHO && w.sp & CHINOOK);
    assert.equal(shedLines(w, true)[0], 'This street is in the Issaquah Creek watershed.');
    assert.match(shedLines(w, true)[1], /^WDFW records coho, Chinook\b.* in Issaquah Creek\.$/);
  });

  test('Kirkland, Lakewood and Fife, cities without pipe maps, each get a watershed', () => {
    assert.equal(at([-122.2059, 47.6765])?.name, 'Lake Washington-Sammamish River');
    assert.equal(at([-122.2059, 47.6765])?.stream, 'Sammamish River');
    assert.equal(at([-122.5208, 47.1612])?.name, 'Chambers Creek');
    assert.equal(at([-122.5208, 47.1612])?.stream, 'Chambers Creek');
    assert.equal(at([-122.36, 47.24])?.stream, 'Hylebos Creek');
  });

  test('every city on the map without a pipe map is covered; Wenatchee, far outside King and Pierce, is not', () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
    const R = new Region(read('region.json'), read('coverage.json'));
    const missing = R.places.filter((p) => !R.isMapped(p));
    assert.ok(missing.length >= 20);
    for (const p of missing) assert.ok(watershedAt(list, p.at), p.name);
    assert.equal(at([-120.3107, 47.4253]), null);
  });
});
