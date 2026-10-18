import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GridIndex, localProjection, type XY } from '../src/geo/geo.ts';
import { flowDirections, sliceArea, type CountyModel } from '../src/county/area.ts';
import { describeCounty, loadCountyAssets, type CountyStormLayers } from '../src/county/assets.ts';
import { buildGraph } from '../src/county/graph.ts';
import { DEFAULT_ROUTE_OPTIONS, measureDirection, nodePath, route } from '../src/county/route.ts';
import { classifyCountyStreets, IntakeFinder } from '../src/county/streets.ts';
import { CountyTracer, DEFAULT_COUNTY_TRACE_OPTIONS, feet, INTAKE_SAYS, WDFW_SAYS } from '../src/county/trace.ts';
import { cleanWaterName, CountyWaters, swifdName, type CountyWaterLayers, type ExtraWater } from '../src/county/waters.ts';
import { encodeBundle } from '../src/data/encode.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import type { Feature, FeatureCollection, Properties } from '../src/trace/geojson.ts';
import { classifyStreets } from '../src/trace/streets.ts';

const P = localProjection([-122.3, 47.1]);
const ll = (p: XY) => P.toLngLat(p);
const fc = (features: Feature[] = []): FeatureCollection => ({ type: 'FeatureCollection', features });
const pt = (properties: Properties, at: XY): Feature => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: ll(at) } });
const ln = (properties: Properties, pts: XY[]): Feature => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: pts.map(ll) } });
const poly = (properties: Properties, ring: XY[]): Feature => ({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(ll)] } });
const box = (cx: number, cy: number, h: number): XY[] => [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];

const cb = (id: string, at: XY, extra: Properties = {}) => pt({ AssetID: id, StructureType: 'Catch Basin - Type1', BottomType: 'Solid', ...extra }, at);
const ep = (id: string, type: string, at: XY) => pt({ AssetID: id, EndPointType: type }, at);
const pipe = (id: string, pts: XY[], extra: Properties = {}) => ln({ AssetID: id, MainLineType: 'Conveyance Pipe', PipeWallType: 'Solid', PipeWidth: 12, ...extra }, pts);
const ditch = (id: string, pts: XY[], type = 'Man-made') => ln({ AssetID: id, ChannelType: type }, pts);
/** A WDFW coho reach; Documented unless said. */
const reach = (name: string, pts: XY[], dist = 'Documented') => ln({ LLID_STRM_NAME: name, DISTTYPE_DESC: dist }, pts);
const stream = (name: string, pts: XY[]) => ln({ FeatureName: name, FeatureType: 'Stream', StreamTypeNPDES: 'Receiving' }, pts);
const scupper = (id: string, at: XY) => pt({ AssetID: id, InletType: 'Bridge Scupper' }, at);
const lonlat = (pts: XY[]) => pts.map(ll);

type Parts = Partial<Record<keyof CountyStormLayers, Feature[]>>;
type WaterParts = Partial<Record<keyof CountyWaterLayers, Feature[]>>;
function layers(parts: Parts): CountyStormLayers {
  const keys: (keyof CountyStormLayers)[] = ['drainStructures', 'networkStructures', 'endPoints', 'inletComponents', 'outletComponents', 'barriers', 'mainLines', 'openChannels', 'virtualDrainlines', 'facilityPolygons', 'storageBasins'];
  return Object.fromEntries(keys.map((k) => [k, fc(parts[k])])) as unknown as CountyStormLayers;
}
function waterLayers(parts: WaterParts = {}): CountyWaterLayers {
  return { swifdCoho: fc(parts.swifdCoho), hydroCenterlines: fc(parts.hydroCenterlines), hydroWaterbodies: fc(parts.hydroWaterbodies) };
}
function trace(parts: Parts, waters: WaterParts = {}, opts = DEFAULT_COUNTY_TRACE_OPTIONS, extra: ExtraWater[] = []) {
  const { assets } = loadCountyAssets(layers(parts), P);
  const graph = buildGraph(assets);
  const stormPonds = assets.filter((a) => a.polygons).map((a) => a.polygons!);
  const w = new CountyWaters(waterLayers(waters), P, { extra, stormPonds });
  const tracer = new CountyTracer(assets, graph, w, opts);
  const out = tracer.traceAll();
  const of = (id: string) => {
    const t = out.traces.find((x) => assets[x.drain].key === id);
    if (!t) throw new Error(`no drain ${id}`);
    return { ...t, keys: t.path.map((k) => assets[k].key) };
  };
  return { assets, graph, waters: w, tracer, ...out, of };
}

describe('county graph from geometry', () => {
  test('line ends join the point they touch within 1.5 m, and each other', () => {
    const { graph, assets } = trace({
      drainStructures: [cb('CB-1', [0, 0])],
      mainLines: [pipe('PI-1', [[1, 0], [30, 0]]), pipe('PI-2', [[31, 0.5], [60, 0]])],
    });
    const key = (k: string) => assets.find((a) => a.key === k)!.index;
    const [s1, e1] = graph.lineEnds.get(key('PI-1'))!;
    const [s2] = graph.lineEnds.get(key('PI-2'))!;
    assert.equal(s1, graph.nodeOf[key('CB-1')]);
    assert.equal(e1, s2);
  });

  test('a lone point beside the middle of a line joins it partway', () => {
    const { graph } = trace({
      drainStructures: [cb('CB-1', [15, 1])],
      mainLines: [pipe('PI-1', [[0, 0], [30, 0]])],
    });
    assert.equal(graph.stats.midLineJoins, 1);
    assert.equal(graph.stats.components, 1);
  });

  test('a loose downstream end bridges a short gap, a long one stays open', () => {
    const near = trace({ drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [34, 0])], mainLines: [pipe('PI-1', [[0, 0], [30, 0]])] });
    assert.equal(near.graph.stats.bridges, 1);
    const far = trace({ drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [45, 0])], mainLines: [pipe('PI-1', [[0, 0], [30, 0]])] });
    assert.equal(far.graph.stats.bridges, 0);
  });

  test('a pipe ending inside a pond drains into it', () => {
    const t = trace({
      drainStructures: [cb('CB-1', [0, 0])],
      mainLines: [pipe('PI-1', [[0, 0], [40, 0]])],
      facilityPolygons: [poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(50, 0, 12))],
    });
    assert.equal(t.graph.stats.pondJoins, 1);
    assert.deepEqual(t.of('CB-1').keys, ['CB-1', 'PI-1', 'IC-1']);
    assert.equal(t.of('CB-1').ending.code, 'infiltration-pond');
  });

  test('touching ponds join, and a holding pond joins an infiltration cell a berm away', () => {
    // P-1 spans -10..10, P-2 starts `gap` m past it
    const links = (gap: number, type: string) =>
      trace({ facilityPolygons: [poly({ AssetID: 'P-1', ComponentType: 'Detention Cell' }, box(0, 0, 10)), poly({ AssetID: 'P-2', ComponentType: type }, box(20 + gap, 0, 10))] }).graph.stats.pondLinks;
    assert.equal(links(0, 'Detention Cell'), 1);
    assert.equal(links(6, 'Detention Cell'), 0);
    assert.equal(links(6, 'Infiltration Cell'), 1);
    assert.equal(links(15, 'Infiltration Cell'), 0);
  });
});

