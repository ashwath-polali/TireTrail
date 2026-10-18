// Writes public/data/state/: the land itself, statewide, for the region map and for close views outside the town basemap.
// - t<L>/<x>_<y>.png: pixel hillshade and land cover in the region map's projection (scripts/lib/lcc.ts),
//   200 m cells at level 0, doubling per level; one gray byte per cell (cellCode below).
// - far.json, mid.json and near/<x>_<y>.json: lakes, rivers and big roads, thinned for each zoom.
// Sources: AWS Terrain Tiles (terrarium PNG; USGS 3DEP and SRTM in the US), fetched once into .cache/terrain/terrarium,
// and each state's Geofabrik GeoPackage of OpenStreetMap (read only).
// Another state later: add it to scripts/lib/states.ts.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { simplify, type LngLat, type XY } from '../src/geo/geo.ts';
import { CREDIT, features, openGpkg, polyArea, type Poly } from './build-labels.ts';
import { join } from './build-majorroads.ts';
import { project, unproject } from './lib/lcc.ts';
import { decodePng, encodeGray } from './lib/png.ts';
import { STATES, type StateSource } from './lib/states.ts';

const OUT = 'public/data/state';
const DEM_CACHE = '.cache/terrain/terrarium';
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const DEM_Z = 10; // about 100 m a pixel here
export const CELL = 200; // m, level 0
export const TILE = 256; // cells a side
export const LEVELS = 5; // 200, 400, 800, 1600, 3200 m
const SUB = 2; // elevation samples per cell, each way, at level 0
const GROW = 3; // cells past the state's edge, so the land meets its outline
/** shades, darkest first; light from the northwest */
export const SHADES = 6;
const FLAT = 3;
/** land cover: 0 land, 1 towns (OSM homes, shops and works), 2 rock and ice (OSM glaciers, and above HIGH) */
export const COVERS = 3;
/** a cell's byte: 0 outside, else 8 * (1 + shade + SHADES * cover), spread out so a browser's decode can't blur it */
export const cellCode = (shade: number, cover: number) => 8 * (1 + shade + SHADES * cover);
const HIGH = 2000; // m: rock and snow above this
// vertical exaggeration per level, so hills still show as cells grow
const EXAGGERATE = [2.2, 2.8, 3.6, 4.6, 5.8];
// brightness against flat ground where each shade starts (the first is 0)
const STEPS = [0.6, 0.79, 0.93, 1.07, 1.19];

// OSM's farm and forest areas stop at the edges of old imports, so they would draw squares that aren't there
const TOWN = ['residential', 'commercial', 'industrial', 'retail'];

/** zoom tiers for the lines and lakes (state.ts picks one by zoom): lakes from this many m², lines thinned to this many m, rivers from this long, road classes */
export const TIERS = {
  far: { lakeM2: 1.5e6, tol: 300, river: 150000, roads: [5, 4] },
  mid: { lakeM2: 2e5, tol: 60, river: 25000, roads: [5, 4, 3] },
  near: { lakeM2: 1e4, tol: 8, river: 0, roads: [5, 4, 3, 2] },
} as const;
type Tier = keyof typeof TIERS;
const ROAD_CLS: Record<string, number> = { motorway: 5, trunk: 4, primary: 3, secondary: 2 };
/** near tiles are level-0 terrain tiles: 51.2 km */
export const NEAR = CELL * TILE;

// ---------- elevation ----------

const N = 256 * 2 ** DEM_Z;
const tileX = (lon: number) => ((lon + 180) / 360) * N;
const tileY = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N;

