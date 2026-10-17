/** terrain estimates: GeoTIFF reading, depression filling, D8, the downhill walk, labels */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import type { Bundle } from '../src/data/bundle.ts';
import { encodeCoords } from '../src/data/bundle.ts';
import { Dem, PPD, tileName, tilesFor } from '../scripts/terrain/dem.ts';
import { bundleExits } from '../scripts/terrain/endings.ts';
import { DEFAULT_ESTIMATE_OPTIONS, Estimator, type Estimate } from '../scripts/terrain/estimate.ts';
import { bigPatches, DC, depressions, DR, EXIT, fill, flowDirections } from '../scripts/terrain/flow.ts';
import { bytesSource, decodeBlock, lzwDecode, readBlock, readGeoTiff, type GeoTiffImage } from '../scripts/terrain/geotiff.ts';
import { lineCells, polygonCells, segmentCells } from '../scripts/terrain/raster.ts';
import { estimateClass, labelFor, normName, outcome, reasonFor, Table } from '../scripts/terrain/report.ts';
import { cohoLevel, contextCoho, contextWater, WaterSet } from '../scripts/terrain/waters.ts';

/** TIFF LZW as libtiff writes it (MSB first, early change, clear when the table fills). */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  const put = (code: number, width: number) => {
    buf = (buf << width) | code;
    bits += width;
    while (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buf &= (1 << bits) - 1;
  };
  let dict = new Map<number, number>();
  let next = 258;
  let width = 9;
  const bump = () => {
    next++;
    if (next === 4094) {
      put(256, width);
      dict = new Map();
      next = 258;
      width = 9;
    } else if (next >= 1 << width) width++;
  };
  put(256, width);
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const key = prefix * 256 + data[i];
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix, width);
    dict.set(key, next);
    bump();
    prefix = data[i];
  }
  put(prefix, width);
  bump();
  put(257, width);
  if (bits) out.push((buf << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

/** Floating point predictor: bytes into planes (most significant first), then differenced. */
function fpPredict(data: Uint8Array, width: number, rows: number): Uint8Array {
  const out = new Uint8Array(data.length);
  const rb = width * 4;
  for (let r = 0; r < rows; r++) {
    const o = r * rb;
    for (let c = 0; c < width; c++) for (let b = 0; b < 4; b++) out[o + b * width + c] = data[o + c * 4 + (3 - b)];
    for (let k = o + rb - 1; k > o; k--) out[k] = (out[k] - out[k - 1]) & 0xff;
  }
  return out;
}

interface TiffSpec {
  width: number;
  height: number;
  tile: number;
  values: Float32Array;
  compression: 1 | 5 | 8;
  predictor: 1 | 3;
  originX: number;
  originY: number;
  res: number;
  nodata?: string;
}

/** A little-endian tiled float32 GeoTIFF. */
function makeTiff(s: TiffSpec): Uint8Array {
  const across = Math.ceil(s.width / s.tile);
  const down = Math.ceil(s.height / s.tile);
  const tiles: Uint8Array[] = [];
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const block = new Float32Array(s.tile * s.tile);
      for (let r = 0; r < s.tile; r++) {
        for (let c = 0; c < s.tile; c++) {
          const R = ty * s.tile + r;
          const C = tx * s.tile + c;
          block[r * s.tile + c] = R < s.height && C < s.width ? s.values[R * s.width + C] : 0;
        }
      }
      let bytes: Uint8Array = new Uint8Array(block.buffer.slice(0));
      if (s.predictor === 3) bytes = fpPredict(bytes, s.tile, s.tile);
      tiles.push(s.compression === 5 ? lzwEncode(bytes) : s.compression === 8 ? new Uint8Array(deflateSync(bytes)) : bytes);
    }
  }
  type Entry = [tag: number, type: number, values: number[] | string];
  const entries: Entry[] = [
    [256, 3, [s.width]],
    [257, 3, [s.height]],
    [258, 3, [32]],
    [259, 3, [s.compression]],
    [262, 3, [1]],
    [277, 3, [1]],
    [284, 3, [1]],
    [317, 3, [s.predictor]],
    [322, 3, [s.tile]],
    [323, 3, [s.tile]],
    [324, 4, tiles.map(() => 0)],
    [325, 4, tiles.map((t) => t.length)],
    [339, 3, [3]],
    [33550, 12, [s.res, s.res, 0]],
    [33922, 12, [0, 0, 0, s.originX, s.originY, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4269]],
  ];
  if (s.nodata) entries.push([42113, 2, `${s.nodata}\0`]);
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 } as Record<number, number>;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const placed = entries.map(([tag, type, v]) => {
    const n = typeof v === 'string' ? v.length : v.length;
    const bytes = n * size[type];
    const at = bytes > 4 ? extra : -1;
    if (bytes > 4) extra += bytes + (bytes % 2);
    return { tag, type, v, n, at };
  });
  let dataAt = extra;
  const offsets = tiles.map((t) => {
    const o = dataAt;
    dataAt += t.length;
    return o;
  });
  placed.find((p) => p.tag === 324)!.v = offsets;
  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49]);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  const write = (o: number, type: number, v: number[] | string) => {
    if (typeof v === 'string') for (let k = 0; k < v.length; k++) out[o + k] = v.charCodeAt(k);
    else v.forEach((x, k) => (type === 3 ? dv.setUint16(o + 2 * k, x, true) : type === 4 ? dv.setUint32(o + 4 * k, x, true) : dv.setFloat64(o + 8 * k, x, true)));
  };
  placed.forEach((p, k) => {
    const e = 10 + k * 12;
    dv.setUint16(e, p.tag, true);
    dv.setUint16(e + 2, p.type, true);
    dv.setUint32(e + 4, p.n, true);
    if (p.at < 0) write(e + 8, p.type, p.v);
    else {
      dv.setUint32(e + 8, p.at, true);
      write(p.at, p.type, p.v);
    }
  });
  tiles.forEach((t, k) => out.set(t, offsets[k]));
  return out;
}

