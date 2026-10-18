// Writes public/data/sea.json: the salt water of Puget Sound and its inlets inside the box, so it draws as water up close.
// OSM's coastline isn't in the Geofabrik GeoPackage, and the census county outlines miss small bays (Gig Harbor).
// So this uses the marine polygons (USGS NHD, Pierce County and King County GIS) in the county job's source cache,
// .cache/sources/context/waters-*.ndjson (read only). Set SEA_SOURCES to use another folder.
import { closeSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { localProjection, pointInPolygon, simplify, type LngLat, type XY } from '../src/geo/geo.ts';
import { BOX } from './build-labels.ts';
import { deltas } from './build-majorroads.ts';
import { project } from './lib/lcc.ts';

const SRC = process.env.SEA_SOURCES ?? '.cache/sources/context';
const CELL = 5; // meters
const TOL = 5; // meters
const CLOSE = 2; // cells: seals slivers between polygons from different sources
const MIN_CELLS = 200; // drops water specks under 5,000 m²

type Poly = LngLat[][];

// land in the census county outlines, to tell salt bays from lake bays
function onLand(): (p: LngLat) => boolean {
  const region = JSON.parse(readFileSync('public/data/region.json', 'utf8'));
  const counties: XY[][][] = region.counties.map((c: { rings: number[][] }) => c.rings.map((d) => {
    const r: XY[] = [];
    let x = 0, y = 0;
    for (let k = 0; k < d.length; k += 2) r.push([(x += d[k]), (y += d[k + 1])]);
    return r;
  }));
  return (p) => { const xy = project(p); return counties.some((rings) => pointInPolygon(xy, rings)); };
}

/** the lines of a big text file, read in pieces */
function* lines(file: string): Generator<string> {
  const fd = openSync(file, 'r'), buf = Buffer.alloc(1 << 24), dec = new StringDecoder('utf8');
  let rest = '';
  try {
    for (let got; (got = readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const parts = (rest + dec.write(buf.subarray(0, got))).split('\n');
      rest = parts.pop()!;
      yield* parts;
    }
    if (rest) yield rest;
  } finally {
    closeSync(fd);
  }
}

function marinePolys(): Poly[] {
  const land = onLand();
  const out: Poly[] = [];
  const files = readdirSync(SRC).filter((f) => /^waters-.*\.ndjson$/.test(f)).sort();
  if (!files.length) throw new Error(`no waters-*.ndjson in ${SRC}`);
  for (const f of files) {
    for (const line of lines(`${SRC}/${f}`)) {
      if (!line.includes('"polygons"') || !(line.includes('"marine"') || line.includes('"BayInlet"'))) continue;
      const o = JSON.parse(line) as { kind: string; type: string; polygons: Poly[] };
      for (const p of o.polygons) {
        // some salt bays are filed as lakes; lake bays (Lake Washington's) sit inside the county outlines
        if (o.kind !== 'marine' && (o.type !== 'BayInlet' || land(p[0][0]))) continue;
        out.push(p);
      }
    }
  }
  return out;
}

/** square grow (v = 1) or shrink (v = 0) by r cells, one axis at a time */
function morph(m: Uint8Array, W: number, H: number, r: number, v: 0 | 1): Uint8Array {
  let cur = m;
  for (const [n, step, lines, stride] of [[W, 1, H, W], [H, W, W, 1]] as const) {
    const next = cur.slice();
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      let last = -Infinity; // index of the last cell equal to v
      for (let i = 0; i < n; i++) { if (cur[base + i * step] === v) last = i; else if (i - last <= r) next[base + i * step] = v; }
      last = Infinity;
      for (let i = n - 1; i >= 0; i--) { if (cur[base + i * step] === v) last = i; else if (last - i <= r) next[base + i * step] = v; }
    }
    cur = next;
  }
  return cur;
}

/** a grid of cells, west to east, then north to south */
interface Grid { w: number; n: number; dx: number; dy: number; W: number; H: number }

function grid(cell: number, [w, s, e, n]: readonly number[]): Grid {
  const P = localProjection([(w + e) / 2, (s + n) / 2]);
  const dx = cell / P.metersPerDegLon, dy = cell / P.metersPerDegLat;
  return { w, n, dx, dy, W: Math.ceil((e - w) / dx), H: Math.ceil((n - s) / dy) };
}

/** even-odd scanline fill, one polygon (outer ring and holes) at a time */
function fill(polys: Poly[], { w, n, dx, dy, W, H }: Grid): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (const rings of polys) {
    const rows = new Map<number, number[]>();
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const a = r[i], b = r[k];
      // rows whose centers this edge crosses
      const ja = Math.max(0, Math.ceil((n - Math.max(a[1], b[1])) / dy - 0.5)), jb = Math.min(H - 1, Math.ceil((n - Math.min(a[1], b[1])) / dy - 0.5) - 1);
      for (let j = ja; j <= jb; j++) {
        const y = n - (j + 0.5) * dy;
        if (a[1] > y === b[1] > y) continue;
        const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        const l = rows.get(j);
        if (l) l.push(x); else rows.set(j, [x]);
      }
    }
    for (const [j, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil((xs[q] - w) / dx - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[q + 1] - w) / dx - 0.5));
        if (i1 >= i0) mask.fill(1, j * W + i0, j * W + i1 + 1);
      }
    }
  }
  return mask;
}

