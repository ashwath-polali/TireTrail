// Writes public/data/coverage.json: the outline of everywhere TireTrail has traced storm drains,
// shown in yellow on the zoomed-out map. Cities with almost no traced streets stay out.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeCoords, KINDS, type Bundle } from '../src/data/bundle.ts';
import { pointInPolygon, simplify, type XY } from '../src/geo/geo.ts';
import { project } from './lib/lcc.ts';

const CELL = 250; // meters
const NEAR = 2; // cells of reach around a traced street
const CLOSE = 4; // cells: joins neighborhoods up to about 2 km apart
const MIN_CELLS = 16; // specks under 1 km² are dropped
const CITY_SHARE = 0.05; // a city with fewer of its cells traced stays out

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const bundles: Bundle[] = [read('public/data/tiretrail.json')];
for (const a of read('public/data/areas/index.json') as { id: string }[]) bundles.push(read(`public/data/areas/${a.id}.json`));

// streets with a traced storm drain, in the region map's coordinates (a roadside ditch taking a street's rain isn't one)
const CHANNEL = KINDS.indexOf('channel');
const lines: XY[][] = [];
for (const b of bundles) {
  b.streets.runs.geom.forEach((g, i) => {
    const d = b.streets.runs.drain[i];
    if (d >= 0 && b.assets.kind[b.drains.asset[d]] !== CHANNEL) lines.push(decodeCoords(g).map(project));
  });
}

let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const l of lines) for (const [x, y] of l) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
const pad = (NEAR + CLOSE + 2) * CELL;
[x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
const W = Math.ceil((x1 - x0) / CELL), H = Math.ceil((y1 - y0) / CELL);
const cell = (x: number, y: number) => Math.floor((y - y0) / CELL) * W + Math.floor((x - x0) / CELL);

// cells a traced street passes through
const seen = new Uint8Array(W * H);
for (const l of lines) for (let k = 1; k < l.length; k++) {
  const [a, b] = [l[k - 1], l[k]], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2)));
  for (let s = 0; s <= n; s++) seen[cell(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n)] = 1;
}

/** v = 1 grows the mask by one cell per pass, v = 0 shrinks it */
function grow(m: Uint8Array, passes: number, v: 0 | 1): Uint8Array {
  let cur = m;
  for (let t = 0; t < passes; t++) {
    const next = cur.slice();
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (cur[k] === v) continue;
      if (cur[k - 1] === v || cur[k + 1] === v || cur[k - W] === v || cur[k + W] === v
        || cur[k - W - 1] === v || cur[k - W + 1] === v || cur[k + W - 1] === v || cur[k + W + 1] === v) next[k] = v;
    }
    cur = next;
  }
  return cur;
}
const mask = grow(grow(grow(seen, NEAR, 1), CLOSE, 1), CLOSE, 0);

// cities with almost no traced streets (no public pipe map yet) stay out
const ring = (d: number[]): XY[] => { const out: XY[] = []; let x = 0, y = 0; for (let k = 0; k < d.length; k += 2) out.push([(x += d[k]), (y += d[k + 1])]); return out; };
const kept: string[] = [], left: string[] = [];
for (const pl of read('public/data/region.json').places as { name: string; rings: number[][] }[]) {
  const rings = pl.rings.map(ring);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) [bx0, by0, bx1, by1] = [Math.min(bx0, x), Math.min(by0, y), Math.max(bx1, x), Math.max(by1, y)];
  const inside: number[] = [];
  let traced = 0;
  for (let j = Math.max(0, Math.floor((by0 - y0) / CELL)); j <= Math.min(H - 1, Math.floor((by1 - y0) / CELL)); j++) {
    for (let i = Math.max(0, Math.floor((bx0 - x0) / CELL)); i <= Math.min(W - 1, Math.floor((bx1 - x0) / CELL)); i++) {
      if (!pointInPolygon([x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL], rings)) continue;
      inside.push(j * W + i);
      traced += seen[j * W + i];
    }
  }
  if (!inside.length) continue;
  if (traced >= inside.length * CITY_SHARE) { kept.push(pl.name); continue; }
  left.push(pl.name);
  for (const k of inside) mask[k] = 0;
}

// drop specks
const comp = new Int32Array(W * H).fill(-1);
for (let s = 0; s < W * H; s++) {
  if (!mask[s] || comp[s] >= 0) continue;
  const stack = [s], members: number[] = [];
  comp[s] = s;
  while (stack.length) {
    const k = stack.pop()!;
    members.push(k);
    for (const q of [k - 1, k + 1, k - W, k + W]) if (q >= 0 && q < W * H && mask[q] && comp[q] < 0) { comp[q] = s; stack.push(q); }
  }
  if (members.length < MIN_CELLS) for (const k of members) mask[k] = 0;
}

// outline: walk the cell edges between inside and outside, then smooth the steps
const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
const edges = new Map<number, number[]>(); // from corner -> to corners
const corner = (i: number, j: number) => j * (W + 1) + i;
const addEdge = (a: number, b: number) => { const l = edges.get(a); if (l) l.push(b); else edges.set(a, [b]); };
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  if (!filled(i, j)) continue;
  if (!filled(i, j - 1)) addEdge(corner(i + 1, j), corner(i, j));
  if (!filled(i, j + 1)) addEdge(corner(i, j + 1), corner(i + 1, j + 1));
  if (!filled(i - 1, j)) addEdge(corner(i, j), corner(i, j + 1));
  if (!filled(i + 1, j)) addEdge(corner(i + 1, j + 1), corner(i + 1, j));
}
const rings: XY[][] = [];
for (const [start, outs] of edges) {
  while (outs.length) {
    const pts: XY[] = [];
    let at = start, next = outs.pop()!;
    for (;;) {
      pts.push([x0 + (at % (W + 1)) * CELL, y0 + Math.floor(at / (W + 1)) * CELL]);
      at = next;
      if (at === start) break;
      const l = edges.get(at)!;
      next = l.pop()!;
    }
    if (pts.length >= 4) {
      const smooth = simplify([...pts, pts[0]], CELL * 0.9).slice(0, -1);
      if (smooth.length >= 3) rings.push(smooth);
    }
  }
}

const encode = (pts: XY[]): number[] => {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [x, y] of pts) { const rx = Math.round(x), ry = Math.round(y); out.push(rx - px, ry - py); [px, py] = [rx, ry]; }
  return out;
};
const out = JSON.stringify({ cell: CELL, rings: rings.map(encode) });
writeFileSync('public/data/coverage.json', out);
const km2 = mask.reduce((n, v) => n + v, 0) * (CELL / 1000) ** 2;
console.log(`coverage: ${Math.round(km2)} km² in ${rings.length} rings, ${(out.length / 1024).toFixed(1)} KB`);
console.log(`  cities kept: ${kept.join(', ') || 'none'}`);
console.log(`  cities left out (no public pipe map yet): ${left.join(', ') || 'none'}`);