describe('GeoTIFF reader', () => {
  const width = 7;
  const height = 5;
  const values = new Float32Array(width * height).map((_, i) => 100 + i * 0.25 - (i % 3) * 7.5);
  values[3] = -999999;

  for (const [compression, predictor] of [[1, 1], [5, 3], [8, 3], [5, 1]] as const) {
    test(`reads tiles with compression ${compression}, predictor ${predictor}, padding edge tiles`, async () => {
      const bytes = makeTiff({ width, height, tile: 4, values, compression, predictor, originX: -123 - 6 / PPD, originY: 48 + 6 / PPD, res: 1 / PPD, nodata: '-999999' });
      const src = bytesSource(bytes);
      const img = await readGeoTiff(src);
      assert.equal(img.width, width);
      assert.equal(img.height, height);
      assert.equal(img.blockWidth, 4);
      assert.equal(img.offsets.length, 4);
      assert.equal(img.epsg, 4269);
      assert.equal(img.nodata, -999999);
      assert.ok(Math.abs(img.originX - (-123 - 6 / PPD)) < 1e-12);
      assert.ok(Math.abs(img.originY - (48 + 6 / PPD)) < 1e-12);
      for (let b = 0; b < 4; b++) {
        const block = await readBlock(src, img, b);
        const bx = b % 2;
        const by = Math.floor(b / 2);
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            const R = by * 4 + r;
            const C = bx * 4 + c;
            if (R >= height || C >= width) continue;
            const want = values[R * width + C];
            const got = block[r * 4 + c];
            if (want === -999999) assert.ok(Number.isNaN(got));
            else assert.equal(got, want);
          }
        }
      }
    });
  }

  test('LZW round trip through code widths 9 to 12 and a table reset', () => {
    const data = new Uint8Array(60000);
    let x = 12345;
    for (let i = 0; i < data.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      data[i] = i % 7 === 0 ? (x >>> 24) & 0xff : (i * 31) & 0x3f;
    }
    assert.deepEqual(lzwDecode(lzwEncode(data), data.length), data);
    assert.deepEqual(lzwDecode(lzwEncode(data), 0), data);
  });

  test('a block decodes with nodata as NaN', () => {
    const img: GeoTiffImage = {
      width: 2, height: 1, blockWidth: 2, blockHeight: 1, tiled: true, bitsPerSample: 32, sampleFormat: 3, compression: 1, predictor: 1,
      littleEndian: true, offsets: [0], byteCounts: [8], originX: 0, originY: 0, resX: 1, resY: 1, nodata: -1, epsg: null,
    };
    const raw = new Uint8Array(new Float32Array([5.5, -1]).buffer);
    const out = decodeBlock(img, raw);
    assert.equal(out[0], 5.5);
    assert.ok(Number.isNaN(out[1]));
  });
});

