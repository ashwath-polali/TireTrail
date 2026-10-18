// npm run build:county: traces unincorporated Pierce County and writes public/data/areas/<id>.json + index.json.
// Always builds every area: names and ids depend on the whole set, and the folder is rewritten.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { COUNTY_CREDITS, COUNTY_DISCLAIMER } from '../src/data/bundle.ts';
import { encodeBundle } from '../src/data/encode.ts';
import { GridIndex, localProjection, pointInPolygon, polylineLength, type BBox, type XY } from '../src/geo/geo.ts';
import { flowDirections, inBox, sliceArea, type CountyModel } from '../src/county/area.ts';
import { loadCountyAssets } from '../src/county/assets.ts';
import { buildGraph } from '../src/county/graph.ts';
import { classifyCountyStreets, IntakeFinder } from '../src/county/streets.ts';
import { CountyTracer, DEFAULT_COUNTY_TRACE_OPTIONS } from '../src/county/trace.ts';
import { checkCircuits, checkDrawn } from '../src/county/validate.ts';
import { CountyWaters } from '../src/county/waters.ts';
import { streetTitle } from '../src/trace/fixlist.ts';
import { text, type Feature } from '../src/trace/geojson.ts';
import { STREET_CLASSES } from '../src/trace/streets.ts';
import { DRAIN_CLASSES } from '../src/trace/trace.ts';
import { CACHE, COUNTY_LAYERS, fetchCounty, readCounty, readExtraWaters } from './lib/county-fetch.ts';

const MAX_BYTES = 1.5e6;
const START_CELL_M = 10_000;
const MIN_CELL_M = 1250;
const OUT = 'public/data/areas';
/** Tehaleh home point */
const HOME: [number, number] = [-122.155, 47.137];

const started = performance.now();
const log = (s: string) => console.log(s);

await fetchCounty(log);
const L = readCounty();
const extra = await readExtraWaters(log);
const projection = localProjection([-122.3, 47.1]);
const xy = (c: number[]): XY => projection.toXY([c[0], c[1]]);

// 1. trace the whole county once
const load = loadCountyAssets(L, projection);
const { assets } = load;
const graph = buildGraph(assets);
const stormPonds = assets.filter((a) => a.kind === 'pond' && a.polygons).map((a) => a.polygons!);
const waters = new CountyWaters(L, projection, { extra: extra.waters, stormPonds });
const tracer = new CountyTracer(assets, graph, waters);
const traced = tracer.traceAll();
const { traces } = traced;
log(`Traced ${traces.length} drains in ${Math.round(performance.now() - started)} ms`);
const bySource = new Map<string, number>();
for (const w of waters.all) bySource.set(w.source, (bySource.get(w.source) ?? 0) + 1);
log(`  waters: ${[...bySource.entries()].map(([k, v]) => `${k} ${v}`).join(', ')} (extra layers from ${extra.files.join(', ')})`);

// 2. unincorporated roads (county address code PC on either side), no ferries
const roads: Feature[] = [];
const roadMid: XY[] = [];
for (const f of L.roads.features) {
  const p = f.properties;
  if (text(p.LCITY) !== 'PC' && text(p.RCITY) !== 'PC') continue;
  if (Number(p.MAP_CLASS) === 7 || Number(p.MAP_CLASS) === 9) continue;
  const g = f.geometry;
  if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
  const coords = g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
  if (coords.length < 2) continue;
  const line = coords.map(xy);
  const len = polylineLength(line);
  let walked = 0;
  let mid = line[0];
  for (let i = 1; i < line.length; i++) {
    const seg = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (walked + seg >= len / 2) {
      const t = seg ? (len / 2 - walked) / seg : 0;
      mid = [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])];
      break;
    }
    walked += seg;
  }
  roads.push({ type: 'Feature', geometry: g, properties: { id: Number(p.ROADS_ID), road_name: text(p.FULLNAME), receiving_creek: '', mapClass: Number(p.MAP_CLASS) } });
  roadMid.push(mid);
}

