// npm run build:sources [keys]: traces the city and county maps the adapters in scripts/sources wrote to
// .cache/sources/<key>/ (assets.ndjson + meta.json) and adds their areas to public/data/areas, beside the
// Pierce County ones from build:county. Each source is clipped to its own boundary and traced alone.
// Streets, waters and coho reaches come from .cache/sources/context (scripts/sources/context.ts).
// Sources traced by their own pipe keys (Seattle, src/county/sources/config.ts) go through build-keyed.ts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { encodeBundle } from '../src/data/encode.ts';
import { flowDirections, inBox, sliceArea, type CountyModel } from '../src/county/area.ts';
import type { CountyAsset, CountyLayer } from '../src/county/assets.ts';
import { buildGraph } from '../src/county/graph.ts';
import type { Role, SourceAsset, SourceMeta } from '../src/county/source.ts';
import { classifyCountyStreets, IntakeFinder } from '../src/county/streets.ts';
import { SOURCES } from '../src/county/sources/config.ts';
import { CountyTracer } from '../src/county/trace.ts';
import { CountyWaters, type ExtraWater } from '../src/county/waters.ts';
import { bboxOf, dist, GridIndex, localProjection, pointInPolygon, polygonsCentroid, polylineLength, type BBox, type Projection, type XY } from '../src/geo/geo.ts';
import { streetTitle } from '../src/trace/fixlist.ts';
import type { Feature, FeatureCollection } from '../src/trace/geojson.ts';
import { DRAIN_CLASSES } from '../src/trace/trace.ts';
import type { AreaInfo } from '../src/app/areas.ts';

/** Sources traced by the County tracer. */
export const SOURCE_KEYS = ['tacoma', 'puyallup', 'sumner', 'auburn', 'bellevue', 'renton', 'kc-ms4'];
/** Sources traced by their keys. */
export const KEYED_KEYS = SOURCES.map((s) => s.key);
/** TT_CACHE: another checkout's .cache */
const CACHE = process.env.TT_CACHE ?? '.cache';
const SRC = `${CACHE}/sources`;
const CTX = `${SRC}/context`;
const OUT = 'public/data/areas';
const MAX_BYTES = 1.2e6;
const START_CELL_M = 10_000;
const MIN_CELL_M = 1250;
/** a line end this close to the node its key names moves onto it */
const KEY_SNAP_M = 30;
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023/Places_CouSub_ConCity_SubMCD/MapServer';

const log = (s: string) => console.log(s);
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const ndjson = <T>(f: string): T[] => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;

/** "City of Tacoma" -> "Tacoma"; the unincorporated county keeps its place names */
export const cityName = (m: Pick<SourceMeta, 'name'>): string => m.name.replace(/^City of /, '').replace(/\s*\(.*\)$/, '');
export const isCounty = (m: Pick<SourceMeta, 'key'>): boolean => m.key === 'kc-ms4';

// role -> the County layer shape the tracer reads
const AS: Record<Role, { layer: CountyLayer; kind: CountyAsset['kind']; type: string }> = {
  drain: { layer: 'drain', kind: 'structure', type: 'Catch Basin - Type1' },
  junction: { layer: 'network', kind: 'vault', type: 'Manhole' },
  outfall: { layer: 'endpoint', kind: 'outlet', type: 'Outfall' },
  discharge: { layer: 'endpoint', kind: 'outlet', type: 'Discharge Point' },
  'facility-hold': { layer: 'facility', kind: 'pond', type: 'Detention Cell' },
  'facility-infiltrate': { layer: 'facility', kind: 'pond', type: 'Infiltration Cell' },
  pipe: { layer: 'pipe', kind: 'pipe', type: 'Storm Main' },
  culvert: { layer: 'pipe', kind: 'pipe', type: 'Culvert' },
  'stream-culvert': { layer: 'pipe', kind: 'pipe', type: 'Culvert' },
  ditch: { layer: 'channel', kind: 'channel', type: 'Man-made' },
  stream: { layer: 'channel', kind: 'channel', type: 'Natural' },
  virtual: { layer: 'virtual', kind: 'pipe', type: 'Virtual Drainline' },
};

