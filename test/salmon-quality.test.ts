/** How sure each salmon crossing is (OpenStreetMap checks in the build), the crossings a stream line stops short of, and the creek chip's reach */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { XY } from '../src/geo/geo.ts';
import { classifyCrossing, endSnap, type BridgeSeg, type OsmCross } from '../src/salmon/build.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { COHO } from '../src/salmon/species.ts';
import { readTile, SalmonData, tilesIn, type RawTile, type Tile } from '../src/salmon/tiles.ts';
import { SALMON, SalmonWatch } from '../src/salmon/watch.ts';
import { fromRegion } from '../src/salmon/proj.ts';

describe('salmon: how sure a crossing is', () => {
  // a road running north (direction 0) through the crossing at the origin
  const at: XY = [0, 0];

  test('an OSM stream through the same road within 60 m confirms it, and it moves onto that spot', () => {
    const k = classifyCrossing(at, 0, [{ at: [0, -42], dir: 2 }], [], 80, true);
    assert.equal(k.q, 2);
    assert.deepEqual(k.at, [0, -42]);
  });

  test('a bridge of the same road within 40 m confirms it, in place', () => {
    const bridge: BridgeSeg = { a: [0, -30], b: [0, -10], dir: 0 };
    assert.deepEqual(classifyCrossing(at, 0, [], [bridge], 80, false), { q: 2, at: null });
  });

  test('an OSM crossing on a cross street or a road beside this one only makes it likely, and nothing moves', () => {
    const cross: OsmCross = { at: [40, 0], dir: 90 }, beside: OsmCross = { at: [40, -20], dir: 0 };
    assert.deepEqual(classifyCrossing(at, 0, [cross], [], 10, false), { q: 1, at: null });
    assert.deepEqual(classifyCrossing(at, 0, [beside], [], 10, false), { q: 1, at: null });
    // an OSM crossing 60 to 150 m off: likely
    assert.equal(classifyCrossing(at, 0, [{ at: [0, -120], dir: 0 }], [], 10, false).q, 1);
  });

  test('a stream line running beside the road, or an unnamed one OSM lacks, is doubtful; a named one cutting the road is likely', () => {
    // 30 m beside and parallel: the line clips the road at 5 degrees
    assert.equal(classifyCrossing(at, 0, [], [], 5, true).q, 0);
    assert.equal(classifyCrossing(at, 0, [], [], 80, false).q, 0);
    assert.equal(classifyCrossing(at, 0, [], [], 70, true).q, 1);
    // OSM's stream crosses a road only past 150 m
    assert.equal(classifyCrossing(at, 0, [{ at: [0, -200], dir: 0 }], [], 10, false).q, 0);
  });
});

describe('salmon: a stream line that stops short of a road', () => {
  const e: XY = [0, 0];
  const x = (at: XY, name: string) => ({ at, dir: 90, name });

  test("OSM's same stream crossing the road 42 m on is the crossing", () => {
    assert.deepEqual(endSnap(e, 'Fennel Creek', [x([0, -42], 'Fennel Creek')])?.at, [0, -42]);
    // the nearest of two
    assert.deepEqual(endSnap(e, 'Fennel Creek', [x([0, -48], 'Fennel Creek'), x([0, 30], 'Fennel Creek')])?.at, [0, 30]);
  });

  test('never invents one: another name, too far, or a named OSM stream for an unnamed line', () => {
    assert.equal(endSnap(e, 'Fennel Creek', [x([0, -20], 'Canyonfalls Creek')]), null);
    assert.equal(endSnap(e, 'Fennel Creek', [x([0, -55], 'Fennel Creek')]), null);
    assert.equal(endSnap(e, '', [x([0, -20], 'Fennel Creek')]), null);
    assert.equal(endSnap(e, 'Fennel Creek', []), null);
  });

  test('an unnamed OSM stream counts only within 45 m', () => {
    assert.ok(endSnap(e, 'Fennel Creek', [x([0, -40], '')]));
    assert.equal(endSnap(e, 'Fennel Creek', [x([0, -48], '')]), null);
  });
});

/** a tile with crossings at region points (road direction 0, north), q as given (undefined: an older tile) */
function tileOf(list: { at: XY; name: string; q?: number }[]): Tile {
  const raw: RawTile = { v: 1, s: [], l: [], c: [], b: [] };
  for (const c of list) {
    let si = raw.s.findIndex((s) => s[0] === c.name);
    if (si < 0) si = raw.s.push([c.name, COHO, 1]) - 1;
    raw.c.push(c.q === undefined ? [c.at[0], c.at[1], si, 0, COHO] : [c.at[0], c.at[1], si, 0, COHO, c.q]);
  }
  return readTile('0_0', raw)!;
}
const src = (t: Tile) => ({ near: () => [t] });

