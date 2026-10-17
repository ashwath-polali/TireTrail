// Where water leaving a point most likely goes, following the ground downhill (build time only).
// Streams are burned into the DEM, depressions are filled, then the walk follows D8 until it meets
// a stream or lake, the Sound, or a closed low spot where the water probably soaks in.
import { Dem, PPD } from './dem.ts';
import { bigPatches, DC, depressions, DR, EXIT, fill, flowDirections, stepLengths, type Depressions } from './flow.ts';
import { lineCells, polygonCells } from './raster.ts';
import type { Coho, WaterFeature, WaterSet } from './waters.ts';

export type EstimateKind = 'stream' | 'lake' | 'sound' | 'depression' | 'unknown';
export type Stop = 'water' | 'sea' | 'pit' | 'far' | 'nodata' | 'edge';

export interface Estimate {
  kind: EstimateKind;
  /** water name; '' when unnamed or none */
  name: string;
  coho: Coho;
  /** meters along the downhill path to where it stops */
  distanceM: number;
  /** where it stops, lon/lat */
  at: [number, number];
  /** for an unnamed stream: the first named water it runs into */
  into?: string;
  /** meters on downstream to the coho reach, when it isn't right there */
  cohoDownstreamM?: number;
  /** meters the ground drops along the path */
  dropM: number;
  stop: Stop;
  /** lon/lat every few cells (keepPath) */
  path?: [number, number][];
}

export interface EstimateOptions {
  /** stream cells are lowered this much, after being made to run downhill */
  burnM: number;
  /** cells at or below this, in a patch of seaCells or more, are open water */
  seaZ: number;
  seaCells: number;
  /** a filled low spot this deep and big, with no mapped water and no lower ground near its rim, holds the water */
  pitDepthM: number;
  pitAreaM2: number;
  /** lower ground this close to a low spot's rim means a road fill or a culvert, not a closed basin */
  breachM: number;
  /** a coho reach this close counts (src/county/waters.ts COHO_MATCH_M) */
  cohoM: number;
  /** a stream reaching coho water this far downstream counts as coho (DEFAULT_COUNTY_TRACE_OPTIONS.downstreamCohoM) */
  downstreamCohoM: number;
  /** how far to look downstream for a name when the first stream has none */
  intoM: number;
  /** windows, smallest first; a walk reaching an edge retries in the next */
  levels: { coreM: number; haloM: number }[];
  keepPath: boolean;
}

export const DEFAULT_ESTIMATE_OPTIONS: EstimateOptions = {
  burnM: 3,
  seaZ: 0,
  seaCells: 20000,
  pitDepthM: 1,
  pitAreaM2: 2000,
  breachM: 50,
  cohoM: 20,
  downstreamCohoM: 2000,
  intoM: 5000,
  levels: [
    { coreM: 2000, haloM: 3000 },
    { coreM: 8000, haloM: 8000 },
    { coreM: 16000, haloM: 16000 },
  ],
  keepPath: false,
};

/** Meters per degree of latitude and longitude. */
export function metersPerDegree(lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  return [111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi), 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)];
}

/** The block grids use one cell size for the whole region. */
const [KX, KY] = metersPerDegree(47.25);
const DX0 = KX / PPD;
const DY0 = KY / PPD;

type Verdict = { kind: 'pass' } | { kind: 'pit' } | { kind: 'edge' } | { kind: 'water'; feat: number; cell: number };

/** One window's conditioned grid. */
export interface FlowWindow {
  row0: number;
  col0: number;
  rows: number;
  cols: number;
  dx: number;
  dy: number;
  step: number[];
  /** burned elevations */
  z: Float32Array;
  filled: Float32Array;
  dir: Uint8Array;
  sea: Uint8Array;
  /** feature (index into feats) at each cell, -1 none */
  water: Int32Array;
  feats: WaterFeature[];
  /** display name per feature, filled in for unnamed rivers drawn as areas */
  names: string[];
  dep: Depressions;
  verdicts: Map<number, Verdict>;
}

/** Feature priority on a shared cell: the Sound, lakes, named streams, then paths through lakes and river areas. */
function priority(f: WaterFeature, isLine: boolean): number {
  if (f.kind === 'sound') return 6;
  if (f.kind === 'lake') return 5;
  if (!isLine) return f.name ? 2 : 1;
  return f.name ? 4 : 3;
}

