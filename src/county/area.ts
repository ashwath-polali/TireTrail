// One area's slice of the county trace, in the shape the bundle encoder reads.
import { GridIndex, nearestOnPolyline, type BBox, type Projection, type XY } from '../geo/geo.ts';
import type { BundleSource } from '../data/encode.ts';
import { exitPoint, streetTitle, type FixItem } from '../trace/fixlist.ts';
import type { Feature, FeatureCollection } from '../trace/geojson.ts';
import { computeNumbers } from '../trace/numbers.ts';
import type { StreetResult } from '../trace/streets.ts';
import type { Trace } from '../trace/trace.ts';
import type { Water } from '../trace/waters.ts';
import { describeCounty, type CountyAsset } from './assets.ts';
import type { Graph } from './graph.ts';
import { otherEnd } from './route.ts';
import { classifyCountyStreets, type IntakeFinder } from './streets.ts';
import { feet } from './trace.ts';
import type { CountyWaters } from './waters.ts';

/** Roadside ditches that take street rain where no drain is mapped. */
export interface CountyIntakes {
  finder: IntakeFinder;
  /** Intake trace and the edges it crossed, by ditch asset. */
  byChannel: Map<number, { trace: Trace; edges: number[] }>;
}

export interface CountyModel {
  assets: CountyAsset[];
  graph: Graph;
  traces: Trace[];
  traceEdges: number[][];
  waters: CountyWaters;
  /** Unincorporated road pieces, already in the street layer's shape (id, road_name, receiving_creek). */
  roads: Feature[];
  roadMid: XY[];
  projection: Projection;
  intakes?: CountyIntakes;
}

/** Drains just outside an area still color its edge streets. */
const EDGE_M = 60;

export const inBox = (p: XY, b: BBox, pad = 0) => p[0] >= b.minX - pad && p[0] <= b.maxX + pad && p[1] >= b.minY - pad && p[1] <= b.maxY + pad;

/** Where an intake trace starts: its ditch's drawn downstream end. */
const intakeStart = (m: CountyModel, ditch: number) => m.graph.lineEnds.get(ditch)![1];

/** Lines walked against their drawing get reversed, so bundle lines run in flow order. */
export function flowDirections(m: CountyModel): Set<number> {
  const votes = new Map<number, number>();
  const vote = (start: number, edges: readonly number[]) => {
    let node = start;
    for (const ei of edges) {
      const e = m.graph.edges[ei];
      if (e.how === 'line' && e.asset >= 0) votes.set(e.asset, (votes.get(e.asset) ?? 0) + (node === e.a ? 1 : -1));
      node = otherEnd(e, node);
    }
  };
  m.traceEdges.forEach((edges, t) => vote(m.graph.nodeOf[m.traces[t].drain], edges));
  for (const [ditch, x] of m.intakes?.byChannel ?? []) vote(intakeStart(m, ditch), x.edges);
  const reversed = new Set<number>();
  for (const [k, v] of votes) if (v < 0) reversed.add(k);
  return reversed;
}