describe('ponds on the way', () => {
  const wetPond = poly({ AssetID: 'WP-1', ComponentType: 'Wet Pond Cell' }, box(50, 0, 12));
  const cell = poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(80, 0, 12));

  test('a wet pond beside an infiltration cell drains into it, as a guessed link', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])], mainLines: [pipe('PI-1', [[0, 0], [40, 0]])], facilityPolygons: [wetPond, cell] }).of('CB-1');
    assert.deepEqual(t.keys, ['CB-1', 'PI-1', 'WP-1', 'IC-1']);
    assert.deepEqual([t.ending.code, t.confidence], ['infiltration-pond', 'likely']);
  });

  test('a discharge point that opens onto a pond passes the water on into it', () => {
    const t = trace({
      drainStructures: [cb('CB-1', [0, 0])],
      endPoints: [ep('DP-1', 'Discharge', [40, 0])],
      mainLines: [pipe('PI-1', [[0, 0], [40, 0]])],
      facilityPolygons: [wetPond, cell],
    });
    assert.deepEqual(t.of('CB-1').keys, ['CB-1', 'PI-1', 'DP-1', 'WP-1', 'IC-1']);
    assert.equal(t.passedDischarge, 1);
  });

  test('a pond with no way out says so, in its own words', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])], endPoints: [ep('DP-1', 'Discharge', [40, 0])], mainLines: [pipe('PI-1', [[0, 0], [40, 0]])], facilityPolygons: [wetPond] });
    const d = t.of('CB-1');
    assert.deepEqual([d.ending.cls, d.ending.code, t.assets[d.ending.exit].key], ['unknown', 'pond-unmapped', 'WP-1']);
    assert.equal(d.ending.reason, "Flows into wet pond cell WP-1. The County's map doesn't show where the pond drains.");
  });

  test('a planting area drawn as a shape is not called a pond', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])], mainLines: [pipe('PI-1', [[0, 0], [40, 0]])], facilityPolygons: [poly({ AssetID: 'PA-1', ComponentType: 'Planting Area_Other' }, box(50, 0, 12))] }).of('CB-1');
    assert.deepEqual([t.ending.code, t.ending.reason], ['dead-end', "Flows into planting area PA-1. The County's map doesn't show where the water goes from there."]);
  });

  test('an end point the map stops at, at a pond the water never passed through, flows into that pond', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])], endPoints: [ep('EP-1', 'Endpoint', [39, 0])], mainLines: [pipe('PI-1', [[0, 0], [39, 0]])], facilityPolygons: [wetPond] });
    const d = t.of('CB-1');
    assert.deepEqual([d.ending.code, t.assets[d.ending.exit].key], ['pond-unmapped', 'EP-1']);
    assert.match(d.ending.reason, /^Flows into wet pond cell WP-1 at end point EP-1\./);
  });

  test('an end point at the edge of an infiltration cell soaks in there', () => {
    const t = trace({
      drainStructures: [cb('CB-1', [0, 0])],
      endPoints: [ep('EP-1', 'Endpoint', [39, 0])],
      mainLines: [pipe('PI-1', [[0, 0], [39, 0]])],
      facilityPolygons: [poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(50, 0, 12))],
    }).of('CB-1');
    assert.deepEqual([t.ending.cls, t.ending.code, t.confidence], ['ground', 'infiltration-pond', 'likely']);
    assert.equal(t.ending.reason, 'Flows into infiltration cell IC-1 at end point EP-1, and soaks into the ground there.');
  });

  test('an outlet in a pond opens onto it when the drawn way on stops, not when it reaches an ending', () => {
    const outlet = (id: string, at: XY) => pt({ AssetID: id, OutletType: 'Debris Barrier' }, at);
    const parts = (end: Feature[]): Parts => ({
      drainStructures: [cb('CB-1', [0, 0])],
      outletComponents: [outlet('OL-1', [70, 0])],
      endPoints: end,
      mainLines: [pipe('PI-1', [[0, 0], [70, 0]])],
      openChannels: [ditch('CH-1', [[70, 0], [130, 0]])],
      facilityPolygons: [poly({ AssetID: 'IC-2', ComponentType: 'Infiltration Cell' }, box(75, 0, 10))],
    });
    assert.equal(trace(parts([])).of('CB-1').ending.code, 'infiltration-pond');
    assert.equal(trace(parts([ep('OF-1', 'NPDES_Outfall', [130, 0])])).of('CB-1').ending.code, 'outfall-unknown');
  });
});

describe('routing to the nearest ending', () => {
  // CB-1 sits between two discharge points: 40 m upstream (against the drawing) and 60 m downstream
  const parts: Parts = {
    drainStructures: [cb('CB-1', [0, 0])],
    endPoints: [ep('DP-UP', 'Discharge', [-40, 0]), ep('DP-DOWN', 'Discharge', [60, 0])],
    mainLines: [pipe('PI-UP', [[-40, 0], [0, 0]]), pipe('PI-DOWN', [[0, 0], [60, 0]])],
  };

  test('the drawn direction is a cost, so water prefers the downstream ending', () => {
    assert.deepEqual(trace(parts).of('CB-1').keys, ['CB-1', 'PI-DOWN', 'DP-DOWN']);
  });

  test('with no direction penalty the shorter way wins', () => {
    const opts = { ...DEFAULT_COUNTY_TRACE_OPTIONS, route: { ...DEFAULT_ROUTE_OPTIONS, againstFactor: 1 } };
    assert.deepEqual(trace(parts, {}, opts).of('CB-1').keys, ['CB-1', 'PI-UP', 'DP-UP']);
  });

  test('fallback endings count only where no explicit ending is reachable', () => {
    const t = trace({
      drainStructures: [cb('CB-1', [0, 0]), cb('CB-OPEN', [20, 0], { BottomType: 'Open' }), cb('CB-2', [200, 0]), cb('CB-OPEN2', [220, 0], { BottomType: 'Open' })],
      endPoints: [ep('DP-1', 'NPDES_Discharge', [-200, 0])],
      mainLines: [pipe('PI-1', [[0, 0], [20, 0]]), pipe('PI-0', [[0, 0], [-200, 0]]), pipe('PI-2', [[200, 0], [220, 0]])],
    });
    assert.equal(t.of('CB-1').ending.code, 'discharge-point');
    assert.equal(t.of('CB-2').ending.code, 'drywell');
    assert.deepEqual(t.of('CB-2').keys, ['CB-2', 'PI-2', 'CB-OPEN2']);
  });

  test("every routed node's steps lead to its ending", () => {
    const t = trace(parts);
    const r = route(t.graph, [...t.sinks.values()].map((s) => s.node), []);
    for (let n = 0; n < t.graph.nodes.length; n++) {
      if (r.sink[n] < 0) continue;
      const p = nodePath(t.graph, r, n);
      assert.equal(p.nodes[p.nodes.length - 1], r.sink[n]);
    }
  });

  test('direction check counts lines drawn toward an end point', () => {
    const t = trace(parts);
    const isEp = (n: number) => t.graph.nodes[n].assets.some((k) => t.assets[k].layer === 'endpoint');
    assert.deepEqual(measureDirection(t.graph, isEp), { lines: 2, towardEndPoint: 1, share: 0.5 });
  });
});