function main(): void {
  const t0 = Date.now();
  const polys = marinePolys();
  // a rough pass finds where the water is, then the fine grid covers just that
  const rough = grid(200, BOX), m0 = fill(polys, rough);
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (let k = 0; k < m0.length; k++) if (m0[k]) { const i = k % rough.W, j = Math.floor(k / rough.W); [i0, j0, i1, j1] = [Math.min(i0, i), Math.min(j0, j), Math.max(i1, i), Math.max(j1, j)]; }
  const area = [rough.w + (i0 - 1) * rough.dx, rough.n - (j1 + 2) * rough.dy, rough.w + (i1 + 2) * rough.dx, rough.n - (j0 - 1) * rough.dy];
  const g = grid(CELL, [Math.max(area[0], BOX[0]), Math.max(area[1], BOX[1]), Math.min(area[2], BOX[2]), Math.min(area[3], BOX[3])]);
  const { w, n, dx, dy, W, H } = g;
  const sea = morph(morph(fill(polys, g), W, H, CLOSE, 1), W, H, CLOSE, 0);

  // drop specks
  const seen = new Uint8Array(W * H), QMASK = (1 << 22) - 1, queue = new Int32Array(QMASK + 1);
  for (let k0 = 0; k0 < W * H; k0++) {
    if (!sea[k0] || seen[k0]) continue;
    // breadth first, in a ring buffer: the front line stays short
    const members: number[] = [];
    let head = 0, tail = 0;
    queue[tail++] = k0;
    seen[k0] = 1;
    while (head !== tail) {
      const k = queue[head], i = k % W;
      head = (head + 1) & QMASK;
      if (members.length <= MIN_CELLS) members.push(k);
      for (const q of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W]) {
        if (q < 0 || q >= W * H || !sea[q] || seen[q]) continue;
        seen[q] = 1;
        queue[tail] = q;
        tail = (tail + 1) & QMASK;
        if (tail === head) throw new Error('flood queue full');
      }
    }
    if (members.length < MIN_CELLS) for (const k of members) sea[k] = 0;
  }

  // outline: walk the cell edges between water and land, then smooth the steps
  const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && sea[j * W + i] === 1;
  const edges = new Map<number, number[]>();
  const corner = (i: number, j: number) => j * (W + 1) + i;
  const addEdge = (a: number, b: number) => { const l = edges.get(a); if (l) l.push(b); else edges.set(a, [b]); };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!filled(i, j)) continue;
    if (!filled(i, j - 1)) addEdge(corner(i + 1, j), corner(i, j));
    if (!filled(i, j + 1)) addEdge(corner(i, j + 1), corner(i + 1, j + 1));
    if (!filled(i - 1, j)) addEdge(corner(i, j), corner(i, j + 1));
    if (!filled(i + 1, j)) addEdge(corner(i + 1, j + 1), corner(i + 1, j));
  }
  const rings: number[][] = [];
  let points = 0;
  for (const [start, outs] of edges) {
    while (outs.length) {
      const pts: XY[] = [];
      let at = start, next = outs.pop()!;
      for (;;) {
        pts.push([(at % (W + 1)) * CELL, -Math.floor(at / (W + 1)) * CELL]);
        at = next;
        if (at === start) break;
        next = edges.get(at)!.pop()!;
      }
      if (pts.length < 4) continue;
      const smooth = simplify([...pts, pts[0]], TOL).slice(0, -1);
      if (smooth.length < 3) continue;
      points += smooth.length;
      rings.push(deltas(smooth.map(([x, y]): LngLat => [w + (x / CELL) * dx, n + (y / CELL) * dy])));
    }
  }
  const text = JSON.stringify({ v: 1, rings });
  writeFileSync('public/data/sea.json', text);
  const km2 = sea.reduce((a, v) => a + v, 0) * (CELL / 1000) ** 2;
  console.log(`sea.json ${(text.length / 1024).toFixed(0)} KB: ${Math.round(km2)} km² of water in ${rings.length} rings, ${points} points, from ${polys.length} polygons (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

if (import.meta.main) main();
