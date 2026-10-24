// Gives built area files their lakes' islands without a retrace. Each lake ring takes the inner rings of the
// King or Pierce outline with the same name and box. Files built after the encode.ts fix have them already.
//   node scripts/patch-islands.ts [--dry]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeCoords, encodeCoords } from '../src/data/bundle.ts';
import { MIN_ISLAND_M2 } from '../src/data/encode.ts';
import { localProjection, pointInPolygon, polygonsArea, simplify, type LngLat } from '../src/geo/geo.ts';

const CACHE = process.env.TT_CACHE ?? '.cache';
const DRY = process.argv.includes('--dry');
// encode.ts DISPLAY_TOL_M
const TOL_M = 1;
// the same outline: every edge of the two boxes within about 40 m
const SAME_DEG = 0.0005;
// another source's outline of the lake: within about 250 m, and only islands wholly inside the ring
const NEAR_DEG = 0.003;

type Box = [number, number, number, number];
const boxOf = (r: readonly LngLat[]): Box => {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of r) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
};
const within = (a: Box, b: Box, deg: number) => a.every((v, i) => Math.abs(v - b[i]) < deg);
const key = (name: unknown) => String(name ?? '').trim().toLowerCase();

const outlines = new Map<string, { box: Box; holes: LngLat[][] }[]>();
for (const county of ['king', 'pierce']) {
  for (const line of readFileSync(`${CACHE}/sources/context/waters-${county}.ndjson`, 'utf8').split('\n')) {
    if (!line) continue;
    const w = JSON.parse(line) as { name?: string; polygons?: LngLat[][][] };
    for (const rings of w.polygons ?? []) {
      if (rings.length < 2) continue;
      const list = outlines.get(key(w.name)) ?? [];
      list.push({ box: boxOf(rings[0]), holes: rings.slice(1) });
      outlines.set(key(w.name), list);
    }
  }
}

function encodeHole(ring: readonly LngLat[]): number[] | null {
  const proj = localProjection(ring[0]);
  const s = simplify(ring.map((p) => proj.toXY(p)), TOL_M);
  return s.length >= 4 && polygonsArea([[s]]) >= MIN_ISLAND_M2 ? encodeCoords(s.map((p) => proj.toLngLat(p))) : null;
}

/** The islands for one lake ring, worked out once per name and box. */
const memo = new Map<string, number[][]>();
function islandsFor(name: string, enc: readonly number[]): number[][] {
  const ring = decodeCoords(enc), box = boxOf(ring), id = `${key(name)}|${box.join(',')}|${ring.length}`;
  const hit = memo.get(id);
  if (hit) return hit;
  const cands = outlines.get(key(name)) ?? [];
  const same = cands.find((c) => within(c.box, box, SAME_DEG));
  const near = same ? null : cands.find((c) => within(c.box, box, NEAR_DEG));
  const holes = same ? same.holes : near ? near.holes.filter((h) => h.every((p) => pointInPolygon(p, [ring]))) : [];
  const out = holes.map(encodeHole).filter((h): h is number[] => h !== null);
  memo.set(id, out);
  return out;
}

interface BundleWater { name: string; kind: string; fennel: boolean; lines: number[][]; rings: number[][]; holes?: number[][][] }

const indexPath = 'public/data/areas/index.json';
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { id: string; bytes: number }[];
const files = [...index.map((a) => `public/data/areas/${a.id}.json`), 'public/data/tiretrail.json'];
let changed = 0, lakes = 0, islands = 0, added = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const b = JSON.parse(text) as { waters: BundleWater[] };
  if (JSON.stringify(b) !== text) throw new Error(`${f} doesn't round-trip, so it isn't rewritten`);
  let touched = false;
  b.waters = b.waters.map((w): BundleWater => {
    if (!w.rings.length || !outlines.has(key(w.name))) return w;
    const holes = w.rings.map((r) => islandsFor(w.name, r));
    if (!holes.some((h) => h.length)) return w;
    touched = true;
    lakes += holes.filter((h) => h.length).length;
    islands += holes.reduce((n, h) => n + h.length, 0);
    const { holes: _, ...rest } = w;
    return { ...rest, holes };
  });
  if (!touched) continue;
  changed++;
  const out = JSON.stringify(b);
  added += out.length - text.length;
  const area = index.find((a) => f.endsWith(`/${a.id}.json`));
  if (area) area.bytes = Buffer.byteLength(out);
  if (!DRY) writeFileSync(f, out);
}
if (!DRY) writeFileSync(indexPath, JSON.stringify(index, null, 1));
const big = index.filter((a) => a.bytes > 1.5e6).map((a) => `${a.id} ${a.bytes}`);
if (big.length) console.log("over 1.5 MB:", big.join(", "));
console.log(`${DRY ? 'would patch' : 'patched'} ${changed} of ${files.length} files: ${lakes} lake rings, ${islands} islands, +${(added / 1e6).toFixed(2)} MB`);