describe('routes against the drawn direction', () => {
  // CB-1 reaches an outfall by a coho stream only against PI-1's drawing; PI-2 runs on as drawn to nothing
  const against = (m: number) =>
    trace(
      {
        drainStructures: [cb('CB-1', [0, 0])],
        endPoints: [ep('OF-1', 'NPDES_Outfall', [-m, 0])],
        mainLines: [pipe('PI-1', [[-m, 0], [0, 0]]), pipe('PI-2', [[0, 0], [0, 40]])],
      },
      { swifdCoho: [reach('Test Creek [1]', [[-m - 10, -50], [-m - 10, 50]])] },
    ).of('CB-1');

  test('a route may run against the drawing up to the cap, and is high confidence only for a short way', () => {
    assert.deepEqual([against(10).ending.cls, against(10).confidence], ['creek', 'high']);
    assert.deepEqual([against(50).ending.cls, against(50).confidence], ['creek', 'likely']);
  });

  test('past the cap the drain follows the drawing until the map stops', () => {
    const far = against(150);
    assert.ok(DEFAULT_ROUTE_OPTIONS.maxAgainstM < 150);
    assert.deepEqual([far.ending.cls, far.ending.code, far.keys], ['unknown', 'dead-end', ['CB-1', 'PI-2']]);
    assert.match(far.ending.reason, /the way they're drawn/);
  });

  test('a drain upstream gets its own way round the cap', () => {
    // CB-1 reaches OF-NEAR 40 m against the drawing; CB-2 already runs 50 m against to reach CB-1
    const t = trace({
      drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [0, 50])],
      endPoints: [ep('OF-NEAR', 'NPDES_Outfall', [-40, 0]), ep('OF-FAR', 'NPDES_Outfall', [1000, 0])],
      mainLines: [pipe('PI-A', [[0, 0], [0, 50]]), pipe('PI-B', [[-40, 0], [0, 0]]), pipe('PI-C', [[0, 0], [1000, 0]])],
    });
    assert.deepEqual(t.of('CB-1').keys, ['CB-1', 'PI-B', 'OF-NEAR']);
    assert.deepEqual(t.of('CB-2').keys, ['CB-2', 'PI-A', 'CB-1', 'PI-C', 'OF-FAR']);
    assert.deepEqual(t.againstM, [40, 50]);
  });

  test('a drain with lines drawn only into it says so', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])], mainLines: [pipe('PI-1', [[-200, 0], [0, 0]])] }).of('CB-1');
    assert.deepEqual([t.ending.code, t.keys], ['dead-end', ['CB-1']]);
    assert.match(t.ending.reason, /flowing into catch basin CB-1, but none flowing out/);
  });
});