/** The type an end point's hint means: water (outfall), ground (soaks in), a handoff (the map just ends). */
function endType(a: SourceAsset): string {
  const h = String(a.endHint);
  if (h === 'ground') return 'NPDES_Discharge';
  return h === 'water' ? 'Outfall' : 'End Point';
}

/** Adapter records -> County assets in local meters. Line ends move onto the node their key names. */
export function toCountyAssets(src: readonly SourceAsset[], P: Projection): { assets: CountyAsset[]; keyed: number; snapped: number } {
  const assets: CountyAsset[] = [];
  const at = new Map<string, XY>();
  let keyed = 0, snapped = 0;
  for (const s of src) {
    const spec = AS[s.role];
    if (!spec || !s.coords?.length) continue;
    const pts = s.coords.map((c) => P.toXY([c[0], c[1]]));
    let layer = spec.layer, kind = spec.kind, type = spec.type;
    let anchor: XY = pts[0], line: XY[] | undefined, polygons: XY[][][] | undefined;
    if (layer === 'facility') {
      if (pts.length >= 3) [polygons, anchor] = [[[pts]], polygonsCentroid([[pts]])];
      // a facility drawn as a point is a vault
      else [layer, kind, type] = ['network', 'vault', s.role === 'facility-infiltrate' ? 'Infiltration Vault' : 'Detention Vault'];
    } else if (layer === 'endpoint') {
      // an outlet into a pond, ditch or swale: the walk goes on if the map does
      if (String(s.endHint ?? 'unknown') === 'unknown') [layer, kind] = ['outlet', 'outlet'];
      else type = endType(s);
    }
    if (['pipe', 'channel', 'virtual'].includes(layer)) {
      if (pts.length < 2) continue;
      line = pts;
    }
    if (!line && s.key) at.set(s.key, anchor);
    const owner = s.owner === 'private' ? 'Private' : s.owner === 'public' ? 'Public' : s.owner ? 'Other' : '';
    assets.push({
      index: assets.length, id: s.id, key: `${s.src}:${s.id}#${assets.length}`, kind, layer, type, anchor, line, polygons,
      lengthM: line ? polylineLength(line) : 0, width: s.width ?? 0, perforated: !!s.perforated, gallery: false,
      bottom: s.openBottom ? 'Open' : '', fromId: s.fromId ?? '', toId: s.toId ?? '', toType: '', owner, liveStream: s.role === 'stream-culvert' || !!s.liveStream,
    });
  }
  for (const a of assets) {
    if (!a.line) continue;
    for (const [id, end] of [[a.fromId, 0], [a.toId, a.line.length - 1]] as const) {
      const p = id ? at.get(id) : undefined;
      if (!p) continue;
      keyed++;
      if (dist(p, a.line[end]) <= KEY_SNAP_M) {
        a.line[end] = p;
        snapped++;
      }
    }
    if (a.lengthM) a.lengthM = polylineLength(a.line);
    a.anchor = a.line[0];
  }
  return { assets, keyed, snapped };
}

