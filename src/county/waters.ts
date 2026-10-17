// County waters: WDFW coho reaches, county streams and lakes. "fennel" on a Water means coho-bearing here.
import {
  bboxOf,
  dist,
  distanceToPolygons,
  GridIndex,
  nearestOnPolyline,
  pointAlong,
  polygonsArea,
  polylineLength,
  type Projection,
  type XY,
} from '../geo/geo.ts';
import { text, type FeatureCollection, type Geometry } from '../trace/geojson.ts';
import type { Water } from '../trace/waters.ts';

export interface CountyWaterLayers {
  swifdCoho: FeatureCollection;
  hydroCenterlines: FeatureCollection;
  hydroWaterbodies: FeatureCollection;
}

export interface CountyWater extends Water {
  /** coho: SWIFD reach (classification only, not drawn). */
  source: 'coho' | 'stream' | 'lake';
}

export interface WaterNear {
  water: CountyWater;
  d: number;
}

/** Ponds smaller than this aren't receiving waters (same as Bonney Lake). */
const MIN_LAKE_AREA_M2 = 3000;
/** A county stream is drawn as coho-bearing if most of it runs within this of a coho reach. */
const COHO_MATCH_M = 20;
/** Centerline types that are streams (not storm pipes). */
const STREAM_TYPES = new Set(['Stream', 'River', 'Culvert', 'Waterbody', 'Drainage']);
/** Stream line ends this close are one joint. */
const JOIN_M = 1;

/** One drawn piece of the County's stream lines (drawn downstream: 2254 joints merge, 81 split). */
interface StreamLink {
  line: XY[];
  lengthM: number;
  from: number;
  to: number;
  /** Runs along a coho reach. */
  coho: boolean;
}

function linesOf(g: Geometry | null, xy: (p: number[]) => XY): XY[][] {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates.map(xy)];
  if (g.type === 'MultiLineString') return g.coordinates.map((part) => part.map(xy));
  return [];
}

function polygonsOf(g: Geometry | null, xy: (p: number[]) => XY): XY[][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates.map((r) => r.map(xy))];
  if (g.type === 'MultiPolygon') return g.coordinates.map((poly) => poly.map((r) => r.map(xy)));
  return [];
}

function distanceTo(w: Water, p: XY): number {
  let best = Infinity;
  for (const line of w.lines ?? []) best = Math.min(best, nearestOnPolyline(p, line).d);
  if (w.polygons) best = Math.min(best, distanceToPolygons(p, w.polygons));
  return best;
}

/** "Unnamed stream [1220954471946]" -> "" */
export function swifdName(raw: string): string {
  return /^unnamed/i.test(raw) ? '' : raw.replace(/\s*\[\d+\]\s*$/, '').trim();
}

export class CountyWaters {
  readonly all: CountyWater[] = [];
  private readonly index = new GridIndex<number>(200);
  /** Every stream line piece, MS4 ones too, for walking downstream. */
  private readonly links: StreamLink[] = [];
  private readonly linksOf = new Map<CountyWater, number[]>();
  private readonly outOf = new Map<number, number[]>();

  constructor(layers: CountyWaterLayers, projection: Projection) {
    const xy = (p: number[]): XY => projection.toXY([p[0], p[1]]);
    for (const f of layers.swifdCoho.features) {
      const name = swifdName(text(f.properties.LLID_STRM_NAME));
      this.add({ name, kind: 'creek', fennel: true, source: 'coho', lines: linesOf(f.geometry, xy) });
    }
    const cohoCount = this.all.length;
    for (const f of layers.hydroCenterlines.features) {
      const p = f.properties;
      const lines = linesOf(f.geometry, xy);
      const samples = lines.map((l) => this.cohoSamples(l, cohoCount));
      const near = samples.reduce((s, [n]) => s + n, 0);
      const total = samples.reduce((s, [, t]) => s + t, 0);
      const receiving = STREAM_TYPES.has(text(p.FeatureType)) && text(p.StreamTypeNPDES) !== 'MS4';
      const w: CountyWater | null = receiving ? { name: text(p.FeatureName), kind: 'creek', fennel: total > 0 && near / total >= 0.5, source: 'stream', lines } : null;
      if (w) this.add(w);
      lines.forEach((line, i) => {
        if (line.length < 2) return;
        if (w) this.linksOf.set(w, [...(this.linksOf.get(w) ?? []), this.links.length]);
        this.links.push({ line, lengthM: polylineLength(line), from: -1, to: -1, coho: samples[i][0] / samples[i][1] >= 0.5 });
      });
    }
    for (const f of layers.hydroWaterbodies.features) {
      const polygons = polygonsOf(f.geometry, xy);
      if (!polygons.length || polygonsArea(polygons) < MIN_LAKE_AREA_M2) continue;
      this.add({ name: text(f.properties.FeatureName), kind: 'lake', fennel: false, source: 'lake', polygons });
    }
    this.joinLinks();
  }