describe('county endings', () => {
  const coho = reach('Unnamed stream [1221]', [[100, -100], [100, 100]]);
  const named = stream('Clarks Creek', [[105, -100], [105, 100]]);
  const lake = poly({ FeatureName: 'Lake Example' }, box(-200, 0, 50));
  const one = (endType: string, at: XY, waters: WaterParts, extra: ExtraWater[] = []) =>
    trace({ drainStructures: [cb('CB-1', [at[0] - 30, at[1]])], endPoints: [ep('DP-1', endType, at)], mainLines: [pipe('PI-1', [[at[0] - 30, at[1]], at])] }, waters, DEFAULT_COUNTY_TRACE_OPTIONS, extra).of('CB-1');

  test('an outfall within 30 m of documented coho water is creek, named from the county stream', () => {
    const t = one('NPDES_Outfall', [80, 0], { swifdCoho: [coho], hydroCenterlines: [named] });
    assert.deepEqual([t.ending.cls, t.ending.code, t.ending.receiving, t.confidence], ['creek', 'outfall-creek', 'Clarks Creek', 'high']);
    assert.equal(t.ending.reason, `Comes out at outfall DP-1, about 70 ft from Clarks Creek. ${WDFW_SAYS.documented}`);
  });

  test('a reach WDFW only models as reachable by coho is other water, and says so', () => {
    for (const [dist, say] of [['Gradient Accessible', WDFW_SAYS.modeled], ['Potential', WDFW_SAYS.modeled], ['Historic - Documented', WDFW_SAYS.historic]] as const) {
      const t = one('NPDES_Outfall', [80, 0], { swifdCoho: [reach('Unnamed stream [1221]', [[100, -100], [100, 100]], dist)], hydroCenterlines: [named] });
      assert.deepEqual([t.ending.cls, t.ending.code, t.ending.receiving], ['elsewhere', 'outfall-elsewhere', 'Clarks Creek'], dist);
      assert.ok(t.ending.reason.endsWith(say), t.ending.reason);
    }
    // Presumed and transported reaches count as documented
    for (const dist of ['Presumed', 'Transported - Documented', 'Artificial - Presumed']) {
      assert.equal(one('NPDES_Outfall', [80, 0], { swifdCoho: [reach('Unnamed stream [1221]', [[100, -100], [100, 100]], dist)] }).ending.cls, 'creek', dist);
    }
  });

  test('a stream that runs on into documented coho water within 2 km, as the County draws it, counts as creek', () => {
    // Little Creek runs north into Clarks Creek, which runs along a coho reach; `gap` m of plain stream between
    const waters = (gap: number, dist = 'Documented') => ({
      swifdCoho: [reach('Clarks Creek [1]', [[105, 400 + gap], [105, 1400 + gap]], dist)],
      hydroCenterlines: [
        stream('Little Creek', [[100, -100], [100, 400]]),
        ...(gap ? [stream('Middle Creek', [[100, 400], [100, 400 + gap]])] : []),
        stream('Clarks Creek', [[100, 400 + gap], [100, 1400 + gap]]),
      ],
    });
    const near = one('NPDES_Outfall', [80, 0], waters(0));
    assert.deepEqual([near.ending.cls, near.ending.code, near.ending.receiving, near.confidence], ['creek', 'downstream-creek', 'Clarks Creek', 'likely']);
    assert.equal(near.ending.reason, 'Comes out at outfall DP-1, about 70 ft from Little Creek. Little Creek flows about 1,300 ft on into Clarks Creek, where WDFW records coho salmon.');
    const far = one('NPDES_Outfall', [80, 0], waters(2000));
    assert.deepEqual([far.ending.cls, far.ending.receiving], ['elsewhere', 'Little Creek']);
    // the downstream water has to be documented coho water too; modeled water downstream is said as such
    const modeled = one('NPDES_Outfall', [80, 0], waters(0, 'Gradient Accessible'));
    assert.deepEqual([modeled.ending.cls, modeled.ending.code, modeled.ending.receiving], ['elsewhere', 'outfall-elsewhere', 'Little Creek']);
    assert.equal(
      modeled.ending.reason,
      "Comes out at outfall DP-1, about 70 ft from Little Creek. Little Creek flows about 1,300 ft on into Clarks Creek, which WDFW maps as reachable by coho salmon. They haven't been confirmed there.",
    );
  });

  test('an outfall by a lake is elsewhere, named, without a word on coho', () => {
    const t = one('Outfall', [-140, 0], { swifdCoho: [coho], hydroWaterbodies: [lake] });
    assert.deepEqual([t.ending.cls, t.ending.receiving], ['elsewhere', 'Lake Example']);
    assert.doesNotMatch(t.ending.reason, /coho/);
  });

  test('a permit discharge point away from water soaks in, in plain words; an outfall there is unknown', () => {
    const p = one('NPDES_Discharge', [0, 500], {});
    assert.deepEqual([p.ending.cls, p.ending.code, p.confidence], ['ground', 'discharge-point', 'likely']);
    assert.equal(p.ending.reason, 'Ends at discharge point DP-1. In the state stormwater permit, a discharge point is where water leaves the pipes through something built to soak it into the ground.');
    const o = one('NPDES_Outfall', [0, 500], {});
    assert.deepEqual([o.ending.cls, o.ending.code, o.confidence], ['unknown', 'outfall-unknown', 'none']);
    assert.equal(o.ending.reason, "Comes out at outfall DP-1, but the stream or pond it flows into isn't on the map.");
    // water a little farther off is named, not answered
    const by = one('NPDES_Outfall', [-110, 0], { hydroWaterbodies: [lake] });
    assert.deepEqual([by.ending.code, by.ending.reason], ['outfall-unknown', "Comes out at outfall DP-1, but the stream or pond it flows into isn't on the map. The nearest mapped water, Lake Example, is about 130 ft away."]);
  });

  test('a permit discharge point beside a creek soaks in first, and never reads as ending up in the creek', () => {
    const t = one('NPDES_Discharge', [80, 0], { swifdCoho: [coho], hydroCenterlines: [named] });
    assert.deepEqual([t.ending.cls, t.ending.code, t.ending.receiving, t.confidence], ['ground', 'discharge-by-water', 'Clarks Creek', 'likely']);
    assert.match(t.ending.reason, /built to soak it into the ground\. It is about 70 ft from Clarks Creek, so some may still reach it\. WDFW records coho salmon in this stream\.$/);
    // a discharge point with a soak-in facility drawn beside it does the same
    const cell = poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(80, -12, 5));
    const f = trace({ drainStructures: [cb('CB-1', [50, 0])], endPoints: [ep('DP-1', 'Discharge', [80, 0])], mainLines: [pipe('PI-1', [[50, 0], [80, 0]])], facilityPolygons: [cell] }, { swifdCoho: [coho] }).of('CB-1');
    assert.deepEqual([f.ending.cls, f.ending.code], ['ground', 'discharge-by-water']);
  });

  test('beside a discharge point, an unnamed pond may be the soak-in pond itself, so it is not water it reaches', () => {
    const pond = poly({ FeatureName: '' }, box(0, 520, 10));
    assert.equal(one('NPDES_Discharge', [0, 500], { hydroWaterbodies: [pond] }).ending.code, 'discharge-point');
    assert.equal(one('Discharge', [0, 500], { hydroWaterbodies: [pond] }).ending.code, 'discharge-probable');
    // an outfall there does reach it
    assert.deepEqual([one('NPDES_Outfall', [0, 500], { hydroWaterbodies: [pond] }).ending.receiving], ['an unnamed pond']);
  });

  test('with nothing drawn that soaks it in, a discharge point drains to the County’s own water, and only mentions the extra layers', () => {
    const nhd: ExtraWater = { kind: 'stream', name: 'Elizabeth Creek', lines: [lonlat([[100, -100], [100, 100]])] };
    const t = one('Discharge', [80, 0], {}, [nhd]);
    assert.deepEqual([t.ending.cls, t.ending.code], ['unknown', 'discharge-probable']);
    assert.match(t.ending.reason, /can't confirm it\. It is about 70 ft from Elizabeth Creek\.$/);
    const county = one('Discharge', [80, 0], { hydroCenterlines: [stream('Rody Creek', [[100, -100], [100, 100]])] });
    assert.deepEqual([county.ending.cls, county.ending.code, county.ending.receiving], ['elsewhere', 'stream-elsewhere', 'Rody Creek']);
  });

  test('any other discharge point soaks in only with a mapped sign of it; without one it probably does', () => {
    const bare = one('Discharge', [0, 500], {});
    assert.deepEqual([bare.ending.cls, bare.ending.code, bare.confidence], ['unknown', 'discharge-probable', 'none']);
    assert.match(bare.ending.reason, /^Ends at discharge point DP-1\. In the state stormwater permit, .* The County's map doesn't show that part here, so TireTrail can't confirm it\.$/);
    const at = (extra: Parts) =>
      trace({ drainStructures: [cb('CB-1', [0, 0])], endPoints: [ep('DP-1', 'Discharge', [30, 0])], mainLines: [pipe('PI-1', [[0, 0], [30, 0]])], ...extra }).of('CB-1').ending;
    const drywell = at({ drainStructures: [cb('CB-1', [0, 0]), cb('DW-1', [30, 0], { BottomType: 'Open' })] });
    assert.deepEqual([drywell.cls, drywell.code], ['ground', 'discharge-point']);
    assert.match(drywell.reason, /catch basin DW-1 has an open bottom/);
    const byCell = at({ facilityPolygons: [poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(45, 0, 8))] });
    assert.deepEqual([byCell.cls, byCell.code], ['ground', 'discharge-point']);
    assert.match(byCell.reason, /about 20 ft from infiltration cell IC-1, which is built to soak water into the ground/);
    const unnamedCell = at({ facilityPolygons: [poly({ ComponentType: 'Infiltration Cell' }, box(45, 0, 8))] });
    assert.match(unnamedCell.reason, /from an unnamed infiltration cell,/);
  });

  test('where a drawn line carries on past a discharge point with no sign of soaking in, the trace goes on', () => {
    const t = trace(
      {
        drainStructures: [cb('CB-1', [0, 0])],
        endPoints: [ep('DP-1', 'Discharge', [30, 0]), ep('OF-1', 'NPDES_Outfall', [80, 0])],
        mainLines: [pipe('PI-1', [[0, 0], [30, 0]])],
        openChannels: [ditch('CH-1', [[30, 0], [80, 0]])],
      },
      { swifdCoho: [coho] },
    );
    assert.deepEqual(t.of('CB-1').keys, ['CB-1', 'PI-1', 'DP-1', 'CH-1', 'OF-1']);
    assert.equal(t.of('CB-1').ending.cls, 'creek');
    assert.equal(t.passedDischarge, 1);
  });

  test('a plain end point near a coho reach is creek, far from water unknown', () => {
    assert.equal(one('Endpoint', [80, 0], { swifdCoho: [coho] }).ending.cls, 'creek');
    assert.equal(one('Endpoint', [0, 500], {}).ending.code, 'dead-end');
  });

  test('a catch basin with nothing mapped is unknown unless it has an open bottom', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [100, 0], { BottomType: 'Open' })] });
    assert.deepEqual([t.of('CB-1').ending.cls, t.of('CB-1').ending.code], ['unknown', 'not-connected']);
    assert.deepEqual([t.of('CB-2').ending.cls, t.of('CB-2').ending.code], ['ground', 'drywell']);
  });

  test('reaching a stream culvert ends the trace at that stream', () => {
    const t = trace(
      {
        drainStructures: [cb('CB-1', [40, 0])],
        mainLines: [pipe('PI-1', [[40, 0], [95, 0]]), pipe('CU-1', [[95, 0], [110, 0]], { MainLineType: 'Culvert', LiveStreamCulvert: 1 })],
      },
      { swifdCoho: [coho] },
    );
    assert.deepEqual(t.of('CB-1').keys, ['CB-1', 'PI-1', 'CU-1']);
    assert.equal(t.of('CB-1').ending.code, 'stream-creek');
    assert.equal(t.of('CB-1').ending.receiving, 'an unnamed stream');
  });

  test('a stream culvert by a lake runs into it, rather than being part of it', () => {
    const t = trace(
      { drainStructures: [cb('CB-1', [-60, 0])], mainLines: [pipe('PI-1', [[-60, 0], [-40, 0]]), pipe('CU-1', [[-40, 0], [-160, 0]], { MainLineType: 'Culvert', LiveStreamCulvert: 1 })] },
      { hydroWaterbodies: [lake] },
    ).of('CB-1');
    assert.equal(t.ending.reason, 'Reaches stream culvert CU-1, which runs into Lake Example.');
  });

  test('two unnamed streams are never said to be the same one', () => {
    const waters = {
      swifdCoho: [reach('Unnamed stream [9]', [[105, 400], [105, 1400]])],
      hydroCenterlines: [stream('', [[100, -100], [100, 400]]), stream('', [[100, 400], [100, 1400]])],
    };
    const t = one('NPDES_Outfall', [80, 0], waters);
    assert.equal(t.ending.reason, 'Comes out at outfall DP-1, about 70 ft from an unnamed stream. That stream flows about 1,300 ft on into another stream, where WDFW records coho salmon.');
  });

  test('WDFW names drop the reach number; unnamed reaches have no name', () => {
    assert.equal(swifdName('Unnamed stream [1220954471946]'), '');
    assert.equal(swifdName('Fennel Creek [1221]'), 'Fennel Creek');
  });

  test('reasons use IDs and types, not owner names', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0], { PropertyOwner: 'Acme HOA' })], endPoints: [ep('DP-1', 'Discharge', [30, 0])], mainLines: [pipe('PI-1', [[0, 0], [30, 0]])] });
    assert.match(t.of('CB-1').ending.reason, /discharge point DP-1/);
    assert.doesNotMatch(t.of('CB-1').ending.reason, /Acme/);
  });
});

