// Minimal GeoTIFF reader for single-band elevation rasters (3DEP COGs): tiled or striped,
// LZW / Deflate / none, predictor 1-3, little or big endian, classic TIFF or BigTIFF.
import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

/** Random access to the bytes of a file or URL. */
export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export function fileSource(path: string): ByteSource {
  let handle: ReturnType<typeof open> | null = null;
  return {
    async read(offset, length) {
      handle ??= open(path, 'r');
      const fh = await handle;
      const out = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await fh.read(out, got, length - got, offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return got === length ? out : out.subarray(0, got);
    },
    async close() {
      if (handle) await (await handle).close();
      handle = null;
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)) };
}

export interface GeoTiffImage {
  width: number;
  height: number;
  /** block size; a strip is a block as wide as the image */
  blockWidth: number;
  blockHeight: number;
  tiled: boolean;
  bitsPerSample: number;
  /** 1 uint, 2 int, 3 float */
  sampleFormat: number;
  compression: number;
  predictor: number;
  littleEndian: boolean;
  offsets: number[];
  byteCounts: number[];
  /** top-left corner of pixel (0, 0) in map units */
  originX: number;
  originY: number;
  /** pixel size; resY is positive going down */
  resX: number;
  resY: number;
  nodata: number | null;
  /** geographic (2048) or projected (3072) CRS code from the GeoKeys */
  epsg: number | null;
}

export const blocksAcross = (img: GeoTiffImage) => Math.ceil(img.width / img.blockWidth);
export const blocksDown = (img: GeoTiffImage) => Math.ceil(img.height / img.blockHeight);

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** Reads the first (full resolution) image's tags. */
export async function readGeoTiff(src: ByteSource): Promise<GeoTiffImage> {
  let head = await src.read(0, 65536);
  const need = async (end: number) => {
    if (end > head.length) head = await src.read(0, Math.max(end, head.length * 2));
    if (end > head.length) throw new Error('TIFF header runs past the end of the file');
  };
  const le = head[0] === 0x49;
  if (!le && head[0] !== 0x4d) throw new Error('not a TIFF');
  let dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = dv.getUint16(2, le);
  const big = magic === 43;
  if (!big && magic !== 42) throw new Error(`bad TIFF magic ${magic}`);
  const u64 = (o: number) => Number(dv.getBigUint64(o, le));
  const ifd = big ? u64(8) : dv.getUint32(4, le);
  await need(ifd + 16);
  dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const count = big ? u64(ifd) : dv.getUint16(ifd, le);
  const entrySize = big ? 20 : 12;
  const first = ifd + (big ? 8 : 2);
  await need(first + count * entrySize + 8);
  dv = new DataView(head.buffer, head.byteOffset, head.byteLength);

  const tags = new Map<number, number[] | string>();
  for (let i = 0; i < count; i++) {
    const e = first + i * entrySize;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const n = big ? u64(e + 4) : dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const inline = size <= (big ? 8 : 4);
    const at = inline ? e + (big ? 12 : 8) : big ? u64(e + 12) : dv.getUint32(e + 8, le);
    await need(at + size);
    dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (type === 2) {
      let s = '';
      for (let k = 0; k < n; k++) s += String.fromCharCode(head[at + k]);
      tags.set(tag, s.replace(/\0+$/, ''));
      continue;
    }
    const vals: number[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const o = at + k * (TYPE_SIZE[type] ?? 1);
      vals[k] =
        type === 3 ? dv.getUint16(o, le)
        : type === 4 || type === 13 ? dv.getUint32(o, le)
        : type === 16 ? Number(dv.getBigUint64(o, le))
        : type === 12 ? dv.getFloat64(o, le)
        : type === 11 ? dv.getFloat32(o, le)
        : type === 8 ? dv.getInt16(o, le)
        : type === 9 ? dv.getInt32(o, le)
        : type === 5 ? dv.getUint32(o, le) / dv.getUint32(o + 4, le)
        : head[o];
    }
    tags.set(tag, vals);
  }
  const num = (tag: number, def?: number): number => {
    const v = tags.get(tag);
    if (Array.isArray(v)) return v[0];
    if (def === undefined) throw new Error(`TIFF tag ${tag} missing`);
    return def;
  };
  const arr = (tag: number): number[] => {
    const v = tags.get(tag);
    if (!Array.isArray(v)) throw new Error(`TIFF tag ${tag} missing`);
    return v;
  };
  const width = num(256);
  const height = num(257);
  const tiled = tags.has(322);
  if (num(277, 1) !== 1) throw new Error('only single-band rasters are supported');
  if (num(284, 1) !== 1) throw new Error('only chunky planar layout is supported');
  const scale = tags.get(33550) as number[] | undefined;
  const tie = tags.get(33922) as number[] | undefined;
  const geo = tags.get(34735) as number[] | undefined;
  let epsg: number | null = null;
  if (geo) {
    for (let k = 4; k + 3 < geo.length; k += 4) if ((geo[k] === 2048 || geo[k] === 3072) && geo[k + 1] === 0) epsg = geo[k + 3];
  }
  const nd = tags.get(42113);
  const img: GeoTiffImage = {
    width,
    height,
    tiled,
    blockWidth: tiled ? num(322) : width,
    blockHeight: tiled ? num(323) : Math.min(num(278, height), height),
    bitsPerSample: num(258, 1),
    sampleFormat: num(339, 1),
    compression: num(259, 1),
    predictor: num(317, 1),
    littleEndian: le,
    offsets: arr(tiled ? 324 : 273),
    byteCounts: arr(tiled ? 325 : 279),
    resX: scale ? scale[0] : 1,
    resY: scale ? scale[1] : 1,
    originX: tie && scale ? tie[3] - tie[0] * scale[0] : 0,
    originY: tie && scale ? tie[4] + tie[1] * scale[1] : 0,
    nodata: typeof nd === 'string' && nd.trim() !== '' ? Number(nd) : null,
    epsg,
  };
  if (![1, 5, 8, 32946].includes(img.compression)) throw new Error(`unsupported TIFF compression ${img.compression}`);
  return img;
}

