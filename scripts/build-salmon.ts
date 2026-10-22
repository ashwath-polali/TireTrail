// Writes public/data/salmon/: Washington's salmon and steelhead streams, every place a road crosses one,
// and the road stretches that run beside one. Run: npm run build:salmon
// Sources: WDFW SWIFD (geodataservices.wdfw.wa.gov, MapServices/SWIFD layer 0), Documented and Presumed only,
// fetched once into .cache/salmon; names from SWIFD, else USGS NHD flowlines (hydro.nationalmap.gov);
// roads from the Geofabrik OpenStreetMap GeoPackage (read only).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { nearestOnPolyline, simplify, type LngLat, type XY } from '../src/geo/geo.ts';
import { cleanName, crossT, segDist } from '../src/salmon/build.ts';
import { SPECIES } from '../src/salmon/species.ts';
import { BESIDE_M, CHUNK_M, TIERS, TILE, type RawIndex, type RawTier, type RawTile } from '../src/salmon/tiles.ts';
import { readGeom } from './basemap/gpkg.ts';
import { project, unproject } from './lib/lcc.ts';
import { STATES } from './lib/states.ts';

const OUT = 'public/data/salmon';
const CACHE = process.env.SALMON_CACHE ?? '.cache/salmon';
const SWIFD = 'https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/SWIFD/MapServer/0/query';
const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';
// occupied habitat only: SWIFD also lists historic, potential, modeled and confirmed-absent reaches
const KINDS = ['Documented', 'Presumed'];
const DRIVE = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
/** one crossing per stream within this, m (two carriageways, a ramp beside the bridge) */
const SAME_M = 60;
/** a road stretch counts as beside a stream from this long, m */
const BESIDE_MIN = 200;
/** a SWIFD species line already drawn by another within this, m */
const DRAWN_M = 15;
// open water SWIFD routes through: not a stream to name
const OPEN = /\b(Lake|Sound|Bay|Reservoir|Inlet|Harbor|Passage|Canal|Pond|Waterway|Ocean|Strait)$/i;

interface Rec { llid: string; name: string; sp: number; paths: LngLat[][] }
interface Stream { llid: string; name: string; sp: number; lines: XY[][]; crossings: number }
interface Seg { s: number; sp: number; a: XY; b: XY }
interface Cross { s: number; sp: number; at: XY; dir: number; cls: number; road: string }

// ---------- fetch ----------