describe('bridge drains and loose pipe ends', () => {
  const creek = reach('Clover Creek [2]', [[0, -100], [0, 100]]);

  test('a bridge drain with no pipe most likely drops into the water below it', () => {
    const t = trace({ inletComponents: [scupper('BS-1', [5, 0]), scupper('BS-2', [15, 0]), scupper('BS-3', [30, 0])] }, { swifdCoho: [creek] });
    assert.deepEqual([t.of('BS-1').ending.cls, t.of('BS-1').ending.code, t.of('BS-1').ending.receiving, t.of('BS-1').confidence], ['creek', 'bridge-creek', 'Clover Creek', 'likely']);
    assert.equal(t.of('BS-1').ending.reason, `Bridge drain BS-1 has no pipe on the County's map, so rain most likely drops through it into Clover Creek, about 20 ft away. ${WDFW_SAYS.documented}`);
    assert.equal(t.of('BS-2').ending.code, 'bridge-creek');
    assert.deepEqual([t.of('BS-3').ending.cls, t.of('BS-3').ending.code], ['unknown', 'not-connected']);
    // over other water it is other water
    const lake = trace({ inletComponents: [scupper('BS-1', [5, 0])] }, { hydroWaterbodies: [poly({ FeatureName: 'Lake Example' }, box(0, 0, 4))] }).of('BS-1');
    assert.deepEqual([lake.ending.cls, lake.ending.code, lake.ending.receiving], ['elsewhere', 'bridge-elsewhere', 'Lake Example']);
    // a catch basin by the creek with no pipe stays a gap
    assert.equal(trace({ drainStructures: [cb('CB-1', [5, 0])] }, { swifdCoho: [creek] }).of('CB-1').ending.code, 'not-connected');
  });

  test('a pipe or ditch the map stops at within 15 m of water most likely flows in', () => {
    const at = (end: number, extra: Parts = {}) =>
      trace({ drainStructures: [cb('CB-1', [-100, 0])], mainLines: [pipe('PI-1', [[-100, 0], [-end, 0]])], ...extra }, { hydroCenterlines: [stream('Rody Creek', [[0, -100], [0, 100]])] }).of('CB-1');
    const near = at(10);
    assert.deepEqual([near.ending.cls, near.ending.code, near.ending.receiving, near.confidence], ['elsewhere', 'pipe-end-elsewhere', 'Rody Creek', 'likely']);
    assert.equal(near.ending.reason, "Following the pipes and ditches the way they're drawn, the County's map stops at the end of pipe PI-1, about 30 ft from Rody Creek. It most likely flows in, but the map doesn't show an outfall.");
    assert.equal(at(25).ending.code, 'dead-end');
    // a structure at the end is a gap in the map, not an outfall
    assert.equal(at(10, { drainStructures: [cb('CB-1', [-100, 0]), cb('MH-1', [-10, 0])] }).ending.code, 'dead-end');
    // documented coho water makes it creek
    const coho = trace({ drainStructures: [cb('CB-1', [-100, 0])], mainLines: [pipe('PI-1', [[-100, 0], [-10, 0]])] }, { swifdCoho: [creek] }).of('CB-1');
    assert.deepEqual([coho.ending.cls, coho.ending.code], ['creek', 'pipe-end-creek']);
  });
});

