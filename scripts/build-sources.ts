// npm run build:sources -- seattle: traces a city source (scripts/sources/<key>.ts) by its keys and adds its areas
// to public/data/areas (other areas stay). Run after build:county, which clears the folder.
// Inputs: <cache>/sources/<key>/assets.ndjson + meta.json, and the King context (streets, waters, coho).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { encodeBundle } from '../src/data/encode.ts';
import { GridIndex, localProjection, pointInPolygon, polylineLength, type BBox, type LngLat, type XY } from '../src/geo/geo.ts';
import { inBox, sliceArea, type CountyModel } from '../src/county/area.ts';
import type { Graph } from '../src/county/graph.ts';
import type { SourceAsset, SourceMeta } from '../src/county/source.ts';
import { SOURCES } from '../src/county/sources/config.ts';
import { decide, finishBundle, NAMED_COHO_M, waterKey } from '../src/county/sources/decide.ts';
import { KeyGraph, toCountyAssets, toTrace } from '../src/county/sources/walk.ts';
import { cohoStatus, CountyWaters, swifdName, type ExtraWater } from '../src/county/waters.ts';
import { streetTitle } from '../src/trace/fixlist.ts';
import type { Feature, FeatureCollection } from '../src/trace/geojson.ts';

const CACHE = process.env.TT_CACHE ?? '.cache';
const OUT = 'public/data/areas';
const MAX_BYTES = 1.5e6;
const START_CELL_M = 8000;
const MIN_CELL_M = 1000;
/** context waters and coho this far past the city */
const PAD_DEG = 0.03;

const key = process.argv[2];
const found = SOURCES.find((s) => s.key === key);
if (!found) throw new Error(`usage: node scripts/build-sources.ts <${SOURCES.map((s) => s.key).join('|')}>`);
const cfg = found;
const started = performance.now();
const log = (s: string) => console.log(s);
const dir = `${CACHE}/sources/${cfg.key}`;
const ndjson = <T>(file: string): T[] => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) as SourceMeta;
const src = ndjson<SourceAsset>(`${dir}/assets.ndjson`);
const P = localProjection(cfg.origin);
const boundary = meta.boundary.map((poly) => poly.map((r) => r.map((c) => P.toXY(c))));
const inCity = (p: XY) => boundary.some((rings) => pointInPolygon(p, rings));
let [w0, s0, e0, n0] = [Infinity, Infinity, -Infinity, -Infinity];
for (const c of meta.boundary.flat(2)) [w0, s0, e0, n0] = [Math.min(w0, c[0]), Math.min(s0, c[1]), Math.max(e0, c[0]), Math.max(n0, c[1])];
const near = (pts: readonly number[][]) => pts.some((c) => c[0] >= w0 - PAD_DEG && c[0] <= e0 + PAD_DEG && c[1] >= s0 - PAD_DEG && c[1] <= n0 + PAD_DEG);
log(`${meta.name}: ${src.length} assets`);

// 1. waters: King County streams and lakes as the County layers, NHD and the Sound as extras, WDFW coho reaches
type Ctx = { src: string; kind: string; type?: string; name?: string; coords?: number[][]; polygons?: number[][][][]; covered?: boolean };
const ctxDir = `${CACHE}/sources/context`;
const lines: Feature[] = [], bodies: Feature[] = [], extra: ExtraWater[] = [];
for (const o of ndjson<Ctx>(`${ctxDir}/${cfg.waters}`)) {
  const pts = o.coords ?? o.polygons?.flat(2) ?? [];
  if (!pts.length || !near(pts)) continue;
  const marine = o.kind === 'marine' || o.kind === 'coastline' || o.type === 'BayInlet';
  if (marine) {
    if (o.covered) continue;
    extra.push({ kind: 'marine', name: 'Puget Sound', ...(o.coords ? { lines: [o.coords] } : { polygons: o.polygons }), covered: false });
  } else if (o.src === 'nhd') {
    if (o.covered) continue;
    const kind = o.kind === 'wetland' ? 'wetland' : o.kind === 'lake' ? 'lake' : o.kind === 'stream' || o.kind === 'river' ? 'stream' : null;
    if (kind) extra.push({ kind, name: o.name ?? '', ...(o.coords ? { lines: [o.coords] } : { polygons: o.polygons }), covered: false });
  } else if (o.coords && (o.kind === 'stream' || o.kind === 'river')) {
    lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: o.coords }, properties: { FeatureName: o.name ?? '', FeatureType: 'Stream', StreamTypeNPDES: '' } });
  } else if (o.polygons && (o.kind === 'lake' || o.kind === 'river' || o.kind === 'pond')) {
    bodies.push({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: o.polygons }, properties: { FeatureName: o.name ?? '' } });
  }
}
const coho: Feature[] = [];
const cohoByName = new Map<string, XY[]>();
for (const o of ndjson<{ name: string; dist: string; coords: number[][] }>(`${ctxDir}/coho.ndjson`)) {
  if (!near(o.coords)) continue;
  coho.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: o.coords }, properties: { LLID_STRM_NAME: o.name, DISTTYPE_DESC: o.dist } });
  const name = waterKey(swifdName(o.name));
  if (name && cohoStatus(o.dist) === 'documented') cohoByName.set(name, [...(cohoByName.get(name) ?? []), ...o.coords.map((c) => P.toXY(c as LngLat))]);
}
const cohoNamed = (name: string, p: XY) => (cohoByName.get(waterKey(name)) ?? []).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= NAMED_COHO_M);
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const waters = new CountyWaters({ swifdCoho: fc(coho), hydroCenterlines: fc(lines), hydroWaterbodies: fc(bodies) }, P, { extra });
log(`  waters: ${coho.length} coho reaches, ${lines.length} streams, ${bodies.length} lakes, ${extra.length} extra`);

