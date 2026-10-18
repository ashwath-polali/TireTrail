// A tiny PNG reader (8-bit, not interlaced) and gray PNG writer, on node's zlib.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Pixels of an 8-bit PNG, `channels` bytes each, row by row. */
export function decodePng(buf: Uint8Array): { w: number; h: number; channels: number; data: Uint8Array } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let w = 0, h = 0, channels = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      [w, h] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      const depth = body[8], color = body[9];
      channels = CHANNELS[color] ?? 0;
      if (depth !== 8 || !channels || body[12] !== 0) throw new Error(`PNG kind this can't read (depth ${depth}, color ${color}, interlace ${body[12]})`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * channels, out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[o + x - channels] : 0, up = y ? out[o - stride + x] : 0, c = x >= channels && y ? out[o - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) v += paeth(a, up, c);
      out[o + x] = v & 255;
    }
  }
  return { w, h, channels, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit gray PNG; each row takes whichever filter leaves the smallest bytes. */
export function encodeGray(data: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h), row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let best = 0, bestCost = Infinity;
    const cand = new Uint8Array(w);
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < w; x++) {
        const v = data[o + x], a = x ? data[o + x - 1] : 0, up = y ? data[o - w + x] : 0, c = x && y ? data[o - w + x - 1] : 0;
        const d = (v - (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : paeth(a, up, c))) & 255;
        cand[x] = d;
        cost += d < 128 ? d : 256 - d;
      }
      if (cost < bestCost) {
        [best, bestCost] = [f, cost];
        row.set(cand);
      }
    }
    raw[y * (w + 1)] = best;
    raw.set(row, y * (w + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 0; // gray
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
