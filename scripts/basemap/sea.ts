// Salt water (Puget Sound and its bays): OSM's coastline made into water polygons by osmdata.openstreetmap.de (ODbL).
// The shapefile is read straight out of the zip, so the 1.3 GB inside never lands on disk.
import type { LngLat } from '../../src/geo/geo.ts';
import { unzipEntry } from './zip.ts';

export const SEA_URL = 'https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip';

// positive when the ring runs counterclockwise
const area = (r: readonly LngLat[]) => {
  let a = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
  return a / 2;
};
function inRing(p: LngLat, ring: readonly LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Sea polygons ([outer, ...holes], lon/lat) that meet the box [w, s, e, n]. */
export async function* seaPolygons(zip: string, [W, S, E, N]: number[]): AsyncGenerator<LngLat[][]> {
  const { stream } = unzipEntry(zip, /water_polygons\.shp$/);
  let buf: Buffer = Buffer.alloc(0), header = true;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    // the unread end of the last chunk, then this one
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let p = 0;
    if (header) {
      if (buf.length < 100) continue;
      if (buf.readInt32BE(0) !== 9994) throw new Error(`${zip}: not a shapefile`);
      header = false;
      p = 100;
    }
    // records: number and length (16-bit words) big-endian, then the shape little-endian
    while (p + 8 <= buf.length) {
      const len = buf.readInt32BE(p + 4) * 2;
      if (p + 8 + len > buf.length) break;
      const r = p + 8;
      p += 8 + len;
      if (buf.readInt32LE(r) !== 5) continue;
      const x0 = buf.readDoubleLE(r + 4), y0 = buf.readDoubleLE(r + 12), x1 = buf.readDoubleLE(r + 20), y1 = buf.readDoubleLE(r + 28);
      if (x1 < W || x0 > E || y1 < S || y0 > N) continue;
      const parts = buf.readInt32LE(r + 36), n = buf.readInt32LE(r + 40), pts = r + 44 + 4 * parts;
      const rings: LngLat[][] = [];
      for (let i = 0; i < parts; i++) {
        const a = buf.readInt32LE(r + 44 + 4 * i), b = i + 1 < parts ? buf.readInt32LE(r + 48 + 4 * i) : n;
        const ring: LngLat[] = [];
        for (let k = a; k < b; k++) ring.push([buf.readDoubleLE(pts + 16 * k), buf.readDoubleLE(pts + 16 * k + 8)]);
        rings.push(ring);
      }
      // outer rings run clockwise, holes (islands) the other way; each hole goes with the outer that holds it
      const outers = rings.filter((g) => area(g) < 0), holes = rings.filter((g) => area(g) > 0);
      for (const o of outers) yield [o, ...holes.filter((h) => outers.length === 1 || inRing(h[0], o))];
    }
    buf = buf.subarray(p);
  }
}
