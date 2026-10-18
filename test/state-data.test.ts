/** the land statewide (scripts/build-state.ts, read by src/app/map/state.ts): terrain tiles, lakes, rivers and big roads */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CELL, cellCode, COVERS, LEVELS, SHADES, TILE } from '../scripts/build-state.ts';
import { project, unproject } from '../scripts/lib/lcc.ts';
import { decodePng, encodeGray } from '../scripts/lib/png.ts';
import { STATES } from '../scripts/lib/states.ts';
import { cellOf, HIGH, LAND, readLayer, TOWN, type Layer } from '../src/app/map/state.ts';
import { pointInPolygon, type LngLat, type XY } from '../src/geo/geo.ts';

const dir = new URL('../public/data/state/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const index = read('index.json');

function bytes(u: URL): number {
  let n = 0;
  for (const e of readdirSync(u, { withFileTypes: true })) n += e.isDirectory() ? bytes(new URL(`${e.name}/`, u)) : statSync(new URL(e.name, u)).size;
  return n;
}

/** the terrain cell code at a place, on level L (0 if outside the states) */
function cell(L: number, at: LngLat): number {
  const [x, y] = project(at), s = CELL * 2 ** L, ci = Math.floor(x / s), cj = Math.floor(y / s);
  const name = `t${L}/${Math.floor(ci / TILE)}_${Math.floor(cj / TILE)}.png`;
  if (!existsSync(new URL(name, dir))) return 0;
  const { data } = decodePng(readFileSync(new URL(name, dir)));
  return cellOf(data[((cj & 255) << 8) | (ci & 255)]);
}
const cover = (c: number) => Math.floor((c - 1) / SHADES);

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

describe('state terrain', () => {
  test('the index lists files that are there, and everything fits in 10 MB', () => {
    assert.equal(index.v, 1);
    assert.deepEqual([index.cell, index.tile, index.levels, index.shades, index.covers], [CELL, TILE, LEVELS, SHADES, COVERS]);
    assert.deepEqual(index.states, STATES.map((s) => s.id));
    for (let L = 0; L < LEVELS; L++) {
      assert.ok(index.terrain[L].length > 0);
      for (const k of index.terrain[L]) assert.ok(existsSync(new URL(`t${L}/${k}.png`, dir)), `t${L}/${k}`);
    }
    for (const k of index.near) assert.ok(existsSync(new URL(`near/${k}.json`, dir)), k);
    assert.ok(bytes(dir) <= 10 * 1024 * 1024, `${(bytes(dir) / 1048576).toFixed(1)} MB`);
  });

  test('cell codes survive the gray PNG, which spreads them out', () => {
    for (let s = 0; s < SHADES; s++) for (let c = 0; c < COVERS; c++) {
      const code = cellCode(s, c);
      assert.ok(code < 256 && code % 8 === 0);
      // a decode a few grays off still reads the same cell
      for (const off of [-3, 0, 3]) assert.equal(cellOf(code + off), 1 + s + SHADES * c);
    }
    assert.equal(cellOf(0), 0);
    const px = Uint8Array.from({ length: 64 * 48 }, (_, k) => cellCode(k % SHADES, (k >> 5) % COVERS));
    assert.deepEqual(decodePng(encodeGray(px, 64, 48)).data, px);
  });

  test('Mount Rainier is rock and ice, Spokane is town, the Palouse is open land, Portland is outside', () => {
    for (let L = 0; L < LEVELS - 1; L++) assert.equal(cover(cell(L, [-121.7603, 46.8529])), HIGH, `Rainier at level ${L}`);
    assert.equal(cover(cell(0, [-117.4235, 47.6572])), TOWN);
    const palouse = cell(0, [-117.6, 46.95]);
    assert.ok(palouse > 0 && cover(palouse) === LAND);
    assert.equal(cell(0, [-122.6765, 45.5231]), 0);
  });
});

describe('state lakes, rivers and roads', () => {
  const far = readLayer(read('far.json')) as Layer, mid = readLayer(read('mid.json')) as Layer;

  test('each tier reads, and stays in Washington', () => {
    for (const l of [far, mid]) {
      assert.ok(l && l.lakes.length && l.rivers.length && l.roads.length);
      for (const r of l.roads) {
        assert.ok(r.cls >= 2 && r.cls <= 5);
        for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) {
          const [lon, lat] = unproject(p), b = STATES[0].box;
          assert.ok(lon > b[0] - 0.1 && lon < b[2] + 0.1 && lat > b[1] - 0.1 && lat < b[3] + 0.1, `${lon}, ${lat}`);
        }
      }
    }
    // far out only motorways and trunks; more in close
    assert.ok(far.roads.every((r) => r.cls >= 4) && mid.roads.some((r) => r.cls === 3));
    assert.ok(far.lakes.length < mid.lakes.length);
  });

  test('Lake Washington is water, and I-90 runs past Ellensburg', () => {
    const lw = project([-122.258, 47.62]);
    assert.ok(far.lakes.some((q) => pointInPolygon(lw, q.rings)));
    const eb = project([-120.53, 46.97]);
    const d = Math.min(...mid.roads.filter((r) => r.cls === 5).flatMap((r) => r.pts.slice(1).map((p, k) => segDist(eb, r.pts[k], p))));
    assert.ok(d < 1500, `${d} m`);
  });

  test('near tiles are cut to their 51.2 km squares', () => {
    const t = CELL * TILE;
    for (const k of index.near.slice(0, 12)) {
      const [tx, ty] = k.split('_').map(Number), l = readLayer(read(`near/${k}.json`))!;
      for (const r of [...l.roads, ...l.rivers]) for (const [x, y] of r.pts) assert.ok(x >= tx * t - 60 && x <= (tx + 1) * t + 60 && y >= ty * t - 60 && y <= (ty + 1) * t + 60, k);
    }
  });
});
