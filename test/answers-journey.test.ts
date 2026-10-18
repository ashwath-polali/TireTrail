/** More details: the trip in plain steps, technical details only for staff, and owner words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type LngLat, type XY } from '../src/geo/geo.ts';
import type { App } from '../src/app/app.ts';
import type { Region } from '../src/app/map/region.ts';
import { World } from '../src/app/map/world.ts';
import { drainOutcome, runOutcome } from '../src/app/screens/common.ts';
import { endTitle, journey, staff } from '../src/app/screens/journey.ts';
import { StreetIndex } from '../src/app/screens/streets.ts';

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));

// one drain through 2 pipes and a pond to a creek; one drywell right at the inlet; one dead end
function app(owner: 'city' | 'county'): App {
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: {
      key: ['CB-1', 'PI_10', 'PI_11', 'P_99', 'DW-2', 'CB-3', 'PI_12'],
      kind: [1, 5, 5, 7, 0, 1, 5],
      geom: [enc([[0, 0]]), enc([[0, 0], [0, 100]]), enc([[0, 100], [0, 300]]), enc([[0, 310]]), enc([[50, 0]]), enc([[90, 0]]), enc([[90, 0], [90, 40]])],
    },
    pondShapes: [],
    next: [1, 2, 3, -1, -1, 6, -1],
    endings: [
      { code: 'pond-to-creek', cls: 0, confidence: 1, terminal: 3, exit: 3, receiving: 'Fennel Creek', reason: 'Flows into pond P_99, 12 m from the creek, which the city lists as draining to Fennel Creek.' },
      { code: 'drywell', cls: 1, confidence: 1, terminal: 4, exit: 4, receiving: '', reason: 'Soaks into the ground through the open bottom of DW-2.' },
      { code: 'dead-end', cls: 3, confidence: 2, terminal: 6, exit: 6, receiving: '', reason: 'The map stops at pipe PI_12.' },
    ],
    drains: { asset: [0, 4, 5], ending: [0, 1, 2], explicitPaths: {} },
    streets: {
      pieces: [{ id: 0, name: '214th Ave E', lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' }, { id: 1, name: '214th Ave E', lengthM: 0, cls: 1, terrainCls: 0, terrainName: '' }],
      runs: { piece: [0, 1, 1], drain: [0, 1, 2], cls: [0, 1, 3], geom: [enc([[-20, 0], [20, 0]]), enc([[40, 0], [60, 0]]), enc([[80, 0], [100, 0]])] },
    },
    waters: [],
    fixList: [],
    numbers: {},
  } as unknown as Bundle;
  const data = new TireTrailData(bundle);
  const world = new World(data);
  const region = { ownerAt: () => owner, placeAt: () => (owner === 'city' ? { name: 'Bonney Lake' } : null), countyAt: () => ({ name: 'Pierce' }) } as unknown as Region;
  return { data, world, region, placeOf: () => (owner === 'city' ? 'Bonney Lake' : 'Tehaleh') } as unknown as App;
}

describe('more details', () => {
  test('the trip reads as plain steps, with no ids and no meters', () => {
    const a = app('city');
    const steps = journey(a, 0, '214th Ave E');
    assert.deepEqual(steps.map((s) => s.title), ['214th Ave E', 'Storm drain', '1,020 ft of underground pipes', 'Pond', 'Fennel Creek']);
    assert.deepEqual(steps.map((s) => s.detail), ['Rain lands here and picks up tire dust.', 'At the curb.', '', 'Holds the water for a while.', 'Coho salmon live there.']);
    for (const s of steps) assert.doesNotMatch(`${s.title} ${s.detail}`, /CB-1|PI_|P_99|\d\s?m\b/);
    // drive stops keep their own first line
    assert.equal(journey(a, 0, 'Stop 2', 'Your tires left dust on the road here when you stopped.')[0].detail, 'Your tires left dust on the road here when you stopped.');
  });

  test('a drywell at the inlet has no pipe step, and its pond-less ending says how it soaks in', () => {
    const steps = journey(app('city'), 1, null);
    assert.deepEqual(steps.map((s) => s.title), ['Storm drain', 'Soaks into the ground']);
    assert.equal(steps[1].detail, 'It runs into a dry well, a pit that lets water sink into the soil.');
  });

  test('a map gap names whose map it is', () => {
    const city = journey(app('city'), 2, null), county = journey(app('county'), 2, null);
    assert.equal(city[city.length - 1].detail, "The pipe it flows into just ends on the city's map. TireTrail stops there instead of guessing.");
    assert.equal(county[county.length - 1].detail, "The pipe it flows into just ends on Pierce County's map. TireTrail stops there instead of guessing.");
    assert.equal(endTitle(drainOutcome(app('city'), 2)), 'The pipe map stops here');
  });

  test('ids, codes, the raw reason in feet and the source are for city staff', () => {
    const rows = Object.fromEntries(staff(app('city'), 0));
    assert.equal(rows['Inlet ID'], 'CB-1');
    assert.equal(rows['Pipe and ditch pieces'], '2');
    assert.equal(rows['Ponds and tanks'], 'P_99');
    assert.equal(rows['Ending code'], 'pond-to-creek');
    assert.equal(rows['Receiving water'], 'Fennel Creek');
    assert.equal(rows['Why it ends here'], 'Flows into pond P_99, 39 ft from the creek, which the city lists as draining to Fennel Creek.');
    assert.equal(rows['Data source'], 'City of Bonney Lake storm data (unofficial screening data)');
    assert.equal(Object.fromEntries(staff(app('county'), 0))['Data source'], 'Pierce County GIS drainage layers');
  });

  test('a street run reads its answer from its own class, with owner words by place', () => {
    const a = app('county');
    const o = runOutcome(a, a.world.runs[2]);
    assert.deepEqual([o.cls, o.code, o.owner, o.city], ['unknown', 'dead-end', "Pierce County's", false]);
  });

  test('all of a street means the same name in the same place', () => {
    const a = app('city');
    const idx = new StreetIndex(a.world, (r) => (r === 0 ? 'Bonney Lake' : 'Tehaleh'));
    assert.deepEqual(idx.runs('214th Ave E|Bonney Lake').map((r) => r.i), [0]);
    assert.deepEqual(idx.runs('214th Ave E|Tehaleh').map((r) => r.i), [1, 2]);
    assert.equal(idx.keyOf(a.world.runs[2]), '214th Ave E|Tehaleh');
    assert.deepEqual(idx.search('214').map((h) => h.key), ['214th Ave E|Bonney Lake', '214th Ave E|Tehaleh']);
  });
});
