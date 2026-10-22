// Writes public/data/overview.json: every traced street, simplified, so the whole county draws at once.
// Runs are grouped by the area file they came from (0 = Bonney Lake, built in) and keep their class.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeCoords, type Bundle } from '../src/data/bundle.ts';
import { localProjection, polylineLength, simplify, type XY } from '../src/geo/geo.ts';
import { OVERVIEW_FORMAT, OVERVIEW_SCALE, type OverviewFile } from '../src/app/map/world.ts';

const TOL = 8; // m
const MIN_LEN = 30; // m, under a pixel where the overview draws (120 m a pixel and up)

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const P = localProjection();
const ids = (read('public/data/areas/index.json') as { id: string }[]).map((a) => a.id);
const out: OverviewFile = { format: OVERVIEW_FORMAT, version: 1, scale: OVERVIEW_SCALE, areas: ['', ...ids], per: [], cls: '', n: [], xy: [] };
let px = 0, py = 0, kept = 0, dropped = 0, verts = 0;
const cls: string[] = [];

[read('public/data/tiretrail.json') as Bundle, ...ids.map((id) => read(`public/data/areas/${id}.json`) as Bundle)].forEach((b) => {
  const r = b.streets.runs;
  let count = 0;
  r.geom.forEach((g, i) => {
    const xy: XY[] = decodeCoords(g).map((c) => P.toXY(c));
    if (polylineLength(xy) < MIN_LEN) { dropped++; return; }
    const s = simplify(xy, TOL).map((p) => P.toLngLat(p));
    const k = r.cls[i];
    cls.push(Number.isInteger(k) && k >= 0 && k <= 9 ? String(k) : '3');
    out.n.push(s.length);
    for (const [lon, lat] of s) {
      const x = Math.round(lon * OVERVIEW_SCALE), y = Math.round(lat * OVERVIEW_SCALE);
      out.xy.push(x - px, y - py);
      [px, py] = [x, y];
    }
    count++;
    verts += s.length;
  });
  out.per.push(count);
  kept += count;
});
out.cls = cls.join('');

const text = JSON.stringify(out);
writeFileSync('public/data/overview.json', text);
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
console.log(`overview: ${kept} runs (${dropped} under ${MIN_LEN} m dropped), ${verts} points, ${kb(text.length)} (${kb(gzipSync(text).length)} gzipped)`);
