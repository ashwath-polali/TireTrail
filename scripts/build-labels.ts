// Writes public/data/labels.json: town and neighborhood names, lakes, parks and schools for map labels.
// Source: the Geofabrik Washington GeoPackage of OpenStreetMap (read only). Set OSM_GPKG to use another copy.
import type { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { localProjection, pointInPolygon, type LngLat, type XY } from '../src/geo/geo.ts';

export const GPKG = process.env.OSM_GPKG ?? '.cache/osm/washington.gpkg';
/** Pierce + King + 5 km */
export const BOX = [-122.92, 46.68, -121.0, 47.83] as const;
export const CREDIT = '© OpenStreetMap contributors (ODbL)';

export type Poly = LngLat[][]; // outer ring, then holes
export type Geom = { type: 'point'; at: LngLat } | { type: 'lines'; lines: LngLat[][] } | { type: 'polys'; polys: Poly[] };

// loaded only when used, so tests that import this file stay quiet
export const openGpkg = (file = GPKG): DatabaseSync => new (process.getBuiltinModule('node:sqlite').DatabaseSync)(file, { readOnly: true });

/** the date the GeoPackage was made, so re-runs write the same file */
export function dataDate(db: DatabaseSync): string {
  const r = db.prepare('select max(last_change) d from gpkg_contents').get() as { d: string };
  return r.d.slice(0, 10);
}

/** GeoPackage blob: header, optional envelope, then WKB */
export function decodeGeom(blob: Uint8Array, box: readonly number[] = BOX): Geom | null {
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const flags = v.getUint8(3), le = (flags & 1) === 1;
  const env = [0, 32, 48, 48, 64][(flags >> 1) & 7];
  if (env) {
    const x0 = v.getFloat64(8, le), x1 = v.getFloat64(16, le), y0 = v.getFloat64(24, le), y1 = v.getFloat64(32, le);
    if (x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3]) return null;
  }
  let o = 8 + env;
  const pt = (lit: boolean): LngLat => { const p: LngLat = [v.getFloat64(o, lit), v.getFloat64(o + 8, lit)]; o += 16; return p; };
  const seq = (lit: boolean): LngLat[] => { const n = v.getUint32(o, lit); o += 4; const out: LngLat[] = []; for (let k = 0; k < n; k++) out.push(pt(lit)); return out; };
  const poly = (lit: boolean): Poly => { const n = v.getUint32(o, lit); o += 4; const out: Poly = []; for (let k = 0; k < n; k++) out.push(seq(lit)); return out; };
  const head = () => { const lit = v.getUint8(o) === 1; const t = v.getUint32(o + 1, lit) % 1000; o += 5; return { lit, t }; };
  const { lit, t } = head();
  if (t === 1) {
    const at = pt(lit);
    return at[0] < box[0] || at[0] > box[2] || at[1] < box[1] || at[1] > box[3] ? null : { type: 'point', at };
  }
  if (t === 2) return { type: 'lines', lines: [seq(lit)] };
  if (t === 3) return { type: 'polys', polys: [poly(lit)] };
  const n = v.getUint32(o, lit);
  o += 4;
  if (t === 5) { const lines: LngLat[][] = []; for (let k = 0; k < n; k++) { const h = head(); lines.push(seq(h.lit)); } return { type: 'lines', lines }; }
  if (t === 6) { const polys: Poly[] = []; for (let k = 0; k < n; k++) { const h = head(); polys.push(poly(h.lit)); } return { type: 'polys', polys }; }
  return null;
}

/** features of one layer that reach into the box, in osm_id order */
export function* features<T extends Record<string, unknown>>(db: DatabaseSync, table: string, where = '1', cols = 'osm_id, fclass, name'): Generator<T & { geom: Geom }> {
  const st = db.prepare(`select ${cols}, geom from ${table} where ${where} order by cast(osm_id as integer), fid`);
  for (const row of st.iterate() as Iterable<Record<string, unknown>>) {
    const geom = decodeGeom(row.geom as Uint8Array);
    if (geom) yield { ...(row as T), geom };
  }
}

export const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

// meters around a polygon's first point
const projFor = (p: Poly) => localProjection(p[0][0]);