/** An uncompressed one-block tile of the 1/3 arc-second grid with its NW corner at lon, lat. */
function tile(lon: number, lat: number, size: number, z: (r: number, c: number) => number) {
  const values = new Float32Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) values[r * size + c] = z(r, c);
  const img: GeoTiffImage = {
    width: size, height: size, blockWidth: size, blockHeight: size, tiled: true, bitsPerSample: 32, sampleFormat: 3, compression: 1, predictor: 1,
    littleEndian: true, offsets: [0], byteCounts: [size * size * 4], originX: lon, originY: lat, resX: 1 / PPD, resY: 1 / PPD, nodata: null, epsg: 4269,
  };
  return { name: `t${lon},${lat}`, src: bytesSource(new Uint8Array(values.buffer)), img };
}

describe('DEM tiles as one grid', () => {
  test('tile names cover a box', () => {
    assert.equal(tileName(48, 123), 'n48w123');
    assert.deepEqual(tilesFor([-122.86, 46.72, -121.06, 47.79]), ['n48w123', 'n48w122', 'n47w123', 'n47w122']);
  });

  test('a window reads across two neighboring tiles, NaN off them', async () => {
    const lon = -122.3;
    const lat = 47.1;
    const a = tile(lon, lat, 8, (r, c) => r * 100 + c);
    const b = tile(lon + 8 / PPD, lat, 8, (r, c) => 1000 + r * 100 + c);
    const dem = Dem.fromImages([a, b]);
    const row0 = Dem.rowOf(lat - 0.5 / PPD);
    const col0 = Dem.colOf(lon + 0.5 / PPD);
    const w = await dem.window(row0 + 2, col0 + 6, 2, 5);
    assert.deepEqual(Array.from(w.slice(0, 5)), [206, 207, 1200, 1201, 1202]);
    assert.deepEqual(Array.from(w.slice(5)), [306, 307, 1300, 1301, 1302]);
    const off = await dem.window(row0 - 3, col0, 2, 2);
    assert.ok(Array.from(off).every(Number.isNaN));
    assert.ok(Math.abs(Dem.lonOf(col0) - (lon + 0.5 / PPD)) < 1e-9);
    assert.ok(Math.abs(Dem.latOf(row0) - (lat - 0.5 / PPD)) < 1e-9);
  });
});