describe('salmon: doubtful crossings are never said, shown or counted', () => {
  test('tiles: the sixth field is how sure; older tiles read as likely', () => {
    const t = tileOf([{ at: [0, -300], name: 'A Creek', q: 0 }, { at: [0, -600], name: 'B Creek', q: 2 }, { at: [0, -900], name: 'C Creek' }]);
    assert.deepEqual(t.crossings.map((c) => c.q), [0, 2, 1]);
  });

  test('a doubtful crossing ahead: no line, no chip, no quiet zone, not driven over', () => {
    const car: XY = [0, 0], v = 13.4;
    for (const [q, seen] of [[0, false], [1, true], [2, true]] as const) {
      const t = tileOf([{ at: [0, -130], name: 'Doubt Creek', q }]), w = new SalmonWatch();
      assert.equal(!!w.soon(src(t), car, 0, v, 0), seen, `soon q${q}`);
      assert.equal(!!w.next(src(t), car, 0, v), seen, `next q${q}`);
      assert.equal(!!w.within(src(t), car, 0), seen, `within q${q}`);
      // drive over it
      for (let y = 0; y >= -300; y -= 10) w.move(src(t), fromRegion([0, y]), 1000 - y, 0);
      assert.equal(w.passed.length, seen ? 1 : 0, `passed q${q}`);
    }
  });
});

describe('salmon: the creek chip reaches about 30 s ahead, 450 m at most', () => {
  test('a crossing on a road beside this one, 200 m over, never shows as the car drives toward it from 1.5 km', () => {
    const t = tileOf([{ at: [200, -1500], name: 'Beside Creek', q: 2 }]), w = new SalmonWatch();
    for (let y = 0; y >= -1500; y -= 10) {
      for (const v of [null, 11.2, 26.8]) assert.equal(w.next(src(t), [0, y], 0, v), null, `at ${y}, ${v} m/s`);
    }
  });

  test('on this road: at 25 mph from about 335 m, at 60 mph from 450 m, and 200 m when slow', () => {
    const t = tileOf([{ at: [0, -400], name: 'Clover Creek', q: 2 }]);
    assert.equal(new SalmonWatch().next(src(t), [0, 0], 0, 11.2), null);
    assert.equal(new SalmonWatch().next(src(t), [0, -100], 0, 11.2)?.c.stream.name, 'Clover Creek');
    assert.equal(new SalmonWatch().next(src(t), [0, 0], 0, 26.8)?.c.stream.name, 'Clover Creek');
    assert.equal(new SalmonWatch().next(src(t), [0, -150], 0, 2), null);
    assert.equal(new SalmonWatch().next(src(t), [0, -210], 0, 2)?.c.stream.name, 'Clover Creek');
    assert.equal(SalmonWatch.chipM(0), SALMON.chipMinM);
    assert.equal(SalmonWatch.chipM(null), SALMON.lookM);
  });
});

describe('salmon: the rebuilt tiles', () => {
  const data = new SalmonData(new URL('../public/data/salmon/', import.meta.url).href, async (u) => JSON.parse(readFileSync(new URL(u), 'utf8')));
  async function near(lat: number, lon: number, r: number) {
    const p = toRegion([lon, lat]);
    const tiles = await data.some(tilesIn(p[0] - r, p[1] - r, p[0] + r, p[1] + r));
    return tiles.flatMap((t) => t.crossings).filter((c) => Math.hypot(c.at[0] - p[0], c.at[1] - p[1]) <= r);
  }

  test('Fennel Creek under Rhodes Lake Rd E, where the WDFW line ends 42 m short, is a confirmed crossing', async () => {
    const cs = await near(47.14942, -122.18562, 25);
    assert.deepEqual(cs.map((c) => [c.stream.name, c.q]), [['Fennel Creek', 2]]);
  });

  test('the creeks on McCutcheon Rd E and Scatter Creek on I-5 are confirmed; an unnamed one OSM has no stream for is doubtful', async () => {
    assert.deepEqual((await near(47.151177, -122.216576, 25)).map((c) => [c.stream.name, c.q]), [['Fennel Creek', 2]]);
    assert.deepEqual((await near(47.143313, -122.222714, 25)).map((c) => [c.stream.name, c.q]), [['Canyonfalls Creek', 2]]);
    assert.deepEqual((await near(46.82999, -122.99086, 40)).map((c) => [c.stream.name, c.q]), [['Scatter Creek', 2]]);
    assert.deepEqual((await near(47.09109, -122.15487, 25)).map((c) => [c.stream.name, c.q]), [['', 0]]);
  });

  test('the index counts only the crossings it will speak', async () => {
    const idx = JSON.parse(readFileSync(new URL('../public/data/salmon/index.json', import.meta.url), 'utf8'));
    assert.ok(idx.crossings > 7500 && idx.crossings < 9500, String(idx.crossings));
  });
});