const ringArea = (r: XY[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return Math.abs(a / 2); };

/** area in m², outer rings minus holes */
export function polyArea(p: Poly): number {
  const P = projFor(p);
  return p.reduce((s, r, k) => s + (k ? -1 : 1) * ringArea(r.map(P.toXY)), 0);
}

function segDist2(p: XY, a: XY, b: XY): number {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b; else if (t > 0) [x, y] = [x + dx * t, y + dy * t];
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}

/** signed distance to the rings: positive inside */
function edgeDist(p: XY, rings: XY[][]): number {
  let best = Infinity;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) best = Math.min(best, segDist2(p, r[i], r[j]));
  return (pointInPolygon(p, rings) ? 1 : -1) * Math.sqrt(best);
}

/** pole of inaccessibility (the polylabel method), to `prec` meters; always inside */
export function poleOf(p: Poly, prec = 10): LngLat {
  const P = projFor(p), rings = p.map((r) => r.map(P.toXY));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rings[0]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const size = Math.min(x1 - x0, y1 - y0);
  if (!(size > 0) || rings[0].length < 3) return p[0][0];
  type Cell = { x: number; y: number; h: number; d: number; max: number };
  const cell = (x: number, y: number, h: number): Cell => { const d = edgeDist([x, y], rings); return { x, y, h, d, max: d + h * Math.SQRT2 }; };
  // max-heap on the best possible distance inside a cell
  const heap: Cell[] = [];
  const push = (c: Cell) => { heap.push(c); let i = heap.length - 1; while (i) { const up = (i - 1) >> 1; if (heap[up].max >= heap[i].max) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; } };
  const pop = (): Cell => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h0 = size / 2;
  for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) push(cell(x + h0, y + h0, h0));
  let best = cell((x0 + x1) / 2, (y0 + y1) / 2, 0);
  while (heap.length) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= prec) continue;
    const h = c.h / 2;
    push(cell(c.x - h, c.y - h, h)); push(cell(c.x + h, c.y - h, h));
    push(cell(c.x - h, c.y + h, h)); push(cell(c.x + h, c.y + h, h));
  }
  return P.toLngLat([best.x, best.y]);
}

/** the biggest part of a multipolygon */
export const biggest = (polys: Poly[]) => polys.map((p) => ({ p, a: polyArea(p) })).sort((a, b) => b.a - a.a)[0].p;

const inBox = ([lon, lat]: LngLat) => lon >= BOX[0] && lon <= BOX[2] && lat >= BOX[1] && lat <= BOX[3];
const near = (a: LngLat, b: LngLat, m: number) => Math.hypot((a[0] - b[0]) * 75500, (a[1] - b[1]) * 111200) < m;

const PLACE_KINDS: Record<string, string> = { national_capital: 'city', city: 'city', town: 'town', village: 'village', suburb: 'suburb', hamlet: 'hamlet' };
const PLACE_RANK = ['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood', 'hamlet'];
// Geofabrik's free layers leave out place=neighbourhood, so these few get their point from the OSM features named for them
const NAMED_FOR: string[] = ['Tehaleh'];

const LAKE_SKIP = /pond|basin|detention|retention|lagoon|wastewater|ladder|pool|river|creek|waterway|slough|canal|ditch|channel/i;

type Place = [string, string, number, number];
type Lake = [string, number, number, number, number, number, number, number];
type Park = [string, number, number, number];
type School = [string, number, number];

function centerOf(g: Geom): LngLat {
  if (g.type === 'point') return g.at;
  if (g.type === 'polys') return poleOf(biggest(g.polys), 25);
  const l = g.lines[0];
  return l[l.length >> 1];
}

