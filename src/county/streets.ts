// County streets: colored like the city's (src/trace/streets.ts, same sampling and runs), except that where
// no storm drain is mapped within reach, rain runs into a County ditch that runs along the road.
import { bboxOf, dist, GridIndex, pointAlong, polylineLength, slicePolyline, type Projection, type XY } from '../geo/geo.ts';
import { num, text, type FeatureCollection } from '../trace/geojson.ts';
import {
  DEFAULT_STREET_OPTIONS,
  STREET_CLASSES,
  terrainGuess,
  type StreetClass,
  type StreetOptions,
  type StreetPiece,
  type StreetResult,
  type StreetRun,
} from '../trace/streets.ts';
import { isRoadsideChannel, type CountyAsset } from './assets.ts';

export interface IntakeOptions {
  /** A ditch this close to the street's centerline takes its rain... */
  ditchM: number;
  /** ...if it runs along the street, within this angle (a ditch crossing the road doesn't). */
  maxAngleDeg: number;
  /** Only where no storm drain is mapped this close (the street classifier's reach). */
  drainM: number;
}

// Beside gray streets, 1,316 of 1,416 km of ditch runs within 10 degrees of the road and 22 km crosses at 80 to 90.
export const DEFAULT_INTAKE_OPTIONS: IntakeOptions = { ditchM: 10, maxAngleDeg: 30, drainM: DEFAULT_STREET_OPTIONS.maxDrainM };

/** Finds the roadside ditch that takes a street's rain where no drain is mapped. */
export class IntakeFinder {
  private readonly opts: IntakeOptions;
  /** [asset, ax, ay, bx, by] per ditch segment. */
  private readonly segs: number[] = [];
  private readonly segIdx = new GridIndex<number>(25);
  private readonly drains: readonly XY[];
  private readonly drainIdx = new GridIndex<number>(50);
  private readonly cos: number;

  /** drains: every storm drain's spot, county-wide. */
  constructor(assets: readonly CountyAsset[], drains: readonly XY[], opts: IntakeOptions = DEFAULT_INTAKE_OPTIONS) {
    this.opts = opts;
    this.cos = Math.cos((opts.maxAngleDeg * Math.PI) / 180);
    this.drains = drains;
    drains.forEach((p, i) => this.drainIdx.insertPoint(i, p));
    for (const a of assets) {
      if (!isRoadsideChannel(a)) continue;
      const l = a.line!;
      for (let k = 1; k < l.length; k++) {
        if (dist(l[k - 1], l[k]) === 0) continue;
        const s = this.segs.length;
        this.segs.push(a.index, l[k - 1][0], l[k - 1][1], l[k][0], l[k][1]);
        this.segIdx.insert(s, bboxOf([l[k - 1], l[k]]));
      }
    }
  }

  /** Ditch asset taking the rain `along` meters down a street line, or -1 (a drain is near, or no ditch runs along). */
  at(line: readonly XY[], along: number, length = polylineLength(line)): number {
    const p = pointAlong(line, along);
    const { ditchM, drainM } = this.opts;
    if (this.drainIdx.near(p, drainM).some((i) => dist(p, this.drains[i]) <= drainM)) return -1;
    const q0 = pointAlong(line, Math.max(0, along - 2.5));
    const q1 = pointAlong(line, Math.min(length, along + 2.5));
    const ux = q1[0] - q0[0];
    const uy = q1[1] - q0[1];
    const ul = Math.hypot(ux, uy);
    if (ul === 0) return -1;
    let best = -1;
    let bestD = Infinity;
    const s = this.segs;
    for (const k of this.segIdx.near(p, ditchM)) {
      const [ax, ay, bx, by] = [s[k + 1], s[k + 2], s[k + 3], s[k + 4]];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      // runs along the street: |cos| of the angle between them
      if (Math.abs(ux * dx + uy * dy) / (ul * Math.sqrt(len2)) < this.cos) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
      const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
      if (d <= ditchM && (d < bestD || (d === bestD && s[k] < best))) [best, bestD] = [s[k], d];
    }
    return best;
  }
}

/** A street piece's line in local meters, or null if the city classifier would skip it. */
export function streetLine(g: FeatureCollection['features'][number]['geometry'], projection: Projection): XY[] | null {
  if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return null;
  const coords = g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
  const line = coords.map((c) => projection.toXY([c[0], c[1]]));
  return polylineLength(line) === 0 ? null : line;
}

/**
 * Street pieces sampled every 5 m; each sample takes its nearest drain within reach, else (when `intake` is given)
 * the roadside ditch that takes its rain. Indexes: drains 0..n-1 by drainAt, then whatever `intake` returns.
 */
export function classifyCountyStreets(
  streets: FeatureCollection,
  drainAt: readonly XY[],
  clsOf: (trace: number) => StreetClass,
  projection: Projection,
  intake: ((line: readonly XY[], along: number, length: number) => number) | null,
  opts: StreetOptions = DEFAULT_STREET_OPTIONS,
): StreetResult {
  const index = new GridIndex<number>(50);
  drainAt.forEach((p, i) => index.insertPoint(i, p));
  const nearestDrain = (p: XY): number => {
    let best = -1;
    let bestD = Infinity;
    for (const i of index.near(p, opts.maxDrainM)) {
      const d = dist(p, drainAt[i]);
      if (d <= opts.maxDrainM && (d < bestD || (d === bestD && i < best))) [best, bestD] = [i, d];
    }
    return best;
  };

  const pieces: StreetPiece[] = [];
  const runs: StreetRun[] = [];
  streets.features.forEach((f) => {
    const line = streetLine(f.geometry, projection);
    if (!line) return;
    const length = polylineLength(line);

    // sample points along the piece, both ends included
    const at: number[] = [];
    for (let s = 0; s < length; s += opts.sampleM) at.push(s);
    at.push(length);
    const drains = at.map((s) => {
      const d = nearestDrain(pointAlong(line, s));
      return d >= 0 || !intake ? d : intake(line, s, length);
    });

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
        cls: s.drain < 0 ? 'none' : clsOf(s.drain),
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

/** Merge the shortest too-short span into its longer neighbor, repeat (as src/trace/streets.ts does). */
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
