/** lake islands: dry on the map, not "in the lake" for a tap, and in the built Lake Washington data */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, decodeCoords, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, pointInPolygon, type LngLat, type XY } from '../src/geo/geo.ts';
import { shores, World } from '../src/app/map/world.ts';

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));
const sq = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// a 1 km lake with a 200 m island in the middle
function lake(): World {
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: [], kind: [], geom: [] }, pondShapes: [], next: [], endings: [],
    drains: { asset: [], ending: [], explicitPaths: {} },
    streets: { pieces: [], runs: { piece: [], cls: [], drain: [], geom: [] } },
    waters: [{ name: 'Lake Test', kind: 'lake', fennel: false, lines: [], rings: [enc(sq(0, 0, 1000, 1000))], holes: [[enc(sq(400, 400, 600, 600))]] }],
    fixList: [],
    numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

describe('lake islands', () => {
  test('the island is land, the water around it is lake', () => {
    const w = lake(), at = (x: number, y: number) => w.toWorld(ll([x, y]));
    assert.equal(w.waters.length, 1);
    assert.equal(w.waters[0].holes?.length, 1);
    assert.equal(w.waterAt(at(200, 500), 0)?.d, 0);
    const island = w.waterAt(at(500, 500), 150);
    assert.ok(island && island.d > 90, 'the island is about 100 m from the shore');
  });

  test('Mercer Island is not inside Lake Washington in any built area', () => {
    const mercer: LngLat = [-122.2285, 47.5650], channel: LngLat = [-122.2560, 47.5800];
    let seen = 0;
    for (const f of readdirSync('public/data/areas').filter((n) => n.endsWith('.json') && n !== 'index.json' && n !== 'names.json')) {
      const b = JSON.parse(readFileSync(`public/data/areas/${f}`, 'utf8')) as Bundle;
      for (const wt of b.waters) {
        if (wt.name !== 'Lake Washington') continue;
        wt.rings.forEach((r, k) => {
          const rings = [decodeCoords(r), ...(wt.holes?.[k] ?? []).map(decodeCoords)];
          if (!pointInPolygon(channel, rings.slice(0, 1))) return;
          seen++;
          assert.ok(pointInPolygon(channel, rings), `${f}: the west channel is water`);
          assert.ok(!pointInPolygon(mercer, rings), `${f}: Mercer Island is land`);
        });
      }
    }
    assert.ok(seen > 0);
  });

  test('shores lists the lake ring, then its islands', () => {
    assert.deepEqual(shores({ name: '', fennel: false, line: [[0, 0], [1, 1]] }), []);
    const ring: XY[] = sq(0, 0, 10, 10), hole: XY[] = sq(4, 4, 6, 6);
    assert.deepEqual(shores({ name: '', fennel: false, ring, holes: [hole] }), [ring, hole]);
  });
});
