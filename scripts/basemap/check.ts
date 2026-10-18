// Checks built basemap tiles: the format, sizes, the app's own decoder, and a few known places.
// Usage: node scripts/basemap/check.ts [dir]
import { readFileSync, statSync } from 'node:fs';
import { decode } from '../../src/app/map/basemap.ts';
import { localProjection, type LngLat } from '../../src/geo/geo.ts';

const DIR = process.argv[2] ?? 'public/data/basemap';
const MAX = 1 << 20;
const P = localProjection();
const xy = (p: LngLat) => { const q = P.toXY(p); return [q[0], -q[1]] as const; };
// [name, lon, lat, cover class the app decodes (5 is the sea), or 0 for land]
const PLACES: [string, number, number, number][] = [
  ['Commencement Bay', -122.44, 47.27, 5],
  ['Elliott Bay', -122.36, 47.6, 5],
  ['Gig Harbor', -122.583, 47.333, 5],
  ['Quartermaster Harbor', -122.47, 47.38, 5],
  ['Lake Washington', -122.25, 47.62, 4],
  ['Lake Tapps', -122.18, 47.235, 4],
  ['Bonney Lake town', -122.17, 47.18, 0],
  ['downtown Tacoma', -122.44, 47.253, 0],
  ['downtown Seattle', -122.335, 47.607, 0],
];

interface Raw { b: number[]; c: [number, ...number[][]][]; cn?: number[]; r: number[][]; rn?: number[]; rc?: number[]; rf?: number[]; n?: string[] }
const index = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8')) as { v?: number; tile: number; unit: number; tiles: string[] };
const fail: string[] = [];
let bytes = 0, biggest = 0, biggestKey = '', buildings = 0, roads = 0;
const cover = [0, 0, 0, 0, 0, 0];
const tiles = new Map<string, ReturnType<typeof decode>>();
for (const k of index.tiles) {
  const size = statSync(`${DIR}/${k}.json`).size;
  bytes += size;
  if (size > biggest) [biggest, biggestKey] = [size, k];
  if (size > MAX) fail.push(`${k}: ${size} bytes, over 1 MB`);
  const raw = JSON.parse(readFileSync(`${DIR}/${k}.json`, 'utf8')) as Raw;
  const n = raw.n?.length ?? 0;
  const same = (f: keyof Raw, of: unknown[]) => { if (raw[f] && (raw[f] as unknown[]).length !== of.length) fail.push(`${k}: ${f} has ${(raw[f] as unknown[]).length}, not ${of.length}`); };
  same('cn', raw.c); same('rn', raw.r); same('rc', raw.r); same('rf', raw.r);
  if (index.v === 2 && !(raw.cn && raw.rc && raw.rf)) fail.push(`${k}: v2 tile without cn, rc or rf`);
  for (const f of ['cn', 'rn', 'rf'] as const) if (raw[f]?.some((i) => !Number.isInteger(i) || i < 0 || i > n)) fail.push(`${k}: ${f} points past n`);
  if (raw.rc?.some((c) => c < 1 || c > 5)) fail.push(`${k}: rc outside 1 to 5`);
  if (raw.c.some(([c]) => c < 0 || c > 4)) fail.push(`${k}: cover class outside 0 to 4`);
  const [tx, ty] = k.split('_').map(Number);
  const t = decode(raw, tx * index.tile, ty * index.tile, index.unit);
  if ([...t.bv].some((v) => !Number.isFinite(v)) || t.roads.some((r) => [...r.pts].some((v) => !Number.isFinite(v)))) fail.push(`${k}: decodes to bad numbers`);
  buildings += t.bs.length - 1;
  roads += t.roads.length;
  for (const c of t.cover) cover[c.cls]++;
  tiles.set(k, t);
}
// what covers each place, the way the renderer fills (even-odd per piece)
for (const [name, lon, lat, want] of PLACES) {
  const [x, y] = xy([lon, lat]), t = tiles.get(`${Math.floor(x / index.tile)}_${Math.floor(y / index.tile)}`);
  const got = new Set<number>();
  for (const c of t?.cover ?? []) {
    let inside = false;
    for (let r = 0; r < c.ranges.length; r += 2) for (let i = c.ranges[r], j = c.ranges[r + 1] - 1; i < c.ranges[r + 1]; j = i++) {
      const ax = c.pts[2 * i], ay = c.pts[2 * i + 1], bx = c.pts[2 * j], by = c.pts[2 * j + 1];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) got.add(c.cls);
  }
  const ok = want ? got.has(want) : !got.has(4) && !got.has(5);
  if (!ok) fail.push(`${name}: wanted ${want ? `class ${want}` : 'land'}, found ${[...got].join(', ') || 'nothing'}`);
}
console.log(`${DIR}: v${index.v ?? 1}, ${index.tiles.length} tiles, ${(bytes / 1024 ** 2).toFixed(1)} MB, largest ${biggestKey} ${(biggest / 1024).toFixed(0)} KB`);
console.log(`  ${buildings} buildings, ${roads} roads, cover pieces by class ${cover.slice(1).join(' / ')} (forest / park / grass / water / sea)`);
console.log(fail.length ? `PROBLEMS (${fail.length}):\n${fail.slice(0, 40).join('\n')}` : `  all good, and ${PLACES.length} known places land on the right cover`);
process.exitCode = fail.length ? 1 : 0;
