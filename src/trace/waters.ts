// Mapped waters, split into the Fennel Creek system and the rest.
// Fennel = its tributaries, classified streams touching them, and lakes draining in
// (Bonney Lake, Debra Jane). Lake Tapps and others are "elsewhere".
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
import { text, type FeatureCollection, type Geometry } from './geojson.ts';

export interface Water {
  name: string;
  /** creek: city stream layers; lake: NHD waterbody; nhd: NHD flowline (fallback). */
  kind: 'creek' | 'lake' | 'nhd';
  fennel: boolean;
  lines?: XY[][];
  polygons?: XY[][][];
}

export interface WaterLayers {
  fennelCreek: FeatureCollection;
  fennelTributaries: FeatureCollection;
  streamClassification: FeatureCollection;
  nhdWaterbody: FeatureCollection;
  nhdFlowline: FeatureCollection;
}

export interface WaterHit {
  water: Water;
  d: number;
}

/** Streams this close to the Fennel network are part of it. */
const STREAM_JOIN_M = 10;
/** Lakes this close drain into Fennel (not Lake Tapps, which goes to the White River). */
const LAKE_JOIN_M = 30;
/** NHD polygons smaller than this are ponds, not receiving waters. */
const MIN_LAKE_AREA_M2 = 3000;
/** Stream classes that aren't natural streams. */
const NOT_STREAMS = new Set(['Stormwater Ditch', 'Not a stream']);

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

/** Points every step meters along a line. */
function samples(line: XY[], step: number): XY[] {
  const len = polylineLength(line);
  const out: XY[] = [];
  for (let s = 0; s < len; s += step) out.push(pointAlong(line, s));
  out.push(line[line.length - 1]);
  return out;
}

function distanceToWater(w: Water, p: XY): number {
  let best = Infinity;
  for (const line of w.lines ?? []) best = Math.min(best, nearestOnPolyline(p, line).d);
  if (w.polygons) best = Math.min(best, distanceToPolygons(p, w.polygons));
  return best;
}

export class Waters {
  readonly all: Water[] = [];
  private readonly index = new GridIndex<number>(100);

  constructor(layers: WaterLayers, projection: Projection) {
    const xy = (p: number[]): XY => projection.toXY([p[0], p[1]]);

    for (const f of layers.fennelCreek.features) {
      this.add({ name: 'Fennel Creek', kind: 'creek', fennel: true, lines: linesOf(f.geometry, xy) });
    }
    for (const f of layers.fennelTributaries.features) {
      const name = text(f.properties.FEATURE_NA) || 'Fennel Creek tributary (unnamed)';
      this.add({ name, kind: 'creek', fennel: true, lines: linesOf(f.geometry, xy) });
    }

    // any pts within tol of Fennel waters among the first count added
    // checked against a fixed snapshot so layer order doesn't matter
    const touchesFennel = (pts: XY[], tol: number, count: number) =>
      pts.some((p) => this.index.near(p, tol).some((i) => i < count && this.all[i].fennel && distanceToWater(this.all[i], p) <= tol));

    const net1 = this.all.length;
    for (const f of layers.streamClassification.features) {
      if (NOT_STREAMS.has(text(f.properties.StreamType))) continue;
      const lines = linesOf(f.geometry, xy);
      const raw = text(f.properties.StreamName);
      const named = raw === 'None' ? '' : raw;
      const fennel =
        named === 'Fennel Creek' ||
        named === 'Debra Jane Creek' ||
        lines.some((l) => touchesFennel(samples(l, 5), STREAM_JOIN_M, net1));
      this.add({ name: named || (fennel ? 'Fennel Creek tributary (unnamed)' : 'unnamed stream'), kind: 'creek', fennel, lines });
    }

    const net2 = this.all.length;
    const fennelSamples: XY[] = [];
    for (let i = 0; i < net2; i++) {
      if (this.all[i].fennel) for (const l of this.all[i].lines ?? []) fennelSamples.push(...samples(l, 5));
    }
    for (const f of layers.nhdWaterbody.features) {
      const polygons = polygonsOf(f.geometry, xy);
      if (!polygons.length || polygonsArea(polygons) < MIN_LAKE_AREA_M2) continue;
      const name = text(f.properties.GNIS_NAME ?? f.properties.gnis_name);
      const box = bboxOf(polygons.flat(2));
      const close = (p: XY) =>
        p[0] >= box.minX - LAKE_JOIN_M && p[0] <= box.maxX + LAKE_JOIN_M && p[1] >= box.minY - LAKE_JOIN_M && p[1] <= box.maxY + LAKE_JOIN_M;
      const fennel = name !== 'Lake Tapps' && fennelSamples.some((p) => close(p) && distanceToPolygons(p, polygons) <= LAKE_JOIN_M);
      this.add({ name: name || 'unnamed pond or lake', kind: 'lake', fennel, polygons });
    }

    for (const f of layers.nhdFlowline.features) {
      const name = text(f.properties.gnis_name ?? f.properties.GNIS_NAME);
      if (!name) continue;
      this.add({ name: `${name} (NHD)`, kind: 'nhd', fennel: name === 'Fennel Creek', lines: linesOf(f.geometry, xy) });
    }
  }

  private add(w: Water): void {
    if (!w.lines?.length && !w.polygons?.length) return;
    const i = this.all.length;
    this.all.push(w);
    const pts = [...(w.lines ?? []).flat(), ...(w.polygons ?? []).flat(2)];
    this.index.insert(i, bboxOf(pts));
  }

  /** Water an ending at p discharges into within tol meters. City and lake layers beat NHD; then closest. */
  at(p: XY, tol: number): WaterHit | null {
    let best: { rank: number; d: number; i: number } | null = null;
    for (const i of this.index.near(p, tol)) {
      const w = this.all[i];
      const d = distanceToWater(w, p);
      if (d > tol) continue;
      const rank = w.kind === 'nhd' ? 1 : 0;
      if (!best || rank < best.rank || (rank === best.rank && (d < best.d || (d === best.d && i < best.i)))) best = { rank, d, i };
    }
    return best ? { water: this.all[best.i], d: best.d } : null;
  }

  /** Lakes counted as Fennel (for the build report). */
  fennelLakes(): string[] {
    return this.all.filter((w) => w.kind === 'lake' && w.fennel).map((w) => w.name);
  }
}
