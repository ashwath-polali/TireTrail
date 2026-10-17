/** bundle paths decode to traced paths */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { loadInputs, sourceHashes } from '../scripts/lib/inputs.ts';
import { twist } from '../src/data/cards.ts';
import { decodeCoords, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { encodeBundle } from '../src/data/encode.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { dist, localProjection, nearestOnPolyline } from '../src/geo/geo.ts';
import { analyzeCity, type CityResult } from '../src/trace/city.ts';

const P = localProjection();
let city: CityResult;
let bundle: Bundle;
let data: TireTrailData;

before(() => {
  city = analyzeCity(loadInputs());
  // round-trip via JSON like the phone
  bundle = JSON.parse(JSON.stringify(encodeBundle(city, {}))) as Bundle;
  data = new TireTrailData(bundle);
});

describe('the shipped data file', () => {
  test('public/data/tiretrail.json is exactly what the build produces (run npm run build:data after changes)', () => {
    const shipped = readFileSync(new URL('../public/data/tiretrail.json', import.meta.url), 'utf8');
    assert.ok(shipped === JSON.stringify(encodeBundle(city, sourceHashes())), 'the shipped bundle is out of date');
  });
});

describe('coordinates', () => {
  test('microdegree delta encoding round-trips', () => {
    const pts: [number, number][] = [
      [-122.1834567, 47.1712345],
      [-122.1834, 47.1713],
      [-122.19, 47.16],
    ];
    const back = decodeCoords(encodeCoords(pts));
    // half a microdegree, under 6 cm
    pts.forEach((p, i) => assert.ok(Math.abs(p[0] - back[i][0]) <= 5.1e-7 && Math.abs(p[1] - back[i][1]) <= 5.1e-7));
  });
});

describe('paths on the phone match the trace', () => {
  test('every drain decodes to exactly its traced path', () => {
    for (let i = 0; i < city.traces.length; i++) {
      const keys = city.traces[i].path.map((k) => city.net.assets[k].key);
      assert.deepEqual(data.path(i).assets, keys, `drain ${i}`);
    }
  });

  test('spot check of 20 drains: geometry follows the traced assets, ending and class match', () => {
    const step = Math.floor(city.traces.length / 20);
    for (let n = 0; n < 20; n++) {
      const i = n * step;
      const t = city.traces[i];
      const info = data.drain(i);
      const path = data.path(i);
      assert.equal(info.id, city.net.assets[t.drain].key);
      assert.equal(info.cls, t.ending.cls);
      assert.equal(info.code, t.ending.code);
      assert.equal(info.terminalId, city.net.assets[t.ending.terminal].key);
      // line starts at the drain, within 0.5 m of every asset
      const xy = path.coords.map((c) => P.toXY(c));
      assert.ok(dist(xy[0], t.path.length ? city.net.assets[t.drain].anchor : xy[0]) < 0.5);
      for (const k of t.path) {
        const a = city.net.assets[k];
        const target = a.line ? a.line[a.line.length - 1] : a.anchor;
        assert.ok(nearestOnPolyline(target, xy).d < 0.5, `drain ${i}: ${a.key} is off the path`);
      }
    }
  });

  test('a path walked through a side connection enters the pipe at the joint', () => {
    // drain whose path joins a line mid-way ("snap-mid")
    const t = city.traces.find((x) => x.linkCounts['snap-mid']);
    assert.ok(t, 'the network has side connections');
    const path = data.path(city.traces.indexOf(t));
    // no jump over the 20 m pond bridge (centroid can sit farther)
    const xy = path.coords.map((c) => P.toXY(c));
    for (let i = 1; i < xy.length; i++) {
      const pondNearby = path.assets.some((id) => id.startsWith('PN-') || id.startsWith('FC-'));
      if (!pondNearby) assert.ok(dist(xy[i - 1], xy[i]) < 120, `jump of ${dist(xy[i - 1], xy[i]).toFixed(0)} m`);
    }
  });
});

describe('lookups', () => {
  test('find a drain by ID and the nearest drain to a point', () => {
    const d = data.drain(100);
    assert.deepEqual(data.findDrain(d.id), d);
    const near = data.nearestDrain(d.lngLat);
    assert.equal(near?.drain.index, 100);
    assert.equal(near?.distanceM, 0);
    assert.equal(data.nearestDrain([-122.5, 47.5]), null);
  });

  test('street runs carry their class, drain and terrain guess', () => {
    const fc = data.streetsGeoJSON();
    assert.equal(fc.features.length, data.streetRunCount);
    const run = data.street(0);
    assert.equal(fc.features[0].properties.cls, run.cls);
    for (let i = 0; i < data.streetRunCount; i++) {
      const r = data.street(i);
      if (r.drain !== null) assert.equal(data.drain(r.drain).cls, r.cls);
      else assert.equal(r.cls, 'none');
    }
  });

  test('numbers, fix list, credits and disclaimer ship with the data', () => {
    assert.equal(data.numbers.drains.total, 3524);
    assert.equal(data.fixList.length, 5);
    assert.ok(data.credits.some((c) => c.includes('Bonney Lake')));
    assert.match(data.disclaimer, /not endorsed by Pierce County, the City of Bonney Lake, UW or WDFW/);
    assert.ok(data.networkGeoJSON().features.length > 6000);
    assert.ok(data.watersGeoJSON().features.some((f) => f.properties.fennel === true));
  });

  test('rejects a data file of another format', () => {
    assert.throws(() => new TireTrailData({ ...bundle, version: 99 as 1 }));
  });
});

describe('twist card', () => {
  test('wording', () => {
    assert.equal(twist({ cls: 'creek', name: 'Fennel Creek' }, 'ground').text, 'A normal map guesses: the creek. The real pipes: the ground.');
    assert.equal(twist({ cls: 'creek', name: 'Fennel Creek' }, 'creek').text, 'A normal map guesses: the creek. The real pipes agree: the creek.');
    assert.equal(twist({ cls: 'elsewhere', name: 'Puyallup River (direct drainage)' }, 'ground').normalMap, 'the Puyallup River');
    assert.equal(twist({ cls: 'creek', name: 'Fennel Creek' }, 'unknown').differs, false);
    assert.equal(twist({ cls: 'creek', name: 'Fennel Creek' }, 'elsewhere', 'Lake Tapps').realPipes, 'Lake Tapps');
  });
});
