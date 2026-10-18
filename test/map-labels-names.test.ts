/** map labels: which names exist, where they anchor and when they show (no DOM) */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { project } from '../scripts/lib/lcc.ts';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, pointInPolygon, type LngLat, type XY } from '../src/geo/geo.ts';
import { Region } from '../src/app/map/region.ts';
import { TOWN_POINT } from '../src/app/map/views.ts';
import { World } from '../src/app/map/world.ts';

// labels.ts pulls in its stylesheet; node has nothing to do with it
registerHooks({ load: (url, ctx, next) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, ctx)) });
const { buildNames, interior, readFile, sameName, shortName, streetGroups } = await import('../src/app/map/labels.ts');
type Cand = import('../src/app/map/labels.ts').Cand;
type LabelFile = import('../src/app/map/labels.ts').LabelFile;

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));
const sq = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** a world from named runs and waters, in meters (y down) */
function world(runs: [name: string, pts: XY[]][], waters: { name: string; fennel?: boolean; line?: XY[]; ring?: XY[] }[] = []): World {
  const names = [...new Set(runs.map((r) => r[0]))];
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: [], kind: [], geom: [] }, pondShapes: [], next: [], endings: [],
    drains: { asset: [], ending: [], explicitPaths: {} },
    streets: {
      pieces: names.map((name, id) => ({ id, name, lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' })),
      runs: { piece: runs.map((r) => names.indexOf(r[0])), drain: runs.map(() => -1), cls: runs.map(() => 4), geom: runs.map((r) => enc(r[1])) },
    },
    waters: waters.map((w) => ({ name: w.name, kind: w.ring ? 'lake' : 'creek', fennel: !!w.fennel, lines: w.line ? [enc(w.line)] : [], rings: w.ring ? [enc(w.ring)] : [] })),
    fixList: [], numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const R = new Region(read('region.json'), read('coverage.json'));
const W0 = world([['Main St E', [[0, 0], [300, 0]]]]);
const named = (cs: Cand[], text: string) => cs.filter((c) => c.text === text);
const all = (n: ReturnType<typeof buildNames>) => [...n.early, ...n.towns, ...n.water, ...n.hoods, ...n.late];
const near = (a: XY, b: XY, m: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= m;

describe('road names', () => {
  test('OSM names read the way the county writes them', () => {
    assert.equal(shortName('41st Street Place Southeast'), '41st St Pl SE');
    assert.equal(shortName('Lake Tapps Parkway East'), 'Lake Tapps Pkwy E');
    assert.equal(shortName('Crystal Ridge Court Southeast'), 'Crystal Ridge Ct SE');
    // a leading direction is part of the name; a lone word stays
    assert.equal(shortName('East Pioneer Avenue'), 'East Pioneer Ave');
    assert.equal(shortName('Avenue A'), 'Avenue A');
    assert.equal(shortName('East'), 'East');
  });

  test('two spellings of one road match, two roads do not', () => {
    assert.equal(sameName('South Prairie Road East'), sameName('S Prairie Rd E'));
    assert.equal(sameName('214th Avenue East'), sameName('214th Ave E'));
    assert.notEqual(sameName('214th Ave E'), sameName('214th Ave Ct E'));
  });
});

describe('labels.json', () => {
  test('rows are checked one by one; anything else is no file', () => {
    assert.equal(readFile(null), null);
    assert.equal(readFile({ v: 2, places: [] }), null);
    assert.equal(readFile({ v: 1 }), null);
    const f = readFile({
      v: 1, places: [['Bonney Lake', 'town', -122.17, 47.187], ['', 'town', 0, 0], ['Odd', 'town', 'x', 1], ['Short', 'town']],
      lakes: [['Lake Tapps', -122.17, 47.21, 1e7, -122.2, 47.19, -122.14, 47.25], ['Bad', 1, 2]],
      parks: [['Allan Yorke Park', -122.19, 47.18, 2e5]],
    })!;
    assert.deepEqual(f.places, [['Bonney Lake', 'town', -122.17, 47.187]]);
    assert.equal(f.lakes.length, 1);
    assert.equal(f.parks!.length, 1);
    assert.deepEqual(f.schools, []);
  });
});

describe('places without labels.json', () => {
  const n = buildNames(W0, R, null), cs = all(n);

  test('the built-in town is named at its town point, before cities without a pipe map', () => {
    const bl = named(cs, 'Bonney Lake').filter((c) => c.kind === 'town');
    assert.equal(bl.length, 1);
    assert.ok(near(bl[0].at[0], W0.toWorld(TOWN_POINT), 1));
    assert.equal(bl[0].min, 2.6);
    assert.equal(bl[0].max, 420);
    const order = n.early.map((c) => c.text);
    assert.ok(order.indexOf('Bonney Lake') < order.indexOf('Puyallup'));
  });

  test('cities without a pipe map get a second line, kept inside their own outline', () => {
    const p = named(cs, 'Puyallup');
    assert.equal(p.length, 1);
    assert.equal(p[0].kind, 'nomap');
    assert.equal(p[0].sub, 'Pipe map not added yet');
    assert.deepEqual([p[0].min, p[0].max], [2.6, 420]);
    assert.ok(p[0].fill && pointInPolygon(p[0].at[0], p[0].fill.world));
    // the same rule the map's striping uses
    for (const pl of R.places) {
      const c = cs.find((x) => x.text === pl.name)!;
      assert.equal(c.kind, R.isMapped(pl) ? 'town' : 'nomap', pl.name);
    }
  });

  test('region names: the home state first and always, the marker label, covered counties only', () => {
    assert.equal(n.early[0].text, 'WASHINGTON');
    assert.ok(n.early[0].fill && n.early[0].around);
    assert.equal(n.early[0].min, 700);
    const here = named(cs, 'Where TireTrail works')[0];
    assert.equal(here.min, 1500);
    assert.equal(here.extra, 'ml-here');
    assert.equal(named(cs, 'PIERCE COUNTY').length, 1);
    assert.equal(named(cs, 'SPOKANE COUNTY').length, 0);
    // drawn anchors are the region map's own points
    const seattle = named(cs, 'Seattle')[0];
    assert.deepEqual(seattle.drawn[0], R.points.find((q) => q.name === 'Seattle')!.at);
  });

  test('only the new kinds; no neighborhoods without labels.json', () => {
    const kinds = new Set(cs.map((c) => c.kind));
    for (const k of kinds) assert.ok(['street', 'water', 'town', 'hood', 'place', 'region', 'city', 'peak', 'sea', 'tag', 'nomap'].includes(k), k);
    assert.ok(!kinds.has('hood'));
    assert.equal(n.towns.length, 0);
  });
});

describe('places from labels.json', () => {
  const W = (p: LngLat) => W0.toWorld(p);
  const f: LabelFile = {
    v: 1,
    places: [
      ['Bonney Lake', 'town', -122.170229, 47.187019], ['Puyallup', 'town', -122.29214, 47.184901], ['Kent', 'city', -122.2348, 47.3809],
      ['Seattle', 'city', -122.330062, 47.603832], ['Prairie Ridge', 'town', -122.148726, 47.137602], ['Lake Tapps', 'hamlet', -122.190865, 47.244516],
      ['Tehaleh', 'suburb', -122.12, 47.12], ['Kent', 'hamlet', -122.235, 47.381], ['Ellensburg', 'town', -120.545122, 46.997064],
    ],
    lakes: [['Lake Tapps', -122.171408, 47.214778, 10853915, -122.22, 47.19, -122.13, 47.26], ['Spanaway Lake', -122.4426, 47.1153, 1060000, -122.45, 47.105, -122.435, 47.125], ['Clear Pond', -122.3, 47.1, 50000, -122.31, 47.09, -122.29, 47.11]],
    parks: [['Allan Yorke Park', -122.191, 47.183, 200000]],
    schools: [['Bonney Lake High School', -122.16, 47.17]],
  };
  const tapps = world([['Main St E', [[0, 0], [300, 0]]]], [{ name: 'Lake Tapps', ring: [W([-122.2, 47.2]), W([-122.15, 47.2]), W([-122.15, 47.24]), W([-122.2, 47.24])] }]);
  const n = buildNames(tapps, R, f), cs = all(n);

  test('a city in both files is one name, at the OSM town point', () => {
    const bl = named(cs, 'Bonney Lake').filter((c) => c.kind === 'town');
    assert.equal(bl.length, 1);
    assert.ok(near(bl[0].at[0], W([-122.170229, 47.187019]), 0.5));
    const pu = named(cs, 'Puyallup');
    assert.equal(pu.length, 1);
    assert.equal(pu[0].kind, 'nomap');
    assert.ok(near(pu[0].at[0], W([-122.29214, 47.184901]), 0.5));
  });

  test('other towns from data, a few at a time; a city with a dot on the region map hands over at mpp 90', () => {
    const kent = named(n.towns, 'Kent');
    assert.equal(kent.length, 1);
    assert.deepEqual([kent[0].min, kent[0].max], [2.6, 420]);
    assert.ok((kent[0].tier ?? 0) > (named(n.towns, 'Prairie Ridge')[0].tier ?? 0));
    assert.equal(named(n.towns, 'Seattle')[0].max, 90);
    // past the wander box, towns name the land from farther out
    assert.deepEqual(named(n.towns, 'Ellensburg').map((c) => c.max), [1400]);
  });

  test('neighborhoods show from 1.8 to 40, unless a town of that name is right there', () => {
    const t = named(n.hoods, 'Tehaleh')[0];
    assert.deepEqual([t.kind, t.min, t.max], ['hood', 1.8, 40]);
    assert.equal(named(n.hoods, 'Lake Tapps').length, 1);
    assert.equal(named(n.hoods, 'Kent').length, 0);
  });

  test("lakes: the map's own outline wins over the file's point; ponds aren't lakes; file lakes only where water is drawn", () => {
    const lt = named(n.water, 'Lake Tapps');
    assert.equal(lt.length, 1);
    lt[0].make?.();
    assert.ok(lt[0].fill && !lt[0].wet);
    const sp = named(n.water, 'Spanaway Lake')[0];
    assert.ok(sp.wet && sp.across! > 1000);
    assert.equal(named(cs, 'Clear Pond').length, 0);
  });

  test('parks to mpp 3.4, schools to 2.7, after the streets', () => {
    assert.deepEqual(n.late.map((c) => [c.text, c.kind, c.max]), [['Allan Yorke Park', 'place', 3.4], ['Bonney Lake High School', 'place', 2.7]]);
  });
});

describe('nothing assumes Pierce', () => {
  test('a King County city without a pipe map is named so; one with coverage is a plain town', () => {
    const ringOf = (pts: LngLat[]) => {
      const out: number[] = [];
      let px = 0, py = 0;
      for (const q of pts) { const [x, y] = project(q); out.push(x - px, y - py); [px, py] = [x, y]; }
      return out;
    };
    const box = (w0: number, s: number, e: number, nn: number) => ringOf([[w0, s], [e, s], [e, nn], [w0, nn]]);
    const K = new Region({
      states: [], detail: [], abroad: [], points: [],
      counties: [{ name: 'King', home: false, at: project([-122.1, 47.5]).map(Math.round) as XY, rings: [box(-122.5, 47.1, -121.1, 47.8)] }],
      places: [
        { name: 'Seattle', at: project([-122.33, 47.6]).map(Math.round) as XY, rings: [box(-122.44, 47.49, -122.22, 47.74)] },
        { name: 'Bellevue', at: project([-122.15, 47.6]).map(Math.round) as XY, rings: [box(-122.2, 47.55, -122.1, 47.65)] },
      ],
    }, { rings: [box(-122.45, 47.45, -122.21, 47.75)] });
    const cs = all(buildNames(W0, K, null));
    assert.equal(named(cs, 'Seattle')[0].kind, 'town');
    assert.equal(named(cs, 'Bellevue')[0].kind, 'nomap');
    assert.equal(named(cs, 'KING COUNTY').length, 1);
  });
});

describe('water names', () => {
  const w = world([['Main St E', [[0, 0], [300, 0]]]], [
    { name: 'Test Creek', fennel: true, line: [[0, 100], [2000, 100]] },
    { name: 'Quiet Creek', line: [[0, 300], [3000, 300]] },
    { name: 'Lake Bonney Outflow', fennel: true, line: [[0, 500], [400, 500]] },
    { name: 'Fennel Creek tributary (unnamed)', fennel: true, line: [[0, 600], [400, 600]] },
    { name: 'Roadside Ditch', line: [[0, 700], [400, 700]] },
    { name: 'Unnamed lake', ring: sq(500, 500, 800, 800) },
    { name: 'Test Pond', ring: sq(900, 900, 950, 950) },
    { name: 'Lake Test', ring: sq(1000, 1000, 1400, 1400) },
    { name: 'Lake Test', ring: sq(1100, 1100, 1300, 1300) },
  ]);
  const n = buildNames(w, null, null);

  test('survey names: never "unnamed" or "tributary"; outflows and ditches only up close (mpp 3)', () => {
    const t = n.water.map((c) => c.text);
    assert.ok(!t.some((x) => /unnamed|tributary/i.test(x)));
    assert.equal(named(n.water, 'Lake Bonney Outflow')[0].max, 3);
    assert.equal(named(n.water, 'Roadside Ditch')[0].max, 3);
    assert.equal(named(n.water, 'Quiet Creek')[0].max, 16);
  });

  test('coho streams first, with a fish; anchors along the whole stream', () => {
    const creeks = n.water.filter((c) => c.across === undefined);
    creeks[0].make?.();
    assert.equal(creeks[0].text, 'Test Creek');
    assert.ok(creeks[0].fish);
    assert.ok(!named(n.water, 'Quiet Creek')[0].fish);
    assert.ok(creeks[0].at.length >= 7);
  });

  test('lakes: one name per lake even where files repeat it, no ponds, sized for when they fit', () => {
    const lakes = n.water.filter((c) => c.across !== undefined);
    assert.deepEqual(lakes.map((c) => c.text), ['Lake Test']);
    assert.ok(Math.abs(lakes[0].across! - 400) < 1);
  });
});

describe('street anchors', () => {
  test('one name per street, anchors every 150 m, a short court still gets one', () => {
    const w = world([
      ['Long Rd E', [[0, 0], [600, 0]]], ['Long Rd E', [[600, 0], [1000, 0]]],
      ['Short Ct E', [[200, 50], [200, 110]]],
      ['', [[0, 300], [500, 300]]],
    ]);
    const s = streetGroups(w);
    assert.deepEqual(s.groups.map((g) => g.text).sort(), ['Long Rd E', 'Short Ct E']);
    const long = s.groups.findIndex((g) => g.text === 'Long Rd E'), court = s.groups.findIndex((g) => g.text === 'Short Ct E');
    // coordinates go through lon/lat, so within a few cm
    assert.ok(Math.abs(s.groups[long].len - 1000) < 0.5);
    const xs = [...s.x].filter((_, i) => s.g[i] === long).sort((a, b) => a - b);
    assert.equal(xs.length, 7);
    xs.forEach((x, i) => assert.ok(Math.abs(x - (75 + 150 * i)) < 0.5, String(x)));
    assert.equal([...s.g].filter((g) => g === court).length, 1);
    assert.equal(s.runG[3], -1);
  });

  test('a street of the same name in another town is its own', () => {
    const s = streetGroups(world([['Main St', [[0, 0], [200, 0]]], ['Main St', [[5000, 0], [5200, 0]]], ['Main St', [[200, 0], [400, 0]]]]));
    assert.equal(s.groups.length, 2);
    assert.equal(s.runG[0], s.runG[2]);
    assert.notEqual(s.runG[0], s.runG[1]);
  });
});

describe('a spot inside the part in view', () => {
  // a U-shaped lake: two arms joined along the bottom
  const U: XY[] = [[0, 0], [1000, 0], [1000, 1000], [700, 1000], [700, 300], [300, 300], [300, 1000], [0, 1000]];
  const box: [number, number, number, number] = [0, 0, 1000, 1000];

  test('the visible arm is named even when the middle of the lake is off screen', () => {
    const view: [number, number, number, number] = [650, 400, 1400, 1200];
    const s = interior([U], box, view);
    assert.ok(s.length > 0);
    const [x, y] = s[0].at;
    assert.ok(x > 700 && x < 1000 && y > 400 && y < 1000, `${x}, ${y}`);
    assert.ok(s.every((q, i) => i === 0 || q.d <= s[i - 1].d));
    // its middle, as far as can be from the shore and the screen edge
    assert.ok(s[0].d >= 100);
  });

  test('the grid is fixed to the ground, so spots stay put while the view pans a little', () => {
    const key = (s: { at: XY }[]) => new Set(s.map((q) => q.at.join(',')));
    const a = key(interior([U], box, [600, 350, 1400, 1200])), b = key(interior([U], box, [610, 360, 1410, 1210]));
    const both = [...b].filter((k) => { const [x, y] = k.split(',').map(Number); return x > 610 && y > 360; });
    assert.ok(both.length > 3);
    for (const k of both) assert.ok(a.has(k), k);
  });

  test('nothing when the lake is out of view', () => {
    assert.deepEqual(interior([U], box, [2000, 2000, 3000, 3000]), []);
  });
});