/** Context streets: map class like the Pierce roads layer (3-6 name an area; 7 and 9 are ferries there). */
const STREET_CLASS: Record<string, number> = { freeway: 1, ramp: 2, highway: 3, arterial: 4, collector: 6, local: 8, service: 8, alley: 8 };
export function streetClass(r: { class?: string; fc?: string | number }): number {
  if (typeof r.fc === 'number') return r.fc;
  if (/^M\//.test(String(r.fc ?? ''))) return 5;
  return STREET_CLASS[String(r.class)] ?? 8;
}

interface CtxWater { src: string; kind: string; type?: string; name?: string; npdes?: string; coords?: number[][]; polygons?: number[][][][]; covered?: boolean }

/** Context waters near a box -> the County hydro layers' shape plus extra waters. */
function watersFor(county: 'King' | 'Pierce', near: (c: number[]) => boolean): { layers: { swifdCoho: FeatureCollection; hydroCenterlines: FeatureCollection; hydroWaterbodies: FeatureCollection }; extra: ExtraWater[] } {
  const own = county === 'King' ? 'kc' : 'pierce';
  const lines: Feature[] = [], bodies: Feature[] = [], coho: Feature[] = [];
  const extra: ExtraWater[] = [];
  const first = (w: CtxWater) => w.coords?.[0] ?? w.polygons?.[0]?.[0]?.[0];
  for (const w of ndjson<CtxWater>(`${CTX}/waters-${county.toLowerCase()}.ndjson`)) {
    const c = first(w);
    if (!c || !near(c) || w.covered) continue;
    const marine = w.kind === 'marine' || w.kind === 'coastline' || w.type === 'BayInlet';
    if (marine) {
      extra.push({ kind: 'marine', name: 'Puget Sound', ...(w.coords ? { lines: [w.coords] } : { polygons: w.polygons }), covered: false });
    } else if (w.src === own) {
      const name = w.name ?? '';
      if (w.coords) {
        const type = w.kind === 'river' ? 'River' : w.kind === 'culvert' ? 'Culvert' : w.kind === 'stream' ? 'Stream' : 'Ditch';
        lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: w.coords }, properties: { FeatureName: name, FeatureType: type, StreamTypeNPDES: w.npdes ?? '' } });
      } else if (w.polygons && ['lake', 'pond', 'river'].includes(w.kind)) {
        bodies.push({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: w.polygons }, properties: { FeatureName: name } });
      }
    } else if (w.src === 'nhd') {
      const kind = w.kind === 'wetland' ? 'wetland' : w.kind === 'lake' ? 'lake' : w.kind === 'stream' || w.kind === 'river' ? 'stream' : null;
      if (kind) extra.push({ kind, name: w.name ?? '', ...(w.coords ? { lines: [w.coords] } : { polygons: w.polygons }), covered: false });
    }
  }
  for (const r of ndjson<{ name: string; dist: string; coords: number[][] }>(`${CTX}/coho.ndjson`)) {
    if (!r.coords?.length || !near(r.coords[0])) continue;
    coho.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { LLID_STRM_NAME: r.name, DISTTYPE_DESC: r.dist } });
  }
  const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  return { layers: { swifdCoho: fc(coho), hydroCenterlines: fc(lines), hydroWaterbodies: fc(bodies) }, extra };
}

/** Census place outlines in a lon/lat box (for unincorporated area names), cached. */
async function placesIn(key: string, box: number[]): Promise<{ name: string; rings: number[][][][] }[]> {
  const file = `${CACHE}/pipeline/raw/places-${key}.geojson`;
  if (!existsSync(file)) {
    const q = new URLSearchParams({ where: "STATE='53'", geometry: box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'BASENAME', outSR: '4326', f: 'geojson' });
    const feats: Feature[] = [];
    for (const layer of [11, 10]) {
      const res = await fetch(`${TIGER}/${layer}/query?${q}`);
      if (!res.ok) throw new Error(`TIGER ${layer}: HTTP ${res.status}`);
      feats.push(...((await res.json()) as FeatureCollection).features);
    }
    mkdirSync(`${CACHE}/pipeline/raw`, { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: feats }));
  }
  return (read(file) as FeatureCollection).features.flatMap((f) => {
    const g = f.geometry;
    const rings = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    return rings.length ? [{ name: String(f.properties.BASENAME), rings }] : [];
  });
}

interface Built { box: BBox; json: string; own: number[]; ownByClass: Record<string, number>; name: string }

