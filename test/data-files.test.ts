/** label, major road and sea files built from OpenStreetMap and the marine water layers */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';
import { BOX, decodeGeom, poleOf, type Poly } from '../scripts/build-labels.ts';
import { deltas, join, lastRef, shortName } from '../scripts/build-majorroads.ts';
import { STATES } from '../scripts/lib/states.ts';
import { decodeCoords } from '../src/data/bundle.ts';
import { pointInPolygon, type LngLat } from '../src/geo/geo.ts';

const file = (name: string) => new URL(`../public/data/${name}`, import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(file(name), 'utf8'));
const kb = (name: string) => statSync(file(name)).size / 1024;
const meters = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 75500, (a[1] - b[1]) * 111200);
const inBox = ([lon, lat]: LngLat) => lon >= BOX[0] && lon <= BOX[2] && lat >= BOX[1] && lat <= BOX[3];
const inState = ([lon, lat]: LngLat) => STATES.some(({ box: b }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]);
const sixPlaces = (x: number) => Math.abs(x * 1e6 - Math.round(x * 1e6)) < 1e-6;

describe('labels.json', () => {
  const labels = read('labels.json');

  test('has the schema, and fits in 350 KB', () => {
    assert.equal(labels.v, 1);
    assert.match(labels.built, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(labels.credit, '© OpenStreetMap contributors (ODbL)');
    assert.ok(kb('labels.json') <= 350);
    const kinds = new Set(['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood', 'hamlet']);
    for (const [name, kind, lon, lat] of labels.places) {
      assert.ok(typeof name === 'string' && name && kinds.has(kind), `${name} ${kind}`);
      // cities, towns and villages statewide; neighborhoods around Pierce and King
      assert.ok((['city', 'town', 'village'].includes(kind) ? inState([lon, lat]) : inBox([lon, lat])) && sixPlaces(lon) && sixPlaces(lat), name);
    }
    for (const [name, lon, lat, area, w, s, e, n] of labels.lakes) {
      assert.ok(name && area >= 20000 && Number.isInteger(area), name);
      assert.ok(w <= lon && lon <= e && s <= lat && lat <= n, `${name}: label point outside its box`);
    }
    for (const [name, lon, lat, area] of labels.parks) assert.ok(name && area >= 5000 && inBox([lon, lat]), name);
    for (const [name, lon, lat] of labels.schools) assert.ok(name && inBox([lon, lat]), name);
  });

  test('has the towns and neighborhoods around Bonney Lake, Tacoma and Seattle, and towns across the state', () => {
    const bl = labels.places.find((p: [string, string]) => p[0] === 'Bonney Lake' && p[1] === 'town');
    assert.ok(bl, 'Bonney Lake');
    assert.ok(Math.abs(bl[2] - -122.1702) <= 0.002 && Math.abs(bl[3] - 47.187) <= 0.002, `Bonney Lake at ${bl[2]}, ${bl[3]}`);
    const names = new Set(labels.places.map((p: [string]) => p[0]));
    for (const n of ['Tehaleh', 'Prairie Ridge', 'South Hill', 'Spanaway', 'Tacoma', 'Seattle', 'Spokane', 'Yakima', 'Walla Walla']) assert.ok(names.has(n), n);
  });

  test('names Lake Tapps inside the lake, and no ponds or basins', () => {
    const tapps = labels.lakes.find((l: [string]) => l[0] === 'Lake Tapps');
    assert.ok(tapps, 'Lake Tapps');
    const [, lon, lat, , w, s, e, n] = tapps;
    assert.ok(w < lon && lon < e && s < lat && lat < n);
    for (const [name] of labels.lakes) assert.doesNotMatch(name, /pond|basin/i);
  });
});

describe('majorroads.json', () => {
  const data = read('majorroads.json');
  const pts = (r: (number | string)[]) => decodeCoords(r.slice(3) as number[]);

  test('has the schema, and fits in 1000 KB', () => {
    assert.equal(data.v, 1);
    assert.equal(data.credit, '© OpenStreetMap contributors (ODbL)');
    assert.ok(kb('majorroads.json') <= 1000);
    // posted limits in mph, 0 = not tagged; tertiary roads never get one
    assert.equal(data.mph.length, data.roads.length);
    data.mph.forEach((m: number, i: number) => assert.ok(m === 0 || (m % 5 === 0 && m >= 10 && m <= 80 && data.roads[i][0] >= 3), `${m}`));
    for (const r of data.roads) {
      const [cls, ref, name] = r;
      assert.ok([2, 3, 4, 5].includes(cls) && typeof ref === 'string' && typeof name === 'string');
      const d = r.slice(3);
      assert.ok(d.length >= 4 && d.length % 2 === 0, `${ref} ${name}: odd delta list`);
      assert.ok(d.every(Number.isInteger));
    }
  });

  test('SR 410 runs by Bonney Lake as a big road, and I 5 through Tacoma as a freeway', () => {
    const near = (ref: string, at: LngLat, m: number) => data.roads.filter((r: (number | string)[]) => r[1] === ref && pts(r).some((p) => meters(p, at) < m));
    const sr410 = near('SR 410', [-122.17, 47.18], 3000);
    assert.ok(sr410.length && sr410.every((r: number[]) => r[0] >= 4));
    const i5 = near('I 5', [-122.44, 47.23], 2000);
    assert.ok(i5.length && i5.every((r: number[]) => r[0] === 5));
  });

  test('names are shortened, and a list of refs keeps the last', () => {
    assert.equal(shortName('Sumner-Buckley Highway East'), 'Sumner-Buckley Hwy E');
    assert.equal(shortName('148th Avenue Northeast'), '148th Ave NE');
    assert.equal(shortName('Main Street'), 'Main St');
    assert.equal(shortName('East Main'), 'East Main');
    assert.equal(lastRef('SR 161;SR 167'), 'SR 167');
    assert.equal(lastRef('City of Lacey'), '');
    assert.equal(lastRef(null), '');
  });

  test('lines join end to end, and deltas decode back', () => {
    const a: LngLat[] = [[0, 0], [1, 0]], b: LngLat[] = [[2, 0], [1, 0]], c: LngLat[] = [[5, 5], [6, 6]];
    assert.deepEqual(join([a, b, c]), [[[0, 0], [1, 0], [2, 0]], c]);
    const line: LngLat[] = [[-122.170001, 47.180002], [-122.169, 47.181], [-122.169, 47.181]];
    assert.deepEqual(decodeCoords(deltas(line)), line.slice(0, 2));
  });
});

describe('sea.json', () => {
  const sea = read('sea.json');
  const rings = (sea.rings as number[][]).map((d) => decodeCoords(d));
  const wet = (p: LngLat) => rings.filter((r) => pointInPolygon(p, [r])).length % 2 === 1;

  test('has the schema, and fits in 1 MB', () => {
    assert.equal(sea.v, 1);
    assert.ok(kb('sea.json') <= 1024);
    for (const d of sea.rings) assert.ok(d.length >= 6 && d.length % 2 === 0 && d.every(Number.isInteger));
  });

  test('covers Gig Harbor and Commencement Bay, not Bonney Lake or Lake Washington', () => {
    // the plan's Gig Harbor point (-122.58, 47.315) is on land by Soundview Drive; this one is in the bay
    assert.ok(wet([-122.581, 47.336]), 'Gig Harbor');
    assert.ok(wet([-122.44, 47.27]), 'Commencement Bay');
    for (const r of rings) assert.ok(!pointInPolygon([-122.17, 47.18], [r]), 'Bonney Lake');
    assert.ok(!wet([-122.25, 47.6]), 'Lake Washington');
    assert.ok(!wet([-122.46, 47.42]), 'Vashon Island');
  });
});

describe('the GeoPackage reader', () => {
  // a GeoPackage point blob: "GP", version, flags (little endian, no envelope), srs id, then WKB
  const point = (lon: number, lat: number) => {
    const b = Buffer.alloc(8 + 21);
    b.write('GP', 0, 'latin1');
    b[3] = 1;
    b.writeInt32LE(100000, 4);
    b[8] = 1;
    b.writeUInt32LE(1, 9);
    b.writeDoubleLE(lon, 13);
    b.writeDoubleLE(lat, 21);
    return new Uint8Array(b);
  };

  test('reads points, and skips ones outside the box', () => {
    assert.deepEqual(decodeGeom(point(-122.17, 47.18)), { type: 'point', at: [-122.17, 47.18] });
    assert.equal(decodeGeom(point(-120, 47.18)), null);
  });

  test('the label point of a U shape is inside it', () => {
    const u: Poly = [[[-122.2, 47.1], [-122.1, 47.1], [-122.1, 47.2], [-122.12, 47.2], [-122.12, 47.12], [-122.18, 47.12], [-122.18, 47.2], [-122.2, 47.2], [-122.2, 47.1]]];
    const at = poleOf(u, 10);
    assert.ok(pointInPolygon(at, u), `${at}`);
  });
});
