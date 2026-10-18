/** the map tap resolver: every tap gets an answer, in the order of plan 1.8 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type LngLat, type XY } from '../src/geo/geo.ts';
import type { Region } from '../src/app/map/region.ts';
import { World } from '../src/app/map/world.ts';
import { reach, resolve, type Answer, type TapState } from '../src/app/screens/resolve.ts';

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));
const sq = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// a creek street, a soak-in street and a dry one; three drains; a lake, a coho creek and a nameless pond
function town(): World {
  const runs: [number, number, number, XY[]][] = [
    [0, 0, 0, [[0, 0], [300, 0]]],
    [1, 1, 1, [[0, 200], [300, 200]]],
    [2, 4, -1, [[0, 400], [300, 400]]],
  ];
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: ['CB-0', 'CB-1', 'CB-2'], kind: [1, 1, 1], geom: [enc([[150, 5]]), enc([[250, 205]]), enc([[600, 600]])] },
    pondShapes: [],
    next: [-1, -1, -1],
    endings: [
      { code: 'outfall-creek', cls: 0, confidence: 0, terminal: 0, exit: 0, receiving: 'Coho Creek', reason: '' },
      { code: 'drywell', cls: 1, confidence: 0, terminal: 1, exit: 1, receiving: '', reason: '' },
      { code: 'outfall-elsewhere', cls: 2, confidence: 0, terminal: 2, exit: 2, receiving: 'Lake Test', reason: '' },
    ],
    drains: { asset: [0, 1, 2], ending: [0, 1, 2], explicitPaths: {} },
    streets: {
      pieces: ['Creek St', 'Soak Ave', 'Dry Rd'].map((name, id) => ({ id, name, lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' })),
      runs: { piece: runs.map((r) => r[0]), cls: runs.map((r) => r[1]), drain: runs.map((r) => r[2]), geom: runs.map((r) => enc(r[3])) },
    },
    waters: [
      { name: 'Lake Test', kind: 'lake', fennel: false, lines: [], rings: [enc(sq(500, -300, 700, -100))] },
      { name: 'Coho Creek', kind: 'creek', fennel: true, lines: [enc([[-200, -500], [800, -500]])], rings: [] },
      { name: 'unnamed pond or lake', kind: 'lake', fennel: false, lines: [], rings: [enc(sq(1000, 0, 1050, 50))] },
    ],
    fixList: [],
    numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

// OSM roads with no pipe data: a side road, an alley beside Soak Ave, a road by the lone drain, a city street
const ROADS: { name: string; pts: XY[] }[] = [
  { name: 'Side Rd', pts: [[0, -50], [400, -50]] },
  { name: '', pts: [[100, 214], [200, 214]] },
  { name: 'Drain Ln', pts: [[560, 595], [660, 595]] },
  { name: 'Main St', pts: [[2500, -100], [2500, 100]] },
];
function segD(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
const basemap: TapState['basemap'] = {
  roadNear(x, y, r) {
    let best: { name: string; d: number; major: boolean; pts: Float32Array } | null = null;
    for (const rd of ROADS) {
      const d = segD([x, y], rd.pts[0], rd.pts[1]);
      if (d <= r && (!best || d < best.d)) best = { name: rd.name, d, major: false, pts: new Float32Array(rd.pts.flat()) };
    }
    return best;
  },
  waterAt: (x, y) => (x >= 3000 && x <= 3100 && y >= 0 && y <= 100 ? { name: '' } : null),
};
// a city without a pipe map between x 2000 and 2900; one traced county everywhere x < 10 km
const region = {
  placeAt: (p: XY) => (p[0] > 2000 && p[0] < 2900 && Math.abs(p[1]) < 400 ? { name: 'Gray City', at: [2400, 0] } : null),
  isMapped: () => false,
  countyAt: (p: XY) => (p[0] < 10000 ? { name: 'Test' } : null),
  covered: () => true,
  ownerAt: () => 'county',
} as unknown as Region;

const w = town();
const at = (p: XY, mpp = 1.5, extra: Partial<TapState> = {}): Answer => resolve({ world: w, region, basemap, missing: () => [], mpp, ...extra }, p);

describe('tap resolver', () => {
  test('reach is at least 22 CSS px', () => {
    for (const m of [0.8, 1.5, 3, 6, 12, 24]) assert.ok((reach(m) / m) * 3 >= 22, `mpp ${m}`);
  });

  test('far out, the app zooms; between 16 and 24 a miss flies in', () => {
    assert.deepEqual(at([5000, 5000], 30), { kind: 'zoom', to: 7.5 });
    assert.deepEqual(at([5000, 5000], 20), { kind: 'zoom', to: 20 / 3 });
    assert.deepEqual(at([5000, 5000], 18), { kind: 'zoom', to: 6 });
    // a traced street still answers up to mpp 24
    const a = at([150, 2], 20);
    assert.equal(a.kind, 'street');
  });

  test('a traced street under the finger answers', () => {
    const a = at([150, 2]);
    assert.equal(a.kind, 'street');
    assert.equal(a.kind === 'street' && a.run.i, 0);
    assert.equal((at([150, 398]) as { run: { i: number } }).run.i, 2);
  });

  test('a gray road under the finger beats a traced street beside it', () => {
    const a = at([150, 214]);
    assert.equal(a.kind, 'road');
    assert.equal(a.kind === 'road' && a.road.name, '');
    assert.equal(a.kind === 'road' && a.nearest?.i, 1);
  });

  test('a county area that is not loaded yet loads first', () => {
    const a = at([5000, 5000], 3, { missing: () => [{}] });
    assert.equal(a.kind, 'loading');
    assert.ok(a.kind === 'loading' && a.box[2] - a.box[0] > 0.007 && a.box[2] - a.box[0] < 0.009);
  });

  test('water: a lake, a coho creek, OSM water and a pond with no name', () => {
    const lake = at([600, -200]);
    assert.deepEqual(lake.kind === 'water' && [lake.name, lake.coho], ['Lake Test', false]);
    const creek = at([100, -503]);
    assert.deepEqual(creek.kind === 'water' && [creek.name, creek.coho], ['Coho Creek', true]);
    const osm = at([3050, 50]);
    assert.deepEqual(osm.kind === 'water' && [osm.water, osm.name], [null, '']);
    const pond = at([1020, 20]);
    assert.equal(pond.kind === 'water' && pond.coho, false);
    // a creek 12 m away is too far at street zoom
    assert.notEqual(at([100, -512]).kind, 'water');
  });

  test('a city without a pipe map names the road and the nearest street with an answer', () => {
    const a = at([2505, 0]);
    assert.equal(a.kind, 'city');
    assert.ok(a.kind === 'city' && a.place.name === 'Gray City' && a.road === 'Main St');
    assert.equal(a.kind === 'city' && a.nearest?.i, 0);
    assert.equal((at([2600, 0]) as { road: string | null }).road, null);
  });

  test('a road with no pipe data: a drain within 15 m answers for it, else the road card', () => {
    const r = at([200, -50]);
    assert.equal(r.kind, 'road');
    assert.ok(r.kind === 'road' && r.road.name === 'Side Rd' && r.road.d < 1);
    assert.equal(r.kind === 'road' && r.nearest?.i, 0);
    const d = at([600, 594]);
    assert.equal(d.kind, 'drain');
    assert.ok(d.kind === 'drain' && d.drain === 2 && d.d < 7);
  });

  test('a lawn: a drain within 15 m, else the street within 150 m, labeled as near', () => {
    const d = at([600, 612]);
    assert.ok(d.kind === 'drain' && d.drain === 2);
    const n = at([150, 60]);
    assert.equal(n.kind, 'near');
    assert.ok(n.kind === 'near' && n.run.i === 0 && Math.abs(n.d - 60) < 1);
  });

  test('nothing close: in a traced county, else outside', () => {
    const f = at([5000, 0]);
    assert.equal(f.kind, 'far');
    assert.ok(f.kind === 'far' && f.nearest !== null);
    assert.deepEqual(at([20000, 0]), { kind: 'outside', county: null });
    const noRegion = resolve({ world: w, region: null, basemap: null, missing: () => [], mpp: 3 }, [30000, 30000]);
    assert.equal(noRegion.kind, 'outside');
  });

  test('no tap goes unanswered', () => {
    const kinds = new Set(['zoom', 'loading', 'street', 'water', 'city', 'road', 'drain', 'near', 'far', 'outside']);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 400; k++) {
      const p: XY = [rnd() * 4000 - 600, rnd() * 2000 - 900], mpp = [0.8, 1.5, 3, 6, 12, 20][k % 6];
      const a = at(p, mpp);
      assert.ok(a && kinds.has(a.kind), `${p} at ${mpp}`);
    }
  });
});