/** Builds the conditioned grid for global rows row0.. and columns col0... */
export async function buildWindow(dem: Dem, waters: WaterSet, row0: number, col0: number, rows: number, cols: number, opts: EstimateOptions): Promise<FlowWindow> {
  const n = rows * cols;
  const z = await dem.window(row0, col0, rows, cols);
  const [kx, ky] = metersPerDegree(Dem.latOf(row0 + rows / 2));
  const dx = kx / PPD;
  const dy = ky / PPD;
  const lon0 = Dem.lonOf(col0) - 0.5 / PPD;
  const lat0 = Dem.latOf(row0) + 0.5 / PPD;
  const box = [lon0, lat0 - rows / PPD, lon0 + cols / PPD, lat0] as const;
  const feats = waters.inBox(box);
  const water = new Int32Array(n).fill(-1);
  const prio = new Uint8Array(n);
  const sea = bigPatches((i) => z[i] <= opts.seaZ, rows, cols, opts.seaCells);
  const mark = (i: number, f: number, p: number) => {
    if (p >= prio[i]) {
      prio[i] = p;
      water[i] = f;
    }
  };
  const toCells = (a: Float64Array) => {
    const m = a.length / 2;
    const xs = new Float64Array(m);
    const ys = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      xs[k] = (a[2 * k] - lon0) * PPD;
      ys[k] = (lat0 - a[2 * k + 1]) * PPD;
    }
    return { xs, ys };
  };
  const burn = new Uint8Array(n);
  feats.forEach((f, fi) => {
    for (const poly of f.polygons ?? []) {
      const p = priority(f, false);
      polygonCells(poly.map(toCells), rows, cols, (i) => {
        mark(i, fi, p);
        if (f.kind === 'sound') sea[i] = 1;
      });
    }
    for (const line of f.lines ?? []) {
      const { xs, ys } = toCells(line);
      let cells = lineCells(xs, ys, rows, cols);
      if (!cells.length) continue;
      const p = priority(f, true);
      for (const i of cells) mark(i, fi, p);
      if (f.kind !== 'stream') continue;
      // make the line run downhill, as drawn, or turned around if the ground clearly says so
      if (!f.directed && cells.length > 1) {
        const a = z[cells[0]];
        const b = z[cells[cells.length - 1]];
        if (b > a + 1) cells = cells.reverse();
      }
      let low = Infinity;
      for (const i of cells) {
        if (Number.isNaN(z[i])) continue;
        if (z[i] < low) low = z[i];
        else z[i] = low;
        burn[i] = 1;
      }
    }
  });
  for (let i = 0; i < n; i++) if (burn[i]) z[i] -= opts.burnM;
  const filled = fill(z, rows, cols, sea);
  const dir = flowDirections(filled, rows, cols, dx, dy, sea);
  const dep = depressions(z, filled, rows, cols);
  // unnamed river areas take the most common name of the lines inside them
  const names = feats.map((f) => f.name);
  const votes = new Map<number, Map<string, number>>();
  for (let i = 0; i < n; i++) {
    const f = water[i];
    if (f < 0 || feats[f].name || feats[f].kind !== 'stream' || !feats[f].polygons?.length) continue;
    // a cell only remembers its top feature, so look for named lines next to it
    const r = (i / cols) | 0;
    const c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const g = water[rr * cols + cc];
      if (g < 0 || !feats[g].name || feats[g].kind !== 'stream') continue;
      const m = votes.get(f) ?? new Map<string, number>();
      m.set(feats[g].name, (m.get(feats[g].name) ?? 0) + 1);
      votes.set(f, m);
    }
  }
  for (const [f, m] of votes) names[f] = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  return { row0, col0, rows, cols, dx, dy, step: stepLengths(dx, dy), z, filled, dir, sea, water, feats, names, dep, verdicts: new Map() };
}

/** Margin (cells) where the walk counts as reaching the edge. */
const EDGE_CELLS = 8;

export class Estimator {
  readonly opts: EstimateOptions;
  private readonly dem: Dem;
  private readonly waters: WaterSet;
  private readonly windows = new Map<string, FlowWindow>();
  /** windows built, per level */
  readonly built: number[];
  private readonly maxCells: number;