/** TIFF LZW (MSB first, early change). `size` is the decoded length when known. */
export function lzwDecode(input: Uint8Array, size: number): Uint8Array {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
    len[i] = 1;
  }
  let out = new Uint8Array(size > 0 ? size : input.length * 4);
  let pos = 0;
  const grow = (n: number) => {
    if (pos + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, pos + n));
    bigger.set(out.subarray(0, pos));
    out = bigger;
  };
  // writes the string of a code at pos
  const emit = (code: number) => {
    const n = len[code];
    grow(n);
    let c = code;
    for (let k = pos + n - 1; k >= pos; k--) {
      out[k] = suffix[c];
      c = prefix[c];
    }
    pos += n;
  };
  let width = 9;
  let next = 258;
  let old = -1;
  let buf = 0;
  let bits = 0;
  let i = 0;
  for (;;) {
    while (bits < width && i < input.length) {
      buf = ((buf << 8) | input[i++]) >>> 0;
      bits += 8;
    }
    if (bits < width) break;
    const code = (buf >>> (bits - width)) & ((1 << width) - 1);
    bits -= width;
    buf &= (1 << bits) - 1;
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      old = -1;
      continue;
    }
    if (old < 0) {
      if (code > 255) throw new Error(`bad LZW code ${code}`);
      emit(code);
      old = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = old;
        suffix[next] = first[code];
        first[next] = first[old];
        len[next] = len[old] + 1;
        next++;
      }
    } else if (code === next && next < 4096) {
      prefix[next] = old;
      suffix[next] = first[old];
      first[next] = first[old];
      len[next] = len[old] + 1;
      next++;
      emit(code);
    } else throw new Error(`bad LZW code ${code}`);
    old = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return pos === out.length ? out : out.subarray(0, pos);
}

