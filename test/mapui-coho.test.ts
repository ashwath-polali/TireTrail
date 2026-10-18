/** What the cards may say about coho, by whose data it is; and roadside ditches as the way in */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type LngLat, type XY } from '../src/geo/geo.ts';
import type { App } from '../src/app/app.ts';
import type { Region } from '../src/app/map/region.ts';
import { World } from '../src/app/map/world.ts';
import { INTAKE_SAYS, WDFW_SAYS } from '../src/county/trace.ts';
import { cohoSay, drainOutcome, headline, isDitch, why } from '../src/app/screens/common.ts';
import { journey } from '../src/app/screens/journey.ts';
import { cohoHere, noteCityWaters } from '../src/app/screens/resolve.ts';

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));

function bundle(waters: { name: string; fennel: boolean; at: number }[], drainKind = 1, ending = { code: 'outfall-creek', cls: 0, receiving: 'Clover Creek', reason: '' }): Bundle {
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: ['CH_1', 'PI_2'], kind: [drainKind, 5], geom: [enc([[0, 0], [0, 50]]), enc([[0, 50], [0, 150]])] },
    pondShapes: [], next: [1, -1],
    endings: [{ ...ending, confidence: 1, terminal: 1, exit: 1 }],
    drains: { asset: [0], ending: [0], explicitPaths: {} },
    streets: { pieces: [{ id: 0, name: 'Ditch Rd E', lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' }], runs: { piece: [0], drain: [0], cls: [0], geom: [enc([[-40, 0], [40, 0]])] } },
    waters: waters.map((w) => ({ name: w.name, kind: 'creek', fennel: w.fennel, lines: [enc([[w.at, -500], [w.at, 500]])], rings: [] })),
    fixList: [], numbers: {},
  } as unknown as Bundle;
}

describe('coho words follow the data', () => {
  test("the county tracer's WDFW sentences are the ones the cards read", () => {
    const say = (reason: string, cls: 'creek' | 'elsewhere' = 'elsewhere') => cohoSay({ cls, reason, city: false, receiving: 'Swan Creek' });
    assert.equal(say(`Comes out at outfall OF_1, right by Clover Creek. ${WDFW_SAYS.documented}`, 'creek'), 'here');
    assert.equal(say(`Comes out at outfall OF_1. ${WDFW_SAYS.modeled}`), 'modeled');
    assert.equal(say(`Comes out at outfall OF_1. ${WDFW_SAYS.historic}`), 'historic');
    assert.equal(say('That stream flows about 970 ft on into another stream, where WDFW records coho salmon.', 'creek'), 'down');
    assert.equal(say('Comes out at outfall OF_1, right by Lake Tapps.'), null);
    assert.ok(INTAKE_SAYS.startsWith('Runs into a roadside ditch'));
  });

  test("a tapped stream: WDFW's coho here, Fennel Creek's lower reach, or farther along", () => {
    // Bonney Lake's own file loads first: its Fennel Creek is flagged for the whole system
    noteCityWaters(new World(new TireTrailData(bundle([{ name: 'Fennel Creek', fennel: true, at: 300 }]))));
    const w = new World(new TireTrailData(bundle([
      { name: 'Fennel Creek', fennel: true, at: 300 },
      { name: 'Clover Creek', fennel: true, at: 600 },
      { name: 'Fennel Creek', fennel: false, at: 900 },
      { name: 'Swan Creek', fennel: true, at: 1200 },
      { name: 'Swan Creek', fennel: false, at: 1500 },
      { name: 'Lake Outlet', fennel: false, at: 1800 },
    ])));
    assert.deepEqual(w.waters.map((x) => cohoHere(w, x)), ['spawn', 'here', 'spawn', 'here', 'along', null]);
  });
});

describe('roadside ditches', () => {
  const app = (kind: number): App => {
    const data = new TireTrailData(bundle([], kind, { code: 'outfall-creek', cls: 0, receiving: 'Clover Creek', reason: `${INTAKE_SAYS} Comes out at outfall OF_1, right by Clover Creek. ${WDFW_SAYS.documented}` }));
    const region = { ownerAt: () => 'county', placeAt: () => null, countyAt: () => ({ name: 'Pierce' }) } as unknown as Region;
    return { data, world: new World(data), region, placeOf: () => 'Tehaleh' } as unknown as App;
  };

  test('rain that runs into a roadside ditch is told as a ditch, not a storm drain at the curb', () => {
    const a = app(6), o = drainOutcome(a, 0);
    assert.equal(isDitch(a, 0), true);
    assert.equal(o.ditch, true);
    const steps = journey(a, 0, 'Ditch Rd E');
    assert.deepEqual(steps.map((s) => s.title), ['Ditch Rd E', 'Roadside ditch', '490 ft of pipes and ditches', 'Clover Creek']);
    assert.equal(steps[1].detail, 'Rain runs off the road into it.');
    assert.equal(steps[3].detail, 'WDFW records coho salmon in this stream.');
    assert.equal(headline(o), 'Rain here ends up in Clover Creek.');
    assert.equal(why(o).title, 'WDFW records coho salmon in this stream.');
  });

  test('a storm drain stays a storm drain, at the curb only for Bonney Lake catch basins', () => {
    const a = app(1);
    assert.equal(isDitch(a, 0), false);
    const steps = journey(a, 0, null);
    assert.deepEqual([steps[0].title, steps[0].detail], ['Storm drain', '']);
  });
});