  constructor(dem: Dem, waters: WaterSet, opts: Partial<EstimateOptions> = {}, maxCells = 48e6) {
    this.dem = dem;
    this.waters = waters;
    this.opts = { ...DEFAULT_ESTIMATE_OPTIONS, ...opts };
    this.built = this.opts.levels.map(() => 0);
    this.maxCells = maxCells;
  }

  /** The window around a point at a level: its core block plus a halo. */
  blockKey(lon: number, lat: number, level: number): string {
    const L = this.opts.levels[level];
    const cr = Math.max(1, Math.round(L.coreM / DY0));
    const cc = Math.max(1, Math.round(L.coreM / DX0));
    return `${level}:${Math.floor(Dem.rowOf(lat) / cr)}:${Math.floor(Dem.colOf(lon) / cc)}`;
  }

  private async windowFor(lon: number, lat: number, level: number): Promise<FlowWindow> {
    const key = this.blockKey(lon, lat, level);
    const hit = this.windows.get(key);
    if (hit) {
      this.windows.delete(key);
      this.windows.set(key, hit);
      return hit;
    }
    const L = this.opts.levels[level];
    const cr = Math.max(1, Math.round(L.coreM / DY0));
    const cc = Math.max(1, Math.round(L.coreM / DX0));
    const hr = Math.round(L.haloM / DY0);
    const hc = Math.round(L.haloM / DX0);
    const br = Math.floor(Dem.rowOf(lat) / cr);
    const bc = Math.floor(Dem.colOf(lon) / cc);
    const w = await buildWindow(this.dem, this.waters, br * cr - hr, bc * cc - hc, cr + 2 * hr, cc + 2 * hc, this.opts);
    this.built[level]++;
    this.windows.set(key, w);
    let cells = 0;
    for (const x of this.windows.values()) cells += x.rows * x.cols;
    for (const [k, x] of this.windows) {
      if (cells <= this.maxCells || x === w) continue;
      this.windows.delete(k);
      cells -= x.rows * x.cols;
    }
    return w;
  }

  /** Drops cached windows (between levels). */
  clear(): void {
    this.windows.clear();
  }

  async estimate(lon: number, lat: number): Promise<Estimate> {
    const last = this.opts.levels.length - 1;
    for (let level = 0; ; level++) {
      const w = await this.windowFor(lon, lat, level);
      const e = this.walk(w, lon, lat, level === last);
      if (e.stop !== 'edge' || level === last) return e;
    }
  }

