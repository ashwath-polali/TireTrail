// One file out of a zip, as a stream, without unpacking the rest.
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

/** The first entry whose name matches, unpacked as it's read. */
export function unzipEntry(file: string, name: RegExp): { name: string; size: number; stream: Readable } {
  const fd = openSync(file, 'r');
  try {
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b; };
    const size = fstatSync(fd).size;
    const tail = read(Math.max(0, size - 66000), Math.min(size, 66000));
    let e = tail.length - 22;
    while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error(`${file}: not a zip`);
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
    // zip64: the real numbers are in another record
    if (e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {
      const z = read(Number(tail.readBigUInt64LE(e - 12)), 56);
      [count, cdSize, cdAt] = [Number(z.readBigUInt64LE(32)), Number(z.readBigUInt64LE(40)), Number(z.readBigUInt64LE(48))];
    }
    const cd = read(cdAt, cdSize);
    for (let p = 0, i = 0; i < count; i++) {
      const method = cd.readUInt16LE(p + 10), nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), kl = cd.readUInt16LE(p + 32);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), at = cd.readUInt32LE(p + 42);
      const nm = cd.toString('utf8', p + 46, p + 46 + nl);
      for (let x = p + 46 + nl; x < p + 46 + nl + el; x += 4 + cd.readUInt16LE(x + 2)) {
        if (cd.readUInt16LE(x) !== 1) continue;
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (at === 0xffffffff) at = Number(cd.readBigUInt64LE(q));
      }
      if (name.test(nm)) {
        if (method !== 0 && method !== 8) throw new Error(`${file}: ${nm} is packed a way this can't read`);
        const local = read(at, 30), start = at + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const raw = createReadStream(file, { start, end: start + csize - 1, highWaterMark: 1 << 20 });
        return { name: nm, size: usize, stream: method === 8 ? raw.pipe(createInflateRaw({ chunkSize: 1 << 20 })) : raw };
      }
      p += 46 + nl + el + kl;
    }
    throw new Error(`${file}: nothing matches ${name}`);
  } finally {
    closeSync(fd);
  }
}