async function getJson(url: string, body?: URLSearchParams): Promise<any> {
  for (let tries = 0; ; tries++) {
    try {
      const res = await fetch(url, body ? { method: 'POST', body } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j;
    } catch (e) {
      if (tries >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
    }
  }
}

async function swifd(): Promise<Rec[]> {
  const file = `${CACHE}/swifd.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const where = `SPECIES IN (${SPECIES.map((s) => `'${s.swifd}'`).join(',')}) AND DISTTYPE_DESC IN (${KINDS.map((k) => `'${k}'`).join(',')})`;
  const count = (await getJson(`${SWIFD}?${new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' })}`)).count as number;
  const pages: number[] = [];
  for (let o = 0; o < count; o += 1000) pages.push(o);
  const out: Rec[] = [];
  let done = 0;
  const one = async (o: number) => {
    const q = new URLSearchParams({ where, outFields: 'LLID,LLID_STRM_NAME,SPECIES', outSR: '4326', geometryPrecision: '6', maxAllowableOffset: '0.00002',
      orderByFields: 'OBJECTID', resultOffset: String(o), resultRecordCount: '1000', f: 'json' });
    const j = await getJson(SWIFD, q);
    for (const f of j.features ?? []) {
      const a = f.attributes, bit = SPECIES.find((s) => s.swifd === a.SPECIES)?.bit ?? 0;
      if (!bit || !f.geometry?.paths?.length) continue;
      out.push({ llid: a.LLID, name: a.LLID_STRM_NAME ?? '', sp: bit, paths: f.geometry.paths });
    }
    process.stdout.write(`\rSWIFD ${++done}/${pages.length} pages`);
  };
  for (let k = 0; k < pages.length; k += 4) await Promise.all(pages.slice(k, k + 4).map(one));
  console.log(`, ${out.length} of ${count} records`);
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** NHD names for unnamed streams at crossings: the named flowline nearest each point, within 40 m. */
async function nhdNames(points: { key: number; ll: LngLat }[]): Promise<Map<number, string>> {
  const file = `${CACHE}/nhd-names.json`;
  const cached: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const out = new Map<number, string>(), todo: { key: number; ll: LngLat; id: string }[] = [];
  for (const p of points) {
    const id = `${p.ll[0].toFixed(5)},${p.ll[1].toFixed(5)}`;
    if (id in cached) { if (cached[id]) out.set(p.key, cached[id]); } else todo.push({ ...p, id });
  }
  let done = 0;
  const one = async (p: (typeof todo)[number]) => {
    const q = new URLSearchParams({ geometry: `${p.ll[0]},${p.ll[1]}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      distance: '40', units: 'esriSRUnit_Meter', where: "gnis_name IS NOT NULL AND gnis_name <> ''", outFields: 'gnis_name', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.00005', f: 'json' });
    let name = '';
    try {
      const j = await getJson(`${NHD}?${q}`);
      let best = Infinity;
      const c = project(p.ll);
      for (const f of j.features ?? []) for (const path of f.geometry?.paths ?? []) {
        const d = nearestOnPolyline(c, (path as LngLat[]).map((ll) => project(ll))).d;
        if (d < best) [best, name] = [d, f.attributes.gnis_name];
      }
    } catch { return; }
    cached[p.id] = name;
    if (name) out.set(p.key, name);
    if (++done % 50 === 0) process.stdout.write(`\rNHD names ${done}/${todo.length}`);
  };
  for (let k = 0; k < todo.length; k += 24) {
    await Promise.all(todo.slice(k, k + 24).map(one));
    if (k % 240 === 0) writeFileSync(file, JSON.stringify(cached));
  }
  if (todo.length) { console.log(`\rNHD names ${done}/${todo.length}`); writeFileSync(file, JSON.stringify(cached)); }
  return out;
}

// ---------- geometry ----------

class Grid<T> {
  readonly cells = new Map<number, T[]>();
  readonly size: number;
  constructor(size: number) { this.size = size; }
  key(i: number, j: number): number { return (i + 32768) * 65536 + j + 32768; }
  add(t: T, x0: number, y0: number, x1: number, y1: number): void {
    const S = this.size;
    for (let i = Math.floor(x0 / S); i <= Math.floor(x1 / S); i++) for (let j = Math.floor(y0 / S); j <= Math.floor(y1 / S); j++) {
      const k = this.key(i, j), l = this.cells.get(k);
      if (l) l.push(t); else this.cells.set(k, [t]);
    }
  }
  each(x0: number, y0: number, x1: number, y1: number, f: (t: T) => void): void {
    const S = this.size;
    for (let i = Math.floor(x0 / S); i <= Math.floor(x1 / S); i++) for (let j = Math.floor(y0 / S); j <= Math.floor(y1 / S); j++) {
      const l = this.cells.get(this.key(i, j));
      if (l) for (const t of l) f(t);
    }
  }
}

/** Lines in pieces no longer than CHUNK_M, sharing their ends. */
function chunks(line: XY[]): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [line[0]], len = 0;
  for (let k = 1; k < line.length; k++) {
    len += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
    cur.push(line[k]);
    if (len >= CHUNK_M && k < line.length - 1) { out.push(cur); cur = [line[k]]; len = 0; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** [first x, first y, then deltas], whole meters */
function deltas(line: readonly XY[]): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  for (const p of line) {
    const X = Math.round(p[0]), Y = Math.round(p[1]);
    if (out.length && X === x && Y === y) continue;
    out.push(X - x, Y - y);
    [x, y] = [X, Y];
  }
  return out;
}

const tileOf = (p: XY) => `${Math.floor(p[0] / TILE)}_${Math.floor(p[1] / TILE)}`;

// ---------- build ----------

async function main(): Promise<void> {
  const t0 = Date.now();
  const recs = await swifd();
  // streams by LLID; each species record's line kept for the crossings
  const byId = new Map<string, number>(), streams: Stream[] = [];
  const segs = new Grid<Seg>(250);
  const lines: { s: number; sp: number; pts: XY[] }[] = [];
  for (const r of recs) {
    let s = byId.get(r.llid);
    if (s === undefined) { byId.set(r.llid, (s = streams.length)); streams.push({ llid: r.llid, name: cleanName(r.name), sp: 0, lines: [], crossings: 0 }); }
    streams[s].sp |= r.sp;
    for (const p of r.paths) if (p.length > 1) lines.push({ s, sp: r.sp, pts: p.map((ll) => project(ll)) });
  }
  for (const l of lines) for (let k = 1; k < l.pts.length; k++) {
    const a = l.pts[k - 1], b = l.pts[k];
    segs.add({ s: l.s, sp: l.sp, a, b }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
  }
  console.log(`${streams.length} streams, ${lines.length} species lines`);

  // each stream drawn once: the longest species line, then only the parts of the others not drawn yet
  const drawn = new Grid<{ s: number; a: XY; b: XY }>(100);
  const len = (p: XY[]) => p.reduce((t, q, k) => (k ? t + Math.hypot(q[0] - p[k - 1][0], q[1] - p[k - 1][1]) : 0), 0);
  for (const l of [...lines].sort((a, b) => len(b.pts) - len(a.pts))) {
    const near = (p: XY) => {
      let hit = false;
      drawn.each(p[0] - DRAWN_M, p[1] - DRAWN_M, p[0] + DRAWN_M, p[1] + DRAWN_M, (q) => { if (!hit && q.s === l.s && segDist(p, q.a, q.b) <= DRAWN_M) hit = true; });
      return hit;
    };
    const covered = l.pts.map(near), N = l.pts.length, pieces: XY[][] = [];
    // the new parts, each reaching one point into the drawn part so they meet it
    let run: XY[] = [];
    for (let k = 0; k < N; k++) {
      if (!covered[k] || (k > 0 && !covered[k - 1]) || (k + 1 < N && !covered[k + 1])) run.push(l.pts[k]);
      else { if (run.length > 1) pieces.push(run); run = []; }
    }
    if (run.length > 1) pieces.push(run);
    streams[l.s].lines.push(...pieces);
    for (const piece of pieces) for (let k = 1; k < piece.length; k++) {
      const a = piece[k - 1], b = piece[k];
      drawn.add({ s: l.s, a, b }, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }

  // roads: every crossing, and stretches beside a stream
  const db = new DatabaseSync(STATES[0].gpkg, { readOnly: true });
  const rows = db.prepare(`SELECT fclass, name, ref, tunnel, geom FROM gis_osm_roads_free WHERE fclass IN (${DRIVE.map(() => '?').join(',')})`);
  const raw: Cross[] = [], beside: { s: number; pts: XY[] }[] = [];
  let n = 0, besideM = 0;
  for (const r of rows.iterate(...DRIVE) as Iterable<{ fclass: string; name: string | null; ref: string | null; tunnel: string | null; geom: Uint8Array }>) {
    if (++n % 50000 === 0) process.stdout.write(`\rroads ${n}`);
    if (r.tunnel === 'T') continue;
    const cls = r.fclass.startsWith('motorway') ? 5 : r.fclass.startsWith('trunk') ? 4 : r.fclass.startsWith('primary') ? 3 : r.fclass.startsWith('secondary') ? 2 : 1;
    const road = r.ref && cls >= 3 ? r.ref.split(';')[0] : r.name ?? '';
    for (const ll of readGeom(r.geom).lines) {
      const pts = ll.map((p) => project(p));
      // samples every 25 m, for stretches beside a stream
      let open: { s: number; pts: XY[]; m: number } | null = null;
      const close = () => { if (open && open.m >= BESIDE_MIN) { beside.push(open); besideM += open.m; } open = null; };
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        segs.each(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), (q) => {
          const t = crossT(a, b, q.a, q.b);
          if (t < 0) return;
          const dir = ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 180;
          raw.push({ s: q.s, sp: q.sp, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], dir: Math.round(dir), cls, road });
        });
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(L / 25));
        for (let i = k === 1 ? 0 : 1; i <= steps; i++) {
          const p: XY = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
          let best = -1, bd = BESIDE_M;
          segs.each(p[0] - BESIDE_M, p[1] - BESIDE_M, p[0] + BESIDE_M, p[1] + BESIDE_M, (q) => { const d = segDist(p, q.a, q.b); if (d < bd) [bd, best] = [d, q.s]; });
          if (best >= 0 && open && open.s === best) { open.m += L / steps; open.pts.push(p); }
          else { close(); if (best >= 0) open = { s: best, pts: [p], m: 0 }; }
        }
      }
      close();
    }
  }
  db.close();
  console.log(`\r${n} roads, ${raw.length} raw crossings, ${(besideM / 1609.344).toFixed(0)} mi beside`);

  // one crossing per stream per place, with every species there
  const cg = new Grid<Cross>(SAME_M), cross: Cross[] = [];
  for (const c of raw.sort((a, b) => b.cls - a.cls)) {
    let same: Cross | null = null;
    cg.each(c.at[0] - SAME_M, c.at[1] - SAME_M, c.at[0] + SAME_M, c.at[1] + SAME_M, (o) => { if (!same && o.s === c.s && Math.hypot(o.at[0] - c.at[0], o.at[1] - c.at[1]) <= SAME_M) same = o; });
    if (same) { (same as Cross).sp |= c.sp; continue; }
    cross.push(c);
    cg.add(c, c.at[0], c.at[1], c.at[0], c.at[1]);
  }
  // names: SWIFD's, else NHD's at a crossing; open water isn't a stream
  const unnamed = cross.filter((c) => !streams[c.s].name);
  const firstOf = new Map<number, Cross>();
  for (const c of unnamed) if (!firstOf.has(c.s)) firstOf.set(c.s, c);
  const nhd = await nhdNames([...firstOf].map(([s, c]) => ({ key: s, ll: unproject(c.at) })));
  for (const [s, nm] of nhd) if (!OPEN.test(nm)) streams[s].name = nm;
  for (const st of streams) if (OPEN.test(st.name)) st.name = '';
  for (const c of cross) streams[c.s].crossings++;
  console.log(`${cross.length} crossings; ${unnamed.length} on streams SWIFD leaves unnamed, ${nhd.size} of ${firstOf.size} such streams named from NHD`);

  // ---------- write ----------
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}/t`, { recursive: true });
  const tiles = new Map<string, { s: Map<number, number>; t: RawTile }>();
  const tile = (p: XY) => {
    const k = tileOf(p);
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { s: new Map(), t: { v: 1, s: [], l: [], c: [], b: [] } }));
    return t;
  };
  const local = (t: { s: Map<number, number>; t: RawTile }, s: number) => {
    let i = t.s.get(s);
    if (i === undefined) { t.s.set(s, (i = t.t.s.length)); t.t.s.push([streams[s].name, streams[s].sp, streams[s].crossings]); }
    return i;
  };
  for (const [s, st] of streams.entries()) for (const line of st.lines) for (const piece of chunks(simplify(line, TIERS.near))) {
    const t = tile(piece[0]);
    t.t.l.push([local(t, s), ...deltas(piece)]);
  }
  for (const c of cross) {
    const t = tile(c.at);
    t.t.c.push([Math.round(c.at[0]), Math.round(c.at[1]), local(t, c.s), c.dir, c.sp]);
  }
  for (const b of beside) for (const piece of chunks(simplify(b.pts, 10))) {
    const t = tile(piece[0]);
    t.t.b.push([local(t, b.s), ...deltas(piece)]);
  }
  let bytes = 0;
  for (const [k, t] of tiles) { const j = JSON.stringify(t.t); bytes += j.length; writeFileSync(`${OUT}/t/${k}.json`, j); }
  // far tiers: the whole state in one file each, long streams only far out
  for (const tier of ['far', 'mid'] as const) {
    const tol = TIERS[tier], f: RawTier = { v: 1, l: [] };
    for (const st of streams) for (const line of st.lines) {
      if (len(line) < (tier === 'far' ? 10000 : 1000)) continue;
      const d = deltas(simplify(line, tol));
      if (d.length >= 4) f.l.push([st.sp, ...d]);
    }
    const j = JSON.stringify(f);
    bytes += j.length;
    writeFileSync(`${OUT}/${tier}.json`, j);
  }
  const miles = streams.reduce((t, st) => t + st.lines.reduce((u, l) => u + len(l), 0), 0) / 1609.344;
  const index: RawIndex = { v: 1, tile: TILE, tiles: [...tiles.keys()].sort(), streams: streams.length, crossings: cross.length, miles: Math.round(miles),
    source: 'WDFW SWIFD (Documented and Presumed salmon and steelhead), USGS NHD names, OpenStreetMap roads', built: new Date().toISOString().slice(0, 10) };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  console.log(`${tiles.size} tiles, ${(bytes / 1e6).toFixed(2)} MB, ${Math.round(miles)} stream miles, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await main();