  /** Estimates for many points, reusing each window for the points inside its core. */
  async estimateAll(points: readonly { lon: number; lat: number }[], log: (s: string) => void = () => {}): Promise<Estimate[]> {
    const out: Estimate[] = new Array(points.length);
    let todo = points.map((_, i) => i);
    const last = this.opts.levels.length - 1;
    for (let level = 0; level <= last && todo.length; level++) {
      const keys = todo.map((i) => this.blockKey(points[i].lon, points[i].lat, level));
      const order = todo.map((i, k) => [i, keys[k]] as const).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] - b[0]));
      const next: number[] = [];
      let done = 0;
      for (const [i] of order) {
        const w = await this.windowFor(points[i].lon, points[i].lat, level);
        const e = this.walk(w, points[i].lon, points[i].lat, level === last);
        if (e.stop === 'edge' && level < last) next.push(i);
        else out[i] = e;
        if (++done % 250 === 0) log(`  level ${level}: ${done}/${order.length} points, ${this.built[level]} windows`);
      }
      log(`  level ${level}: ${order.length} points, ${this.built[level]} windows, ${next.length} go on to a bigger window`);
      this.clear();
      todo = next;
    }
    return out;
  }

  private lonLat(w: FlowWindow, i: number): [number, number] {
    const r = (i / w.cols) | 0;
    const c = i - r * w.cols;
    return [Math.round(Dem.lonOf(w.col0 + c) * 1e6) / 1e6, Math.round(Dem.latOf(w.row0 + r) * 1e6) / 1e6];
  }

  private nearEdge(w: FlowWindow, i: number): boolean {
    const r = (i / w.cols) | 0;
    const c = i - r * w.cols;
    return r < EDGE_CELLS || c < EDGE_CELLS || r >= w.rows - EDGE_CELLS || c >= w.cols - EDGE_CELLS;
  }

  /** Water at a cell or right next to it: the cell's own first, then the top-priority neighbor. */
  private waterAt(w: FlowWindow, i: number): number {
    if (w.water[i] >= 0) return i;
    const r = (i / w.cols) | 0;
    const c = i - r * w.cols;
    let best = -1;
    let bp = -1;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || cc < 0 || rr >= w.rows || cc >= w.cols) continue;
      const j = rr * w.cols + cc;
      const f = w.water[j];
      if (f < 0) continue;
      const p = priority(w.feats[f], !!w.feats[f].lines?.length) * 2 + (k === 1 || k === 3 || k === 4 || k === 6 ? 1 : 0);
      if (p > bp) {
        bp = p;
        best = j;
      }
    }
    return best;
  }

  private seaAt(w: FlowWindow, i: number): boolean {
    if (w.sea[i]) return true;
    const r = (i / w.cols) | 0;
    const c = i - r * w.cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr >= 0 && cc >= 0 && rr < w.rows && cc < w.cols && w.sea[rr * w.cols + cc]) return true;
    }
    return false;
  }

  /** Is the filled low spot d a closed basin, mapped water, or just a dip to pass through? */
  private verdict(w: FlowWindow, d: number, top: boolean): Verdict {
    const cached = w.verdicts.get(d);
    if (cached) return cached;
    const v = this.judge(w, d, top);
    w.verdicts.set(d, v);
    return v;
  }

  private judge(w: FlowWindow, d: number, top: boolean): Verdict {
    const o = this.opts;
    const dep = w.dep.list[d];
    if (dep.depth < o.pitDepthM) return { kind: 'pass' };
    if (dep.edge) return top ? { kind: 'pass' } : { kind: 'edge' };
    if (dep.cells * w.dx * w.dy < o.pitAreaM2) return { kind: 'pass' };
    // mapped water inside: the low spot is that water (the most cells, streams first)
    const count = new Map<number, number>();
    for (let k = dep.start; k < dep.start + dep.cells; k++) {
      const f = w.water[w.dep.members[k]];
      if (f >= 0) count.set(f, (count.get(f) ?? 0) + 1);
    }
    if (count.size) {
      const rank = (f: number) => (w.feats[f].kind === 'stream' ? 2e9 : 0) + (count.get(f) ?? 0);
      const feat = [...count.keys()].sort((a, b) => rank(b) - rank(a) || a - b)[0];
      let cell = -1;
      for (let k = dep.start; k < dep.start + dep.cells && cell < 0; k++) if (w.water[w.dep.members[k]] === feat) cell = w.dep.members[k];
      return { kind: 'water', feat, cell };
    }
    if (this.breachable(w, d)) return { kind: 'pass' };
    return { kind: 'pit' };
  }

  /** Ground lower than the bottom of low spot d lies within breachM of its rim. */
  private breachable(w: FlowWindow, d: number): boolean {
    const dep = w.dep.list[d];
    const bottom = w.z[dep.pit];
    const R = this.opts.breachM;
    const rr = Math.ceil(R / w.dy);
    const rc = Math.ceil(R / w.dx);
    const { label, members } = w.dep;
    for (let k = dep.start; k < dep.start + dep.cells; k++) {
      const i = members[k];
      const r = (i / w.cols) | 0;
      const c = i - r * w.cols;
      let rim = false;
      for (let q = 0; q < 8 && !rim; q++) {
        const r2 = r + DR[q];
        const c2 = c + DC[q];
        rim = r2 >= 0 && c2 >= 0 && r2 < w.rows && c2 < w.cols && label[r2 * w.cols + c2] !== d;
      }
      if (!rim) continue;
      for (let a = -rr; a <= rr; a++) {
        const r2 = r + a;
        if (r2 < 0 || r2 >= w.rows) continue;
        for (let b = -rc; b <= rc; b++) {
          const c2 = c + b;
          if (c2 < 0 || c2 >= w.cols) continue;
          if ((a * w.dy) ** 2 + (b * w.dx) ** 2 > R * R) continue;
          const j = r2 * w.cols + c2;
          if (label[j] !== d && w.z[j] < bottom) return true;
        }
      }
    }
    return false;
  }

  /** Follows the ground down from a point in one window. */
  walk(w: FlowWindow, lon: number, lat: number, top: boolean): Estimate {
    const r0 = Dem.rowOf(lat) - w.row0;
    const c0 = Dem.colOf(lon) - w.col0;
    let i = r0 * w.cols + c0;
    const startZ = w.filled[i];
    const path: [number, number][] = [];
    let m = 0;
    const done = (stop: Stop, at: number, extra: Partial<Estimate> = {}): Estimate => {
      const dropM = Number.isFinite(startZ) && Number.isFinite(w.filled[at]) ? Math.max(0, Math.round((startZ - w.filled[at]) * 10) / 10) : 0;
      const e: Estimate = { kind: 'unknown', name: '', coho: 'no', distanceM: Math.round(m), at: this.lonLat(w, at), dropM, stop, ...extra };
      if (this.opts.keepPath) e.path = [...path, this.lonLat(w, at)];
      return e;
    };
    if (Number.isNaN(w.z[i])) return done('nodata', i);
    for (let steps = 0; steps < w.rows * w.cols; steps++) {
      if (this.opts.keepPath && steps % 5 === 0) path.push(this.lonLat(w, i));
      const hit = this.waterAt(w, i);
      if (hit >= 0) {
        if (hit !== i) m += Math.hypot(((hit % w.cols) - (i % w.cols)) * w.dx, (((hit / w.cols) | 0) - ((i / w.cols) | 0)) * w.dy) / 2;
        return this.atWater(w, hit, w.water[hit], m, done);
      }
      if (this.seaAt(w, i)) return done('sea', i, { kind: 'sound', name: 'Puget Sound' });
      const d = w.dep.label[i];
      if (d >= 0) {
        const v = this.verdict(w, d, top);
        if (v.kind === 'pit') return done('pit', i, { kind: 'depression' });
        if (v.kind === 'edge') return done('edge', i);
        if (v.kind === 'water') {
          // across the low spot to its water, in a straight line
          const dr = ((v.cell / w.cols) | 0) - ((i / w.cols) | 0);
          const dc = (v.cell % w.cols) - (i % w.cols);
          m += Math.hypot(dr * w.dy, dc * w.dx);
          return this.atWater(w, v.cell, v.feat, m, done);
        }
      }
      if (this.nearEdge(w, i) && !top) return done('edge', i);
      const k = w.dir[i];
      if (k === EXIT) return done(this.nearEdge(w, i) ? 'edge' : 'nodata', i);
      i += DR[k] * w.cols + DC[k];
      m += w.step[k];
    }
    return done('far', i);
  }

  /** Name, coho and the water downstream for a walk that met feature f at cell i. */
  private atWater(w: FlowWindow, i: number, f: number, m: number, done: (stop: Stop, at: number, extra?: Partial<Estimate>) => Estimate): Estimate {
    const feat = w.feats[f];
    const name = w.names[f];
    if (feat.kind === 'sound') return done('sea', i, { kind: 'sound', name: 'Puget Sound' });
    const [lon, lat] = this.lonLat(w, i);
    const here = this.waters.cohoNear(lon, lat, this.opts.cohoM);
    let coho: Coho = here?.level ?? 'no';
    const extra: Partial<Estimate> = { kind: feat.kind, name, coho };
    if (feat.kind === 'stream' && (coho !== 'yes' || !name)) {
      // follow the stream on down for coho water and a name
      let j = i;
      let along = 0;
      let into = '';
      const far = Math.max(this.opts.downstreamCohoM, name ? 0 : this.opts.intoM);
      for (let s = 0; s < w.rows * w.cols && along <= far; s++) {
        const k = w.dir[j];
        if (k === EXIT || w.sea[j]) break;
        j += DR[k] * w.cols + DC[k];
        along += w.step[k];
        const g = this.waterAt(w, j);
        if (g < 0) continue;
        const gf = w.water[g];
        if (!name && !into && w.names[gf] && w.feats[gf].kind !== 'sound') into = w.names[gf];
        if (coho !== 'yes' && along <= this.opts.downstreamCohoM && w.feats[gf].kind === 'stream') {
          const [glon, glat] = this.lonLat(w, g);
          const c = this.waters.cohoNear(glon, glat, this.opts.cohoM);
          if (c && (c.level === 'yes' || coho === 'no')) {
            coho = c.level;
            extra.cohoDownstreamM = Math.round(along);
          }
        }
        if ((coho === 'yes' || along > this.opts.downstreamCohoM) && (name || into)) break;
      }
      extra.coho = coho;
      if (into) extra.into = into;
    }
    return done('water', i, extra);
  }
}