describe('depression filling and flow directions', () => {
  // a bowl draining through a notch at the east edge
  const rows = 7;
  const cols = 7;
  const z = new Float32Array(rows * cols).fill(10);
  for (let r = 1; r < 6; r++) for (let c = 1; c < 6; c++) z[r * cols + c] = 5;
  z[3 * cols + 3] = 2;
  z[3 * cols + 6] = 7; // notch on the edge
  const f = fill(z, rows, cols);

  test('fills the pit to the notch, leaves the rest', () => {
    assert.equal(f[3 * cols + 3], 7);
    assert.equal(f[2 * cols + 2], 7);
    assert.equal(f[0], 10);
    assert.equal(f[3 * cols + 6], 7);
  });

  test('every cell drains out along its directions, flats toward the notch', () => {
    const dir = flowDirections(f, rows, cols, 7, 10);
    for (let s = 0; s < rows * cols; s++) {
      let i = s;
      for (let k = 0; k < 100 && dir[i] !== EXIT; k++) i += DR[dir[i]] * cols + DC[dir[i]];
      assert.equal(dir[i], EXIT);
    }
    let i = 3 * cols + 3;
    while (dir[i] !== EXIT) i += DR[dir[i]] * cols + DC[dir[i]];
    assert.equal(i, 3 * cols + 6);
  });

  test('the filled bowl is one depression, its deepest cell the pit', () => {
    const d = depressions(z, f, rows, cols);
    assert.equal(d.list.length, 1);
    assert.equal(d.list[0].cells, 25);
    assert.equal(d.list[0].depth, 5);
    assert.equal(d.list[0].pit, 3 * cols + 3);
    assert.equal(d.list[0].edge, false);
    assert.equal(d.label[0], -1);
  });

  test('steepest descent uses true distances on cells wider than tall', () => {
    // dropping 1 m to the east (7 m away) beats 1.2 m to the south (10 m away)
    const g = new Float32Array([5, 5, 5, 5, 5, 4, 5, 3.8, 5]);
    const dir = flowDirections(g, 3, 3, 7, 10);
    assert.equal(dir[4], 4);
  });

  test('outlets take the water, big patches only', () => {
    const zz = new Float32Array(25).fill(5);
    zz[0] = zz[1] = zz[5] = zz[6] = -1;
    zz[24] = -1;
    const sea = bigPatches((i) => zz[i] <= 0, 5, 5, 3);
    assert.deepEqual([sea[0], sea[1], sea[5], sea[6], sea[24]], [1, 1, 1, 1, 0]);
    const ff = fill(zz, 5, 5, sea);
    const dir = flowDirections(ff, 5, 5, 7, 10, sea);
    assert.equal(dir[0], EXIT);
    assert.equal(DR[dir[12]] < 0 && DC[dir[12]] < 0, true);
  });
});

describe('burning lines and polygons into cells', () => {
  test('a diagonal segment is covered by side-sharing cells', () => {
    const cells: [number, number][] = [];
    segmentCells(0.5, 0.5, 4.5, 3.5, (r, c) => cells.push([r, c]));
    assert.deepEqual(cells[0], [0, 0]);
    assert.deepEqual(cells[cells.length - 1], [3, 4]);
    for (let k = 1; k < cells.length; k++) assert.equal(Math.abs(cells[k][0] - cells[k - 1][0]) + Math.abs(cells[k][1] - cells[k - 1][1]), 1);
  });

  test('line cells stay inside the window and in drawing order', () => {
    const cells = lineCells([-2.5, 2.5, 2.5], [1.5, 1.5, 3.5], 4, 4);
    assert.deepEqual(cells, [4, 5, 6, 10, 14]);
  });

  test('polygon cells by center, holes left out', () => {
    const got: number[] = [];
    const outer = { xs: [0, 6, 6, 0], ys: [0, 0, 6, 6] };
    const hole = { xs: [2, 4, 4, 2], ys: [2, 2, 4, 4] };
    polygonCells([outer, hole], 6, 6, (i) => got.push(i));
    assert.equal(got.length, 32);
    assert.ok(!got.includes(2 * 6 + 2));
    assert.ok(got.includes(1 * 6 + 1));
  });
});

