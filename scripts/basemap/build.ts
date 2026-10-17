// Builds public/data/basemap/: real buildings, land cover and roads in 2 km tiles, in the app's meters.
// Sources: Microsoft Global ML Building Footprints (ODbL) and OpenStreetMap via Overpass (ODbL).
// Usage: node scripts/basemap/build.ts [box|pierce] [--no-osm] [--fetch-only] [--out=dir]
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, gzipSync } from 'node:zlib';
import { decodeCoords } from '../../src/data/bundle.ts';
import { GridIndex, localProjection, nearestOnPolyline, pointInPolygon, simplify, type LngLat, type XY } from '../../src/geo/geo.ts';
import { fetchOsm, type Cover } from './osm.ts';

const CACHE = '.cache/basemap';
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'public/data/basemap';
const LINKS = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
const COUNTY = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023/State_County/MapServer/11/query?'
  + new URLSearchParams({ f: 'geojson', outSR: '4326', returnGeometry: 'true', outFields: 'BASENAME', where: "STATE='53' AND BASENAME='Pierce'" });
const AREAS: Record<string, number[]> = {
  // Bonney Lake, Tehaleh, Lake Tapps, the Sumner edge, South Prairie, Orting
  box: [-122.35, 47.05, -121.95, 47.25],
  pierce: [-122.86, 46.72, -121.38, 47.42],
};
const TILE = 2000; // meters
const U = 2; // stored units per meter
const MIN_BUILDING = 10; // m², skips sheds the footprints barely resolve
const COVERS: Cover[] = ['forest', 'park', 'grass', 'water'];

const P = localProjection();
// same as World.toWorld: y flipped so north is up
const xy = (p: LngLat): XY => { const q = P.toXY(p); return [q[0], -q[1]]; };
const key = (tx: number, ty: number) => `${tx}_${ty}`;