function places(db: DatabaseSync): Place[] {
  const out: { name: string; kind: string; at: LngLat }[] = [];
  const add = (name: string, kind: string, at: LngLat, reach = 5000) => {
    if (!inBox(at) || out.some((p) => p.name === name && near(p.at, at, reach))) return;
    out.push({ name, kind, at });
  };
  const kinds = Object.keys(PLACE_KINDS).map((k) => `'${k}'`).join(',');
  for (const f of features<{ name: string; fclass: string }>(db, 'gis_osm_places_free', `name <> '' and fclass in (${kinds})`)) {
    if (f.geom.type === 'point') add(f.name, PLACE_KINDS[f.fclass], f.geom.at);
  }
  // places mapped only as an area
  for (const f of features<{ name: string; fclass: string }>(db, 'gis_osm_places_a_free', `name <> '' and fclass in (${kinds})`)) {
    if (f.geom.type === 'polys') add(f.name, PLACE_KINDS[f.fclass], poleOf(biggest(f.geom.polys), 50), 20000);
  }
  for (const name of NAMED_FOR) {
    const pts: LngLat[] = [];
    for (const t of ['gis_osm_landuse_a_free', 'gis_osm_pois_a_free', 'gis_osm_roads_free']) {
      for (const f of features<{ name: string }>(db, t, `name like '%${name}%'`)) pts.push(centerOf(f.geom));
    }
    if (!pts.length) throw new Error(`no OSM features named for ${name}`);
    const mid = (k: 0 | 1) => pts.map((p) => p[k]).sort((a, b) => a - b)[pts.length >> 1];
    add(name, 'neighbourhood', [mid(0), mid(1)]);
  }
  return out
    .map((p): Place => [p.name, p.kind, r6(p.at[0]), r6(p.at[1])])
    .sort((a, b) => PLACE_RANK.indexOf(a[1]) - PLACE_RANK.indexOf(b[1]) || a[0].localeCompare(b[0]) || a[2] - b[2]);
}

function lakes(db: DatabaseSync): Lake[] {
  const out: Lake[] = [];
  for (const f of features<{ name: string; fclass: string }>(db, 'gis_osm_water_a_free', `name <> '' and fclass in ('water', 'reservoir')`)) {
    if (f.geom.type !== 'polys' || LAKE_SKIP.test(f.name)) continue;
    if (f.fclass === 'reservoir' && !/\blake\b/i.test(f.name)) continue;
    const area = f.geom.polys.reduce((s, p) => s + polyArea(p), 0);
    if (area < 20000) continue;
    const part = biggest(f.geom.polys), at = poleOf(part, 10);
    const P = projFor(part);
    if (!pointInPolygon(P.toXY(at), part.map((r) => r.map(P.toXY)))) throw new Error(`${f.name}: label point outside the lake`);
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of f.geom.polys) for (const [x, y] of p[0]) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
    if (!inBox(at)) continue;
    out.push([f.name, r6(at[0]), r6(at[1]), Math.round(area), r6(w), r6(s), r6(e), r6(n)]);
  }
  return out.sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
}

function parks(db: DatabaseSync): Park[] {
  const out: Park[] = [];
  for (const f of features<{ name: string }>(db, 'gis_osm_pois_a_free', `name <> '' and fclass = 'park'`)) {
    if (f.geom.type !== 'polys') continue;
    const area = f.geom.polys.reduce((s, p) => s + polyArea(p), 0);
    if (area < 5000) continue;
    const at = poleOf(biggest(f.geom.polys), 10);
    if (!inBox(at) || out.some((p) => p[0] === f.name && near([p[1], p[2]], at, 300))) continue;
    out.push([f.name, r6(at[0]), r6(at[1]), Math.round(area)]);
  }
  return out.sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
}

function schools(db: DatabaseSync): School[] {
  const out: School[] = [];
  // campuses first, then the nodes that aren't already one
  for (const t of ['gis_osm_pois_a_free', 'gis_osm_pois_free']) {
    for (const f of features<{ name: string }>(db, t, `name <> '' and fclass = 'school'`)) {
      const at = centerOf(f.geom);
      if (!inBox(at) || out.some((p) => p[0] === f.name && near([p[1], p[2]], at, 500))) continue;
      out.push([f.name, r6(at[0]), r6(at[1])]);
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
}

function main(): void {
  const t0 = Date.now();
  const db = openGpkg();
  const out = { v: 1, built: dataDate(db), credit: CREDIT, places: places(db), lakes: lakes(db), parks: parks(db), schools: schools(db) };
  const text = JSON.stringify(out);
  writeFileSync('public/data/labels.json', text);
  console.log(`labels.json ${(text.length / 1024).toFixed(0)} KB: ${out.places.length} places, ${out.lakes.length} lakes, ${out.parks.length} parks, ${out.schools.length} schools (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

if (import.meta.main) main();
