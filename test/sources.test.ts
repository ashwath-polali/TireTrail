// the city and King County pipe maps (scripts/build-sources.ts) and what the app reads from them
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { cityName, isCounty, SOURCE_KEYS, streetClass, toCountyAssets, watersFor, type CtxWater } from '../scripts/build-sources.ts';
import { CountyTracer } from '../src/county/trace.ts';
import { CountyWaters } from '../src/county/waters.ts';
import { buildGraph } from '../src/county/graph.ts';
import type { SourceAsset } from '../src/county/source.ts';
import { localProjection } from '../src/geo/geo.ts';
import { covers } from '../src/app/screens/common.ts';
import { Region } from '../src/app/map/region.ts';

const P = localProjection([-122.44, 47.25]);
const ll = (x: number, y: number): [number, number] => P.toLngLat([x, y]) as [number, number];
const A = (o: Partial<SourceAsset> & Pick<SourceAsset, 'role' | 'id' | 'coords'>): SourceAsset => ({ src: 'tacoma', trust: 'id', ...o });

describe('adapter records to the tracer', () => {
  test('roles take the County layer shapes, and an outlet into a pond or ditch lets the walk go on', () => {
    const { assets } = toCountyAssets([
      A({ role: 'drain', id: 'CB1', key: 'CB1', coords: [ll(0, 0)] }),
      A({ role: 'outfall', id: 'OF1', key: 'OF1', coords: [ll(100, 0)], endHint: 'water' }),
      A({ role: 'outfall', id: 'OF2', coords: [ll(200, 0)], endHint: 'unknown' }),
      A({ role: 'discharge', id: 'DP1', coords: [ll(300, 0)], endHint: 'ground' }),
      A({ role: 'discharge', id: 'DP2', coords: [ll(400, 0)], endHint: 'handoff:Kent' }),
      A({ role: 'facility-infiltrate', id: 'F1', coords: [ll(500, 0)] }),
      A({ role: 'facility-hold', id: 'F2', coords: [ll(600, 0), ll(620, 0), ll(620, 20), ll(600, 0)] }),
      A({ role: 'ditch', id: 'D1', coords: [ll(0, 50), ll(50, 50)] }),
      A({ role: 'stream-culvert', id: 'C1', coords: [ll(0, 80), ll(50, 80)] }),
    ], P);
    const by = Object.fromEntries(assets.map((a) => [a.id, a]));
    assert.deepEqual([by.CB1.layer, by.CB1.type], ['drain', 'Catch Basin - Type1']);
    assert.deepEqual([by.OF1.layer, by.OF1.type], ['endpoint', 'Outfall']);
    assert.equal(by.OF2.layer, 'outlet');
    assert.deepEqual([by.DP1.layer, by.DP1.type], ['endpoint', 'NPDES_Discharge']);
    assert.equal(by.DP2.type, 'End Point');
    // a facility drawn as a point is a vault; one drawn as a shape is a pond
    assert.deepEqual([by.F1.layer, by.F1.type], ['network', 'Infiltration Vault']);
    assert.ok(by.F2.kind === 'pond' && by.F2.polygons);
    assert.deepEqual([by.D1.layer, by.D1.type], ['channel', 'Man-made']);
    assert.ok(by.C1.liveStream);
  });

  test('a line end moves onto the node its key names, within 30 m', () => {
    const { assets, keyed, snapped } = toCountyAssets([
      A({ role: 'junction', id: 'MH1', key: 'MH1', coords: [ll(0, 0)] }),
      A({ role: 'junction', id: 'MH2', key: 'MH2', coords: [ll(100, 0)] }),
      A({ role: 'pipe', id: 'P1', fromId: 'MH1', toId: 'MH2', coords: [ll(4, 3), ll(96, 2)] }),
      A({ role: 'pipe', id: 'P2', fromId: 'MH2', coords: [ll(150, 0), ll(200, 0)] }),
    ], P);
    assert.equal(keyed, 3);
    assert.equal(snapped, 2);
    const g = buildGraph(assets);
    const p1 = assets.find((a) => a.id === 'P1')!;
    const [a, b] = g.lineEnds.get(p1.index)!;
    assert.equal(a, g.nodeOf[0]);
    assert.equal(b, g.nodeOf[1]);
  });

  test('a river, lake or coho reach running into the city counts, even when it starts far outside', () => {
    // the box is the city; the Green River, Cedar River and Lake Washington start kilometers away
    const near = (c: number[]) => c[0] >= ll(0, 0)[0] && c[0] <= ll(1000, 0)[0] && c[1] >= ll(0, 0)[1] && c[1] <= ll(0, 1000)[1];
    const river: CtxWater = { src: 'kc', kind: 'river', name: 'Green River', coords: [ll(-20000, 500), ll(-5000, 500), ll(500, 500)] };
    const lake: CtxWater = { src: 'kc', kind: 'lake', name: 'Lake Washington', polygons: [[[ll(0, 30000), ll(900, 30000), ll(900, 900), ll(0, 900), ll(0, 30000)]]] };
    const far: CtxWater = { src: 'kc', kind: 'stream', name: 'Far Creek', coords: [ll(-20000, 0), ll(-19000, 0)] };
    const reach = { name: 'Green River', dist: 'Documented', coords: [ll(-20000, 500), ll(500, 500)] };
    const W = watersFor([river, lake, far], [reach], 'King', near);
    assert.deepEqual(W.layers.hydroCenterlines.features.map((f) => f.properties.FeatureName), ['Green River']);
    assert.deepEqual(W.layers.hydroWaterbodies.features.map((f) => f.properties.FeatureName), ['Lake Washington']);
    assert.deepEqual(W.layers.swifdCoho.features.map((f) => f.properties.LLID_STRM_NAME), ['Green River']);
  });

  test('an outfall the city left untagged, where the map stops, is judged like any outfall: water within 30 m', () => {
    const at = (y: number) => {
      const { assets } = toCountyAssets([
        A({ role: 'drain', id: 'CB1', coords: [ll(0, 0)] }),
        A({ role: 'pipe', id: 'P1', coords: [ll(0, 0), ll(100, 0)] }),
        A({ role: 'outfall', id: 'OF1', coords: [ll(100, 0)], endHint: 'unknown' }),
      ], P);
      const reach = { type: 'Feature' as const, properties: { LLID_STRM_NAME: 'Mill Creek', DISTTYPE_DESC: 'Documented' }, geometry: { type: 'LineString' as const, coordinates: [ll(0, y), ll(200, y)] } };
      const fc = (features: typeof reach[]) => ({ type: 'FeatureCollection' as const, features });
      const waters = new CountyWaters({ swifdCoho: fc([reach]), hydroCenterlines: fc([]), hydroWaterbodies: fc([]) }, P);
      const t = new CountyTracer(assets, buildGraph(assets), waters).traceAll().traces[0];
      return [t.ending.cls, t.ending.code, t.confidence, t.ending.reason];
    };
    assert.deepEqual(at(25), ['creek', 'outfall-creek', 'likely', 'Comes out at outfall OF1, about 80 ft from Mill Creek. WDFW records coho salmon in this stream.']);
    // farther than 30 m: still unknown, and it says why
    assert.deepEqual(at(50), ['unknown', 'outfall-unknown', 'none', "Comes out at outfall OF1, but the stream or pond it flows into isn't on the map. The nearest mapped water, Mill Creek, is about 160 ft away."]);
  });

  test('an end point where the County hands the water to a private owner or a city says so', () => {
    const { assets } = toCountyAssets([
      A({ role: 'drain', id: 'CB1', coords: [ll(0, 0)] }),
      A({ role: 'pipe', id: 'P1', coords: [ll(0, 0), ll(100, 0)] }),
      A({ role: 'discharge', id: 'LNK-1', coords: [ll(100, 0)], endHint: 'handoff:private' }),
      A({ role: 'drain', id: 'CB2', coords: [ll(0, 500)] }),
      A({ role: 'pipe', id: 'P2', coords: [ll(0, 500), ll(100, 500)] }),
      A({ role: 'discharge', id: 'LNK-2', coords: [ll(100, 500)], endHint: 'handoff:City of Seattle' }),
    ], P);
    const fc = { type: 'FeatureCollection' as const, features: [] };
    const traces = new CountyTracer(assets, buildGraph(assets), new CountyWaters({ swifdCoho: fc, hydroCenterlines: fc, hydroWaterbodies: fc }, P)).traceAll().traces;
    assert.deepEqual(traces.map((t) => [t.ending.cls, t.ending.code, t.ending.reason]), [
      ['unknown', 'handoff', "The County's map hands the water on at end point LNK-1 to a private owner, whose pipes aren't on the map."],
      ['unknown', 'handoff', "The County's map hands the water on at end point LNK-2 to the City of Seattle, whose pipes aren't on the map."],
    ]);
  });

  test('street classes match the Pierce map classes that name areas', () => {
    assert.equal(streetClass({ class: 'local', fc: 8 }), 8);
    assert.equal(streetClass({ class: 'arterial', fc: 'P/A30' }), 4);
    assert.equal(streetClass({ class: 'arterial', fc: 'M/A31' }), 5);
    assert.equal(streetClass({ class: 'collector', fc: 'C/A40' }), 6);
    assert.equal(cityName({ name: 'City of Tacoma' }), 'Tacoma');
    assert.ok(isCounty({ key: 'kc-ms4' }) && !isCounty({ key: 'renton' }));
  });
});