describe('waters the County layers lack', () => {
  const sound: ExtraWater = { kind: 'marine', name: 'Puget Sound', polygons: [[lonlat([[0, 0], [0, 1000], [-1000, 1000], [-1000, 0], [0, 0]])]], covered: false };

  test('an outfall at the shore drains to Puget Sound', () => {
    const t = trace({ drainStructures: [cb('CB-1', [40, 500])], endPoints: [ep('OF-1', 'Outfall', [10, 500])], mainLines: [pipe('PI-1', [[40, 500], [10, 500]])] }, {}, DEFAULT_COUNTY_TRACE_OPTIONS, [sound]).of('CB-1');
    assert.deepEqual([t.ending.cls, t.ending.code, t.ending.receiving], ['elsewhere', 'outfall-elsewhere', 'Puget Sound']);
    assert.equal(t.ending.reason, 'Comes out at outfall OF-1, about 30 ft from Puget Sound.');
    // inside the water body (or right at it)
    const inside = trace({ drainStructures: [cb('CB-1', [20, 500])], endPoints: [ep('OF-1', 'Outfall', [-1, 500])], mainLines: [pipe('PI-1', [[20, 500], [-1, 500]])] }, {}, DEFAULT_COUNTY_TRACE_OPTIONS, [sound]).of('CB-1');
    assert.equal(inside.ending.reason, 'Comes out at outfall OF-1, right by Puget Sound.');
  });

  test('NHD streams, wetlands and small ponds are receiving waters; NHD lines that repeat a County line are dropped', () => {
    const outfall = (at: XY) => ({ drainStructures: [cb('CB-1', [at[0] - 30, at[1]])], endPoints: [ep('OF-1', 'Outfall', at)], mainLines: [pipe('PI-1', [[at[0] - 30, at[1]], at])] });
    const nhd: ExtraWater = { kind: 'stream', name: 'Elizabeth Creek', lines: [lonlat([[100, -100], [100, 100]])] };
    assert.equal(trace(outfall([85, 0]), {}, DEFAULT_COUNTY_TRACE_OPTIONS, [nhd]).of('CB-1').ending.receiving, 'Elizabeth Creek');
    // the same line beside a County stream repeats it, so the County's name and line are used
    const county = trace(outfall([85, 0]), { hydroCenterlines: [stream('Rody Creek', [[101, -100], [101, 100]])] }, DEFAULT_COUNTY_TRACE_OPTIONS, [nhd]).of('CB-1');
    assert.equal(county.ending.receiving, 'Rody Creek');
    const wetland: ExtraWater = { kind: 'wetland', name: '', polygons: [[lonlat([[90, -10], [110, -10], [110, 10], [90, 10], [90, -10]])]] };
    assert.equal(trace(outfall([85, 0]), {}, DEFAULT_COUNTY_TRACE_OPTIONS, [wetland]).of('CB-1').ending.receiving, 'a wetland');
    const small = poly({ FeatureName: '' }, box(100, 0, 10));
    assert.equal(trace(outfall([85, 0]), { hydroWaterbodies: [small] }).of('CB-1').ending.receiving, 'an unnamed pond');
    // a small water body on a drainage facility is that storm pond, even a crescent whose middle misses it
    const storm = trace({ ...outfall([85, 0]), facilityPolygons: [poly({ AssetID: 'WP-1', ComponentType: 'Wet Pond Cell' }, box(100, 0, 12))] }, { hydroWaterbodies: [small] }).of('CB-1');
    assert.equal(storm.ending.code, 'outfall-unknown');
    const crescent = poly({ FeatureName: '' }, [[90, -20], [130, -20], [130, 20], [90, 20], [90, 12], [122, 12], [122, -12], [90, -12]]);
    const inCrescent = trace({ ...outfall([85, 0]), facilityPolygons: [poly({ AssetID: 'WP-2', ComponentType: 'Wet Pond Cell' }, box(126, 0, 3))] }, { hydroWaterbodies: [crescent] }).of('CB-1');
    assert.equal(inCrescent.ending.code, 'outfall-unknown');
  });

  test('an NHD river area takes the coho kind and name of the reach inside it', () => {
    const river: ExtraWater = { kind: 'stream', name: '', polygons: [[lonlat([[60, -500], [160, -500], [160, 500], [60, 500], [60, -500]])]] };
    const t = trace(
      { drainStructures: [cb('CB-1', [20, 0])], endPoints: [ep('OF-1', 'Outfall', [55, 0])], mainLines: [pipe('PI-1', [[20, 0], [55, 0]])] },
      { swifdCoho: [reach('Puyallup River [3]', [[110, -500], [110, 500]])] },
      DEFAULT_COUNTY_TRACE_OPTIONS,
      [river],
    ).of('CB-1');
    assert.deepEqual([t.ending.cls, t.ending.receiving], ['creek', 'Puyallup River']);
  });
});

