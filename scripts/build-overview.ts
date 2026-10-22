// Writes public/data/overview.json: every traced street, simplified, so the whole county draws at once.
// Runs are grouped by the area file they came from (0 = Bonney Lake, built in) and keep their class;
// runs of one class that meet end to start are joined first.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeCoords, type Bundle } from '../src/data/bundle.ts';
import { localProjection, polylineLength, simplify, type XY } from '../src/geo/geo.ts';
import { OVERVIEW_FORMAT, OVERVIEW_SCALE, type OverviewFile } from '../src/app/map/world.ts';

const TOL = 10; // m
const MIN_LEN = 20; // m

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const P = localProjection();
const ids = (read('public/data/areas/index.json') as { id: string }[]).map((a) => a.id);
const out: OverviewFile = { format: OVERVIEW_FORMAT, version: 1, scale: OVERVIEW_SCALE, areas: ['', ...ids], per: [], cls: '', n: [], xy: [] };
let px = 0, py = 0, kept = 0, dropped = 0, verts = 0;
const cls: string[] = [];

/** Runs of one class that meet end to start join into one line, so the file holds fewer, longer lines. */
export function chain(lines: { xy: XY[]; k: number }[]): { xy: XY[]; k: number }[] {
  const key = (p: XY, k: number) => `${k}:${Math.round(p[0])},${Math.round(p[1])}`;
  const starts = new Map<string, number[]>();
  lines.forEach((l, i) => { const s = key(l.xy[0], l.k); starts.set(s, [...(starts.get(s) ?? []), i]); });
  const used = new Uint8Array(lines.length), ends = new Set<string>(lines.map((l) => key(l.xy[l.xy.length - 1], l.k)));
  const out: { xy: XY[]; k: number }[] = [];
  // start where no run ends, then loops
  const order = [...lines.keys()].sort((a, b) => Number(ends.has(key(lines[a].xy[0], lines[a].k))) - Number(ends.has(key(lines[b].xy[0], lines[b].k))) || a - b);
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    const xy = [...lines[i].xy];
    for (;;) {
      const next = (starts.get(key(xy[xy.length - 1], lines[i].k)) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      xy.push(...lines[next].xy.slice(1));
    }
    out.push({ xy, k: lines[i].k });
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
