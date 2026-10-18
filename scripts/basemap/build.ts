// Builds public/data/basemap/: real buildings, land cover, water and roads in 2 km tiles, in the app's meters.
// Sources: Microsoft Global ML Building Footprints (ODbL), and OpenStreetMap (ODbL) from Geofabrik's GeoPackage
// (or Overpass with --overpass), with the sea from OSM's coastline (osmdata.openstreetmap.de).
// Usage: node scripts/basemap/build.ts [box|pierce|king|puget] [--overpass] [--no-osm] [--fetch-only] [--out=dir]
// TT_CACHE=dir keeps the downloads in dir/basemap and dir/osm instead of .cache.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { createGunzip, gzipSync } from 'node:zlib';
import { decodeCoords, type Bundle } from '../../src/data/bundle.ts';
import { localProjection, pointAlong, pointInPolygon, polylineLength, simplify, type LngLat, type XY } from '../../src/geo/geo.ts';
import { GeoPackage, GPKG_URL } from './gpkg.ts';
import { Footprints, Known, normName, ringArea, type Street } from './match.ts';
import { fetchBuildings, fetchOsm, type Building, type Cover, type CoverPoly, type Road } from './osm.ts';
import { SEA_URL, seaPolygons } from './sea.ts';
import { unzipEntry } from './zip.ts';

const ROOT = process.env.TT_CACHE ?? '.cache';
const CACHE = `${ROOT}/basemap`;
const GPKG = `${ROOT}/osm/washington.gpkg`;
const SEA_ZIP = `${CACHE}/water-polygons-split-4326.zip`;
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'public/data/basemap';
const AREA_DIR = 'public/data/areas';
const LINKS = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
const countyUrl = (name: string) => 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023/State_County/MapServer/11/query?'
  + new URLSearchParams({ f: 'geojson', outSR: '4326', returnGeometry: 'true', outFields: 'BASENAME', where: `STATE='53' AND BASENAME='${name}'` });
const AREAS: Record<string, number[]> = {
  // Bonney Lake, Tehaleh, Lake Tapps, the Sumner edge, South Prairie, Orting
  box: [-122.35, 47.05, -121.95, 47.25],
  pierce: [-122.86, 46.72, -121.38, 47.42],
  king: [-122.55, 47.07, -121.06, 47.79],
  puget: [-122.86, 46.72, -121.06, 47.79],
};
// areas made of whole counties: tiles touching these
const COUNTIES: Record<string, string[]> = { pierce: ['Pierce'], king: ['King'], puget: ['Pierce', 'King'] };
const TILE = 2000; // meters
const U = 2; // stored units per meter
const MIN_BUILDING = 10; // m², skips sheds the footprints barely resolve
const TUNNEL = 50; // m: a tunnel this long would be drawn over whatever sits on top of it, so it's left out
// index + 1 is the class the app decodes; the sea (5) is new in v2, and older app code doesn't draw it
const COVERS: Cover[] = ['forest', 'park', 'grass', 'water', 'sea'];
// route numbers like "SR 410", "I 5", "US 2", "NF 19" or "SR 104 Spur"; the layer also holds notes cut at 20 letters
const REF = /^[A-Z]{1,4}[ -]?\d+[A-Z]?(?: [A-Za-z]+)?$/;
const TILE_FILE = /^-?\d+_-?\d+\.json$/;

const P = localProjection();
// same as World.toWorld: y flipped so north is up
const xy = (p: LngLat): XY => { const q = P.toXY(p); return [q[0], -q[1]]; };
const key = (tx: number, ty: number) => `${tx}_${ty}`;

/**
 * One tile while it's built. Buildings are kept as flat numbers (a million of them would not fit as arrays of points):
 * bq holds [count, x0, y0, x1, y1, ...] per building in tile units, bat holds its middle x, y and where it starts in bq.
 * c and r hold each land cover and road piece already as JSON; c is [class, outer, ...holes], r is [flags, deltas...],
 * flags = 1 if major, plus 2 x meters for a copy of a county street (hidden once a street that close is drawn).
 * cn, rn and rf are 1-based indexes into n (0 for none): a water's name, a road's label and its route number.
 */