describe('waters from the context source', () => {
  test('keeps receiving waters, drops NHD copies, storm lines, pipes, wetlands and small ponds', () => {
    const line = [[-122.3, 47.1], [-122.29, 47.1]];
    const ring = [[[[-122.3, 47.1], [-122.29, 47.1], [-122.29, 47.11], [-122.3, 47.1]]]];
    const s = contextWater({ id: 'pc:s1', src: 'pierce', kind: 'stream', name: 'Taylor Bay Creek', type: 'Stream', npdes: 'Waters of the State', coords: line })!;
    assert.equal(s.kind, 'stream');
    assert.equal(s.name, 'Taylor Bay Creek');
    assert.equal(s.lines!.length, 1);
    assert.equal(contextWater({ src: 'nhd', kind: 'stream', coords: line, covered: true }), null);
    assert.equal(contextWater({ src: 'pierce', kind: 'stream', npdes: 'MS4', coords: line }), null);
    assert.equal(contextWater({ src: 'pierce', kind: 'pipe', coords: line }), null);
    assert.equal(contextWater({ src: 'nhd', kind: 'wetland', polygons: ring, areaM2: 50000 }), null);
    assert.equal(contextWater({ src: 'pierce', kind: 'lake', polygons: ring, areaM2: 828 }), null);
    const lake = contextWater({ src: 'pierce', kind: 'lake', name: 'Spanaway Lake', polygons: ring, areaM2: 1e6 })!;
    assert.equal(lake.kind, 'lake');
    assert.equal(lake.polygons!.length, 1);
    assert.equal(contextWater({ src: 'nhd', kind: 'coastline', name: 'Puget Sound', coords: line })!.kind, 'sound');
    assert.equal(contextWater({ src: 'pierce', kind: 'marine', name: 'Puget Sound', polygons: ring, areaM2: 3e8 })!.kind, 'sound');
    assert.equal(contextWater({ src: 'nhd', kind: 'stream', flowDir: 1, coords: line })!.directed, true);
    assert.equal(contextWater({ src: 'nhd', kind: 'stream', name: 'Unnamed stream [123]', coords: line })!.name, '');
  });

  test('coho: documented and presumed are yes, the rest possible', () => {
    assert.equal(cohoLevel('Documented'), 'yes');
    assert.equal(cohoLevel('Transported - Presumed'), 'yes');
    assert.equal(cohoLevel('Historic - Documented'), 'possible');
    assert.equal(cohoLevel('Gradient Accessible'), 'possible');
    assert.equal(cohoLevel('Modeled'), 'possible');
    const line = [[-122.3, 47.1], [-122.29, 47.1]];
    assert.equal(contextCoho({ coho: 'documented', dist: 'Documented', coords: line })!.level, 'yes');
    assert.equal(contextCoho({ coho: 'possible', dist: 'Modeled', coords: line })!.level, 'possible');
  });

  test('coho near a point, yes before possible', () => {
    const set = new WaterSet();
    const a = new Float64Array([-122.3, 47.1, -122.29, 47.1]);
    const b = new Float64Array([-122.3, 47.10005, -122.29, 47.10005]);
    set.addCoho({ level: 'possible', name: 'Near Creek', lines: [a], box: [-122.3, 47.1, -122.29, 47.1] });
    set.addCoho({ level: 'yes', name: 'Far Creek', lines: [b], box: [-122.3, 47.10005, -122.29, 47.10005] });
    const hit = set.cohoNear(-122.295, 47.1, 20)!;
    assert.equal(hit.level, 'yes');
    assert.equal(hit.name, 'Far Creek');
    assert.ok(hit.d > 5 && hit.d < 6.2);
    assert.equal(set.cohoNear(-122.295, 47.101, 20), null);
    assert.equal(set.inBox([-122.31, 47.09, -122.28, 47.11]).length, 2);
  });
});