describe('water names', () => {
  test("a person's name is not a stream name; doubles and capitals read plainly", () => {
    assert.equal(cleanWaterName('Mark Dickson'), '');
    assert.equal(cleanWaterName('Electron Flume'), 'Electron Flume');
    assert.equal(cleanWaterName('Church Lake/Lake Tapps'), 'Church Lake, then Lake Tapps');
    assert.equal(cleanWaterName('CLOVER CREEK'), 'Clover Creek');
    assert.equal(cleanWaterName('LAKE OF THE WOODS'), 'Lake of the Woods');
    assert.equal(cleanWaterName('Frog Heaven'), '');
    assert.equal(cleanWaterName('Frog Heaven', new Set(['frog heaven'])), 'Frog Heaven');
    assert.equal(cleanWaterName('None'), '');
  });

  test('a County stream with no water word in its name reads as unnamed', () => {
    const t = trace(
      { drainStructures: [cb('CB-1', [50, 0])], endPoints: [ep('OF-1', 'Outfall', [80, 0])], mainLines: [pipe('PI-1', [[50, 0], [80, 0]])] },
      { hydroCenterlines: [stream('Mark Dickson', [[100, -100], [100, 100]])] },
    ).of('CB-1');
    assert.equal(t.ending.receiving, 'an unnamed stream');
  });

  test("a WDFW name one letter off the County stream drawn along it takes the County's spelling", () => {
    const w = new CountyWaters(waterLayers({ swifdCoho: [reach('Swam Creek [4]', [[0, 0], [0, 500]])], hydroCenterlines: [stream('Swan Creek', [[3, 0], [3, 500]])] }), P);
    assert.deepEqual(w.all.filter((x) => x.source === 'coho').map((x) => x.name), ['Swan Creek']);
    const far = new CountyWaters(waterLayers({ swifdCoho: [reach('Swam Creek [4]', [[0, 0], [0, 500]])], hydroCenterlines: [stream('Swan Creek', [[300, 0], [300, 500]])] }), P);
    assert.deepEqual(far.all.filter((x) => x.source === 'coho').map((x) => x.name), ['Swam Creek']);
  });

  test('assets with no ID read with an article, distances in feet', () => {
    const { assets } = loadCountyAssets(layers({ facilityPolygons: [poly({ ComponentType: 'Infiltration Cell' }, box(0, 0, 5))] }), P);
    assert.equal(describeCounty(assets[0]), 'an unnamed infiltration cell');
    assert.deepEqual([feet(1), feet(6), feet(30), feet(400), feet(2000)], ['a few feet', 'about 20 ft', 'about 100 ft', 'about 1,300 ft', 'about 1.2 miles']);
  });

  test('county reasons never speak for the city or as "we"', () => {
    const t = trace(
      {
        drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [0, 300]), cb('CB-3', [500, 0]), cb('DW-1', [530, 0], { BottomType: 'Open' })],
        endPoints: [ep('DP-1', 'NPDES_Discharge', [30, 0]), ep('DP-2', 'Discharge', [0, 330])],
        mainLines: [pipe('PI-1', [[0, 0], [30, 0]]), pipe('PI-2', [[0, 300], [0, 330]]), pipe('PI-3', [[500, 0], [530, 0]])],
        facilityPolygons: [poly({ AssetID: 'IC-1', ComponentType: 'Infiltration Cell' }, box(0, 345, 5))],
      },
      { swifdCoho: [reach('Unnamed stream [1]', [[40, -50], [40, 50]])] },
    );
    for (const tr of t.traces) assert.doesNotMatch(tr.ending.reason, /\bcity\b|\bwe\b|\bour\b/i, tr.ending.reason);
  });
});