interface Tile { bq: number[]; bat: number[]; c: string[]; cn: number[]; r: string[]; rn: number[]; rc: number[]; rf: number[]; n: Map<string, number> }

/** The OpenStreetMap data, wherever it comes from. */
interface Osm { cover(): Iterable<CoverPoly>; roads(): Iterable<Road>; buildings(): Iterable<Building> }

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dirname(file), { recursive: true });
  // straight to disk: some of these are close to a gigabyte
  await pipeline(Readable.fromWeb(res.body as unknown as WebStream<Uint8Array>), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
}

/** Geofabrik's Washington GeoPackage, unpacked from its zip the first time. */
async function geoPackage(): Promise<string> {
  if (existsSync(GPKG)) return GPKG;
  const zip = `${dirname(GPKG)}/washington-latest-free.gpkg.zip`;
  await download(GPKG_URL, zip);
  console.log(`unpacking ${zip}`);
  await pipeline(unzipEntry(zip, /\.gpkg$/).stream, createWriteStream(`${GPKG}.part`));
  renameSync(`${GPKG}.part`, GPKG);
  return GPKG;
}

/** Bing quadkeys at zoom z covering the box: the footprint files are split by these. */
function quadkeys([w, s, e, n]: number[], z = 9): string[] {
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ty = (lat: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  const out: string[] = [];
  for (let y = ty(n); y <= ty(s); y++) for (let x = tx(w); x <= tx(e); x++) {
    let q = '';
    for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += String((x & m ? 1 : 0) + (y & m ? 2 : 0)); }
    out.push(q);
  }
  return out;
}

async function* footprints(file: string): AsyncGenerator<LngLat[]> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const g = JSON.parse(line).geometry;
    if (g.type === 'Polygon') yield g.coordinates[0];
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) yield p[0];
  }
}

/** Douglas-Peucker on a closed ring (no repeated last point). */
function simplifyRing(r: XY[], tol: number): XY[] {
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  return r.length < 4 ? r : simplify([...r, r[0]], tol).slice(0, -1);
}

/** Tile-local integer units, without repeated points. Rings drop a closing point; lines keep it. */
function quantize(r: readonly XY[], o: XY, ring = true): XY[] {
  const out: XY[] = [];
  for (const [x, y] of r) {
    const p: XY = [Math.round((x - o[0]) * U), Math.round((y - o[1]) * U)];
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p);
  }
  while (ring && out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

const delta = (pts: number[][]): number[] => pts.flatMap((p, k) => (k ? [p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]] : p));

// Sutherland-Hodgman against an axis-aligned rectangle
function clipRing(ring: XY[], [x0, y0, x1, y1]: number[]): XY[] {
  let out = ring;
  const edges: [(p: XY) => boolean, (a: XY, b: XY) => XY][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let k = 0; k < src.length; k++) {
      const a = src[(k + src.length - 1) % src.length], b = src[k];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

// Liang-Barsky per segment; continuous runs stay one line
function clipLine(pts: XY[], [x0, y0, x1, y1]: number[]): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] | null = null;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k], dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) ok = false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else if (r < t0) ok = false; else if (r < t1) t1 = r;
    }
    if (!ok || t0 > t1) { cur = null; continue; }
    const a: XY = [ax + t0 * dx, ay + t0 * dy], b: XY = [ax + t1 * dx, ay + t1 * dy];
    if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length > 1);
}

