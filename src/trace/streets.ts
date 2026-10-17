// Colors each street by where its rain goes.
// Pieces are sampled every 5 m; each sample takes its nearest drain's class, and runs
// split where that drain changes. Also carries the "normal map guess": the creek
// terrain alone would pick (road layer drainage class).
import { GridIndex, dist, pointAlong, polylineLength, slicePolyline, type Projection, type XY } from '../geo/geo.ts';
import { num, text, type FeatureCollection } from './geojson.ts';
import { DRAIN_CLASSES, type DrainClass, type Trace } from './trace.ts';
import type { Network } from './network.ts';

/** none: no mapped drain in reach. */
export type StreetClass = DrainClass | 'none';
export const STREET_CLASSES: readonly StreetClass[] = [...DRAIN_CLASSES, 'none'];

export interface TerrainGuess {
  cls: DrainClass;
  /** Receiving water per terrain, e.g. "Fennel Creek". */
  name: string;
}

export interface StreetPiece {
  index: number;
  id: number;
  name: string;
  lengthM: number;
  terrain: TerrainGuess;
  /** Class covering most length. */
  cls: StreetClass;
  runs: number[];
}

export interface StreetRun {
  index: number;
  piece: number;
  /** Trace index of the drain for this run, -1 if none in reach. */
  drain: number;
  cls: StreetClass;
  fromM: number;
  toM: number;
  lengthM: number;
  line: XY[];
}

export interface StreetOptions {
  sampleM: number;
  /** Max distance to the credited drain. Basins sit ~90 m apart, so 45 m covers it; past 50 m, none. */
  maxDrainM: number;
  /** Shorter runs are flicker between two drains; merge into a neighbor. */
  minRunM: number;
}

export const DEFAULT_STREET_OPTIONS: StreetOptions = { sampleM: 5, maxDrainM: 50, minRunM: 10 };

/** Terrain answers in the Fennel system (incl. Bonney Lake, Debra Jane Creek). */
const TERRAIN_FENNEL = new Set(['Fennel Creek', 'Debra Jane Creek', 'Bonney Lake Outflow']);

export function terrainGuess(receiving: string): TerrainGuess {
  if (!receiving) return { cls: 'unknown', name: '' };
  if (TERRAIN_FENNEL.has(receiving)) return { cls: 'creek', name: receiving };
  // closed depression: water pools and soaks in
  if (/closed depression/i.test(receiving)) return { cls: 'ground', name: receiving };
  return { cls: 'elsewhere', name: receiving };
}

export interface StreetResult {
  pieces: StreetPiece[];
  runs: StreetRun[];
}

export function classifyStreets(
  streets: FeatureCollection,
  net: Network,
  traces: readonly Trace[],
  projection: Projection,
  opts: StreetOptions = DEFAULT_STREET_OPTIONS,
): StreetResult {
  const index = new GridIndex<number>(50);
  traces.forEach((t, i) => index.insertPoint(i, net.assets[t.drain].anchor));
  const nearestDrain = (p: XY): number => {
    let best = -1;
    let bestD = Infinity;
    for (const i of index.near(p, opts.maxDrainM)) {
      const d = dist(p, net.assets[traces[i].drain].anchor);
      if (d <= opts.maxDrainM && (d < bestD || (d === bestD && i < best))) [best, bestD] = [i, d];
    }
    return best;
  };
  const clsOf = (drain: number): StreetClass => (drain < 0 ? 'none' : traces[drain].ending.cls);

  const pieces: StreetPiece[] = [];
  const runs: StreetRun[] = [];
  streets.features.forEach((f) => {
    const g = f.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return;
    const coords = g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
    const line = coords.map((c) => projection.toXY([c[0], c[1]]));
    const length = polylineLength(line);
    if (length === 0) return;

    // sample points along the piece, both ends included
    const at: number[] = [];
    for (let s = 0; s < length; s += opts.sampleM) at.push(s);
    at.push(length);
    const drains = at.map((s) => nearestDrain(pointAlong(line, s)));

    // each sample owns the stretch halfway to its neighbors; equal drains in a row make a run
    let spans: { drain: number; from: number; to: number }[] = [];
    for (let i = 0; i < at.length; i++) {
      const from = i === 0 ? 0 : (at[i - 1] + at[i]) / 2;
      const to = i === at.length - 1 ? length : (at[i] + at[i + 1]) / 2;
      const last = spans[spans.length - 1];
      if (last && last.drain === drains[i]) last.to = to;
      else spans.push({ drain: drains[i], from, to });
    }
    spans = mergeShortSpans(spans, opts.minRunM);

    const piece: StreetPiece = {
      index: pieces.length,
      id: num(f.properties.id),
      name: text(f.properties.road_name),
      lengthM: length,
      terrain: terrainGuess(text(f.properties.receiving_creek)),
      cls: 'none',
      runs: [],
    };
    const byClass = new Map<StreetClass, number>();
    for (const s of spans) {
      const run: StreetRun = {
        index: runs.length,
        piece: piece.index,
        drain: s.drain,
        cls: clsOf(s.drain),
        fromM: s.from,
        toM: s.to,
        lengthM: s.to - s.from,
        line: slicePolyline(line, s.from, s.to),
      };
      runs.push(run);
      piece.runs.push(run.index);
      byClass.set(run.cls, (byClass.get(run.cls) ?? 0) + run.lengthM);
    }
    // majority by length; ties go to the earlier class in STREET_CLASSES
    piece.cls = STREET_CLASSES.reduce((best, c) => ((byClass.get(c) ?? 0) > (byClass.get(best) ?? 0) ? c : best), STREET_CLASSES[0]);
    if (!byClass.has(piece.cls)) piece.cls = runs[piece.runs[0]].cls;
    pieces.push(piece);
  });
  return { pieces, runs };
}

/** Merge the shortest too-short span into its longer neighbor, repeat. */
function mergeShortSpans<T extends { drain: number; from: number; to: number }>(spans: T[], minLen: number): T[] {
  const out = spans.map((s) => ({ ...s }));
  for (;;) {
    if (out.length < 2) return out;
    let shortest = -1;
    for (let i = 0; i < out.length; i++) {
      const len = out[i].to - out[i].from;
      if (len < minLen && (shortest < 0 || len < out[shortest].to - out[shortest].from)) shortest = i;
    }
    if (shortest < 0) return out;
    const prev = out[shortest - 1];
    const next = out[shortest + 1];
    const into = !prev ? next : !next ? prev : prev.to - prev.from >= next.to - next.from ? prev : next;
    if (into === prev) prev.to = out[shortest].to;
    else next.from = out[shortest].from;
    out.splice(shortest, 1);
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i].drain === out[i - 1].drain) {
        out[i - 1].to = out[i].to;
        out.splice(i, 1);
      }
    }
  }
}