/** One source: trace, cut into areas, return them unnamed by id. */
async function buildSource(key: string): Promise<{ meta: SourceMeta; built: Built[]; P: Projection; report: Record<string, unknown> }> {
  const started = performance.now();
  const meta = read(`${SRC}/${key}/meta.json`) as SourceMeta;
  const raw = ndjson<SourceAsset>(`${SRC}/${key}/assets.ndjson`);
  const bnd = meta.boundary.flat(2);
  const bb = [Math.min(...bnd.map((c) => c[0])), Math.min(...bnd.map((c) => c[1])), Math.max(...bnd.map((c) => c[0])), Math.max(...bnd.map((c) => c[1]))];
  const P = localProjection([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]);
  const xy = (c: number[]): XY => P.toXY([c[0], c[1]]);
  const boundary = meta.boundary.map((poly) => poly.map((r) => r.map(xy)));
  const inside = (p: XY) => boundary.some((rings) => pointInPolygon(p, rings));
  // clip: a point inside, or a line with a vertex inside
  const kept = raw.filter((a) => a.coords?.length && (a.coords.length === 1 || a.role.startsWith('facility') ? inside(xy(a.coords[0])) : a.coords.some((c) => inside(xy(c)))));
  const { assets, keyed, snapped } = toCountyAssets(kept, P);
  const graph = buildGraph(assets);
  const pad = 0.05;
  const near = (c: number[]) => c[0] >= bb[0] - pad && c[0] <= bb[2] + pad && c[1] >= bb[1] - pad && c[1] <= bb[3] + pad;
  const W = watersFor(meta.county, near);
  const stormPonds = assets.filter((a) => a.kind === 'pond' && a.polygons).map((a) => a.polygons!);
  const waters = new CountyWaters(W.layers, P, { extra: W.extra, stormPonds });
  const tracer = new CountyTracer(assets, graph, waters);
  const traced = tracer.traceAll();
  const { traces } = traced;
  // the city's own map, not the County's
  if (!isCounty(meta)) for (const t of traces) t.ending.reason = t.ending.reason.replace(/County's map/g, "city's map");

  // streets of this city (or unincorporated county), from both counties' road files, once each
  const juris = isCounty(meta) ? `Unincorporated ${meta.county} County` : cityName(meta);
  const roads: Feature[] = [], roadMid: XY[] = [];
  const seen = new Set<string>();
  for (const file of ['streets-pierce', 'streets-king']) {
    for (const r of ndjson<{ id: string; name: string; class: string; fc: string | number; jurisdiction: string; coords: number[][] }>(`${CTX}/${file}.ndjson`)) {
      if (r.jurisdiction !== juris || seen.has(r.id) || r.coords.length < 2) continue;
      seen.add(r.id);
      const line = r.coords.map(xy);
      roads.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { id: roads.length + 1, road_name: r.name ?? '', receiving_creek: '', mapClass: streetClass(r) } });
      roadMid.push(line[line.length >> 1]);
    }
  }
  const finder = new IntakeFinder(assets, traces.map((t) => assets[t.drain].anchor));
  const ditchSet = new Set<number>();
  classifyCountyStreets({ type: 'FeatureCollection', features: roads }, [], () => 'none', P, (line, along, length) => {
    const d = finder.at(line, along, length);
    if (d >= 0) ditchSet.add(d);
    return -1;
  });
  const ditches = [...ditchSet].sort((a, b) => a - b);
  const intakeTraced = tracer.traceIntakes(ditches);
  if (!isCounty(meta)) for (const t of intakeTraced.traces) t.ending.reason = t.ending.reason.replace(/County's map/g, "city's map");
  const byChannel = new Map(ditches.map((d, i) => [d, { trace: intakeTraced.traces[i], edges: intakeTraced.traceEdges[i] }]));
  const model: CountyModel = { assets, graph, traces, traceEdges: traced.traceEdges, waters, roads, roadMid, projection: P, intakes: { finder, byChannel } };
  const reversed = flowDirections(model);

  // names: the city, or the census place holding most of an area's drains
  const places = isCounty(meta)
    ? (await placesIn(key, bb)).map((p) => ({ name: p.name, polys: p.rings.map((rings) => rings.map((r) => r.map(xy))) }))
    : [];
  const placeName = (own: number[]): string => {
    if (!places.length) return cityName(meta);
    const counts = new Map<string, number>();
    const step = Math.max(1, Math.floor(own.length / 300));
    for (let i = 0; i < own.length; i += step) {
      const p = assets[traces[own[i]].drain].anchor;
      const hit = places.find((pl) => pl.polys.some((rings) => pointInPolygon(p, rings)));
      if (hit) counts.set(hit.name, (counts.get(hit.name) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= Math.max(3, 0.15 * Math.ceil(own.length / step))) return best[0];
    // else the nearest place, as the Pierce County areas do
    const xs = own.map((t) => assets[traces[t].drain].anchor), c: XY = [xs.reduce((a, p) => a + p[0], 0) / xs.length, xs.reduce((a, p) => a + p[1], 0) / xs.length];
    const d = (pl: (typeof places)[number]) => Math.min(...pl.polys.flat(2).filter((_, i) => i % 8 === 0).map((p) => dist(p, c)));
    return `Near ${places.reduce((a, b) => (d(b) < d(a) ? b : a)).name}`;
  };

  // areas: 10 km cells, split until each file fits
  const drainIdx = new GridIndex<number>(500);
  traces.forEach((t, i) => drainIdx.insertPoint(i, assets[t.drain].anchor));
  const sources: Record<string, string> = {};
  for (const f of [`${key}/assets.ndjson`, `${key}/meta.json`, 'context/coho.ndjson', `context/waters-${meta.county.toLowerCase()}.ndjson`]) {
    sources[f] = createHash('sha256').update(readFileSync(`${SRC}/${f}`)).digest('hex').slice(0, 16);
  }
  const credits = [meta.credit.replace(/^Storm drain data: /, '').replace(/\.$/, ''), 'WDFW SWIFD (coho distribution)', 'USGS NHD (streams, lakes, wetlands and shoreline, via Washington State Department of Ecology)', `${meta.county} County GIS (roads and streams)`];
  const who = isCounty(meta) ? `${meta.county} County` : `the City of ${cityName(meta)}`;
  const disclaimer = `Independent student project. Not made, reviewed or endorsed by ${who}, UW or WDFW. Map data is provided as is, without warranty of any kind. Planning-level estimates.`;
  const box0 = bboxOf(traces.map((t) => assets[t.drain].anchor));
  const built: Built[] = [];
  const buildCell = (box: BBox): void => {
    const own = drainIdx.near([(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2).filter((t) => inBox(assets[traces[t].drain].anchor, box));
    if (!own.length) return;
    const slice = sliceArea(model, box, reversed, drainIdx);
    const json = JSON.stringify(encodeBundle(slice, sources, { credits, disclaimer, displayTolM: 2 }));
    const size = box.maxX - box.minX;
    if (Buffer.byteLength(json) > MAX_BYTES && size / 2 >= MIN_CELL_M) {
      const h = size / 2;
      for (const [dx, dy] of [[0, 0], [h, 0], [0, h], [h, h]]) buildCell({ minX: box.minX + dx, minY: box.minY + dy, maxX: box.minX + dx + h, maxY: box.minY + dy + h });
      return;
    }
    built.push({ box, json, own, ownByClass: slice.ownByClass, name: placeName(own) });
  };
  for (let x = box0.minX; x <= box0.maxX; x += START_CELL_M) for (let y = box0.minY; y <= box0.maxY; y += START_CELL_M) buildCell({ minX: x, minY: y, maxX: x + START_CELL_M, maxY: y + START_CELL_M });
  // main roads for names (Pierce map classes 3 to 6, wider weighs more)
  const mainRoads = (box: BBox): string[] => {
    const len = new Map<string, number>();
    roads.forEach((f, i) => {
      const cls = Number(f.properties.mapClass), name = String(f.properties.road_name);
      if (!name || cls < 3 || cls > 6 || !inBox(roadMid[i], box)) return;
      const g = f.geometry as { coordinates: number[][] };
      len.set(name, (len.get(name) ?? 0) + (cls <= 4 ? 3 : cls === 5 ? 2 : 1) * polylineLength(g.coordinates.map(xy)));
    });
    return [...len].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => streetTitle(n));
  };
  for (const b of built) (b as Built & { roads: string[] }).roads = mainRoads(b.box);

  const byClass = Object.fromEntries(DRAIN_CLASSES.map((c) => [c, traces.filter((t) => t.ending.cls === c).length]));
  const codes = new Map<string, number>();
  for (const t of traces) codes.set(t.ending.code, (codes.get(t.ending.code) ?? 0) + 1);
  const report = {
    key, name: meta.name, assets: assets.length, clipped: raw.length - kept.length, drains: traces.length, keyed, snapped,
    nodes: graph.stats.nodes, pieces: graph.stats.components, endsJoined: graph.stats.endsJoined, endsLoose: graph.stats.endsLoose,
    byClass, codes: Object.fromEntries([...codes].sort((a, b) => b[1] - a[1])),
    samples: Object.fromEntries([...codes.keys()].map((c) => [c, traces.filter((t) => t.ending.code === c).filter((_, i) => i % 97 === 0).slice(0, 4).map((t) => t.ending.reason)])), ditches: ditches.length, roads: roads.length,
    areas: built.length, bytes: built.reduce((n, b) => n + b.json.length, 0), s: Math.round((performance.now() - started) / 1000),
  };
  log(`${meta.name}: ${traces.length} drains (${DRAIN_CLASSES.map((c) => `${c} ${byClass[c]} ${pct(byClass[c], traces.length)}`).join(', ')})`);
  log(`  assets ${assets.length} (${report.clipped} outside the boundary), line keys ${keyed}, snapped ${snapped}; graph ${graph.stats.nodes} nodes, ${graph.stats.components} pieces, ends joined ${graph.stats.endsJoined}, loose ${graph.stats.endsLoose}`);
  log(`  endings: ${[...codes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`  streets ${roads.length}, roadside ditches ${ditches.length}; ${built.length} areas, ${Math.round(report.bytes / 1024)} KB, ${report.s} s`);
  return { meta, built, P, report };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Index entries carry their source; the Pierce County ones from build:county carry none. */
export type SourceArea = AreaInfo;

/** Builds the listed sources (all by default) into the area folder; after: names, coverage and overview too. */
export async function buildSources(keys: string[], after = true): Promise<void> {
  const all = keys.length ? keys : [...SOURCE_KEYS, ...KEYED_KEYS];
  const todo = all.filter((k) => !KEYED_KEYS.includes(k));
  const keyed = all.filter((k) => KEYED_KEYS.includes(k));
  const index = read(`${OUT}/index.json`) as SourceArea[];
  const used = new Set(index.filter((a) => !a.src || !todo.includes(a.src)).map((a) => a.name));
  // build:county's areas are unincorporated Pierce County's
  const keep = index.filter((a) => !a.src || !todo.includes(a.src)).map((a) => (a.src ? a : { ...a, county: 'Pierce' }));
  for (const a of index) if (a.src && todo.includes(a.src)) rmSync(`${OUT}/${a.id}.json`, { force: true });
  const reports: Record<string, unknown>[] = [];
  for (const key of todo) {
    const { meta, built, P, report } = await buildSource(key);
    reports.push(report);
    for (const b of built.sort((p, q) => q.box.maxY - p.box.maxY || p.box.minX - q.box.minX) as (Built & { roads: string[] })[]) {
      let name = b.name;
      for (const road of b.roads) if (!used.has(`${b.name} / ${road}`)) { name = `${b.name} / ${road}`; break; }
      for (let k = 2; used.has(name); k++) name = `${b.name} (${k})`;
      used.add(name);
      const id = slug(name);
      writeFileSync(`${OUT}/${id}.json`, b.json);
      const [w, s] = P.toLngLat([b.box.minX, b.box.minY]);
      const [e, n] = P.toLngLat([b.box.maxX, b.box.maxY]);
      const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
      keep.push({ id, name, bbox: [r6(w), r6(s), r6(e), r6(n)], drains: b.own.length, byClass: b.ownByClass, bytes: Buffer.byteLength(b.json), src: meta.key, ...(isCounty(meta) ? { county: meta.county } : {}) });
    }
  }
  writeFileSync(`${OUT}/index.json`, JSON.stringify(keep, null, 1));
  mkdirSync(`${CACHE}/pipeline`, { recursive: true });
  writeFileSync(`${CACHE}/pipeline/sources-report.json`, JSON.stringify(reports, null, 1));
  const total = keep.reduce((n, a) => n + a.bytes, 0);
  log(`\n${keep.length} areas in all, ${keep.reduce((n, a) => n + a.drains, 0)} drains, ${Math.round(total / 1024 / 1024)} MB`);
  if (after) {
    await import('./area-names.ts');
    await import('./build-coverage.ts');
    await import('./build-overview.ts');
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/build-sources.ts')) {
  await buildSources(process.argv.slice(2).filter((a) => !a.startsWith('-')), !process.argv.includes('--no-after'));
}