/** Keeps the parts of a line inside a box (plus one vertex past each side). */
function clipLine(line: readonly XY[], b: BBox): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [];
  for (let i = 0; i < line.length; i++) {
    const keep = inBox(line[i], b) || (i > 0 && inBox(line[i - 1], b)) || (i + 1 < line.length && inBox(line[i + 1], b));
    if (keep) cur.push(line[i]);
    else if (cur.length) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export interface AreaSlice extends BundleSource {
  /** Drains whose catch basin sits inside the area (the rest are edge drains). */
  ownDrains: number;
  ownByClass: Record<string, number>;
  /** Traces before this index are storm drains; the rest are roadside ditch intakes. */
  drainCount: number;
}

export function sliceArea(m: CountyModel, box: BBox, reversed: ReadonlySet<number>, drainIdx: GridIndex<number>): AreaSlice {
  const { assets, traces } = m;
  // drains: inside the box, plus edge drains near it
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const r = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) / 2 + EDGE_M;
  const picked = drainIdx
    .near([cx, cy], r)
    .filter((t) => inBox(assets[traces[t].drain].anchor, box, EDGE_M))
    .sort((a, b) => a - b);
  const D = picked.length;

  // streets: pieces whose middle is in the box; drains first, then roadside ditches where no drain is mapped
  const roads: FeatureCollection = { type: 'FeatureCollection', features: m.roads.filter((_, i) => inBox(m.roadMid[i], box)) };
  const ditches: number[] = [];
  const slot = new Map<number, number>();
  const intakes = m.intakes;
  const intake = intakes
    ? (line: readonly XY[], along: number, length: number) => {
        const ditch = intakes.finder.at(line, along, length);
        if (ditch < 0 || !intakes.byChannel.has(ditch)) return -1;
        let k = slot.get(ditch);
        if (k === undefined) {
          k = D + ditches.length;
          slot.set(ditch, k);
          ditches.push(ditch);
        }
        return k;
      }
    : null;
  const traceAt = (k: number): Trace => (k < D ? traces[picked[k]] : intakes!.byChannel.get(ditches[k - D])!.trace);
  const streets = classifyCountyStreets(roads, picked.map((t) => assets[traces[t].drain].anchor), (k) => traceAt(k).ending.cls, m.projection, intake);
  // keep the ditches some run still uses (samples can merge into a neighbor's run), numbered after the drains
  const used = new Set(streets.runs.map((x) => x.drain));
  const kept = ditches.filter((_, j) => used.has(D + j));
  const renumber = new Map(kept.map((ditch, j) => [slot.get(ditch)!, D + j]));
  for (const run of streets.runs) if (run.drain >= D) run.drain = renumber.get(run.drain)!;
  const areaTraces = [...picked.map((t) => traces[t]), ...kept.map((ditch) => intakes!.byChannel.get(ditch)!.trace)];

  // assets: everything on those paths, plus the network drawn inside the box
  const keep = new Set<number>();
  for (const t of areaTraces) for (const k of t.path) keep.add(k);
  for (const a of assets) if (a.layer !== 'virtual' && inBox(a.anchor, box)) keep.add(a.index);
  const order = [...keep].sort((a, b) => a - b);
  const local = new Map<number, number>();
  order.forEach((k, i) => local.set(k, i));
  const localAssets: CountyAsset[] = order.map((k, i) => {
    const a = assets[k];
    if (!a.line || !reversed.has(k)) return { ...a, index: i };
    const line = [...a.line].reverse();
    return { ...a, index: i, line, anchor: line[0] };
  });
  const L = (k: number) => local.get(k)!;
  const localTraces: Trace[] = areaTraces.map((tr) => ({ ...tr, drain: L(tr.drain), path: tr.path.map(L), ending: { ...tr.ending, terminal: L(tr.ending.terminal), exit: L(tr.ending.exit) } }));
  const own = picked.filter((t) => inBox(assets[traces[t].drain].anchor, box));
  const ownByClass: Record<string, number> = { creek: 0, ground: 0, elsewhere: 0, unknown: 0 };
  for (const t of own) ownByClass[traces[t].ending.cls]++;

  const net = { assets: localAssets };
  const bridges = (i: number) =>
    i < D ? bridgesOf(m, traces[picked[i]], m.traceEdges[picked[i]], m.graph.nodeOf[traces[picked[i]].drain]) : bridgesOf(m, areaTraces[i], intakes!.byChannel.get(kept[i - D])!.edges, intakeStart(m, kept[i - D]));
  const fixList = buildCountyFixList(localAssets, localTraces, streets, bridges, D);
  const numbers = computeNumbers(net, localTraces.slice(0, D), streets, fixList, []);

  const waters: Water[] = [];
  for (const w of m.waters.drawable(box)) {
    const lines = (w.lines ?? []).flatMap((l) => clipLine(l, box));
    if (!lines.length && !w.polygons?.length) continue;
    waters.push({ name: w.name || (w.kind === 'lake' ? 'Unnamed lake or pond' : 'Unnamed stream'), kind: w.kind, fennel: w.fennel, lines, polygons: w.polygons });
  }
  return {
    net,
    traces: localTraces,
    projection: m.projection,
    streets,
    waters: { all: waters },
    fixList,
    numbers,
    ownDrains: own.length,
    ownByClass,
    drainCount: D,
  };
}