async function fetchDem(boxes: readonly (readonly number[])[]): Promise<Map<number, Float32Array>> {
  const want: [number, number][] = [];
  for (const [w, s, e, n] of boxes) {
    for (let x = Math.floor(tileX(w - 0.05) / 256); x <= Math.floor(tileX(e + 0.05) / 256); x++) {
      for (let y = Math.floor(tileY(n + 0.05) / 256); y <= Math.floor(tileY(s - 0.05) / 256); y++) want.push([x, y]);
    }
  }
  const tiles = new Map<number, Float32Array>();
  let got = 0;
  const one = async ([x, y]: [number, number]) => {
    const f = `${DEM_CACHE}/${DEM_Z}/${x}/${y}.png`;
    if (!existsSync(f)) {
      for (let tries = 0; ; tries++) {
        try {
          const res = await fetch(`${DEM_URL}/${DEM_Z}/${x}/${y}.png`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          mkdirSync(`${DEM_CACHE}/${DEM_Z}/${x}`, { recursive: true });
          writeFileSync(f, Buffer.from(await res.arrayBuffer()));
          got++;
          break;
        } catch (e) {
          if (tries >= 4) throw new Error(`terrain tile ${DEM_Z}/${x}/${y}: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 1000 * (tries + 1)));
        }
      }
    }
    const { w, h, channels, data } = decodePng(readFileSync(f));
    if (w !== 256 || h !== 256 || channels !== 3) throw new Error(`${f}: not a terrarium tile`);
    const el = new Float32Array(256 * 256);
    for (let k = 0; k < el.length; k++) el[k] = data[3 * k] * 256 + data[3 * k + 1] + data[3 * k + 2] / 256 - 32768;
    tiles.set(x * 65536 + y, el);
  };
  for (let k = 0; k < want.length; k += 12) await Promise.all(want.slice(k, k + 12).map(one));
  console.log(`terrain: ${want.length} tiles at z${DEM_Z} (${got} fetched)`);
  return tiles;
}

/** elevation in m at lon/lat, bilinear between pixel centers; NaN off the tiles */
function sampler(tiles: Map<number, Float32Array>): (lon: number, lat: number) => number {
  let lastKey = -1, last: Float32Array | undefined;
  const px = (x: number, y: number) => {
    const key = (x >> 8) * 65536 + (y >> 8);
    if (key !== lastKey) [lastKey, last] = [key, tiles.get(key)];
    return last ? last[(y & 255) * 256 + (x & 255)] : NaN;
  };
  return (lon, lat) => {
    const fx = tileX(lon) - 0.5, fy = tileY(lat) - 0.5, x = Math.floor(fx), y = Math.floor(fy), u = fx - x, v = fy - y;
    return (px(x, y) * (1 - u) + px(x + 1, y) * u) * (1 - v) + (px(x, y + 1) * (1 - u) + px(x + 1, y + 1) * u) * v;
  };
}

// ---------- grids ----------

/** A level's cells: global cell index i0 + i across, j0 + j down; cell size `cell` m. */
interface Grid { i0: number; j0: number; w: number; h: number; cell: number }

/** Even-odd fill of rings (region meters) at cell centers; `val` goes into cells where `keep(k)` says. */
function fillRings(buf: Uint8Array, g: Grid, rings: readonly (readonly XY[])[], val: number, keep: (k: number) => boolean = () => true): void {
  const rows = new Map<number, number[]>();
  for (const r of rings) for (let k = 0, p = r.length - 1; k < r.length; p = k++) {
    const ya = r[p][1] / g.cell - g.j0 - 0.5, yb = r[k][1] / g.cell - g.j0 - 0.5;
    if (ya === yb) continue;
    const xa = r[p][0] / g.cell - g.i0 - 0.5, xb = r[k][0] / g.cell - g.i0 - 0.5;
    for (let j = Math.max(0, Math.ceil(Math.min(ya, yb))); j <= Math.min(g.h - 1, Math.ceil(Math.max(ya, yb)) - 1); j++) {
      const x = xa + ((j - ya) * (xb - xa)) / (yb - ya), l = rows.get(j);
      if (l) l.push(x); else rows.set(j, [x]);
    }
  }
  for (const [j, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      for (let i = Math.max(0, Math.ceil(xs[q])); i <= Math.min(g.w - 1, Math.ceil(xs[q + 1]) - 1); i++) {
        const k = j * g.w + i;
        if (keep(k)) buf[k] = val;
      }
    }
  }
}

/** Square grow of nonzero cells by r, the new ones taking a neighbor's value. */
function grow(buf: Uint8Array, g: Grid, r: number): void {
  for (let t = 0; t < r; t++) {
    const prev = buf.slice();
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const k = j * g.w + i;
      if (prev[k]) continue;
      const v = (i > 0 && prev[k - 1]) || (i + 1 < g.w && prev[k + 1]) || (j > 0 && prev[k - g.w]) || (j + 1 < g.h && prev[k + g.w])
        || (i > 0 && j > 0 && prev[k - g.w - 1]) || (i + 1 < g.w && j + 1 < g.h && prev[k + g.w + 1]) || (i > 0 && j + 1 < g.h && prev[k + g.w - 1]) || (i + 1 < g.w && j > 0 && prev[k - g.w + 1]);
      if (v) buf[k] = v;
    }
  }
}

/** The next level up: half the cells each way. */
const half = (g: Grid): Grid => ({ i0: g.i0 >> 1, j0: g.j0 >> 1, w: g.w >> 1, h: g.h >> 1, cell: g.cell * 2 });

function meanDown(a: Float32Array, g: Grid): Float32Array {
  const G = half(g), out = new Float32Array(G.w * G.h);
  for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
    const k = 2 * j * g.w + 2 * i;
    out[j * G.w + i] = (a[k] + a[k + 1] + a[k + g.w] + a[k + g.w + 1]) / 4;
  }
  return out;
}

/** Most common of the four, ties to plain land (the lower class), so small patches don't grow as cells do. */
/** In the state if any of the four is. */
function anyDown(a: Uint8Array, g: Grid): Uint8Array {
  const G = half(g), out = new Uint8Array(G.w * G.h);
  for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
    const k = 2 * j * g.w + 2 * i;
    out[j * G.w + i] = a[k] || a[k + 1] || a[k + g.w] || a[k + g.w + 1];
  }
  return out;
}

function modeDown(a: Uint8Array, g: Grid): Uint8Array {
  const G = half(g), out = new Uint8Array(G.w * G.h), n = new Uint8Array(256);
  for (let j = 0; j < G.h; j++) for (let i = 0; i < G.w; i++) {
    const k = 2 * j * g.w + 2 * i, q = [a[k], a[k + 1], a[k + g.w], a[k + g.w + 1]];
    let best = 0;
    for (const v of q) n[v]++;
    for (const v of q) if (n[v] > n[best] || (n[v] === n[best] && v < best)) best = v;
    for (const v of q) n[v] = 0;
    out[j * G.w + i] = best;
  }
  return out;
}

/** Shade index per cell (Horn's slopes, light from the northwest at 45 degrees). */
function hillshade(dem: Float32Array, g: Grid, z: number): Uint8Array {
  const out = new Uint8Array(g.w * g.h), at = (i: number, j: number) => dem[Math.min(g.h - 1, Math.max(0, j)) * g.w + Math.min(g.w - 1, Math.max(0, i))];
  const lx = -0.5, ly = 0.5, lz = Math.SQRT1_2; // east, north, up
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
    const a = at(i - 1, j - 1), b = at(i, j - 1), c = at(i + 1, j - 1), d = at(i - 1, j), f = at(i + 1, j), gg = at(i - 1, j + 1), h = at(i, j + 1), ii = at(i + 1, j + 1);
    // rows run south, so north is up the grid
    const dx = ((c + 2 * f + ii) - (a + 2 * d + gg)) / (8 * g.cell), dn = ((a + 2 * b + c) - (gg + 2 * h + ii)) / (8 * g.cell);
    const nx = -z * dx, ny = -z * dn, len = Math.hypot(nx, ny, 1);
    const lit = Math.max(0, (nx * lx + ny * ly + lz) / len) / lz;
    let s = 0;
    while (s < STEPS.length && lit >= STEPS[s]) s++;
    out[j * g.w + i] = Number.isNaN(lit) ? FLAT : s;
  }
  return out;
}

/** Twice over: a cell is `cls` when 4 of the 9 around it are; the ones it stops being go back to land. */
function smooth(cover: Uint8Array, g: Grid, cls: number): void {
  for (let pass = 0; pass < 2; pass++) {
    const src = cover.slice();
    for (let j = 1; j < g.h - 1; j++) for (let i = 1; i < g.w - 1; i++) {
      const k = j * g.w + i;
      let c = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (src[k + b * g.w + a] === cls) c++;
      if (c >= 4) cover[k] = cls;
      else if (src[k] === cls) cover[k] = 0;
    }
  }
}

// ---------- the state outlines and OSM ----------

const rings = (d: number[][]): XY[][] => d.map((r) => { const o: XY[] = []; let x = 0, y = 0; for (let k = 0; k < r.length; k += 2) o.push([(x += r[k]), (y += r[k + 1])]); return o; });

function outline(id: string): XY[][] {
  const region = JSON.parse(readFileSync('public/data/region.json', 'utf8'));
  const d = region.detail.find((q: { id: string }) => q.id === id) ?? region.states.find((q: { id: string }) => q.id === id);
  if (!d) throw new Error(`no outline for ${id} in region.json`);
  return rings(d.rings);
}

const projRing = (r: readonly LngLat[]): XY[] => r.map(project);

/** OSM land cover into the level-0 cover grid, inside the state's cells */
function landCover(db: DatabaseSync, st: StateSource, cover: Uint8Array, mask: Uint8Array, g: Grid, sid: number): void {
  const t0 = Date.now(), own = (k: number) => mask[k] === sid;
  let n = 0;
  for (const f of features(db, 'gis_osm_landuse_a_free', `fclass in (${TOWN.map((k) => `'${k}'`).join(',')})`, 'osm_id, fclass', st.box)) {
    if (f.geom.type === 'polys') for (const p of f.geom.polys) { fillRings(cover, g, p.map(projRing), 1, own); n++; }
  }
  // towns as blocks, not specks
  smooth(cover, g, 1);
  for (const t of ['gis_osm_water_a_free', 'gis_osm_natural_a_free']) {
    for (const f of features(db, t, `fclass = 'glacier'`, 'osm_id, fclass', st.box)) if (f.geom.type === 'polys') for (const p of f.geom.polys) { fillRings(cover, g, p.map(projRing), 2, own); n++; }
  }
  console.log(`${st.id} land cover: ${n} polygons (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- terrain ----------

/** Writes the terrain tiles. Returns their names per level, and a test for "in a state, or just past its edge". */
async function terrain(): Promise<{ keys: Record<string, string[]>; inState: (p: XY) => boolean }> {
  const t0 = Date.now();
  // level-0 cells over every state's outline, lined up so each level's cells hold four of the one below
  const outs = STATES.map((s) => outline(s.id));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of outs) for (const r of o) for (const [x, y] of r) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const A = 1 << (LEVELS - 1);
  const i0 = Math.floor(Math.floor(x0 / CELL - GROW - 1) / A) * A, j0 = Math.floor(Math.floor(y0 / CELL - GROW - 1) / A) * A;
  const i1 = Math.ceil(Math.ceil(x1 / CELL + GROW + 1) / A) * A, j1 = Math.ceil(Math.ceil(y1 / CELL + GROW + 1) / A) * A;
  const g0: Grid = { i0, j0, w: i1 - i0, h: j1 - j0, cell: CELL };
  console.log(`grid: ${g0.w} x ${g0.h} cells of ${CELL} m`);

  // which state each cell is in, grown a little past the outline
  const mask = new Uint8Array(g0.w * g0.h);
  outs.forEach((o, s) => fillRings(mask, g0, o, s + 1, (k) => mask[k] === 0));
  grow(mask, g0, GROW);

  // elevation: SUB x SUB samples a cell, averaged
  const elev = sampler(await fetchDem(STATES.map((s) => s.box)));
  let dem: Float32Array = new Float32Array(g0.w * g0.h);
  for (let j = 0; j < g0.h; j++) for (let i = 0; i < g0.w; i++) {
    let sum = 0, n = 0;
    for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
      const [lon, lat] = unproject([(g0.i0 + i + (a + 0.5) / SUB) * CELL, (g0.j0 + j + (b + 0.5) / SUB) * CELL]);
      const e = elev(lon, lat);
      if (!Number.isNaN(e)) { sum += e; n++; }
    }
    dem[j * g0.w + i] = n ? sum / n : 0;
  }
  console.log(`elevation sampled (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  let cover: Uint8Array = new Uint8Array(g0.w * g0.h);
  STATES.forEach((st, s) => { const db = openGpkg(st.gpkg); try { landCover(db, st, cover, mask, g0, s + 1); } finally { db.close(); } });
  for (let k = 0; k < cover.length; k++) if (dem[k] >= HIGH) cover[k] = 2;
  // rock and ice as fields, not specks
  smooth(cover, g0, 2);

  rmSync(OUT, { recursive: true, force: true });
  const index: Record<string, string[]> = {};
  let g = g0, m: Uint8Array = mask, bytes = 0, files = 0;
  for (let L = 0; L < LEVELS; L++) {
    const shade = hillshade(dem, g, EXAGGERATE[L]);
    const keys: string[] = [];
    mkdirSync(`${OUT}/t${L}`, { recursive: true });
    for (let ty = Math.floor(g.j0 / TILE); ty <= Math.floor((g.j0 + g.h - 1) / TILE); ty++) {
      for (let tx = Math.floor(g.i0 / TILE); tx <= Math.floor((g.i0 + g.w - 1) / TILE); tx++) {
        const px = new Uint8Array(TILE * TILE);
        let any = false;
        for (let b = 0; b < TILE; b++) for (let a = 0; a < TILE; a++) {
          const i = tx * TILE + a - g.i0, j = ty * TILE + b - g.j0;
          if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
          const k = j * g.w + i;
          if (!m[k]) continue;
          px[b * TILE + a] = cellCode(shade[k], cover[k]);
          any = true;
        }
        if (!any) continue;
        const png = encodeGray(px, TILE, TILE);
        writeFileSync(`${OUT}/t${L}/${tx}_${ty}.png`, png);
        keys.push(`${tx}_${ty}`);
        bytes += png.length;
        files++;
      }
    }
    index[L] = keys;
    console.log(`level ${L}: ${g.cell} m cells, ${keys.length} tiles`);
    if (L + 1 < LEVELS) [dem, cover, m, g] = [meanDown(dem, g), modeDown(cover, g), anyDown(m, g), half(g)];
  }
  console.log(`terrain: ${files} tiles, ${(bytes / 1024).toFixed(0)} KB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const inState = (p: XY) => {
    const i = Math.floor(p[0] / CELL) - g0.i0, j = Math.floor(p[1] / CELL) - g0.j0;
    return i >= 0 && j >= 0 && i < g0.w && j < g0.h && mask[j * g0.w + i] !== 0;
  };
  return { keys: index, inState };
}

// ---------- lakes, rivers, roads ----------

/** integer meters, delta coded: [x0, y0, dx1, dy1, ...]; repeats dropped */
function enc(pts: readonly XY[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [x, y] of pts) {
    const rx = Math.round(x), ry = Math.round(y);
    if (out.length && rx === px && ry === py) continue;
    out.push(rx - px, ry - py);
    [px, py] = [rx, ry];
  }
  return out;
}

const ringArea = (r: readonly XY[]) => { let a = 0; for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]); return Math.abs(a / 2); };
const lineLen = (l: readonly XY[]) => { let s = 0; for (let k = 1; k < l.length; k++) s += Math.hypot(l[k][0] - l[k - 1][0], l[k][1] - l[k - 1][1]); return s; };

/** Sutherland-Hodgman against a box */
function clipRing(ring: readonly XY[], [x0, y0, x1, y1]: readonly number[]): XY[] {
  let out: XY[] = [...ring];
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
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/** the pieces of a line inside a box */
function clipLine(line: readonly XY[], [x0, y0, x1, y1]: readonly number[]): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [];
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k], dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) ok = false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) ok = false; else if (r > t0) t0 = r; } else if (r < t0) ok = false; else if (r < t1) t1 = r;
    }
    if (!ok) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const a: XY = [ax + t0 * dx, ay + t0 * dy], b: XY = [ax + t1 * dx, ay + t1 * dy];
    if (!cur.length) cur.push(a);
    cur.push(b);
    if (t1 < 1) { if (cur.length > 1) out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

const boxOf = (pts: readonly XY[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  return [x0, y0, x1, y1];
};

interface Lake { area: number; rings: XY[][] }
interface Line { cls: number; pts: XY[] }

function readOsm(): { lakes: Lake[]; rivers: { name: string; lines: XY[][] }[]; roads: Map<string, { cls: number; link: boolean; lines: LngLat[][] }> } {
  const lakes: Lake[] = [], byRiver = new Map<string, LngLat[][]>(), roads = new Map<string, { cls: number; link: boolean; lines: LngLat[][] }>();
  for (const st of STATES) {
    const db = openGpkg(st.gpkg);
    try {
      for (const f of features(db, 'gis_osm_water_a_free', `fclass in ('water', 'reservoir', 'riverbank', 'dock')`, 'osm_id, fclass', st.box)) {
        if (f.geom.type !== 'polys') continue;
        for (const p of f.geom.polys as Poly[]) {
          const area = polyArea(p);
          if (area >= TIERS.near.lakeM2) lakes.push({ area, rings: p.map(projRing) });
        }
      }
      let unnamed = 0;
      for (const f of features<{ name: string | null }>(db, 'gis_osm_waterways_free', `fclass = 'river'`, 'osm_id, fclass, name', st.box)) {
        if (f.geom.type !== 'lines') continue;
        const name = f.name || `#${unnamed++}`, l = byRiver.get(name) ?? [];
        l.push(...f.geom.lines.filter((q) => q.length > 1));
        byRiver.set(name, l);
      }
      const kinds = Object.keys(ROAD_CLS).flatMap((k) => [`'${k}'`, `'${k}_link'`]).join(',');
      for (const f of features<{ fclass: string; name: string | null; ref: string | null }>(db, 'gis_osm_roads_free', `fclass in (${kinds})`, 'osm_id, fclass, name, ref', st.box)) {
        if (f.geom.type !== 'lines') continue;
        const link = f.fclass.endsWith('_link'), cls = ROAD_CLS[f.fclass.replace(/_link$/, '')], k = `${cls}|${+link}|${f.ref ?? ''}|${f.name ?? ''}`;
        let g = roads.get(k);
        if (!g) roads.set(k, (g = { cls, link, lines: [] }));
        for (const l of f.geom.lines) if (l.length > 1) g.lines.push(l);
      }
    } finally {
      db.close();
    }
  }
  const rivers = [...byRiver].map(([name, ls]) => ({ name, lines: join(ls).map(projRing) }));
  return { lakes, rivers, roads };
}

interface TierData { lakes: number[][][]; rivers: number[][]; roads: number[][] }

/** The runs of a line that touch the state: a piece goes on while either end of each step is in it. */
function within(pts: readonly XY[], inState: (p: XY) => boolean): XY[][] {
  const out: XY[][] = [], ins = pts.map(inState);
  let cur: XY[] = [];
  for (let k = 1; k < pts.length; k++) {
    if (ins[k - 1] || ins[k]) { if (!cur.length) cur.push(pts[k - 1]); cur.push(pts[k]); } else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function vectors(inState: (p: XY) => boolean): { far: TierData; mid: TierData; near: Map<string, TierData> } {
  const t0 = Date.now();
  const osm = readOsm();
  // the GeoPackage reaches past the state; what lies wholly beyond it stays out
  const lakes = osm.lakes.filter((l) => l.rings[0].some(inState));
  const rivers = osm.rivers.map((r) => ({ name: r.name, lines: r.lines.flatMap((l) => within(l, inState)) })).filter((r) => r.lines.length);
  const joined: Line[] = [];
  for (const g of osm.roads.values()) for (const l of join(g.lines)) for (const p of within(projRing(l), inState)) joined.push({ cls: g.link ? -g.cls : g.cls, pts: p });
  console.log(`OSM: ${lakes.length} lakes, ${rivers.length} rivers, ${joined.length} road lines (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const riverLen = new Map(rivers.map((r) => [r, r.lines.reduce((s, l) => s + lineLen(l), 0)]));

  const thinRings = (rs: XY[][], tol: number, minArea: number) => {
    const out: XY[][] = [];
    rs.forEach((r, k) => {
      const s = simplify([...r, r[0]], tol).slice(0, -1);
      // the outer ring must stay; holes too small to see go
      if (s.length >= 3 && (k === 0 || ringArea(s) >= minArea)) out.push(s);
    });
    return out.length && ringArea(out[0]) >= minArea * 0.25 ? out : null;
  };
  const tier = (t: Tier): { lakes: XY[][][]; rivers: XY[][]; roads: Line[] } => {
    const T = TIERS[t];
    return {
      lakes: lakes.filter((l) => l.area >= T.lakeM2).map((l) => thinRings(l.rings, T.tol, T.lakeM2 / 4)).filter((r): r is XY[][] => r !== null),
      rivers: rivers.filter((r) => (t === 'near' || !r.name.startsWith('#')) && riverLen.get(r)! >= T.river).flatMap((r) => r.lines.map((l) => simplify(l, T.tol))).filter((l) => lineLen(l) >= T.tol * 2),
      roads: joined.filter((r) => (T.roads as readonly number[]).includes(Math.abs(r.cls)) && (t === 'near' || r.cls > 0)).map((r) => ({ cls: Math.abs(r.cls), pts: simplify(r.pts, T.tol) })).filter((r) => lineLen(r.pts) >= T.tol * 2),
    };
  };
  const pack = (d: { lakes: XY[][][]; rivers: XY[][]; roads: Line[] }): TierData => ({
    lakes: d.lakes.map((rs) => rs.map(enc)),
    rivers: d.rivers.map(enc),
    // biggest roads last, so they draw on top
    roads: [...d.roads].sort((a, b) => a.cls - b.cls).map((r) => [r.cls, ...enc(r.pts)]),
  });
  const far = pack(tier('far')), mid = pack(tier('mid'));

  // near: cut into level-0 terrain tiles, with a little overlap so edges meet
  const nt = tier('near'), near = new Map<string, TierData>(), PAD = 50;
  const into = (x0: number, y0: number, x1: number, y1: number, add: (key: string, box: number[]) => void) => {
    for (let ty = Math.floor((y0 - PAD) / NEAR); ty <= Math.floor((y1 + PAD) / NEAR); ty++) {
      for (let tx = Math.floor((x0 - PAD) / NEAR); tx <= Math.floor((x1 + PAD) / NEAR); tx++) add(`${tx}_${ty}`, [tx * NEAR - PAD, ty * NEAR - PAD, (tx + 1) * NEAR + PAD, (ty + 1) * NEAR + PAD]);
    }
  };
  const at = (key: string) => { let d = near.get(key); if (!d) near.set(key, (d = { lakes: [], rivers: [], roads: [] })); return d; };
  for (const rs of nt.lakes) {
    const [x0, y0, x1, y1] = boxOf(rs[0]);
    into(x0, y0, x1, y1, (key, box) => {
      if (x0 >= box[0] && y0 >= box[1] && x1 <= box[2] && y1 <= box[3]) { at(key).lakes.push(rs.map(enc)); return; }
      // the outer ring cut to the tile, then the islands that are still in it
      const outer = clipRing(rs[0], box);
      if (outer.length >= 3) at(key).lakes.push([outer, ...rs.slice(1).map((r) => clipRing(r, box)).filter((r) => r.length >= 3)].map(enc));
    });
  }
  for (const l of nt.rivers) {
    const [x0, y0, x1, y1] = boxOf(l);
    into(x0, y0, x1, y1, (key, box) => { for (const p of clipLine(l, box)) at(key).rivers.push(enc(p)); });
  }
  for (const r of [...nt.roads].sort((a, b) => a.cls - b.cls)) {
    const [x0, y0, x1, y1] = boxOf(r.pts);
    into(x0, y0, x1, y1, (key, box) => { for (const p of clipLine(r.pts, box)) at(key).roads.push([r.cls, ...enc(p)]); });
  }
  console.log(`vectors (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { far, mid, near };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const { keys: terrainKeys, inState } = await terrain();
  const { far, mid, near } = vectors(inState);
  const size: Record<string, number> = {};
  const write = (name: string, d: TierData) => { const text = JSON.stringify({ v: 1, ...d }); writeFileSync(`${OUT}/${name}`, text); size[name] = text.length; };
  write('far.json', far);
  write('mid.json', mid);
  mkdirSync(`${OUT}/near`, { recursive: true });
  let nearBytes = 0;
  for (const [k, d] of near) { const text = JSON.stringify({ v: 1, ...d }); writeFileSync(`${OUT}/near/${k}.json`, text); nearBytes += text.length; }
  const index = {
    v: 1, credit: [CREDIT, 'AWS Terrain Tiles: USGS 3DEP and SRTM'], states: STATES.map((s) => s.id),
    cell: CELL, tile: TILE, levels: LEVELS, shades: SHADES, covers: COVERS, terrain: terrainKeys,
    tiers: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, { tol: t.tol }])), near: [...near.keys()].sort(),
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`far.json ${kb(size['far.json'])}, mid.json ${kb(size['mid.json'])}, near ${near.size} tiles ${kb(nearBytes)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

if (import.meta.main) await main();
