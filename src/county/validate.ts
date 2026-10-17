// Checks traces against the County's drainage circuits (polygons drawn around connected networks)
// and against the drawn direction of the lines. Never feeds back into the trace.
import { bboxOf, distanceToPolygons, GridIndex, type Projection, type XY } from '../geo/geo.ts';
import type { FeatureCollection } from '../trace/geojson.ts';
import type { Trace } from '../trace/trace.ts';
import type { CountyAsset } from './assets.ts';
import type { Graph } from './graph.ts';
import { drawnReach } from './route.ts';
import type { CountyTraced } from './trace.ts';

export interface DrawnCheck {
  /** Drains routed to an ending (the rest follow the drawing until the map stops). */
  routed: number;
  /** ... whose ending can't be reached going only the drawn way. */
  notDrawn: number;
  /** Routes running against the drawing more than 20, 60 and 100 m in total. */
  over20: number;
  over60: number;
  over100: number;
}

export function checkDrawn(g: Graph, t: Pick<CountyTraced, 'traces' | 'routing' | 'againstM'>): DrawnCheck {
  const out: DrawnCheck = { routed: 0, notDrawn: 0, over20: 0, over60: 0, over100: 0 };
  t.traces.forEach((tr, i) => {
    const start = g.nodeOf[tr.drain];
    const sink = t.routing.sink[start];
    if (sink < 0) return;
    out.routed++;
    if (!drawnReach(g, start).has(sink)) out.notDrawn++;
    const a = t.againstM[i];
    if (a > 20) out.over20++;
    if (a > 60) out.over60++;
    if (a > 100) out.over100++;
  });
  return out;
}

export interface CircuitCheck {
  drains: number;
  /** Drains inside (or within tol of) a circuit. */
  inCircuit: number;
  /** ... whose whole path stays within tol of that circuit. */
  pathInside: number;
  /** Of drains whose circuit holds an end point: ... */
  circuitHasEndPoint: number;
  /** ... the trace ends at one of that circuit's end points. */
  endsAtCircuitEndPoint: number;
  /** ... the trace ends at an end point, but another one. */
  endsElsewhere: number;
}

export function checkCircuits(
  assets: readonly CountyAsset[],
  traces: readonly Trace[],
  circuits: FeatureCollection,
  projection: Projection,
  tolM = 3,
): CircuitCheck {
  const polys: XY[][][][] = [];
  const idx = new GridIndex<number>(100);
  for (const f of circuits.features) {
    const g = f.geometry;
    const raw = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const p = raw.map((rings) => rings.map((r) => r.map((c) => projection.toXY([c[0], c[1]]))));
    if (!p.length || !p[0].length || p[0][0].length < 3) continue;
    idx.insert(polys.length, bboxOf(p.flat(2)));
    polys.push(p);
  }
  const near = (pt: XY) => {
    let best = -1;
    let bestD = Infinity;
    for (const i of idx.near(pt, tolM)) {
      const d = distanceToPolygons(pt, polys[i]);
      if (d <= tolM && (d < bestD || (d === bestD && i < best))) [best, bestD] = [i, d];
    }
    return best;
  };
  // end points per circuit
  const endPoints = new Map<number, Set<number>>();
  for (const a of assets) {
    if (a.layer !== 'endpoint') continue;
    for (const i of idx.near(a.anchor, tolM)) {
      if (distanceToPolygons(a.anchor, polys[i]) > tolM) continue;
      const s = endPoints.get(i) ?? new Set<number>();
      s.add(a.index);
      endPoints.set(i, s);
    }
  }
  const out: CircuitCheck = { drains: traces.length, inCircuit: 0, pathInside: 0, circuitHasEndPoint: 0, endsAtCircuitEndPoint: 0, endsElsewhere: 0 };
  for (const t of traces) {
    const c = near(assets[t.drain].anchor);
    if (c < 0) continue;
    out.inCircuit++;
    const inside = t.path.every((k) => (assets[k].line ?? [assets[k].anchor]).every((p) => distanceToPolygons(p, polys[c]) <= tolM));
    if (inside) out.pathInside++;
    const eps = endPoints.get(c);
    if (!eps?.size) continue;
    out.circuitHasEndPoint++;
    const exit = assets[t.ending.exit];
    if (eps.has(exit.index)) out.endsAtCircuitEndPoint++;
    else if (exit.layer === 'endpoint') out.endsElsewhere++;
  }
  return out;
}