// roadside ditches: where no drain is mapped near a street, a ditch running along it takes the rain
const finder = new IntakeFinder(assets, traces.map((t) => assets[t.drain].anchor));
const ditchSet = new Set<number>();
classifyCountyStreets({ type: 'FeatureCollection', features: roads }, [], () => 'none', projection, (line, along, length) => {
  const d = finder.at(line, along, length);
  if (d >= 0) ditchSet.add(d);
  return -1;
});
const ditches = [...ditchSet].sort((a, b) => a - b);
const intakeTraced = tracer.traceIntakes(ditches);
const byChannel = new Map(ditches.map((d, i) => [d, { trace: intakeTraced.traces[i], edges: intakeTraced.traceEdges[i] }]));

const model: CountyModel = { assets, graph, traces, traceEdges: traced.traceEdges, waters, roads, roadMid, projection, intakes: { finder, byChannel } };
const reversed = flowDirections(model);

// 3. report
const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;
const s = graph.stats;
log('Network');
log(`  assets ${assets.length} (skipped: ${load.skipped.noGeometry} without geometry, ${load.skipped.abandoned} abandoned); drains ${traces.length}`);
log(`  graph: ${s.nodes} nodes, ${s.edges} edges (${Object.entries(s.edgesByHow).map(([k, v]) => `${k} ${v}`).join(', ')}), ${s.components} pieces`);
log(`  line ends joined ${s.endsJoined}, loose ${s.endsLoose}; joints partway along a line ${s.midLineJoins}; pond joins ${s.pondJoins}; pond-to-pond links ${s.pondLinks}; bridges ${s.bridges}`);
log(`  discharge points with no sign of soaking in that the map carries on past (not endings): ${traced.passedDischarge}`);
const d = traced.direction;
log(`  drawn direction: ${d.towardEndPoint} of ${d.lines} lines with an end point at one end are drawn toward it (${pct(d.towardEndPoint, d.lines)})`);
const byClass = Object.fromEntries(DRAIN_CLASSES.map((c) => [c, traces.filter((t) => t.ending.cls === c).length]));
log(`  drains by class: ${DRAIN_CLASSES.map((c) => `${c} ${byClass[c]} (${pct(byClass[c], traces.length)})`).join(', ')}`);
const codes = new Map<string, number>();
for (const t of traces) codes.set(t.ending.code, (codes.get(t.ending.code) ?? 0) + 1);
log(`  endings: ${[...codes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
const conf = new Map<string, number>();
for (const t of traces) conf.set(t.confidence, (conf.get(t.confidence) ?? 0) + 1);
log(`  confidence: ${[...conf.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}; traces crossing a bridged gap or pond-to-pond link: ${traces.filter((t) => t.weakLinks > 0).length}`);
const ditchClass = Object.fromEntries(DRAIN_CLASSES.map((c) => [c, intakeTraced.traces.filter((t) => t.ending.cls === c).length]));
log(`  roadside ditches taking street rain where no drain is mapped: ${ditches.length} (${DRAIN_CLASSES.map((c) => `${c} ${ditchClass[c]}`).join(', ')})`);
log(`  lines drawn against the flow the traces found: ${reversed.size}`);
const dc = checkDrawn(graph, traced);
const cap = DEFAULT_COUNTY_TRACE_OPTIONS.route.maxAgainstM;
log(`Check against the drawn direction (routes may run ${cap} m against it in total)`);
log(`  routed drains: ${dc.routed}; whose ending the drawn direction alone never reaches: ${dc.notDrawn} (${pct(dc.notDrawn, dc.routed)})`);
log(`  routes running against the drawing more than 20 m: ${dc.over20}, 60 m: ${dc.over60}, 100 m: ${dc.over100}`);
const cc = checkCircuits(assets, traces, L.circuits, projection);
log('Check against the County drainage circuits (3 m tolerance)');
log(`  drains in a circuit: ${cc.inCircuit} of ${cc.drains} (${pct(cc.inCircuit, cc.drains)})`);
log(`  path stays inside that circuit: ${cc.pathInside} (${pct(cc.pathInside, cc.inCircuit)})`);
log(`  circuit holds an end point: ${cc.circuitHasEndPoint}; trace ends at that circuit's end point: ${cc.endsAtCircuitEndPoint} (${pct(cc.endsAtCircuitEndPoint, cc.circuitHasEndPoint)}), at another end point: ${cc.endsElsewhere} (${pct(cc.endsElsewhere, cc.circuitHasEndPoint)})`);

// 4. names: census place holding most of an area's drains, plus its main road
type Place = { name: string; polys: XY[][][]; city: boolean; at: XY };
const places: Place[] = [];
for (const [fc, city] of [[L.places, false], [L.cities, true]] as const) {
  for (const f of fc.features) {
    const g = f.geometry;
    const raw = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const polys = raw.map((rings) => rings.map((r) => r.map(xy)));
    if (!polys.length) continue;
    const pts = polys.flat(2);
    const at: XY = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    places.push({ name: text(f.properties.BASENAME), polys, city, at });
  }
}
const drainIdx = new GridIndex<number>(500);
traces.forEach((t, i) => drainIdx.insertPoint(i, assets[t.drain].anchor));

function placeName(box: BBox, own: number[]): string {
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(own.length / 300));
  for (let i = 0; i < own.length; i += step) {
    const p = assets[traces[own[i]].drain].anchor;
    const k = places.findIndex((pl) => pl.polys.some((rings) => pointInPolygon(p, rings)));
    if (k >= 0) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || Number(places[a[0]].city) - Number(places[b[0]].city))[0];
  if (best && best[1] >= Math.max(3, 0.15 * Math.ceil(own.length / step))) return places[best[0]].name;
  const c: XY = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  const nearest = [...places].sort((a, b) => Math.hypot(a.at[0] - c[0], a.at[1] - c[1]) - Math.hypot(b.at[0] - c[0], b.at[1] - c[1]))[0];
  return `Near ${nearest.name}`;
}

function mainRoads(box: BBox): string[] {
  const len = new Map<string, number>();
  roads.forEach((f, i) => {
    if (!inBox(roadMid[i], box)) return;
    const name = String(f.properties.road_name);
    const cls = Number(f.properties.mapClass);
    if (!name || cls < 3 || cls > 6) return;
    const g = f.geometry!;
    const coords = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : [];
    const w = cls <= 4 ? 3 : cls === 5 ? 2 : 1;
    len.set(name, (len.get(name) ?? 0) + w * polylineLength(coords.map(xy)));
  });
  return [...len.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => streetTitle(n));
}

// 5. areas: 10 km cells, split until each bundle fits
const sources: Record<string, string> = {};
for (const name of Object.keys(COUNTY_LAYERS).sort()) {
  const file = `${name}.geojson`;
  sources[`county/${file}`] = createHash('sha256').update(readFileSync(`${CACHE}/${file}`)).digest('hex').slice(0, 16);
}
for (const file of extra.files) sources[file.replace(/^\.cache\/(sources\/)?/, '')] = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const t of traces) {
  const [x, y] = assets[t.drain].anchor;
  minX = Math.min(minX, x);
  minY = Math.min(minY, y);
  maxX = Math.max(maxX, x);
  maxY = Math.max(maxY, y);
}
// grid placed so the home point sits mid quarter cell, so it stays central after one split
const home = projection.toXY(HOME);
const x0 = home[0] - START_CELL_M / 4 - Math.ceil((home[0] - START_CELL_M / 4 - minX) / START_CELL_M) * START_CELL_M;
const y0 = home[1] - START_CELL_M / 4 - Math.ceil((home[1] - START_CELL_M / 4 - minY) / START_CELL_M) * START_CELL_M;