describe('the downhill walk', () => {
  // 300 x 300 cells (about 2.1 km x 3.1 km): a west plateau with a closed bowl, a valley whose
  // creek runs north into the Sound, an east slope with a lake and an east plateau above the Sound
  const LON = -122.3;
  const LAT = 47.1;
  const N = 300;
  const DX = 7.03;
  const DY = 10.29;
  const ground = (r: number, c: number) => {
    let z: number;
    if (c < 100) z = 80;
    else if (c < 150) z = 80 - (c - 100) * DX * 0.1;
    else if (c < 200) z = 44.85 + (c - 150) * DX * 0.1;
    else z = 80;
    if (c >= 100 && c < 200) z = Math.min(80, z + r * DY * 0.01);
    const d = Math.hypot((c - 50) * DX, (r - 150) * DY);
    if (d < 150) z -= 4 * (1 - (d / 150) ** 2);
    if (r < 30) z = -1;
    return z;
  };
  const lonOf = (c: number) => LON + (c + 0.5) / PPD;
  const latOf = (r: number) => LAT - (r + 0.5) / PPD;
  const flat = (pts: [number, number][]) => new Float64Array(pts.flatMap(([r, c]) => [lonOf(c), latOf(r)]));
  const waters = new WaterSet();
  const creek = flat([[299, 150], [0, 150]]);
  waters.add({ kind: 'stream', name: 'Test Creek', src: 'test', lines: [creek], directed: true, box: [lonOf(150), latOf(299), lonOf(150), latOf(0)] });
  const lakeRing = flat([[140, 160], [140, 170], [160, 170], [160, 160], [140, 160]]);
  waters.add({ kind: 'lake', name: 'Test Lake', src: 'test', polygons: [[lakeRing]], directed: false, box: [lonOf(160), latOf(160), lonOf(170), latOf(140)] });
  const cohoLine = flat([[100, 150], [0, 150]]);
  waters.addCoho({ level: 'yes', name: 'Test Creek', lines: [cohoLine], box: [lonOf(150), latOf(100), lonOf(150), latOf(0)] });
  const dem = Dem.fromImages([tile(LON, LAT, N, ground)]);
  const est = new Estimator(dem, waters, { levels: [{ coreM: 300, haloM: 1500 }], seaCells: 500 });
  const at = (r: number, c: number): Promise<Estimate> => est.estimate(lonOf(c), latOf(r));

  test('down the valley side to the creek, coho downstream', async () => {
    const e = await at(200, 120);
    assert.equal(e.kind, 'stream');
    assert.equal(e.name, 'Test Creek');
    assert.equal(e.stop, 'water');
    assert.ok(e.distanceM > 150 && e.distanceM < 320, `walked ${e.distanceM} m`);
    assert.ok(e.dropM > 15);
    assert.equal(e.coho, 'yes');
    assert.ok(e.cohoDownstreamM! > 600 && e.cohoDownstreamM! < 2000, `coho ${e.cohoDownstreamM} m on`);
  });

  test('right on coho water', async () => {
    const e = await at(60, 145);
    assert.equal(e.kind, 'stream');
    assert.equal(e.coho, 'yes');
    assert.equal(e.cohoDownstreamM, undefined);
  });

  test('a closed bowl holds the water', async () => {
    const e = await at(150, 60);
    assert.equal(e.kind, 'depression');
    assert.equal(e.stop, 'pit');
  });

  test('down the other side into the lake', async () => {
    const e = await at(150, 176);
    assert.equal(e.kind, 'lake');
    assert.equal(e.name, 'Test Lake');
    assert.ok(e.distanceM < 60, `walked ${e.distanceM} m`);
  });

  test('off the plateau into the Sound', async () => {
    const e = await at(40, 250);
    assert.equal(e.kind, 'sound');
    assert.equal(e.name, 'Puget Sound');
  });

  test('estimateAll gives the same answers', async () => {
    const pts = [[200, 120], [150, 60], [40, 250]].map(([r, c]) => ({ lon: lonOf(c), lat: latOf(r) }));
    const all = await est.estimateAll(pts);
    assert.deepEqual(all.map((e) => e.kind), ['stream', 'depression', 'sound']);
  });

  test('default windows grow from 8 km to 48 km across', () => {
    assert.deepEqual(DEFAULT_ESTIMATE_OPTIONS.levels.map((l) => (l.coreM + 2 * l.haloM) / 1000), [8, 24, 48]);
  });
});

