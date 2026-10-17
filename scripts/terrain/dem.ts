// USGS 3DEP 1/3 arc-second tiles as one grid: download, then read any window (Node only).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { blocksAcross, fileSource, readBlock, readGeoTiff, type ByteSource, type GeoTiffImage } from './geotiff.ts';

/** Pixels per degree of the 1/3 arc-second grid. */
export const PPD = 10800;
const TILE_URL = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tiretrail-terrain';

/** "n48w123" names the tile whose north-west corner is 48N 123W. */
export function tileName(north: number, west: number): string {
  return `n${north}w${west}`;
}

/** Tiles covering a lon/lat box. */
export function tilesFor(box: readonly [number, number, number, number]): string[] {
  const out: string[] = [];
  for (let n = Math.ceil(box[3]); n > Math.floor(box[1]); n--) {
    for (let w = Math.ceil(-box[0]); w > Math.floor(-box[2]); w--) out.push(tileName(n, w));
  }
  return out;
}

export const tileUrl = (name: string) => `${TILE_URL}/${name}/USGS_13_${name}.tif`;
export const tileFile = (dir: string, name: string) => `${dir}/USGS_13_${name}.tif`;

export function httpSource(url: string): ByteSource {
  return {
    async read(offset, length) {
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': UA } });
          if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
        } catch (e) {
          last = e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      throw new Error(`${url}: ${String(last)}`);
    },
  };
}

/** Downloads one whole tile (resumes a .part file). */
async function download(url: string, file: string, log: (s: string) => void): Promise<void> {
  const part = `${file}.part`;
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
      if (!head.ok) throw new Error(`HTTP ${head.status}`);
      const total = Number(head.headers.get('content-length'));
      let have = existsSync(part) ? statSync(part).size : 0;
      if (have > total) have = 0;
      if (have < total) {
        const res = await fetch(url, { headers: { 'User-Agent': UA, ...(have ? { Range: `bytes=${have}-` } : {}) } });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        if (res.status !== 206) have = 0;
        const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
        let got = have;
        let shown = got;
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
            got += chunk.length;
            if (got - shown > 100e6) {
              shown = got;
              log(`  ${file.split('/').pop()}: ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`);
            }
          }
        } finally {
          await new Promise<void>((resolve) => out.end(() => resolve()));
        }
      }
      const size = statSync(part).size;
      if (size !== total) throw new Error(`short download (${size} of ${total})`);
      renameSync(part, file);
      return;
    } catch (e) {
      last = e;
      log(`  retrying ${url.split('/').pop()}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

/** Downloads missing tiles, at most 4 at a time. */
export async function ensureTiles(names: readonly string[], dir: string, log: (s: string) => void = console.log): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const todo = names.filter((n) => !existsSync(tileFile(dir, n)));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const name = todo[next++];
      log(`Downloading ${name}`);
      await download(tileUrl(name), tileFile(dir, name), log);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
}

interface Tile {
  name: string;
  src: ByteSource;
  img: GeoTiffImage;
  /** global row and column of the tile's pixel (0, 0) */
  row0: number;
  col0: number;
}

/**
 * The tiles as one grid of 1/3 arc-second pixels. Global pixel (row, col) covers
 * lon -180 + col / PPD .. +1/PPD and lat 90 - row / PPD .. -1/PPD.
 */
export class Dem {
  private readonly tiles: Tile[];
  private readonly cache = new Map<string, Float32Array>();
  private readonly maxBlocks: number;
  /** blocks read from disk or the web */
  blocksRead = 0;

  private constructor(tiles: Tile[], maxBlocks: number) {
    this.tiles = tiles;
    this.maxBlocks = maxBlocks;
  }

  /** Opens local tiles (or reads them over the web with `remote`). */
  static async open(names: readonly string[], dir: string, opts: { remote?: boolean; maxBlocks?: number } = {}): Promise<Dem> {
    const tiles: Tile[] = [];
    for (const name of names) {
      const local = tileFile(dir, name);
      const src = !opts.remote && existsSync(local) ? fileSource(local) : opts.remote ? httpSource(tileUrl(name)) : null;
      if (!src) throw new Error(`missing DEM tile ${local}`);
      const img = await readGeoTiff(src);
      tiles.push(Dem.place(name, src, img));
    }
    return new Dem(tiles, opts.maxBlocks ?? 256);
  }

  /** A grid from in-memory images (tests). */
  static fromImages(list: { name: string; src: ByteSource; img: GeoTiffImage }[], maxBlocks = 64): Dem {
    return new Dem(list.map((t) => Dem.place(t.name, t.src, t.img)), maxBlocks);
  }

  private static place(name: string, src: ByteSource, img: GeoTiffImage): Tile {
    if (Math.abs(img.resX * PPD - 1) > 1e-6 || Math.abs(img.resY * PPD - 1) > 1e-6) throw new Error(`${name}: not a 1/3 arc-second grid`);
    return { name, src, img, row0: Math.round((90 - img.originY) * PPD), col0: Math.round((img.originX + 180) * PPD) };
  }

  static rowOf = (lat: number) => Math.floor((90 - lat) * PPD);
  static colOf = (lon: number) => Math.floor((lon + 180) * PPD);
  static latOf = (row: number) => 90 - (row + 0.5) / PPD;
  static lonOf = (col: number) => -180 + (col + 0.5) / PPD;

  private async block(t: Tile, index: number): Promise<Float32Array> {
    const key = `${t.name}/${index}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const b = await readBlock(t.src, t.img, index);
    this.blocksRead++;
    this.cache.set(key, b);
    while (this.cache.size > this.maxBlocks) this.cache.delete(this.cache.keys().next().value!);
    return b;
  }

  /** Elevations (m) of global rows row0.. and columns col0.., row by row; NaN where no tile has data. */
  async window(row0: number, col0: number, rows: number, cols: number): Promise<Float32Array> {
    const out = new Float32Array(rows * cols).fill(NaN);
    for (const t of this.tiles) {
      const { img } = t;
      const r0 = Math.max(row0, t.row0);
      const r1 = Math.min(row0 + rows, t.row0 + img.height);
      const c0 = Math.max(col0, t.col0);
      const c1 = Math.min(col0 + cols, t.col0 + img.width);
      if (r0 >= r1 || c0 >= c1) continue;
      const bw = img.blockWidth;
      const bh = img.blockHeight;
      const across = blocksAcross(img);
      for (let by = Math.floor((r0 - t.row0) / bh); by <= Math.floor((r1 - 1 - t.row0) / bh); by++) {
        for (let bx = Math.floor((c0 - t.col0) / bw); bx <= Math.floor((c1 - 1 - t.col0) / bw); bx++) {
          const b = await this.block(t, by * across + bx);
          const br0 = t.row0 + by * bh;
          const bc0 = t.col0 + bx * bw;
          const rr0 = Math.max(r0, br0);
          const rr1 = Math.min(r1, br0 + bh);
          const cc0 = Math.max(c0, bc0);
          const cc1 = Math.min(c1, bc0 + bw);
          for (let r = rr0; r < rr1; r++) {
            const src = (r - br0) * bw + (cc0 - bc0);
            const dst = (r - row0) * cols + (cc0 - col0);
            for (let k = 0; k < cc1 - cc0; k++) {
              const v = b[src + k];
              if (!Number.isNaN(v)) out[dst + k] = v;
            }
          }
        }
      }
    }
    return out;
  }

  async close(): Promise<void> {
    for (const t of this.tiles) await t.src.close?.();
  }
}