interface Built {
  box: BBox;
  bundle: ReturnType<typeof encodeBundle>;
  json: string;
  own: number[];
  ownByClass: Record<string, number>;
}
const built: Built[] = [];
// street meters by class, through a drain or a roadside ditch
const streetM = { drain: new Map<string, number>(), ditch: new Map<string, number>() };
function buildCell(box: BBox): void {
  const own = drainIdx
    .near([(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2)
    .filter((t) => inBox(assets[traces[t].drain].anchor, box));
  if (!own.length) return;
  const slice = sliceArea(model, box, reversed, drainIdx);
  const bundle = encodeBundle(slice, sources, { credits: COUNTY_CREDITS, disclaimer: COUNTY_DISCLAIMER, displayTolM: 2 });
  const json = JSON.stringify(bundle);
  const size = box.maxX - box.minX;
  if (Buffer.byteLength(json) > MAX_BYTES && size / 2 >= MIN_CELL_M) {
    const h = size / 2;
    for (const [dx, dy] of [[0, 0], [h, 0], [0, h], [h, h]]) {
      buildCell({ minX: box.minX + dx, minY: box.minY + dy, maxX: box.minX + dx + h, maxY: box.minY + dy + h });
    }
    return;
  }
  built.push({ box, bundle, json, own, ownByClass: slice.ownByClass });
  for (const r of slice.streets.runs) {
    const by = r.drain >= slice.drainCount ? streetM.ditch : streetM.drain;
    by.set(r.cls, (by.get(r.cls) ?? 0) + r.lengthM);
  }
}
for (let x = x0; x <= maxX; x += START_CELL_M) {
  for (let y = y0; y <= maxY; y += START_CELL_M) {
    buildCell({ minX: x, minY: y, maxX: x + START_CELL_M, maxY: y + START_CELL_M });
  }
}

// 6. names and files
const used = new Set<string>();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const index: { id: string; name: string; bbox: [number, number, number, number]; drains: number; byClass: Record<string, number>; bytes: number }[] = [];
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const b of built.sort((p, q) => q.box.maxY - p.box.maxY || p.box.minX - q.box.minX)) {
  const place = placeName(b.box, b.own);
  let name = place;
  for (const road of mainRoads(b.box)) {
    if (!used.has(`${place} / ${road}`)) {
      name = `${place} / ${road}`;
      break;
    }
  }
  for (let k = 2; used.has(name); k++) name = `${place} (${k})`;
  used.add(name);
  const id = slug(name);
  writeFileSync(`${OUT}/${id}.json`, b.json);
  const [w, sLat] = projection.toLngLat([b.box.minX, b.box.minY]);
  const [e, n] = projection.toLngLat([b.box.maxX, b.box.maxY]);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  index.push({ id, name, bbox: [r6(w), r6(sLat), r6(e), r6(n)], drains: b.own.length, byClass: b.ownByClass, bytes: Buffer.byteLength(b.json) });
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
log(`\nWrote ${index.length} areas to ${OUT}/ (largest ${kb(Math.max(...index.map((a) => a.bytes)))}, total ${kb(index.reduce((t, a) => t + a.bytes, 0))})`);
const kmOf = (m: Map<string, number>, c: string) => ((m.get(c) ?? 0) / 1000).toFixed(1);
log(`  street km by class: ${STREET_CLASSES.map((c) => `${c} ${kmOf(streetM.drain, c)}${streetM.ditch.has(c) ? ` + ${kmOf(streetM.ditch, c)} by roadside ditch` : ''}`).join(', ')}`);
for (const a of [...index].sort((p, q) => q.drains - p.drains).slice(0, 12)) {
  const gz = gzipSync(readFileSync(`${OUT}/${a.id}.json`)).length;
  log(`  ${a.name}: ${a.drains} drains (${DRAIN_CLASSES.map((c) => `${c} ${a.byClass[c]}`).join(', ')}), ${kb(a.bytes)} (${kb(gz)} gzipped)`);
}
log(`  built in ${Math.round((performance.now() - started) / 1000)} s`);

// search's street-name list lived in the folder this build clears; the yellow coverage and the overview follow the areas
await import('./area-names.ts');
await import('./build-coverage.ts');
await import('./build-overview.ts');