// 2. walk every drain inside the city by its keys
const graph = new KeyGraph(src, P);
const every = toCountyAssets(src, P);
const drains = src.map((s, i) => i).filter((i) => src[i].role === 'drain' && inCity(graph.xy[i][0]));
const traces = drains.map((d) => {
  const r = graph.walk(d);
  return toTrace(r, decide(r, src, graph.xy, waters, cfg, cohoNamed));
});
const count = (f: (t: (typeof traces)[number]) => string) => {
  const m = new Map<string, number>();
  for (const t of traces) m.set(f(t), (m.get(f(t)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v} (${((100 * v) / traces.length).toFixed(1)}%)`).join(', ');
};
log(`Traced ${traces.length} drains in ${Math.round(performance.now() - started)} ms`);
log(`  classes: ${count((t) => (t.sewer ? 'treatment' : t.ending.cls))}`);
log(`  endings: ${count((t) => t.ending.code)}`);
log(`  confidence: ${count((t) => t.confidence)}`);
// check: the water the source records for a drain (its basin) against the water its walk reaches.
// A creek inside that basin agrees; another basin's water doesn't.
const same = (a: string, b: string) => waterKey(a.replace(/\s*\/\s*/g, ', then ')) === waterKey(b);
const basin = new Set(src.filter((s) => s.role === 'drain' && s.receivingHint).map((s) => waterKey(s.receivingHint!.replace(/\s*\/\s*/g, ', then '))));
let recorded = 0, agree = 0, creekIn = 0;
const miss = new Map<string, number>();
traces.forEach((t, i) => {
  const rec = src[drains[i]].receivingHint;
  if (!rec || t.sewer || (t.ending.cls !== 'creek' && t.ending.cls !== 'elsewhere')) return;
  recorded++;
  if (same(rec, t.ending.receiving)) agree++;
  else if (!basin.has(waterKey(t.ending.receiving))) creekIn++;
  else miss.set(`${rec} -> ${t.ending.receiving}`, (miss.get(`${rec} -> ${t.ending.receiving}`) ?? 0) + 1);
});
const pc = (n: number) => `${((100 * n) / Math.max(1, recorded)).toFixed(1)}%`;
log(`  drains with a recorded water that the walk takes to water: ${recorded}; same water ${pc(agree)}, a smaller water in it ${pc(creekIn)}, another basin ${pc(recorded - agree - creekIn)}`);
if (process.env.TT_DEBUG) log([...miss].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `    ${v} ${k}`).join('\n'));

// only what drains walk: sewer trunks past where street water enters, and pipes no drain uses, stay out
const keepIdx = [...new Set(traces.flatMap((t) => [...t.path, t.ending.terminal]))].sort((a, b) => a - b);
const remap = new Map(keepIdx.map((k, i) => [k, i]));
const assets = keepIdx.map((k, i) => ({ ...every[k], index: i }));
for (const t of traces) {
  t.path = t.path.map((k) => remap.get(k)!);
  t.drain = t.path[0];
  t.ending.terminal = t.ending.exit = remap.get(t.ending.terminal)!;
}
log(`  assets kept: ${assets.length} of ${every.length}`);

// 3. streets: the city's own; no freeways or ramps (state drainage, not the city's map), no alleys (keeps the overview light)
const roads: Feature[] = [];
const roadMid: XY[] = [];
const ROAD_CLASS: Record<string, number> = { arterial: 4, collector: 5, local: 6 };
for (const o of ndjson<{ name: string; class: string; jurisdiction: string; coords: number[][] }>(`${ctxDir}/${cfg.streets}`)) {
  if (o.jurisdiction !== cfg.jurisdiction || !(o.class in ROAD_CLASS) || o.coords.length < 2) continue;
  const line = o.coords.map((c) => P.toXY(c as LngLat));
  roads.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: o.coords }, properties: { id: roads.length + 1, road_name: o.name, receiving_creek: '', mapClass: ROAD_CLASS[o.class] } });
  roadMid.push(midpoint(line));
}
log(`  streets: ${roads.length}`);

function midpoint(line: XY[]): XY {
  const half = polylineLength(line) / 2;
  let walked = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (walked + seg >= half) {
      const t = seg ? (half - walked) / seg : 0;
      return [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])];
    }
    walked += seg;
  }
  return line[0];
}

// 4. areas: cells split until each bundle fits; lines are already in flow order, and there are no bridged gaps
const noGraph = { nodeOf: [], edges: [], nodes: [], adj: [], lineEnds: new Map() } as unknown as Graph;
const model: CountyModel = { assets, graph: noGraph, traces, traceEdges: traces.map(() => []), waters, roads, roadMid, projection: P };
const drainIdx = new GridIndex<number>(500);
traces.forEach((t, i) => drainIdx.insertPoint(i, assets[t.drain].anchor));
const sources: Record<string, string> = {};
for (const f of [`${dir}/assets.ndjson`, `${ctxDir}/${cfg.streets}`, `${ctxDir}/${cfg.waters}`, `${ctxDir}/coho.ndjson`]) {
  sources[f.replace(/^.*\/sources\//, '')] = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
}
interface Built { box: BBox; json: string; own: number; byClass: Record<string, number> }
const built: Built[] = [];
function buildCell(box: BBox): void {
  const own = drainIdx.near([(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2).filter((t) => inBox(assets[traces[t].drain].anchor, box));
  if (!own.length) return;
  const slice = sliceArea(model, box, new Set(), drainIdx);
  const bundle = encodeBundle(slice, sources, { credits: cfg.credits, disclaimer: cfg.disclaimer, displayTolM: 2 });
  const byClass = finishBundle(bundle, slice.ownByClass, own.filter((t) => traces[t].sewer).length);
  const json = JSON.stringify(bundle);
  const size = box.maxX - box.minX;
  if (Buffer.byteLength(json) > MAX_BYTES && size / 2 >= MIN_CELL_M) {
    const h = size / 2;
    for (const [dx, dy] of [[0, 0], [h, 0], [0, h], [h, h]]) buildCell({ minX: box.minX + dx, minY: box.minY + dy, maxX: box.minX + dx + h, maxY: box.minY + dy + h });
    return;
  }
  built.push({ box, json, own: own.length, byClass });
}
let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
for (const t of traces) {
  const [x, y] = assets[t.drain].anchor;
  [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
}
for (let x = x0; x <= x1; x += START_CELL_M) for (let y = y0; y <= y1; y += START_CELL_M) buildCell({ minX: x, minY: y, maxX: x + START_CELL_M, maxY: y + START_CELL_M });

// 5. names ("Seattle / Aurora Ave N"), files, and the shared index
function mainRoads(box: BBox): string[] {
  const len = new Map<string, number>();
  roads.forEach((f, i) => {
    const name = String(f.properties.road_name);
    const cls = Number(f.properties.mapClass);
    if (!name || cls > 6 || !inBox(roadMid[i], box)) return;
    const g = f.geometry as { coordinates: number[][] };
    len.set(name, (len.get(name) ?? 0) + (cls === 4 ? 3 : cls === 5 ? 2 : 1) * polylineLength(g.coordinates.map((c) => P.toXY(c as LngLat))));
  });
  return [...len].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => streetTitle(n));
}
type Entry = { id: string; name: string; bbox: [number, number, number, number]; drains: number; byClass: Record<string, number>; bytes: number };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mine = (id: string) => id === cfg.key || id.startsWith(`${cfg.key}-`);
const old: Entry[] = existsSync(`${OUT}/index.json`) ? JSON.parse(readFileSync(`${OUT}/index.json`, 'utf8')) : [];
for (const a of old) if (mine(a.id)) rmSync(`${OUT}/${a.id}.json`, { force: true });
const index = old.filter((a) => !mine(a.id));
const used = new Set(index.map((a) => a.name));
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
for (const b of built.sort((p, q) => q.box.maxY - p.box.maxY || p.box.minX - q.box.minX)) {
  let name = cfg.place;
  for (const road of mainRoads(b.box)) {
    if (!used.has(`${cfg.place} / ${road}`)) {
      name = `${cfg.place} / ${road}`;
      break;
    }
  }
  for (let k = 2; used.has(name); k++) name = `${cfg.place} (${k})`;
  used.add(name);
  const id = slug(name).startsWith(`${cfg.key}-`) || slug(name) === cfg.key ? slug(name) : `${cfg.key}-${slug(name)}`;
  writeFileSync(`${OUT}/${id}.json`, b.json);
  const [w, s] = P.toLngLat([b.box.minX, b.box.minY]);
  const [e, n] = P.toLngLat([b.box.maxX, b.box.maxY]);
  index.push({ id, name, bbox: [r6(w), r6(s), r6(e), r6(n)], drains: b.own, byClass: b.byClass, bytes: Buffer.byteLength(b.json) });
}
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
const added = index.filter((a) => mine(a.id));
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
log(`\nWrote ${added.length} ${cfg.place} areas (${added.reduce((t, a) => t + a.drains, 0)} drains, largest ${kb(Math.max(...added.map((a) => a.bytes)))}, total ${kb(added.reduce((t, a) => t + a.bytes, 0))})`);
log(`  built in ${Math.round((performance.now() - started) / 1000)} s`);

await import('./area-names.ts');
await import('./build-coverage.ts');
await import('./build-overview.ts');

