// Writes public/data/majorroads.json: tertiary and bigger roads with their route numbers, for road weights and shields.
// Source: the Geofabrik Washington GeoPackage of OpenStreetMap (read only), like build-labels.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { localProjection, pointInPolygon, polylineLength, simplify, type LngLat, type XY } from '../src/geo/geo.ts';
import { CREDIT, features, openGpkg } from './build-labels.ts';
import { project } from './lib/lcc.ts';

const CLS: Record<string, number> = { tertiary: 2, secondary: 3, primary: 4, trunk: 5, motorway: 5 };
const TOL = 15; // meters
const MIN_LEN = 30; // meters: shorter bits are under 3 px at any zoom that draws them

const WORDS: [RegExp, string][] = [
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bDrive\b/g, 'Dr'],
  [/\bBoulevard\b/g, 'Blvd'], [/\bHighway\b/g, 'Hwy'],
  [/ (Northeast|Northwest|Southeast|Southwest|North|South|East|West)$/, ''],
];
const DIRS: Record<string, string> = { Northeast: 'NE', Northwest: 'NW', Southeast: 'SE', Southwest: 'SW', North: 'N', South: 'S', East: 'E', West: 'W' };

/** "Sumner-Buckley Highway East" -> "Sumner-Buckley Hwy E" */
export function shortName(name: string): string {
  let s = name.trim();
  for (const [re, to] of WORDS.slice(0, -1)) s = s.replace(re, to);
  return s.replace(WORDS[WORDS.length - 1][0], (_, d: string) => ` ${DIRS[d]}`);
}

/** "SR 161;SR 167" -> "SR 167"; refs that aren't route numbers ("City of Lacey") are dropped */
export function lastRef(ref: string | null): string {
  const r = (ref ?? '').split(';').map((x) => x.trim()).filter(Boolean).pop() ?? '';
  return /^[A-Z]{1,3} ?\d/.test(r) ? r : '';
}

/** integer microdegrees, delta-coded [lon0, lat0, dlon, dlat, ...] */
export function deltas(line: readonly LngLat[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [lon, lat] of line) {
    const x = Math.round(lon * 1e6), y = Math.round(lat * 1e6);
    if (out.length && x === px && y === py) continue;
    out.push(x - px, y - py);
    [px, py] = [x, y];
  }
  return out;
}

/** a test for "within 5 km of Pierce or King County", from the region map's county outlines */
export function nearCounties(names = ['Pierce', 'King'], reach = 5000, cell = 500): (p: LngLat) => boolean {
  const region = JSON.parse(readFileSync('public/data/region.json', 'utf8'));
  const rings: XY[][] = [];
  for (const c of region.counties) {
    if (!names.includes(c.name)) continue;
    for (const d of c.rings as number[][]) { const r: XY[] = []; let x = 0, y = 0; for (let k = 0; k < d.length; k += 2) r.push([(x += d[k]), (y += d[k + 1])]); rings.push(r); }
  }
  const all = rings.flat();
  const x0 = Math.min(...all.map((p) => p[0])) - reach - cell, y0 = Math.min(...all.map((p) => p[1])) - reach - cell;
  const W = Math.ceil((Math.max(...all.map((p) => p[0])) + reach + cell - x0) / cell), H = Math.ceil((Math.max(...all.map((p) => p[1])) + reach + cell - y0) / cell);
  let mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) mask[j * W + i] = pointInPolygon([x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell], rings) ? 1 : 0;
  for (let t = 0; t < Math.ceil(reach / cell); t++) {
    const next = mask.slice();
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (!mask[k] && (mask[k - 1] || mask[k + 1] || mask[k - W] || mask[k + W] || (t % 2 && (mask[k - W - 1] || mask[k - W + 1] || mask[k + W - 1] || mask[k + W + 1])))) next[k] = 1;
    }
    mask = next;
  }
  return (p) => {
    const [x, y] = project(p), i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
    return i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
  };
}

const key = ([lon, lat]: LngLat) => `${Math.round(lon * 1e6)},${Math.round(lat * 1e6)}`;

/** joins lines end to end, lowest id first */
export function join(lines: LngLat[][]): LngLat[][] {
  const used = new Uint8Array(lines.length);
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => { for (const p of [l[0], l[l.length - 1]]) { const k = key(p); const a = ends.get(k); if (a) a.push(i); else ends.set(k, [i]); } });
  const take = (at: LngLat): LngLat[] | null => {
    for (const i of ends.get(key(at)) ?? []) {
      if (used[i]) continue;
      used[i] = 1;
      const l = lines[i];
      return key(l[0]) === key(at) ? l : [...l].reverse();
    }
    return null;
  };
  const out: LngLat[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let line = [...lines[i]];
    for (let next = take(line[line.length - 1]); next; next = take(line[line.length - 1])) line = line.concat(next.slice(1));
    for (let prev = take(line[0]); prev; prev = take(line[0])) line = [...prev].reverse().concat(line.slice(1));
    out.push(line);
  }
  return out;
}

function main(): void {
  const t0 = Date.now();
  const db = openGpkg();
  const near = nearCounties();
  const groups = new Map<string, { cls: number; ref: string; name: string; lines: LngLat[][] }>();
  const kinds = Object.keys(CLS).flatMap((k) => [`'${k}'`, `'${k}_link'`]).join(',');
  for (const f of features<{ fclass: string; name: string | null; ref: string | null }>(db, 'gis_osm_roads_free', `fclass in (${kinds})`, 'osm_id, fclass, name, ref')) {
    if (f.geom.type !== 'lines' || !f.geom.lines.some((l) => l.some(near))) continue;
    // links take their parent's class
    const cls = CLS[f.fclass.replace(/_link$/, '')], ref = lastRef(f.ref), name = shortName(f.name ?? '');
    const k = `${cls}|${ref}|${name}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { cls, ref, name, lines: [] }));
    for (const l of f.geom.lines) if (l.length > 1) g.lines.push(l);
  }
  const P = localProjection();
  const roads: (number | string)[][] = [];
  for (const g of groups.values()) {
    for (const line of join(g.lines)) {
      const xy = line.map(P.toXY);
      if (polylineLength(xy) < MIN_LEN) continue;
      const d = deltas(simplify(xy, TOL).map(P.toLngLat));
      if (d.length >= 4) roads.push([g.cls, g.ref, g.name, ...d]);
    }
  }
  roads.sort((a, b) => (b[0] as number) - (a[0] as number) || String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2]))
    || (a[3] as number) - (b[3] as number) || (a[4] as number) - (b[4] as number));
  const text = JSON.stringify({ v: 1, credit: CREDIT, roads });
  writeFileSync('public/data/majorroads.json', text);
  const n = roads.reduce((s, r) => s + (r.length - 3) / 2, 0);
  console.log(`majorroads.json ${(text.length / 1024).toFixed(0)} KB: ${roads.length} roads, ${n} points (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

if (import.meta.main) main();