/** Undoes the horizontal (2) or floating point (3) predictor in place, row by row. */
export function undoPredictor(data: Uint8Array, predictor: number, width: number, rows: number, bytesPerSample: number, littleEndian: boolean): Uint8Array {
  if (predictor === 1) return data;
  const rowBytes = width * bytesPerSample;
  if (predictor === 2) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let r = 0; r < rows; r++) {
      const o = r * rowBytes;
      for (let c = 1; c < width; c++) {
        const a = o + c * bytesPerSample;
        const b = a - bytesPerSample;
        if (bytesPerSample === 1) data[a] = (data[a] + data[b]) & 0xff;
        else if (bytesPerSample === 2) dv.setUint16(a, (dv.getUint16(a, littleEndian) + dv.getUint16(b, littleEndian)) & 0xffff, littleEndian);
        else dv.setUint32(a, (dv.getUint32(a, littleEndian) + dv.getUint32(b, littleEndian)) >>> 0, littleEndian);
      }
    }
    return data;
  }
  if (predictor !== 3) throw new Error(`unsupported predictor ${predictor}`);
  // bytes were split into planes (most significant first), then differenced
  const out = new Uint8Array(data.length);
  for (let r = 0; r < rows; r++) {
    const o = r * rowBytes;
    for (let k = o + 1; k < o + rowBytes; k++) data[k] = (data[k] + data[k - 1]) & 0xff;
    for (let c = 0; c < width; c++) {
      for (let b = 0; b < bytesPerSample; b++) {
        const v = data[o + b * width + c];
        out[o + c * bytesPerSample + (littleEndian ? bytesPerSample - 1 - b : b)] = v;
      }
    }
  }
  return out;
}

/** Decoded block as float32 (nodata becomes NaN). Edge blocks keep their full padded size. */
export function decodeBlock(img: GeoTiffImage, raw: Uint8Array): Float32Array {
  const bps = img.bitsPerSample / 8;
  const n = img.blockWidth * img.blockHeight;
  const size = n * bps;
  let data: Uint8Array;
  if (img.compression === 1) data = raw.slice(0, size);
  else if (img.compression === 5) data = lzwDecode(raw, size);
  else data = new Uint8Array(inflateSync(raw));
  if (data.length < size) {
    const padded = new Uint8Array(size);
    padded.set(data);
    data = padded;
  }
  // the float predictor writes native order, the others keep the file's order
  const fpLE = img.predictor === 3 ? true : img.littleEndian;
  data = undoPredictor(data, img.predictor, img.blockWidth, img.blockHeight, bps, img.predictor === 3 ? true : img.littleEndian);
  const dv = new DataView(data.buffer, data.byteOffset, size);
  const out = new Float32Array(n);
  const f = img.sampleFormat;
  for (let k = 0; k < n; k++) {
    const o = k * bps;
    out[k] =
      f === 3 ? (bps === 4 ? dv.getFloat32(o, fpLE) : dv.getFloat64(o, fpLE))
      : f === 2 ? (bps === 1 ? dv.getInt8(o) : bps === 2 ? dv.getInt16(o, fpLE) : dv.getInt32(o, fpLE))
      : bps === 1 ? dv.getUint8(o) : bps === 2 ? dv.getUint16(o, fpLE) : dv.getUint32(o, fpLE);
  }
  if (img.nodata !== null) {
    const nd = Math.fround(img.nodata);
    for (let k = 0; k < n; k++) if (out[k] === nd || out[k] === img.nodata) out[k] = NaN;
  }
  return out;
}

export async function readBlock(src: ByteSource, img: GeoTiffImage, index: number): Promise<Float32Array> {
  const len = img.byteCounts[index];
  if (!len) return new Float32Array(img.blockWidth * img.blockHeight).fill(NaN);
  return decodeBlock(img, await src.read(img.offsets[index], len));
}