const DATA = new URL('../public/data/', import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));

describe('the shipped city and King County areas', { skip: !existsSync(new URL('areas/index.json', DATA)) && 'no areas' }, () => {
  const index = read('areas/index.json') as { id: string; name: string; src?: string; drains: number; bytes: number }[];

  test('every source has areas, each file small and named for its city', () => {
    for (const key of SOURCE_KEYS) {
      const mine = index.filter((a) => a.src === key);
      assert.ok(mine.length > 0, key);
      assert.ok(mine.every((a) => a.bytes <= 1.2e6), key);
    }
    for (const a of index.filter((x) => x.src === 'tacoma')) assert.match(a.name, /^Tacoma/);
    // whose map, for search rows: a county's areas name it, a city's don't
    const county = index as { src?: string; county?: string }[];
    assert.ok(county.filter((a) => !a.src).every((a) => a.county === 'Pierce'));
    assert.ok(county.filter((a) => a.src === 'kc-ms4').every((a) => a.county === 'King'));
    assert.ok(county.filter((a) => a.src && a.src !== 'kc-ms4').every((a) => !a.county));
    // the city's own map, not the County's
    const b = read(`areas/${index.find((a) => a.src === 'bellevue')!.id}.json`) as { credits: string[]; disclaimer: string };
    assert.ok(b.credits.some((c) => /City of Bellevue/.test(c)));
    assert.match(b.disclaimer, /City of Bellevue/);
  });

  test('coverage.json lists the cities with their own maps and their credits, and the About words follow', () => {
    const cover = read('coverage.json') as { rings: number[][]; cities: string[]; credits: string[] };
    assert.deepEqual(cover.cities, ['Auburn', 'Bellevue', 'Bothell', 'Burien', 'Clyde Hill', 'Covington', 'Des Moines', 'Duvall', 'Federal Way', 'Kenmore', 'Lake Forest Park', 'Maple Valley', 'Medina', 'Mercer Island', 'Newcastle', 'Normandy Park', 'North Bend', 'Puyallup', 'Redmond', 'Renton', 'Sammamish', 'SeaTac', 'Seattle', 'Shoreline', 'Sumner', 'Tacoma', 'Tukwila', 'Woodinville']);
    assert.ok(cover.credits.some((c) => /King County GIS/.test(c)));
    const R = new Region(read('region.json'), cover);
    assert.ok(['Tacoma', 'Bellevue', 'Bonney Lake'].every((c) => R.cityMaps.has(c)));
    const words = covers(R);
    assert.equal(words, '29 cities and unincorporated King and Pierce counties');
    // King County cities without a map are on the region map, so they're named as not added yet
    const kent = R.places.find((p) => p.name === 'Kent')!;
    assert.ok(kent && !R.isMapped(kent));
    // Seattle has its own map (build-keyed.ts)
    const seattle = R.places.find((p) => p.name === 'Seattle')!;
    assert.ok(seattle && R.isMapped(seattle));
    const bellevue = R.places.find((p) => p.name === 'Bellevue')!;
    assert.ok(R.isMapped(bellevue));
    // Federal Way has its own map (scripts/sources/federal-way.ts)
    assert.ok(R.isMapped(R.places.find((p) => p.name === 'Federal Way')!));
    assert.ok(cover.credits.some((c) => /City of Federal Way GIS/.test(c)));
    for (const name of ['Mercer Island', 'Maple Valley', 'Covington', 'SeaTac', 'Burien', 'Tukwila']) assert.ok(R.isMapped(R.places.find((p) => p.name === name)!), name);
  });
});