describe('roadside ditches', () => {
  // a road along y = 0 with no drain near it; CH-ALONG runs beside it 5 m off and flows east to an outfall at a coho reach
  const roadside: Parts = {
    openChannels: [ditch('CH-ALONG', [[0, 5], [200, 5]]), ditch('CH-ACROSS', [[300, -40], [300, 40]])],
    endPoints: [ep('OF-1', 'Outfall', [210, 5])],
    mainLines: [pipe('PI-1', [[200, 5], [210, 5]])],
    drainStructures: [cb('CB-FAR', [0, 400])],
  };
  const waters: WaterParts = { swifdCoho: [reach('Clover Creek [2]', [[230, -100], [230, 100]])] };
  const road = (id: number, pts: XY[]) => ln({ id, road_name: 'TEST RD E', receiving_creek: '' }, pts);

  function setup(parts: Parts = roadside) {
    const t = trace(parts, waters);
    const finder = new IntakeFinder(t.assets, t.traces.map((x) => t.assets[x.drain].anchor));
    return { t, finder };
  }

  test('a ditch running along a street with no drain takes its rain; one crossing the road does not', () => {
    const { t, finder } = setup();
    const line: XY[] = [[0, 0], [400, 0]];
    const id = (k: string) => t.assets.find((a) => a.key === k)!.index;
    assert.equal(finder.at(line, 100), id('CH-ALONG'));
    assert.equal(finder.at(line, 300), -1);
    assert.equal(finder.at(line, 380), -1);
    // a drain within 50 m wins
    const near = setup({ ...roadside, drainStructures: [cb('CB-1', [100, -20])] });
    assert.equal(near.finder.at(line, 100), -1);
  });

  test("the ditch's water goes where the router sends it from the ditch's downstream end, and the reason says so", () => {
    const { t } = setup();
    const ditchAt = t.assets.find((a) => a.key === 'CH-ALONG')!.index;
    const [it] = t.tracer.traceIntakes([ditchAt]).traces;
    assert.deepEqual(it.path.map((k) => t.assets[k].key), ['CH-ALONG', 'PI-1', 'OF-1']);
    assert.deepEqual([it.ending.cls, it.ending.code, it.ending.receiving, it.confidence, it.pipeM], ['creek', 'outfall-creek', 'Clover Creek', 'likely', 210]);
    assert.equal(it.ending.reason, `${INTAKE_SAYS} Comes out at outfall OF-1, about 70 ft from Clover Creek. ${WDFW_SAYS.documented}`);
    // a ditch that goes nowhere says where the map stops
    const lone = trace({ openChannels: [ditch('CH-1', [[0, 5], [100, 5]])], drainStructures: [cb('CB-FAR', [0, 400])] });
    const [stop] = lone.tracer.traceIntakes([lone.assets.find((a) => a.key === 'CH-1')!.index]).traces;
    assert.deepEqual([stop.ending.cls, stop.ending.code], ['unknown', 'dead-end']);
    assert.equal(stop.ending.reason, "Runs into a roadside ditch. Following the pipes and ditches the way they're drawn, the County's map stops at ditch CH-1 without showing where the water goes.");
  });

  test('county streets color like the city classifier, and take the ditch only where no drain is near', () => {
    const { t, finder } = setup();
    const roads = fc([road(1, [[0, 0], [400, 0]]), road(2, [[0, 390], [100, 390]])]);
    const drainAt = t.traces.map((x) => t.assets[x.drain].anchor);
    const clsOf = (k: number) => (k < t.traces.length ? t.traces[k].ending.cls : 'creek');
    const plain = classifyCountyStreets(roads, drainAt, clsOf, P, null);
    assert.deepEqual(plain, classifyStreets(roads, { assets: t.assets }, t.traces, P));
    const ditchAt = t.assets.find((a) => a.key === 'CH-ALONG')!.index;
    const withDitch = classifyCountyStreets(roads, drainAt, clsOf, P, (line, along, length) => (finder.at(line, along, length) === ditchAt ? t.traces.length : -1));
    const runs = withDitch.runs.filter((r) => r.piece === 0).map((r) => [r.drain, r.cls, Math.round(r.fromM), Math.round(r.toM)]);
    assert.deepEqual(runs, [[t.traces.length, 'creek', 0, 208], [-1, 'none', 208, 400]]);
    // the other street takes the drain where it is within 50 m, and has no ditch past it
    assert.deepEqual(withDitch.runs.filter((r) => r.piece === 1).map((r) => r.drain), [0, -1]);
  });

  test('an area bundle carries the ditch as an extra drain the street points to, outside the drain counts', () => {
    const { t, finder } = setup();
    const ditchAt = t.assets.find((a) => a.key === 'CH-ALONG')!.index;
    const it = t.tracer.traceIntakes([ditchAt]);
    const roads = [road(1, [[0, 0], [400, 0]])];
    const model: CountyModel = {
      assets: t.assets,
      graph: t.graph,
      traces: t.traces,
      traceEdges: t.traceEdges,
      waters: t.waters,
      roads,
      roadMid: [[200, 0]],
      projection: P,
      intakes: { finder, byChannel: new Map([[ditchAt, { trace: it.traces[0], edges: it.traceEdges[0] }]]) },
    };
    const idx = new GridIndex<number>(100);
    t.traces.forEach((tr, i) => idx.insertPoint(i, t.assets[tr.drain].anchor));
    const slice = sliceArea(model, { minX: -50, minY: -50, maxX: 450, maxY: 450 }, flowDirections(model), idx);
    assert.equal(slice.drainCount, 1);
    assert.equal(slice.ownDrains, 1);
    const data = new TireTrailData(JSON.parse(JSON.stringify(encodeBundle(slice, {}, { credits: ['test'], disclaimer: 'test' }))));
    assert.equal(data.drainCount, 2);
    const run = data.street(0);
    assert.equal(run.cls, 'creek');
    const d = data.drain(run.drain!);
    assert.deepEqual([d.id, d.cls, d.receiving], ['CH-ALONG', 'creek', 'Clover Creek']);
    assert.equal(data.bundle.assets.kind[data.bundle.drains.asset[run.drain!]], 6, 'the drain asset is a channel');
    assert.ok(d.reason.startsWith(INTAKE_SAYS), d.reason);
    // how far the map follows the water is the path: the ditch, then the pipe to the outfall
    const path = data.path(run.drain!);
    assert.deepEqual(path.assets, ['CH-ALONG', 'PI-1', 'OF-1']);
    assert.ok(path.lengthM > 209 && path.lengthM < 211, `path ${path.lengthM} m`);
  });
});

describe('county area bundles', () => {
  test('an area encodes to a bundle the app loads, with lines in flow order', () => {
    // pipe drawn backwards: water runs from CB-1 to the outfall at x = 60
    const t = trace(
      {
        drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [10, 30])],
        endPoints: [ep('DP-1', 'NPDES_Outfall', [60, 0])],
        mainLines: [pipe('PI-1', [[60, 0], [0, 0]]), pipe('PI-2', [[10, 30], [10, 0]])],
      },
      { swifdCoho: [reach('Test Creek [1]', [[70, -50], [70, 50]])] },
    );
    const roads = [ln({ id: 1, road_name: 'TEST RD E', receiving_creek: '' }, [[-20, 5], [80, 5]])];
    const model: CountyModel = { assets: t.assets, graph: t.graph, traces: t.traces, traceEdges: t.traceEdges, waters: t.waters, roads, roadMid: [[30, 5]], projection: P };
    const reversed = flowDirections(model);
    const idx = new GridIndex<number>(100);
    t.traces.forEach((tr, i) => idx.insertPoint(i, t.assets[tr.drain].anchor));
    const slice = sliceArea(model, { minX: -50, minY: -50, maxX: 100, maxY: 100 }, reversed, idx);
    const bundle = encodeBundle(slice, {}, { credits: ['test'], disclaimer: 'test' });
    const data = new TireTrailData(JSON.parse(JSON.stringify(bundle)));
    const d = data.findDrain('CB-1')!;
    assert.deepEqual([d.cls, d.receiving, d.exitId], ['creek', 'Test Creek', 'DP-1']);
    const path = data.path(d.index);
    assert.deepEqual(path.assets, ['CB-1', 'PI-1', 'DP-1']);
    assert.ok(path.lengthM > 59 && path.lengthM < 61, `path ${path.lengthM} m`);
    // the side pipe joins PI-1 partway and is drawn from there
    assert.deepEqual(data.path(data.findDrain('CB-2')!.index).assets, ['CB-2', 'PI-2', 'PI-1', 'DP-1']);
    assert.equal(data.street(0).cls, 'creek');
    assert.deepEqual(data.street(0).terrain, { cls: 'unknown', name: '' });
    assert.equal(data.fixList[0].receiving, 'Test Creek');
    assert.ok(bundle.waters.some((w) => w.fennel && w.name === 'Test Creek') === false, 'raw WDFW reaches are not drawn');
  });

  test('only documented coho streams are drawn as coho water', () => {
    const t = trace({ drainStructures: [cb('CB-1', [0, 0])] }, {
      swifdCoho: [reach('A Creek [1]', [[50, -100], [50, 100]]), reach('B Creek [2]', [[150, -100], [150, 100]], 'Gradient Accessible')],
      hydroCenterlines: [stream('A Creek', [[52, -100], [52, 100]]), stream('B Creek', [[152, -100], [152, 100]])],
    });
    const drawn = t.waters.drawable({ minX: -200, minY: -200, maxX: 200, maxY: 200 }).map((w) => [w.name, w.fennel]);
    assert.deepEqual(drawn, [['A Creek', true], ['B Creek', false]]);
  });
});