interface Tile { b: { at: XY; q: number[][] }[]; c: [number, ...number[][]][]; r: number[][] }

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${file}.part`, file);
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

function area(r: readonly XY[]): number {
  let a = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
  return Math.abs(a / 2);
}

/** Douglas-Peucker on a closed ring (no repeated last point). */
function simplifyRing(r: XY[], tol: number): XY[] {
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  return r.length < 4 ? r : simplify([...r, r[0]], tol).slice(0, -1);
}

/** Tile-local integer units, without repeated points. */
function quantize(r: readonly XY[], o: XY): XY[] {
  const out: XY[] = [];
  for (const [x, y] of r) {
    const p: XY = [Math.round((x - o[0]) * U), Math.round((y - o[1]) * U)];
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--')) ?? 'box';
  const box = AREAS[name];
  if (!box) throw new Error(`unknown area ${name}; use ${Object.keys(AREAS).join(' or ')}`);
  const t0 = Date.now();

  // which tiles exist: the box, or tiles touching Pierce County
  let inArea = (p: LngLat) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
  // OSM chunks that reach into the area
  let touches = (_: number[]) => true;
  if (name === 'pierce') {
    await download(COUNTY, `${CACHE}/pierce-county.json`);
    const g = JSON.parse(readFileSync(`${CACHE}/pierce-county.json`, 'utf8')).features[0].geometry;
    const polys: LngLat[][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    inArea = (p) => polys.some((poly) => pointInPolygon(p, poly));
    touches = ([w, s, e, n]) => {
      for (let j = 0; j <= 5; j++) for (let i = 0; i <= 5; i++) if (inArea([w + ((e - w) * i) / 5, s + ((n - s) * j) / 5])) return true;
      return polys.some((poly) => poly[0].some(([x, y]) => x >= w && x <= e && y >= s && y <= n));
    };
  }
  if (args.includes('--fetch-only')) {
    const osm = await fetchOsm(box, touches);
    console.log(`${osm.chunks} OSM chunks cached: ${osm.cover.length} land cover polygons, ${osm.roads.length} roads`);
    return;
  }
  const [bx0, by0] = xy([box[0], box[3]]), [bx1, by1] = xy([box[2], box[1]]);
  const tiles = new Map<string, Tile>();
  for (let ty = Math.floor(by0 / TILE); ty <= Math.floor(by1 / TILE); ty++) for (let tx = Math.floor(bx0 / TILE); tx <= Math.floor(bx1 / TILE); tx++) {
    let hit = false;
    for (let j = 0; j <= 4 && !hit; j++) for (let i = 0; i <= 4 && !hit; i++) {
      const ll = P.toLngLat([(tx + i / 4) * TILE, -(ty + j / 4) * TILE]);
      hit = inArea(ll);
    }
    if (hit) tiles.set(key(tx, ty), { b: [], c: [], r: [] });
  }
  console.log(`${name}: ${tiles.size} tiles of ${TILE / 1000} km`);

  // buildings
  await download(LINKS, `${CACHE}/dataset-links.csv`);
  const links = new Map(readFileSync(`${CACHE}/dataset-links.csv`, 'utf8').split('\n').filter((l) => l.startsWith('UnitedStates,')).map((l) => { const c = l.split(','); return [c[1], c[2]] as const; }));
  let nb = 0, small = 0;
  for (const q of quadkeys(box)) {
    const url = links.get(q);
    if (!url) continue;
    const file = `${CACHE}/ms-${q}.csv.gz`;
    await download(url, file);
    for await (const ring of footprints(file)) {
      const [lon, lat] = ring[0];
      if (lon < box[0] - .01 || lon > box[2] + .01 || lat < box[1] - .01 || lat > box[3] + .01) continue;
      const pts = simplifyRing(ring.map(xy), 0.4);
      if (pts.length < 3) continue;
      let cx = 0, cy = 0;
      for (const p of pts) { cx += p[0] / pts.length; cy += p[1] / pts.length; }
      const t = tiles.get(key(Math.floor(cx / TILE), Math.floor(cy / TILE)));
      if (!t || !inArea([lon, lat])) continue;
      if (area(pts) < MIN_BUILDING) { small++; continue; }
      const o: XY = [Math.floor(cx / TILE) * TILE, Math.floor(cy / TILE) * TILE];
      const qp = quantize(pts, o);
      if (qp.length < 3) continue;
      t.b.push({ at: [cx, cy], q: qp });
      nb++;
    }
    console.log(`  footprints ${q}: ${nb} buildings so far (${small} under ${MIN_BUILDING} m² skipped)`);
  }

  // land cover and roads
  const osm = args.includes('--no-osm') ? { cover: [], roads: [], chunks: 0 } : await fetchOsm(box, touches);
  let nc = 0;
  for (const poly of osm.cover) {
    const rings = poly.rings.map((r) => simplifyRing(r.map(xy), 1)).filter((r) => r.length >= 3);
    if (!rings.length || area(rings[0]) < 100) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      const t = tiles.get(key(tx, ty));
      if (!t) continue;
      const o: XY = [tx * TILE, ty * TILE];
      // a 1 m overlap, so neighboring tiles never leave a seam
      const rect = [o[0] - 1, o[1] - 1, o[0] + TILE + 1, o[1] + TILE + 1];
      const outer = quantize(clipRing(rings[0], rect), o);
      if (outer.length < 3 || area(outer) === 0) continue;
      const holes = rings.slice(1).map((r) => quantize(clipRing(r, rect), o)).filter((r) => r.length >= 3 && area(r) > 0);
      t.c.push([COVERS.indexOf(poly.cls), delta(outer), ...holes.map(delta)]);
      nc++;
    }
  }

  // roads only where the city's street data has none, so town streets keep their drain colors
  const bundle = JSON.parse(readFileSync('public/data/tiretrail.json', 'utf8'));
  const city: XY[][] = bundle.streets.runs.geom.map((g: number[]) => decodeCoords(g).map(xy));
  const cityIdx = new GridIndex<number>(100);
  city.forEach((l, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    cityIdx.insert(i, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
  });
  const covered = (p: XY) => cityIdx.near(p, 10).some((i) => nearestOnPolyline(p, city[i]).d < 10);
  let nr = 0;
  for (const road of osm.roads) {
    // sample every ~4 m and keep the stretches away from city streets
    const pts: XY[] = [];
    const line = road.line.map(xy);
    for (let k = 1; k < line.length; k++) {
      const [a, b] = [line[k - 1], line[k]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
      for (let s = k === 1 ? 0 : 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    }
    const keep = pts.map((p) => !covered(p));
    const pieces: XY[][] = [];
    for (let k = 0; k < pts.length; k++) {
      if (!keep[k]) continue;
      const s = k;
      while (k + 1 < pts.length && keep[k + 1]) k++;
      // one sample more at each cut, so the road meets the city street
      const piece = pts.slice(Math.max(0, s - 1), Math.min(pts.length, k + 2));
      let len = 0;
      for (let q = 1; q < piece.length; q++) len += Math.hypot(piece[q][0] - piece[q - 1][0], piece[q][1] - piece[q - 1][1]);
      if (len >= 20) pieces.push(simplify(piece, 0.8));
    }
    for (const piece of pieces) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of piece) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        const t = tiles.get(key(tx, ty));
        if (!t) continue;
        const o: XY = [tx * TILE, ty * TILE];
        for (const part of clipLine(piece, [o[0] - 1, o[1] - 1, o[0] + TILE + 1, o[1] + TILE + 1])) {
          const qp = quantize(part, o);
          if (qp.length < 2) continue;
          t.r.push([road.major ? 1 : 0, ...delta(qp)]);
          nr++;
        }
      }
    }
  }

  // write: buildings in rows, each [count, first point from the last first point, deltas...]
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const list: string[] = [];
  let bytes = 0, gz = 0, biggest = 0, biggestKey = '';
  for (const [k, t] of [...tiles].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!t.b.length && !t.c.length && !t.r.length) continue;
    t.b.sort((a, b) => Math.floor(a.at[1] / 40) - Math.floor(b.at[1] / 40) || a.at[0] - b.at[0]);
    const b: number[] = [];
    let px = 0, py = 0;
    for (const { q } of t.b) {
      b.push(q.length, q[0][0] - px, q[0][1] - py);
      [px, py] = q[0];
      for (let i = 1; i < q.length; i++) b.push(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
    }
    const text = JSON.stringify({ b, c: t.c, r: t.r });
    writeFileSync(`${OUT}/${k}.json`, text);
    list.push(k);
    bytes += text.length;
    gz += gzipSync(text).length;
    if (text.length > biggest) [biggest, biggestKey] = [text.length, k];
  }
  const index = {
    tile: TILE, unit: 1 / U, area: name, box,
    credits: ['Microsoft Building Footprints (ODbL)', '© OpenStreetMap contributors (ODbL)'],
    tiles: list,
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`${list.length} tiles, ${nb} buildings, ${nc} land cover pieces, ${nr} road pieces from ${osm.chunks} OSM chunks`);
  console.log(`total ${kb(bytes)} (${kb(gz)} gzipped), largest ${biggestKey} ${kb(biggest)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await main();
