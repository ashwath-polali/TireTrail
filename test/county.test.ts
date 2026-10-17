import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GridIndex, localProjection, type XY } from '../src/geo/geo.ts';
import { flowDirections, sliceArea, type CountyModel } from '../src/county/area.ts';
import { loadCountyAssets, type CountyStormLayers } from '../src/county/assets.ts';
import { buildGraph } from '../src/county/graph.ts';
import { DEFAULT_ROUTE_OPTIONS, measureDirection, route } from '../src/county/route.ts';
import { CountyTracer, DEFAULT_COUNTY_TRACE_OPTIONS } from '../src/county/trace.ts';
import { CountyWaters, swifdName, type CountyWaterLayers } from '../src/county/waters.ts';
import { encodeBundle } from '../src/data/encode.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import type { Feature, FeatureCollection, Properties } from '../src/trace/geojson.ts';

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

type Parts = Partial<Record<keyof CountyStormLayers, Feature[]>>;
function layers(parts: Parts): CountyStormLayers {
  const keys: (keyof CountyStormLayers)[] = ['drainStructures', 'networkStructures', 'endPoints', 'inletComponents', 'outletComponents', 'barriers', 'mainLines', 'openChannels', 'virtualDrainlines', 'facilityPolygons', 'storageBasins'];
  return Object.fromEntries(keys.map((k) => [k, fc(parts[k])])) as unknown as CountyStormLayers;
}
function waterLayers(parts: Partial<Record<keyof CountyWaterLayers, Feature[]>> = {}): CountyWaterLayers {
  return { swifdCoho: fc(parts.swifdCoho), hydroCenterlines: fc(parts.hydroCenterlines), hydroWaterbodies: fc(parts.hydroWaterbodies) };
}
function trace(parts: Parts, waters: Partial<Record<keyof CountyWaterLayers, Feature[]>> = {}, opts = DEFAULT_COUNTY_TRACE_OPTIONS) {
  const { assets } = loadCountyAssets(layers(parts), P);
  const graph = buildGraph(assets);
  const w = new CountyWaters(waterLayers(waters), P);
  const out = new CountyTracer(assets, graph, w, opts).traceAll();
  const of = (id: string) => {
    const t = out.traces.find((x) => assets[x.drain].key === id);
    if (!t) throw new Error(`no drain ${id}`);
    return { ...t, keys: t.path.map((k) => assets[k].key) };
  };
  return { assets, graph, waters: w, ...out, of };
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
      endPoints: [ep('DP-1', 'Discharge', [-200, 0])],
      mainLines: [pipe('PI-1', [[0, 0], [20, 0]]), pipe('PI-0', [[0, 0], [-200, 0]]), pipe('PI-2', [[200, 0], [220, 0]])],
    });
    assert.equal(t.of('CB-1').ending.code, 'discharge-point');
    assert.equal(t.of('CB-2').ending.code, 'drywell');
    assert.deepEqual(t.of('CB-2').keys, ['CB-2', 'PI-2', 'CB-OPEN2']);
  });

  test('the routing is a tree: every node has one way out', () => {
    const t = trace(parts);
    const r = route(t.graph, [...t.sinks.values()].map((s) => s.node), []);
    for (let n = 0; n < t.graph.nodes.length; n++) if (r.sink[n] >= 0 && r.sink[n] !== n) assert.ok(r.nextEdge[n] >= 0);
  });

  test('direction check counts lines drawn toward an end point', () => {
    const t = trace(parts);
    const isEp = (n: number) => t.graph.nodes[n].assets.some((k) => t.assets[k].layer === 'endpoint');
    assert.deepEqual(measureDirection(t.graph, isEp), { lines: 2, towardEndPoint: 1, share: 0.5 });
  });
});

describe('county endings', () => {
  const coho = ln({ LLID_STRM_NAME: 'Unnamed stream [1221]' }, [[100, -100], [100, 100]]);
  const named = ln({ FeatureName: 'Clarks Creek', FeatureType: 'Stream', StreamTypeNPDES: 'Receiving' }, [[105, -100], [105, 100]]);
  const lake = poly({ FeatureName: 'Lake Example' }, box(-200, 0, 50));
  const one = (endType: string, at: XY, waters: Partial<Record<keyof CountyWaterLayers, Feature[]>>) =>
    trace({ drainStructures: [cb('CB-1', [at[0] - 30, at[1]])], endPoints: [ep('DP-1', endType, at)], mainLines: [pipe('PI-1', [[at[0] - 30, at[1]], at])] }, waters).of('CB-1');

  test('an outfall within 30 m of a coho reach is creek, named from the county stream', () => {
    const t = one('NPDES_Outfall', [80, 0], { swifdCoho: [coho], hydroCenterlines: [named] });
    assert.equal(t.ending.cls, 'creek');
    assert.equal(t.ending.code, 'outfall-creek');
    assert.equal(t.ending.receiving, 'Clarks Creek');
    assert.equal(t.confidence, 'high');
  });

  test('an outfall by a lake is elsewhere, named', () => {
    const t = one('Outfall', [-140, 0], { swifdCoho: [coho], hydroWaterbodies: [lake] });
    assert.deepEqual([t.ending.cls, t.ending.receiving], ['elsewhere', 'Lake Example']);
  });

  test('a discharge point away from water soaks in; an outfall there is unknown', () => {
    assert.deepEqual([one('NPDES_Discharge', [0, 500], {}).ending.cls, one('NPDES_Discharge', [0, 500], {}).ending.code], ['ground', 'discharge-point']);
    const o = one('NPDES_Outfall', [0, 500], {});
    assert.deepEqual([o.ending.cls, o.ending.code, o.confidence], ['unknown', 'outfall-unknown', 'none']);
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
    assert.equal(t.of('CB-1').ending.receiving, 'Unnamed coho stream');
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

describe('county area bundles', () => {
  test('an area encodes to a bundle the app loads, with lines in flow order', () => {
    // pipe drawn backwards: water runs from CB-1 to the outfall at x = 60
    const t = trace(
      {
        drainStructures: [cb('CB-1', [0, 0]), cb('CB-2', [10, 30])],
        endPoints: [ep('DP-1', 'NPDES_Outfall', [60, 0])],
        mainLines: [pipe('PI-1', [[60, 0], [0, 0]]), pipe('PI-2', [[10, 30], [10, 0]])],
      },
      { swifdCoho: [ln({ LLID_STRM_NAME: 'Test Creek [1]' }, [[70, -50], [70, 50]])] },
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
});
