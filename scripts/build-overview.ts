// Writes public/data/overview.json: every traced street, simplified, so the whole county draws at once.
// Runs are grouped by the area file they came from (0 = Bonney Lake, built in) and keep their class;
// runs of one class that meet end to start are joined first.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeCoords, type Bundle } from '../src/data/bundle.ts';
import { localProjection, polylineLength, simplify, type XY } from '../src/geo/geo.ts';
import { OVERVIEW_FORMAT, OVERVIEW_SCALE, type OverviewFile } from '../src/app/map/world.ts';

const TOL = 15; // m, well under a pixel at 120 m a pixel
const MIN_LEN = 45; // m, under half a pixel where the overview draws (120 m a pixel and up)

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const P = localProjection();
const ids = (read('public/data/areas/index.json') as { id: string }[]).map((a) => a.id);
const out: OverviewFile = { format: OVERVIEW_FORMAT, version: 1, scale: OVERVIEW_SCALE, areas: ['', ...ids], per: [], cls: '', n: [], xy: [] };
let px = 0, py = 0, kept = 0, dropped = 0, verts = 0;
const cls: string[] = [];

/** Runs of one class that meet at an end join into one line (either way round), so the file holds fewer, longer lines. */
export function chain(lines: { xy: XY[]; k: number }[]): { xy: XY[]; k: number }[] {
  const key = (p: XY, k: number) => `${k}:${Math.round(p[0])},${Math.round(p[1])}`;
  const at = new Map<string, number[]>();
  const add = (s: string, i: number) => at.set(s, [...(at.get(s) ?? []), i]);
  lines.forEach((l, i) => { add(key(l.xy[0], l.k), i); add(key(l.xy[l.xy.length - 1], l.k), i); });
  const used = new Uint8Array(lines.length);
  const out: { xy: XY[]; k: number }[] = [];
  /** the next unused run touching p, turned to start at p */
  const take = (p: XY, k: number): XY[] | null => {
    const s = key(p, k);
    const j = (at.get(s) ?? []).find((q) => !used[q]);
    if (j === undefined) return null;
    used[j] = 1;
    return key(lines[j].xy[0], k) === s ? lines[j].xy : [...lines[j].xy].reverse();
  };
  // start where only one run ends, then the rest
  const lone = (i: number) => Number((at.get(key(lines[i].xy[0], lines[i].k))?.length ?? 0) > 1);
  const order = [...lines.keys()].sort((a, b) => lone(a) - lone(b) || a - b);
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    const k = lines[i].k;
    let xy = [...lines[i].xy];
    for (let n = take(xy[xy.length - 1], k); n; n = take(xy[xy.length - 1], k)) xy.push(...n.slice(1));
    for (let n = take(xy[0], k); n; n = take(xy[0], k)) xy = [...[...n].reverse(), ...xy.slice(1)];
    out.push({ xy, k });
  }
  return out;
}

[read('public/data/tiretrail.json') as Bundle, ...ids.map((id) => read(`public/data/areas/${id}.json`) as Bundle)].forEach((b) => {
  const r = b.streets.runs;
  let count = 0;
  const lines = r.geom.map((g, i) => ({ xy: decodeCoords(g).map((c) => P.toXY(c)), k: Number.isInteger(r.cls[i]) && r.cls[i] >= 0 && r.cls[i] <= 9 ? r.cls[i] : 3 }));
  for (const { xy, k } of chain(lines)) {
    if (polylineLength(xy) < MIN_LEN) { dropped++; continue; }
    const s = simplify(xy, TOL).map((p) => P.toLngLat(p));
    cls.push(String(k));
    out.n.push(s.length);
    for (const [lon, lat] of s) {
      const x = Math.round(lon * OVERVIEW_SCALE), y = Math.round(lat * OVERVIEW_SCALE);
      out.xy.push(x - px, y - py);
      [px, py] = [x, y];
    }
    count++;
    verts += s.length;
  }
  out.per.push(count);
  kept += count;
});
out.cls = cls.join('');

const text = JSON.stringify(out);
writeFileSync('public/data/overview.json', text);
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
console.log(`overview: ${kept} runs (${dropped} under ${MIN_LEN} m dropped), ${verts} points, ${kb(text.length)} (${kb(gzipSync(text).length)} gzipped)`);