/** 1-based index of a name in the tile's list, added if new. */
function nameIndex(t: Tile, s: string): number {
  let i = t.n.get(s);
  if (!i) { i = t.n.size + 1; t.n.set(s, i); }
  return i;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--')) ?? 'box';
  const box = AREAS[name];
  if (!box) throw new Error(`unknown area ${name}; use ${Object.keys(AREAS).join(' or ')}`);
  const overpass = args.includes('--overpass'), noOsm = args.includes('--no-osm');
  const t0 = Date.now();
  let lap = t0;
  const step = (what: string) => { const now = Date.now(); console.log(`  ${what} (${((now - lap) / 1000).toFixed(0)} s)`); lap = now; };

  // which tiles exist: the box, or tiles touching the counties
  let inArea = (p: LngLat) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
  const counties = COUNTIES[name];
  if (counties) {
    const polys: LngLat[][][] = [];
    for (const c of counties) {
      const file = `${CACHE}/${c.toLowerCase()}-county.json`;
      await download(countyUrl(c), file);
      const g = JSON.parse(readFileSync(file, 'utf8')).features[0].geometry;
      polys.push(...(g.type === 'Polygon' ? [g.coordinates] : g.coordinates));
    }
    inArea = (p) => polys.some((poly) => pointInPolygon(p, poly));
  }
  const [bx0, by0] = xy([box[0], box[3]]), [bx1, by1] = xy([box[2], box[1]]);
  const tiles = new Map<string, Tile>();
  for (let ty = Math.floor(by0 / TILE); ty <= Math.floor(by1 / TILE); ty++) for (let tx = Math.floor(bx0 / TILE); tx <= Math.floor(bx1 / TILE); tx++) {
    let hit = false;
    for (let j = 0; j <= 4 && !hit; j++) for (let i = 0; i <= 4 && !hit; i++) {
      const ll = P.toLngLat([(tx + i / 4) * TILE, -(ty + j / 4) * TILE]);
      hit = inArea(ll);
    }
    if (hit) tiles.set(key(tx, ty), { bq: [], bat: [], c: [], cn: [], r: [], rn: [], rc: [], rf: [], n: new Map() });
  }
  console.log(`${name}: ${tiles.size} tiles of ${TILE / 1000} km, OSM from ${noOsm ? 'nowhere (--no-osm)' : overpass ? 'Overpass' : GPKG}`);

  // one edge for buildings, land cover and roads: the box, or for the county the tiles' own edges
  const clip = counties ? [-Infinity, -Infinity, Infinity, Infinity] : [bx0, by0, bx1, by1];
  // a 1 m overlap, so neighboring tiles never leave a seam
  const rectOf = (tx: number, ty: number) => [
    Math.max(clip[0], tx * TILE - 1), Math.max(clip[1], ty * TILE - 1), Math.min(clip[2], (tx + 1) * TILE + 1), Math.min(clip[3], (ty + 1) * TILE + 1),
  ];
  // [w, s, e, n] of each tile's drawn part, and of all of them: where to read data
  const parts = [...tiles.keys()].map((k) => {
    const [tx, ty] = k.split('_').map(Number), r = rectOf(tx, ty);
    const [w, n] = P.toLngLat([r[0], -r[1]]), [e, s] = P.toLngLat([r[2], -r[3]]);
    return [w, s, e, n];
  });
  const ext = parts.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[2]), Math.max(a[3], p[3])], [Infinity, Infinity, -Infinity, -Infinity])
    .map((v) => +v.toFixed(6));
  const touches = ([w, s, e, n]: number[]) => parts.some((p) => p[0] < e && p[2] > w && p[1] < n && p[3] > s);
  // tiles a bounding box (world meters) may reach
  const reaches = (x0: number, y0: number, x1: number, y1: number) => {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) if (tiles.has(key(tx, ty))) return true;
    return false;
  };
  await download(LINKS, `${CACHE}/dataset-links.csv`);
  const links = new Map(readFileSync(`${CACHE}/dataset-links.csv`, 'utf8').split('\n').filter((l) => l.startsWith('UnitedStates,')).map((l) => { const c = l.split(','); return [c[1], c[2]] as const; }));
  if (args.includes('--fetch-only')) {
    for (const q of quadkeys(ext)) { const url = links.get(q); if (url) await download(url, `${CACHE}/ms-${q}.csv.gz`); }
    await download(SEA_URL, SEA_ZIP);
    if (!overpass) { console.log(`${await geoPackage()} ready`); return; }
    const osm = await fetchOsm(ext, touches);
    const ob = await fetchBuildings(ext, touches);
    console.log(`${osm.chunks} OSM chunks cached: ${osm.cover.length} land cover polygons, ${osm.roads.length} roads, ${ob.length} buildings`);
    return;
  }
  let osm: Osm = { cover: () => [], roads: () => [], buildings: () => [] };
  let gp: GeoPackage | null = null;
  if (overpass) {
    const o = await fetchOsm(ext, touches), ob = await fetchBuildings(ext, touches);
    osm = { cover: () => o.cover, roads: () => o.roads, buildings: () => ob };
  } else if (!noOsm) {
    const g = gp = new GeoPackage(await geoPackage());
    osm = { cover: () => g.cover(ext), roads: () => g.roads(ext), buildings: () => g.buildings(ext) };
  }

  // buildings: Microsoft's footprints, then OSM's where those have none (they miss some new streets)
  const kept = new Footprints();
  let nb = 0, small = 0, nob = 0, dup = 0;
  // into the tile holding its middle, inside the edge; never over a building already kept when `check`
  const addBuilding = (ring: LngLat[], check: boolean): boolean => {
    const pts = simplifyRing(ring.map(xy), 0.4);
    if (pts.length < 3) return false;
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0] / pts.length; cy += p[1] / pts.length; }
    const tx = Math.floor(cx / TILE), ty = Math.floor(cy / TILE), t = tiles.get(key(tx, ty));
    if (!t || cx < clip[0] || cx > clip[2] || cy < clip[1] || cy > clip[3]) return false;
    if (ringArea(pts) < MIN_BUILDING) { small++; return false; }
    if (check && kept.hits(pts)) { dup++; return false; }
    const qp = quantize(pts, [tx * TILE, ty * TILE]);
    if (qp.length < 3) return false;
    t.bat.push(cx, cy, t.bq.length);
    t.bq.push(qp.length);
    for (const [x, y] of qp) t.bq.push(x, y);
    kept.add(pts);
    return true;
  };
  for (const q of quadkeys(ext)) {
    const url = links.get(q);
    if (!url) continue;
    const file = `${CACHE}/ms-${q}.csv.gz`;
    await download(url, file);
    for await (const ring of footprints(file)) {
      const [lon, lat] = ring[0];
      if (lon < ext[0] - .01 || lon > ext[2] + .01 || lat < ext[1] - .01 || lat > ext[3] + .01) continue;
      if (addBuilding(ring, false)) nb++;
    }
    console.log(`  footprints ${q}: ${nb} buildings so far (${small} under ${MIN_BUILDING} m² skipped)`);
  }
  step('footprints done');
  for (const { ring } of osm.buildings()) if (addBuilding(ring, true)) nob++;
  step(`OSM buildings: ${nob} added where the footprints have none, ${dup} skipped as already drawn`);

  // land cover, water and the sea, cut to each tile they reach
  const nc = [0, 0, 0, 0, 0];
  const addCover = (poly: CoverPoly): void => {
    const rings = poly.rings.map((r) => simplifyRing(r.map(xy), 1)).filter((r) => r.length >= 3);
    if (!rings.length || ringArea(rings[0]) < 100) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const cls = COVERS.indexOf(poly.cls);
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      const t = tiles.get(key(tx, ty));
      if (!t) continue;
      const o: XY = [tx * TILE, ty * TILE], rect = rectOf(tx, ty);
      const outer = quantize(clipRing(rings[0], rect), o);
      if (outer.length < 3 || ringArea(outer) === 0) continue;
      const holes = rings.slice(1).map((r) => quantize(clipRing(r, rect), o)).filter((r) => r.length >= 3 && ringArea(r) > 0);
      // all hole here (a tile inside an island): nothing to draw
      if (holes.reduce((a, h) => a - ringArea(h), ringArea(outer)) <= 0) continue;
      t.c.push(JSON.stringify([cls, delta(outer), ...holes.map(delta)]));
      t.cn.push(poly.name && (poly.cls === 'water' || poly.cls === 'sea') ? nameIndex(t, poly.name) : 0);
      nc[cls]++;
    }
  };
  for (const poly of osm.cover()) addCover(poly);
  step(`land cover: ${COVERS.slice(0, 4).map((c, i) => `${nc[i]} ${c}`).join(', ')} pieces`);
  if (!noOsm) {
    await download(SEA_URL, SEA_ZIP);
    for await (const rings of seaPolygons(SEA_ZIP, ext)) addCover({ cls: 'sea', rings, name: '' });
    step(`sea: ${nc[4]} pieces`);
  }

  // roads only where the city's and county's street data has none, so those streets keep their drain colors
  const streets: Street[] = [];
  const addStreets = (b: Bundle, county: boolean) => b.streets.runs.geom.forEach((g, i) => {
    streets.push({ line: decodeCoords(g).map(xy), name: b.streets.pieces[b.streets.runs.piece[i]]?.name ?? '', county });
  });
  addStreets(JSON.parse(readFileSync('public/data/tiretrail.json', 'utf8')), false);
  let na = 0;
  if (existsSync(`${AREA_DIR}/index.json`)) for (const a of JSON.parse(readFileSync(`${AREA_DIR}/index.json`, 'utf8')) as { id: string; bbox: number[] }[]) {
    if (a.bbox[2] < ext[0] || a.bbox[0] > ext[2] || a.bbox[3] < ext[1] || a.bbox[1] > ext[3]) continue;
    addStreets(JSON.parse(readFileSync(`${AREA_DIR}/${a.id}.json`, 'utf8')), true);
    na++;
  }
  const known = new Known(streets);
  step(`${streets.length} street runs from the city and ${na} county areas`);
  // meters of OSM road: kept, under city streets, under county streets; and county copies a city street hides too early
  const len = [0, 0, 0];
  let nr = 0, early = 0, tunnels = 0;
  for (const road of osm.roads()) {
    const line = road.line.map(xy);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of line) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (!reaches(x0, y0, x1, y1)) continue;
    if (road.tunnel && polylineLength(line) >= TUNNEL) { tunnels += polylineLength(line); continue; }
    const ref = road.ref.split(';').map((s) => s.trim()).filter((s) => REF.test(s)).join(';');
    const names = [road.name, ...ref.split(';')].map(normName).filter(Boolean);
    const label = road.name || ref.replace(/;/g, ' / ');
    // sample every ~4 m: clear (0), under a city street (1), under a county street (2)
    const pts: XY[] = [];
    for (let k = 1; k < line.length; k++) {
      const [a, b] = [line[k - 1], line[k]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
      for (let s = k === 1 ? 0 : 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    }
    const cls = pts.map((p) => known.at(p, names));
    for (let k = 1; k < pts.length; k++) {
      const [x, y] = pts[k];
      if (x >= clip[0] && x <= clip[2] && y >= clip[1] && y <= clip[3] && tiles.has(key(Math.floor(x / TILE), Math.floor(y / TILE)))) len[cls[k]] += Math.hypot(x - pts[k - 1][0], y - pts[k - 1][1]);
    }
    const pieces: [XY[], boolean][] = [];
    for (let k = 0; k < pts.length; k++) {
      if (cls[k] === 1) continue;
      const s = k;
      while (k + 1 < pts.length && cls[k + 1] !== 1) k++;
      // one sample more at each cut, so the road meets the street
      const a = Math.max(0, s - 1), b = Math.min(pts.length, k + 2);
      if (polylineLength(pts.slice(a, b)) < 20) continue;
      // then split where it turns from clear to a county copy; a short bit joins its neighbor
      const groups: { pts: XY[]; county: boolean }[] = [];
      for (let i = a; i < b; i++) {
        const county = cls[Math.min(Math.max(i, s), k)] === 2, g = groups[groups.length - 1];
        if (g && g.county === county) g.pts.push(pts[i]);
        else groups.push({ pts: g ? [g.pts[g.pts.length - 1], pts[i]] : [pts[i]], county });
      }
      for (let i = 0; i < groups.length && groups.length > 1;) {
        if (polylineLength(groups[i].pts) >= 20) { i++; continue; }
        const into = i > 0 ? i - 1 : 1;
        groups[into].pts = into < i ? groups[into].pts.concat(groups[i].pts.slice(1)) : groups[i].pts.concat(groups[into].pts.slice(1));
        groups.splice(i, 1);
        i = 0;
      }
      for (const g of groups) pieces.push([simplify(g.pts, 0.8), g.county]);
    }
    for (const [piece, county] of pieces) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of piece) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        const t = tiles.get(key(tx, ty));
        if (!t) continue;
        const o: XY = [tx * TILE, ty * TILE];
        for (const part of clipLine(piece, rectOf(tx, ty))) {
          const qp = quantize(part, o, false);
          if (qp.length < 2) continue;
          // a county copy hides once the app draws a street this close to its middle
          let near = 0;
          if (county) {
            const mid = pointAlong(part, polylineLength(part) / 2);
            near = Math.min(45, Math.ceil(known.dist(mid, 45, true)) + 2);
            if (known.dist(mid, near, false) < near) early += polylineLength(part);
          }
          t.r.push(JSON.stringify([(road.major ? 1 : 0) + 2 * near, ...delta(qp)]));
          t.rn.push(label ? nameIndex(t, label) : 0);
          t.rc.push(road.cls);
          t.rf.push(ref ? nameIndex(t, ref) : 0);
          nr++;
        }
      }
    }
  }
  gp?.close();
  const km = (m: number) => `${(m / 1000).toFixed(0)} km`;
  step(`OSM roads: ${km(len[0])} kept, ${km(len[1])} under city streets, ${km(len[2])} under county streets (kept, hidden once those are drawn; ${km(early)} of it hides early near a city street), ${km(tunnels)} of tunnels left out`);

  // write: buildings in rows, each [count, first point from the last first point, deltas...]
  mkdirSync(OUT, { recursive: true });
  const list: string[] = [];
  let bytes = 0, gz = 0, biggest = 0, biggestKey = '', over = 0;
  for (const k of [...tiles.keys()].sort()) {
    const t = tiles.get(k)!;
    tiles.delete(k);
    const count = t.bat.length / 3;
    if (!count && !t.c.length && !t.r.length) continue;
    const at = t.bat, q = t.bq;
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => Math.floor(at[3 * a + 1] / 40) - Math.floor(at[3 * b + 1] / 40) || at[3 * a] - at[3 * b]);
    const b: number[] = [];
    let px = 0, py = 0;
    for (const i of order) {
      const o = at[3 * i + 2] + 1, c = q[o - 1];
      b.push(c, q[o] - px, q[o + 1] - py);
      [px, py] = [q[o], q[o + 1]];
      for (let v = 1; v < c; v++) b.push(q[o + 2 * v] - q[o + 2 * v - 2], q[o + 2 * v + 1] - q[o + 2 * v - 1]);
    }
    const text = `{"b":${JSON.stringify(b)},"c":[${t.c.join(',')}],"cn":${JSON.stringify(t.cn)},"r":[${t.r.join(',')}],`
      + `"rn":${JSON.stringify(t.rn)},"rc":${JSON.stringify(t.rc)},"rf":${JSON.stringify(t.rf)},"n":${JSON.stringify([...t.n.keys()])}}`;
    writeFileSync(`${OUT}/${k}.json`, text);
    list.push(k);
    bytes += text.length;
    gz += gzipSync(text).length;
    if (text.length > biggest) [biggest, biggestKey] = [text.length, k];
    if (text.length > 1 << 20) over++;
  }
  // only old tile files go; anything else in the folder stays
  const fresh = new Set(list);
  let stale = 0;
  for (const f of readdirSync(OUT)) if (TILE_FILE.test(f) && !fresh.has(f.slice(0, -5))) { rmSync(`${OUT}/${f}`); stale++; }
  const index = {
    v: 2, tile: TILE, unit: 1 / U, area: name, box, covers: COVERS,
    credits: ['Microsoft Building Footprints (ODbL)', '© OpenStreetMap contributors (ODbL)'],
    tiles: list.sort((a, b) => a.localeCompare(b)),
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  const all = nc.reduce((a, v) => a + v, 0);
  console.log(`${list.length} tiles (${stale} old ones removed), ${nb + nob} buildings (${nob} from OSM), ${all} land cover pieces (${nc[4]} sea), ${nr} road pieces`);
  console.log(`total ${kb(bytes)} (${kb(gz)} gzipped), largest ${biggestKey} ${kb(biggest)}${over ? `, ${over} over 1 MB` : ''}, `
    + `${((Date.now() - t0) / 1000).toFixed(0)} s, peak memory ${(process.resourceUsage().maxRSS / 1024 ** 2).toFixed(2)} GB`);
}

await main();