/** Bridged gaps a trace crosses, as "catch basin X → pipe Y (a gap of about 14 ft)". */
function bridgesOf(m: CountyModel, trace: Trace, edges: readonly number[], start: number): string[] {
  const out: string[] = [];
  let node = start;
  for (const ei of edges) {
    const e = m.graph.edges[ei];
    const next = otherEnd(e, node);
    if (e.how === 'bridge') {
      const from = m.graph.nodes[node].primary;
      const to = m.graph.nodes[next].primary;
      const name = (k: number) => (k >= 0 ? describeCounty(m.assets[k]) : 'a pipe joint');
      // a joint partway along a line: name the line
      const toLine = to < 0 ? m.graph.adj[next].map((x) => m.graph.edges[x]).find((x) => x.how === 'line' && x.asset >= 0)?.asset : undefined;
      out.push(`${name(from >= 0 ? from : trace.path[0])} → ${to >= 0 ? name(to) : toLine !== undefined ? describeCounty(m.assets[toLine]) : 'a pipe joint'} (a gap of ${feet(e.lengthM)})`);
    }
    node = next;
  }
  return out;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Creek-bound endings carrying runoff from the most street length (like fixlist.ts). Traces from drainCount on are ditch intakes, not drains. */
export function buildCountyFixList(
  assets: readonly CountyAsset[],
  traces: readonly Trace[],
  streets: StreetResult,
  bridges: (trace: number) => string[],
  drainCount = traces.length,
  count = 5,
): FixItem[] {
  const byExit = new Map<number, { streetM: number; inferredM: number; bridges: Set<string>; byStreet: Map<string, number> }>();
  for (const run of streets.runs) {
    if (run.cls !== 'creek') continue;
    const trace = traces[run.drain];
    const exit = trace.ending.exit;
    const entry = byExit.get(exit) ?? { streetM: 0, inferredM: 0, bridges: new Set<string>(), byStreet: new Map() };
    entry.streetM += run.lengthM;
    const b = bridges(run.drain);
    if (b.length) {
      entry.inferredM += run.lengthM;
      for (const x of b) entry.bridges.add(x);
    }
    const name = streetTitle(streets.pieces[run.piece].name || 'unnamed street');
    entry.byStreet.set(name, (entry.byStreet.get(name) ?? 0) + run.lengthM);
    byExit.set(exit, entry);
  }
  const streetIdx = new GridIndex<number>(100);
  streets.runs.forEach((r, i) => {
    for (const p of r.line) streetIdx.insertPoint(i, p);
  });
  const nearestStreet = (p: XY): string => {
    for (const radius of [100, 300, 1000]) {
      let best = '';
      let bestD = Infinity;
      for (const i of streetIdx.near(p, radius)) {
        const r = streets.runs[i];
        const name = streets.pieces[r.piece].name;
        const d = nearestOnPolyline(p, r.line).d;
        if (name && d <= radius && (d < bestD || (d === bestD && name < best))) [best, bestD] = [name, d];
      }
      if (best) return streetTitle(best);
    }
    return '';
  };
  const ranked = [...byExit.entries()]
    .map(([exit, v]) => ({ exit, ...v }))
    .sort((a, b) => b.streetM - a.streetM || (assets[a.exit].key < assets[b.exit].key ? -1 : 1))
    .slice(0, count);
  const HOW: Partial<Record<string, string>> = { 'outfall-creek': 'into', 'downstream-creek': 'upstream of', 'bridge-creek': 'over', 'pipe-end-creek': 'near' };
  return ranked.map((r, i) => {
    const a = assets[r.exit];
    const ending = traces.find((t) => t.ending.exit === r.exit && t.ending.cls === 'creek')!.ending;
    const point = exitPoint(a);
    const near = nearestStreet(point);
    const what = `${capitalize(describeCounty(a))} ${HOW[ending.code] ?? 'at'} ${ending.receiving}`;
    return {
      rank: i + 1,
      exit: r.exit,
      exitId: a.id,
      label: near ? `${what}, near ${near}` : what,
      code: ending.code,
      receiving: ending.receiving,
      streetM: Math.round(r.streetM),
      drains: traces.filter((t, k) => k < drainCount && t.ending.exit === r.exit && t.ending.cls === 'creek').length,
      streets: [...r.byStreet.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([n]) => n),
      nearStreet: near,
      inferredStreetM: Math.round(r.inferredM),
      bridges: [...r.bridges].sort(),
      point,
    };
  });
}