describe('labels and calibration', () => {
  const e = (x: Partial<Estimate>): Estimate => ({ kind: 'stream', name: '', coho: 'no', distanceM: 140, at: [0, 0], dropM: 3, stop: 'water', ...x });

  test('labels say estimated and name the water', () => {
    assert.equal(labelFor(e({ name: 'Clover Creek', coho: 'yes' })), 'Estimated: heads toward Clover Creek, a coho stream');
    assert.equal(labelFor(e({ into: 'Clover Creek' })), 'Estimated: heads toward an unnamed stream that runs into Clover Creek');
    assert.equal(labelFor(e({ kind: 'lake', name: '' })), 'Estimated: heads toward an unnamed lake or pond');
    assert.equal(labelFor(e({ kind: 'depression' })), 'Estimated: runs into a low spot with no outlet, so it probably soaks in');
    assert.equal(labelFor(e({ kind: 'unknown', stop: 'edge' })), '');
    assert.match(reasonFor(e({ name: 'Swan Creek', coho: 'yes', cohoDownstreamM: 1166 })), /Swan Creek, which runs on into coho water about 1\.2 km downstream about 140 m away/);
    assert.equal(reasonFor(e({ kind: 'unknown' })), '');
  });

  test('names compare loosely, unnamed waters only with unnamed ones', () => {
    assert.equal(normName('North Fork Clover Creek.'), 'north fork clover creek');
    assert.equal(normName('an unnamed stream'), '');
    assert.equal(outcome(e({ name: 'Clover Creek' }), 'Clover Creek'), 'same water');
    assert.equal(outcome(e({ name: 'North Fork Clover Creek Tributary 5' }), 'North Fork Clover Creek'), 'same system');
    assert.equal(outcome(e({ name: 'Swan Creek' }), 'Clover Creek'), 'other named water');
    assert.equal(outcome(e({ into: 'Clover Creek' }), 'Clover Creek'), 'same water');
    assert.equal(outcome(e({ into: 'Clover Creek' }), 'an unnamed stream'), 'unnamed water');
    assert.equal(outcome(e({ name: 'Swan Creek' }), 'an unnamed stream'), 'other named water');
    assert.equal(outcome(e({ kind: 'depression' }), 'Clover Creek'), 'low spot');
    assert.equal(outcome(e({ kind: 'sound', name: 'Puget Sound' }), 'Clover Creek'), 'Puget Sound');
    assert.equal(estimateClass(e({ coho: 'possible' })), 'creek?');
    assert.equal(estimateClass(e({ kind: 'lake' })), 'elsewhere');
  });

  test('tables count rows by columns', () => {
    const t = new Table(['a', 'b']);
    t.add('x', 'a');
    t.add('x', 'a');
    t.add('y', 'c');
    assert.deepEqual(t.toJSON(), { x: { a: 2, b: 0, c: 0 }, y: { a: 0, b: 0, c: 1 } });
    assert.match(t.text('t'), /total\s+2\s+0\s+1/);
  });
});

describe('endings in the bundles', () => {
  const bundle = (keys: string[], geoms: [number, number][][], drains: number[], endings: { code: string; cls: number; exit: number; receiving?: string }[], ends: number[]): Bundle =>
    ({
      assets: { key: keys, kind: keys.map(() => 0), geom: geoms.map((g) => encodeCoords(g)) },
      endings: endings.map((x) => ({ ...x, confidence: 2, terminal: x.exit, receiving: x.receiving ?? '', reason: '' })),
      drains: { asset: drains, ending: ends, explicitPaths: {} },
    }) as unknown as Bundle;

  test('a drain in two bundles counts once; a line exit leaves at its last vertex', () => {
    const a = bundle(['CB-1', 'CB-2', 'DP-1'], [[[-122.3, 47.1]], [[-122.31, 47.1]], [[-122.32, 47.11]]], [0, 1], [{ code: 'outfall-unknown', cls: 3, exit: 2 }], [0, 0]);
    const b = bundle(['CB-2', 'PI-9'], [[[-122.31, 47.1]], [[-122.4, 47.2], [-122.41, 47.21]]], [0, 1], [{ code: 'outfall-creek', cls: 0, exit: 1, receiving: 'Swan Creek' }], [0, 0]);
    const exits = bundleExits([{ name: 'a', bundle: a }, { name: 'b', bundle: b }]);
    assert.deepEqual(exits.get('DP-1')!.drains, ['CB-1', 'CB-2']);
    assert.deepEqual(exits.get('DP-1')!.at, [-122.32, 47.11]);
    const pi = exits.get('PI-9')!;
    assert.deepEqual(pi.drains, ['PI-9']);
    assert.deepEqual(pi.at, [-122.41, 47.21]);
    assert.equal(pi.receiving, 'Swan Creek');
  });
});
