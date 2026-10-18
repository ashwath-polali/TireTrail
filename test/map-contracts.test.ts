/** map contracts: palette, views, world, basemap and region helpers the map packages build on */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { project } from '../scripts/lib/lcc.ts';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type LngLat, type XY } from '../src/geo/geo.ts';
import { Basemap, decode, type BaseTile } from '../src/app/map/basemap.ts';
import { CAT, HATCH, LINE, PICK, ROAD, ROUTE, swatchSVG, type Band, type Swatch } from '../src/app/map/palette.ts';
import { Region, regionPt, worldPt } from '../src/app/map/region.ts';
import type { Scene } from '../src/app/map/render.ts';
import { HOME_AREA, OVERVIEW_MPP, PLACE_MPP, TOWN_POINT, WANDER } from '../src/app/map/views.ts';
import { CLS, G_ROAD, World } from '../src/app/map/world.ts';

const P = localProjection();
// world meters (y down) to lon/lat
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));

// a tiny town: a gray street, a creek street ending on it, more of that piece, odd class codes, two drains, lakes and creeks
function town(): World {
  const runs: [number, number, XY[]][] = [
    [0, 3, [[0, 0], [200, 0]]],
    [1, 0, [[100, 0], [100, -150]]],
    [1, 5, [[100, -150], [100, -300]]],
    [1, 0, [[100, -300], [100, -400]]],
    [2, 9, [[600, 0], [700, 0]]],
    [2, -1, [[600, 100], [700, 100]]],
  ];
  const sq = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: ['CB-1', 'CB-2'], kind: [1, 1], geom: [enc([[100, -20]]), enc([[50, 5]])] },
    pondShapes: [],
    next: [-1, -1],
    endings: [
      { code: 'outfall-unknown', cls: 5, confidence: 0, terminal: 0, exit: 0, receiving: '', reason: '' },
      { code: 'outfall-unknown', cls: 7, confidence: 0, terminal: 1, exit: 1, receiving: '', reason: '' },
    ],
    drains: { asset: [0, 1], ending: [0, 1], explicitPaths: {} },
    streets: {
      pieces: [0, 1, 2].map((id) => ({ id, name: `Street ${id}`, lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' })),
      runs: { piece: runs.map((r) => r[0]), drain: runs.map(() => -1), cls: runs.map((r) => r[1]), geom: runs.map((r) => enc(r[2])) },
    },
    waters: [
      { name: 'Unnamed lake', kind: 'lake', fennel: false, lines: [], rings: [enc(sq(300, -100, 400, 0))] },
      { name: 'Lake Test', kind: 'lake', fennel: false, lines: [], rings: [enc(sq(300, -100, 400, 0))] },
      { name: 'Unnamed stream', kind: 'nhd', fennel: false, lines: [enc([[310, -50], [390, -50]])], rings: [] },
      { name: 'Test Creek', kind: 'creek', fennel: true, lines: [enc([[300, 50], [500, 50]])], rings: [] },
      { name: 'Fennel Pond', kind: 'lake', fennel: true, lines: [], rings: [enc(sq(800, 800, 820, 820))] },
      { name: 'Lake Bonney Outflow', kind: 'creek', fennel: true, lines: [enc([[800, 900], [900, 900]])], rings: [] },
      { name: 'Quiet Creek', kind: 'creek', fennel: false, lines: [enc([[800, 1000], [900, 1000]])], rings: [] },
    ],
    fixList: [],
    numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

describe('palette', () => {
  test('every answer class has a color, including treatment', () => {
    assert.deepEqual(Object.keys(CAT).sort(), [...CLS].sort());
    assert.ok(CLS.includes('treatment'));
  });

  test('the treatment color stands apart for normal and red-green color-blind eyes, and is not yellow', () => {
    for (const other of [CAT.creek, CAT.ground, CAT.elsewhere, ROAD.fill]) {
      for (const sim of ['normal', 'deutan', 'protan'] as const) {
        const d = de2000(simulate(CAT.treatment, sim), simulate(other, sim));
        assert.ok(d >= 12, `${CAT.treatment} vs ${other} under ${sim}: dE ${d.toFixed(1)}`);
      }
    }
    const [h, s] = hueSat(CAT.treatment);
    assert.ok(s < 0.05 || h < 35 || h > 80, 'yellow is for traced places and for you');
  });

  test('treatment has its own line code', () => {
    const code = (k: keyof typeof LINE) => JSON.stringify(LINE[k]);
    for (const k of ['creek', 'ground', 'elsewhere'] as const) assert.notEqual(code('treatment'), code(k));
  });

  test('legend swatches are 36x12 crisp SVGs in the map colors', () => {
    const kinds: Swatch[] = [...CLS, 'stream', 'coho', 'drain', 'hatch', 'traced', 'pick'];
    const bands: Band[] = ['town', 'overview', 'region'];
    for (const k of kinds) for (const b of bands) {
      const s = swatchSVG(k, b);
      assert.match(s, /^<svg [^>]*width="36" height="12" viewBox="0 0 12 4" shape-rendering="crispEdges"/);
      assert.doesNotMatch(s, /NaN|undefined/);
      assert.ok(s.endsWith('</svg>'));
    }
    assert.ok(swatchSVG('creek', 'overview').includes(CAT.creek));
    assert.ok(swatchSVG('treatment', 'town').includes(CAT.treatment));
    assert.ok(swatchSVG('none', 'overview').includes(ROAD.fill));
    assert.ok(swatchSVG('none', 'town').includes(ROAD.asphalt[0]) && !swatchSVG('none', 'town').includes(CAT.creek));
    assert.ok(swatchSVG('hatch', 'region').includes(HATCH.edge));
    assert.ok(swatchSVG('traced', 'region').includes(ROUTE.fill));
    assert.ok(swatchSVG('pick', 'overview').includes(PICK.band));
    assert.notEqual(swatchSVG('creek', 'overview'), swatchSVG('treatment', 'overview'));
  });
});

describe('views', () => {
  const inWander = ([lon, lat]: LngLat) => lon >= WANDER[0] && lon <= WANDER[2] && lat >= WANDER[1] && lat <= WANDER[3];
  test('the wander box holds all of Washington, the home area Pierce and King; one place up close is at street-color zoom', () => {
    assert.deepEqual(TOWN_POINT, [-122.1702, 47.187]);
    assert.ok(inWander(TOWN_POINT));
    assert.ok(inWander([-122.44, 47.25]) && inWander([-122.335, 47.608]));
    // Spokane, Neah Bay, Vancouver, Blaine, Clarkston
    for (const p of [[-117.426, 47.659], [-124.625, 48.368], [-122.661, 45.639], [-122.747, 48.994], [-117.045, 46.416]] as LngLat[]) assert.ok(inWander(p), String(p));
    assert.ok(!inWander([-116.5, 47.5]) && !inWander([-122.68, 45.4]));
    const home = ([lon, lat]: LngLat) => lon >= HOME_AREA[0] && lon <= HOME_AREA[2] && lat >= HOME_AREA[1] && lat <= HOME_AREA[3];
    assert.ok(home(TOWN_POINT) && home([-122.335, 47.608]) && !home([-117.426, 47.659]));
    assert.deepEqual([PLACE_MPP.laptop, PLACE_MPP.phone], [6, 7]);
  });

  test('the opening view of everything traced stays close enough for colored streets', () => {
    // past REGION_MPP (24) the region map draws; from OV_MPP (120) on, only the yellow areas
    assert.ok(OVERVIEW_MPP > 24 && OVERVIEW_MPP < 120);
  });
});

describe('world', () => {
  const w = town();

  test('class code 5 is treatment; codes the app does not know read as unknown', () => {
    assert.deepEqual(w.runs.map((r) => CLS[r.k]), ['unknown', 'creek', 'treatment', 'creek', 'unknown', 'unknown']);
    assert.equal(w.drainCls(0), 'treatment');
    assert.equal(w.drainCls(1), 'unknown');
    // treatment streets get road pixels of their own class
    assert.equal(w.groundAt(100, -200), G_ROAD + 5);
    assert.equal(w.groundAt(100, -100), G_ROAD + 0);
  });

  test('runAtDrawn picks the street drawn on top where streets overlap', () => {
    const at = (p: XY, m = 30) => w.runAtDrawn(p, m)?.i ?? null;
    // the gray street is nearer, but the creek street is drawn over this spot
    assert.equal(w.nearestRun([102, 2], 30)?.i, 0);
    assert.equal(at([102, 2]), 1);
    assert.equal(at([150, 2]), 0);
    assert.equal(at([100, -30]), 1);
    // off the road: what's drawn at the nearest street's closest point
    assert.equal(at([150, 15]), 0);
    assert.equal(at([104, 12]), 1);
    assert.equal(at([150, 40]), null);
    // a wider drawn line counts more streets as overlapping
    assert.equal(w.runAtDrawn([110, 4], 30)?.i, 0);
    assert.equal(w.runAtDrawn([110, 4], 30, 12)?.i, 1);
  });

  test('stretchOf is every run of the piece with the same answer', () => {
    assert.deepEqual(w.stretchOf(w.runs[1]).map((r) => r.i), [1, 3]);
    assert.deepEqual(w.stretchOf(w.runs[2]).map((r) => r.i), [2]);
    assert.deepEqual(w.stretchOf(w.runs[0]).map((r) => r.i), [0]);
    assert.deepEqual(w.stretchOf(w.runs[4]).map((r) => r.i), [4, 5]);
  });

  test('waterAt: inside a lake is 0 away and names it; creeks by distance; nothing past maxM', () => {
    const lake = w.waterAt([350, -45], 20);
    assert.equal(lake?.w.name, 'Lake Test');
    assert.equal(lake?.d, 0);
    const creek = w.waterAt([400, 58], 20);
    assert.equal(creek?.w.name, 'Test Creek');
    assert.ok(Math.abs(creek!.d - 8) < 0.5);
    assert.equal(w.waterAt([400, 58], 5), null);
    const shore = w.waterAt([420, -50], 30);
    assert.equal(shore?.w.ring !== undefined, true);
    assert.ok(Math.abs(shore!.d - 20) < 0.5);
  });

  test('watersNear lists waters near a point', () => {
    const names = (p: XY, r: number) => new Set(w.watersNear(p, r).map((i) => w.waters[i].name));
    assert.ok(names([350, -50], 10).has('Lake Test'));
    assert.ok(!names([350, -50], 10).has('Quiet Creek'));
    assert.ok(names([850, 1000], 10).has('Quiet Creek'));
  });

  test('isCoho: flagged streams only, not lakes, outflows or unflagged creeks', () => {
    const by = (n: string) => w.waters.find((x) => x.name === n)!;
    assert.equal(w.isCoho(by('Test Creek')), true);
    assert.equal(w.isCoho(by('Fennel Pond')), false);
    assert.equal(w.isCoho(by('Lake Bonney Outflow')), false);
    assert.equal(w.isCoho(by('Quiet Creek')), false);
  });

  test('a scene can carry the new overlay fields', () => {
    const sc: Scene = {
      trip: { path: [[0, 0], [1, 1]], cls: 'treatment', end: 'gap', water: null, pond: null },
      stretch: [[[0, 0], [1, 0]]], tapMark: { at: [0, 0], t0: 1 }, tags: [{ at: [0, 0], text: 'storm drain', tone: 'drain', n: 2 }],
      muted: true, trails: [{ path: [[0, 0]], cls: 'creek' }], me: { at: [0, 0], acc: 12 },
      pins: [{ at: [0, 0], n: 1, hollow: true, badge: 'q' }], ending: { kind: 'soak', at: [0, 0], t: 1, rest: true },
    };
    assert.equal(sc.trip?.cls, 'treatment');
  });
});

describe('basemap', () => {
  // one 2 km tile: a lake with an island, a named major road and an unnamed minor one (tile units are 0.5 m)
  const raw = {
    b: [],
    c: [[3, [200, 200, 400, 0, 0, 400, -400, 0], [360, 360, 80, 0, 0, 80, -80, 0]]] as [number, ...number[][]][],
    r: [[1, 0, 1000, 2000, 0], [0, 0, 1600, 2000, 0]],
    rn: [1, 0],
    n: ['Main St'],
  };
  const make = () => {
    const bm = new Basemap();
    const tile = decode(raw, 0, 0, 0.5);
    (bm as unknown as { tiles: Map<string, BaseTile> }).tiles.set('0_0', tile);
    return { bm, tile };
  };

  test('roadNear gives the nearest drawn road with its name, distance, class and line', () => {
    const { bm } = make();
    const r = bm.roadNear(500, 503, 10)!;
    assert.equal(r.name, 'Main St');
    assert.ok(Math.abs(r.d - 3) < 1e-6);
    assert.equal(r.major, true);
    assert.equal(r.pts.length, 4);
    assert.equal(bm.roadNear(500, 650, 10), null);
    const minor = bm.roadNear(500, 805, 10)!;
    assert.deepEqual([minor.name, minor.major], ['', false]);
  });

  test('roadAt still answers with just the name', () => {
    const { bm } = make();
    assert.equal(bm.roadAt(500, 503, 10), 'Main St');
    assert.equal(bm.roadAt(500, 805, 10), '');
    assert.equal(bm.roadAt(500, 650, 10), null);
  });

  test('roads hidden under a drawn street are skipped', () => {
    const { bm, tile } = make();
    tile.roads[0].hide = true;
    assert.equal(bm.roadNear(500, 503, 10), null);
  });

  test('waterAt: inside the lake, not on its island, not outside or in unloaded tiles', () => {
    const { bm } = make();
    assert.deepEqual(bm.waterAt(150, 150), { name: '' });
    assert.equal(bm.waterAt(200, 200), null);
    assert.equal(bm.waterAt(50, 50), null);
    assert.equal(bm.waterAt(2500, 150), null);
  });
});

describe('region', () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
  const R = new Region(read('region.json'), read('coverage.json'));
  const w = town();
  const W = (lon: number, lat: number) => w.toWorld([lon, lat]);

  // lon/lat of a region point by Newton steps on the forward projection, independent of region.ts
  function invert(t: XY): LngLat {
    let p = ll(t);
    for (let it = 0; it < 30; it++) {
      const f = project(p), ex = f[0] - t[0], ey = f[1] - t[1];
      if (Math.hypot(ex, ey) < 1e-9) break;
      const h = 1e-7, fx = project([p[0] + h, p[1]]), fy = project([p[0], p[1] + h]);
      const a = (fx[0] - f[0]) / h, b = (fy[0] - f[0]) / h, c = (fx[1] - f[1]) / h, d = (fy[1] - f[1]) / h, det = a * d - b * c;
      p = [p[0] - (d * ex - b * ey) / det, p[1] - (a * ey - c * ex) / det];
    }
    return p;
  }

  test('W13: toWorld puts Gig Harbor outline points within 1 m of the direct world projection', () => {
    const gig = R.places.find((p) => p.name === 'Gig Harbor')!;
    const out = R.toWorld(gig);
    let worst = 0, drift = 0;
    gig.rings.forEach((r, i) => r.forEach((q, k) => {
      const direct = w.toWorld(invert(q));
      worst = Math.max(worst, Math.hypot(out.rings[i][k][0] - direct[0], out.rings[i][k][1] - direct[1]));
      drift = Math.max(drift, Math.hypot(q[0] - direct[0], q[1] - direct[1]));
    }));
    assert.ok(worst < 1, `worst ${worst} m`);
    // unconverted outlines sit far off the streets here
    assert.ok(drift > 50, `drift ${drift} m`);
    assert.equal(R.toWorld(gig), out, 'cached');
  });

  test('worldPt and regionPt undo each other across the state', () => {
    for (const [lon, lat] of [[-122.58, 47.33], [-122.335, 47.608], [-124.7, 48.4], [-117.04, 46.1], [-122.1702, 47.187]]) {
      const p = W(lon, lat), back = worldPt(regionPt(p));
      assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1]) < 1e-6);
      const c = project([lon, lat]), rc = regionPt(p);
      assert.ok(Math.hypot(rc[0] - c[0], rc[1] - c[1]) < 1e-6);
    }
  });

  test('places, counties, coverage and owners for real points', () => {
    const bonney = W(-122.1702, 47.187), spanaway = W(-122.4347, 47.1039);
    assert.equal(R.placeAt(bonney)?.name, 'Bonney Lake');
    assert.equal(R.isMapped(R.placeAt(bonney)!), true);
    assert.equal(R.ownerAt(bonney), 'city');
    assert.equal(R.placeAt(W(-122.293, 47.188))?.name, 'Puyallup');
    assert.equal(R.placeAt(spanaway), null);
    assert.equal(R.ownerAt(spanaway), 'county');
    // a city with only county streets along its edges stays the county's
    assert.equal(R.placeAt(W(-122.2045, 47.0985))?.name, 'Orting');
    assert.equal(R.ownerAt(W(-122.2045, 47.0985)), 'county');
    assert.equal(R.countyAt(bonney)?.name, 'Pierce');
    assert.equal(R.countyAt(W(-122.335, 47.608))?.name, 'King');
    assert.equal(R.countyAt(W(-117.43, 47.66))?.name, 'Spokane');
    assert.equal(R.countyAt(W(-125.5, 47.5)), null);
    const county = (n: string) => R.counties.find((c) => c.name === n)!;
    assert.equal(R.covered(county('Pierce')), true);
    assert.equal(R.covered(county('Spokane')), false);
    // the traced area spills a little over the Lewis County line; that doesn't count
    assert.equal(R.covered(county('Lewis')), false);
    assert.equal(R.inCoverage(bonney), true);
    assert.equal(R.inCoverage(W(-117.43, 47.66)), false);
  });

  test('drawn: region-zoom taps compare against the outlines as drawn', () => {
    const at = project([-122.1702, 47.187]);
    assert.equal(R.placeAt(at, true)?.name, 'Bonney Lake');
    assert.equal(R.countyAt(at, true)?.name, 'Pierce');
    assert.equal(R.inCoverage(at, true), true);
  });

  test('nothing assumes Pierce: a King city with its own map is the city, others the county', () => {
    const ringOf = (pts: LngLat[]) => {
      const out: number[] = [];
      let px = 0, py = 0;
      for (const q of pts) { const [x, y] = project(q); out.push(x - px, y - py); [px, py] = [x, y]; }
      return out;
    };
    const box = (w0: number, s: number, e: number, n: number) => ringOf([[w0, s], [e, s], [e, n], [w0, n]]);
    const raw = {
      states: [], detail: [], abroad: [], points: [],
      counties: [{ name: 'King', home: false, at: project([-122.1, 47.5]).map(Math.round) as XY, rings: [box(-122.5, 47.1, -121.1, 47.8)] }],
      places: [
        { name: 'Seattle', at: project([-122.33, 47.6]).map(Math.round) as XY, rings: [box(-122.44, 47.49, -122.22, 47.74)] },
        { name: 'Bellevue', at: project([-122.15, 47.6]).map(Math.round) as XY, rings: [box(-122.2, 47.55, -122.1, 47.65)] },
      ],
    };
    const K = new Region(raw, { rings: [box(-122.45, 47.45, -122.21, 47.75)] });
    const seattle = W(-122.33, 47.62), bellevue = W(-122.15, 47.6), rural = W(-121.5, 47.4);
    assert.equal(K.placeAt(seattle)?.name, 'Seattle');
    assert.equal(K.isMapped(K.places[0]), true);
    assert.equal(K.isMapped(K.places[1]), false);
    assert.equal(K.ownerAt(seattle), 'county');
    K.cityMaps.add('Seattle');
    assert.equal(K.ownerAt(seattle), 'city');
    assert.equal(K.ownerAt(bellevue), 'county');
    K.cityMaps.add('Bellevue');
    assert.equal(K.isMapped(K.places[1]), true);
    assert.equal(K.ownerAt(rural), 'county');
    assert.equal(K.countyAt(seattle)?.name, 'King');
    assert.equal(K.covered(K.counties[0]), true);
    assert.equal(K.inCoverage(seattle), true);
    assert.equal(K.inCoverage(rural), false);
  });
});

// Machado 2009 full-severity color vision simulation and CIEDE2000, for the palette check
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const unlin = (v: number) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function simulate(h: string, kind: 'normal' | 'protan' | 'deutan'): number[] {
  const c = rgb(h);
  if (kind === 'normal') return c;
  const l = c.map(lin);
  return MACHADO[kind].map((row) => unlin(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}
function lab(c: number[]): number[] {
  const [r, g, b] = c.map(lin);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047), y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function de2000(c1: number[], c2: number[]): number {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(a1p, b1), h2 = hue(a2p, b2);
  let dh = C1 * C2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2, Cbp = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (C1 * C2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
function hueSat(h: string): [number, number] {
  const [r, g, b] = rgb(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return [0, 0];
  const H = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [H * 60, d / (1 - Math.abs(mx + mn - 1))];
}
