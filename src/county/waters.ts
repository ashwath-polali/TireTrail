// County waters: WDFW coho reaches, county streams and lakes. "fennel" on a Water means coho-bearing here.
import {
  bboxOf,
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

  constructor(layers: CountyWaterLayers, projection: Projection) {
    const xy = (p: number[]): XY => projection.toXY([p[0], p[1]]);
    for (const f of layers.swifdCoho.features) {
      const name = swifdName(text(f.properties.LLID_STRM_NAME));
      this.add({ name, kind: 'creek', fennel: true, source: 'coho', lines: linesOf(f.geometry, xy) });
    }
    const cohoCount = this.all.length;
    for (const f of layers.hydroCenterlines.features) {
      const p = f.properties;
      if (!STREAM_TYPES.has(text(p.FeatureType)) || text(p.StreamTypeNPDES) === 'MS4') continue;
      const lines = linesOf(f.geometry, xy);
      const coho = this.mostlyNearCoho(lines, cohoCount);
      this.add({ name: text(p.FeatureName), kind: 'creek', fennel: coho, source: 'stream', lines });
    }
    for (const f of layers.hydroWaterbodies.features) {
      const polygons = polygonsOf(f.geometry, xy);
      if (!polygons.length || polygonsArea(polygons) < MIN_LAKE_AREA_M2) continue;
      this.add({ name: text(f.properties.FeatureName), kind: 'lake', fennel: false, source: 'lake', polygons });
    }
  }

  private mostlyNearCoho(lines: XY[][], cohoCount: number): boolean {
    let near = 0;
    let total = 0;
    for (const l of lines) {
      const len = polylineLength(l);
      for (let s = 0; s <= len; s += 10) {
        total++;
        const p = pointAlong(l, s);
        if (this.index.near(p, COHO_MATCH_M).some((i) => i < cohoCount && distanceTo(this.all[i], p) <= COHO_MATCH_M)) near++;
      }
    }
    return total > 0 && near / total >= 0.5;
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