  /** Stream line ends within JOIN_M share a joint. */
  private joinLinks(): void {
    const pts = this.links.flatMap((l) => [l.line[0], l.line[l.line.length - 1]]);
    const parent = pts.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    const idx = new GridIndex<number>(10);
    pts.forEach((p, i) => {
      for (const j of idx.near(p, JOIN_M)) if (dist(p, pts[j]) <= JOIN_M) parent[find(i)] = find(j);
      idx.insertPoint(i, p);
    });
    this.links.forEach((l, k) => {
      l.from = find(2 * k);
      l.to = find(2 * k + 1);
      this.outOf.set(l.from, [...(this.outOf.get(l.from) ?? []), k]);
    });
  }

  /**
   * Coho water a stream carries water to within maxM downstream of p, following the County's
   * stream lines as drawn. Stops where the lines split or end, so the answer is never a guess between ways.
   */
  downstreamCoho(w: CountyWater, p: XY, maxM: number): { name: string; m: number } | null {
    let cur = -1;
    let along = 0;
    let best = Infinity;
    for (const k of this.linksOf.get(w) ?? []) {
      const on = nearestOnPolyline(p, this.links[k].line);
      if (on.d < best) [cur, along, best] = [k, on.along, on.d];
    }
    if (cur < 0) return null;
    let m = this.links[cur].lengthM - along;
    const seen = new Set([cur]);
    while (m <= maxM) {
      const outs = this.outOf.get(this.links[cur].to) ?? [];
      if (outs.length !== 1 || seen.has(outs[0])) return null;
      cur = outs[0];
      seen.add(cur);
      const l = this.links[cur];
      if (l.coho) {
        // name it like cohoName: a named county stream, else the WDFW name
        const at = l.line[0];
        const named = this.nearest(at, COHO_MATCH_M, (x) => x.fennel && x.source === 'stream' && x.name !== '') ?? this.nearest(at, COHO_MATCH_M, (x) => x.fennel && x.name !== '');
        return { name: named?.water.name ?? '', m };
      }
      m += l.lengthM;
    }
    return null;
  }

  /** Points every 10 m along a line: [within COHO_MATCH_M of a coho reach, all]. */
  private cohoSamples(l: XY[], cohoCount: number): [number, number] {
    let near = 0;
    let total = 0;
    const len = polylineLength(l);
    for (let s = 0; s <= len; s += 10) {
      total++;
      const p = pointAlong(l, s);
      if (this.index.near(p, COHO_MATCH_M).some((i) => i < cohoCount && distanceTo(this.all[i], p) <= COHO_MATCH_M)) near++;
    }
    return [near, total];
  }

  private add(w: CountyWater): void {
    if (!w.lines?.length && !w.polygons?.length) return;
    const i = this.all.length;
    this.all.push(w);
    this.index.insert(i, bboxOf([...(w.lines ?? []).flat(), ...(w.polygons ?? []).flat(2)]));
  }

  /** Nearest coho water within tol: a WDFW reach, or a county stream that runs along one. */
  coho(p: XY, tol: number): WaterNear | null {
    return this.nearest(p, tol, (w) => w.fennel);
  }

  /** Nearest stream or lake within tol that isn't a coho reach. */
  other(p: XY, tol: number): WaterNear | null {
    return this.nearest(p, tol, (w) => !w.fennel);
  }

  /** Best name for coho water at p: a named county stream nearby, else the WDFW name. */
  cohoName(p: XY, hit: WaterNear, tol: number): string {
    const named = this.nearest(p, tol, (w) => w.source === 'stream' && w.name !== '');
    return named?.water.name || hit.water.name || 'Unnamed coho stream';
  }

  nearest(p: XY, tol: number, keep: (w: CountyWater) => boolean): WaterNear | null {
    let best: { d: number; i: number } | null = null;
    for (const i of this.index.near(p, tol)) {
      const w = this.all[i];
      if (!keep(w)) continue;
      const d = distanceTo(w, p);
      if (d <= tol && (!best || d < best.d || (d === best.d && i < best.i))) best = { d, i };
    }
    return best ? { water: this.all[best.i], d: best.d } : null;
  }

  /** Drawn waters (not the raw coho reaches) touching a box, in local meters. */
  drawable(box: { minX: number; minY: number; maxX: number; maxY: number }): CountyWater[] {
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const r = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2;
    const out: number[] = [];
    for (const i of this.index.near([cx, cy], r)) {
      const w = this.all[i];
      if (w.source === 'coho') continue;
      const b = bboxOf([...(w.lines ?? []).flat(), ...(w.polygons ?? []).flat(2)]);
      if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) continue;
      out.push(i);
    }
    return out.sort((a, b) => a - b).map((i) => this.all[i]);
  }
}
