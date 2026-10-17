// Routes every node to an ending. The drawn direction of county lines points downstream
// only most of the time (measured in measureDirection), so it is a cost, not a rule:
// flowing against a line's drawing costs `againstFactor` times its length.
// One multi-source Dijkstra from all endings gives each node its nearest ending and next step.
import type { Edge, Graph } from './graph.ts';

export interface RouteOptions {
  /** Cost multiplier for flowing against a line's drawn direction. */
  againstFactor: number;
  /** Cost per meter of bridged gap, plus a fixed cost per bridge. */
  bridgeFactor: number;
  bridgeFixedM: number;
}

// 10 matched the County circuits best (1: 85.3%, 4: 87.2%, 10: 87.6%, 1000: 86.9% end at the circuit's end point)
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = { againstFactor: 10, bridgeFactor: 2, bridgeFixedM: 5 };

export interface Routing {
  /** Edge toward the ending at each node, -1 at an ending or if none. */
  nextEdge: Int32Array;
  /** Ending node each node drains to, -1 if none. */
  sink: Int32Array;
  /** 1: explicit ending, 2: fallback (structure bottom, perforated pipe), 0: none. */
  tier: Uint8Array;
  cost: Float64Array;
}

/** Cost for water moving along edge e from node `from` to the other end. */
export function flowCost(e: Edge, from: number, opts: RouteOptions): number {
  const len = Math.max(e.lengthM, 0.01);
  if (e.how === 'bridge') return len * opts.bridgeFactor + opts.bridgeFixedM;
  if (e.how === 'pond' || !e.directed || e.asset < 0) return len;
  return from === e.a ? len : len * opts.againstFactor;
}

export const otherEnd = (e: Edge, n: number) => (e.a === n ? e.b : e.a);

/** Min-heap of [cost, node]. */
class Heap {
  private readonly c: number[] = [];
  private readonly n: number[] = [];
  get size(): number {
    return this.c.length;
  }
  push(cost: number, node: number): void {
    const c = this.c;
    const n = this.n;
    let i = c.length;
    c.push(cost);
    n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] < c[i] || (c[p] === c[i] && n[p] <= n[i])) break;
      [c[p], c[i]] = [c[i], c[p]];
      [n[p], n[i]] = [n[i], n[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const c = this.c;
    const n = this.n;
    const top: [number, number] = [c[0], n[0]];
    const lc = c.pop()!;
    const ln = n.pop()!;
    if (c.length) {
      c[0] = lc;
      n[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < c.length && (c[l] < c[m] || (c[l] === c[m] && n[l] < n[m]))) m = l;
        if (r < c.length && (c[r] < c[m] || (c[r] === c[m] && n[r] < n[m]))) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]];
        [n[m], n[i]] = [n[i], n[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Routes nodes to endings. tier1 sinks first; nodes they can't reach try tier2 sinks.
 * Ties: lower cost, then lower node index, so results are deterministic.
 */
export function route(g: Graph, tier1: readonly number[], tier2: readonly number[], opts: RouteOptions = DEFAULT_ROUTE_OPTIONS): Routing {
  const n = g.nodes.length;
  const nextEdge = new Int32Array(n).fill(-1);
  const sink = new Int32Array(n).fill(-1);
  const tier = new Uint8Array(n);
  const cost = new Float64Array(n).fill(Infinity);
  const run = (sinks: readonly number[], level: number) => {
    const heap = new Heap();
    for (const s of [...sinks].sort((a, b) => a - b)) {
      if (sink[s] >= 0) continue;
      cost[s] = 0;
      sink[s] = s;
      tier[s] = level;
      heap.push(0, s);
    }
    const done = new Uint8Array(n);
    while (heap.size) {
      const [c, x] = heap.pop();
      if (done[x] || c > cost[x]) continue;
      done[x] = 1;
      for (const ei of g.adj[x]) {
        const e = g.edges[ei];
        const y = otherEnd(e, x);
        if (y === x || (tier[y] && tier[y] !== level)) continue;
        // water flows y -> x
        const cy = c + flowCost(e, y, opts);
        if (cy < cost[y] || (cy === cost[y] && sink[x] < sink[y])) {
          cost[y] = cy;
          nextEdge[y] = ei;
          sink[y] = sink[x];
          tier[y] = level;
          heap.push(cy, y);
        }
      }
    }
  };
  run(tier1, 1);
  run(tier2.filter((s) => !tier[s]), 2);
  return { nextEdge, sink, tier, cost };
}

/** Node sequence from `start` to its ending (just [start] if it has none). */
export function nodePath(g: Graph, r: Routing, start: number): { nodes: number[]; edges: number[] } {
  const nodes = [start];
  const edges: number[] = [];
  let cur = start;
  while (r.nextEdge[cur] >= 0 && nodes.length <= g.nodes.length) {
    const e = g.edges[r.nextEdge[cur]];
    edges.push(e.index);
    cur = otherEnd(e, cur);
    nodes.push(cur);
  }
  return { nodes, edges };
}

/**
 * Where water goes when no ending is reachable: follow lines as drawn (pipes before ditches,
 * then wider) until the map stops or comes back on itself.
 */
export function drawnWalk(g: Graph, start: number, width: (asset: number) => number, maxSteps = 5000): { nodes: number[]; edges: number[]; loop: boolean } {
  const nodes = [start];
  const edges: number[] = [];
  const seen = new Set([start]);
  let cur = start;
  let loop = false;
  while (nodes.length < maxSteps) {
    let best: Edge | null = null;
    for (const ei of g.adj[cur]) {
      const e = g.edges[ei];
      // drawn downstream: lines leaving at their start; connectors either way
      const out = e.how === 'line' && e.asset >= 0 && e.directed ? e.a === cur : e.how !== 'line' || e.asset < 0 || !e.directed;
      if (!out || otherEnd(e, cur) === cur || edges.includes(ei)) continue;
      if (!best || width(e.asset) > width(best.asset) || (width(e.asset) === width(best.asset) && e.index < best.index)) best = e;
    }
    if (!best) break;
    const nx = otherEnd(best, cur);
    if (seen.has(nx)) {
      loop = true;
      break;
    }
    edges.push(best.index);
    nodes.push(nx);
    seen.add(nx);
    cur = nx;
  }
  return { nodes, edges, loop };
}

export interface DirectionCheck {
  /** Lines with an end point at exactly one end. */
  lines: number;
  /** ... where that end is the drawn end. */
  towardEndPoint: number;
  share: number;
}

/** How often a line touching an end point at one end was drawn toward it. */
export function measureDirection(g: Graph, isEndPointNode: (node: number) => boolean): DirectionCheck {
  let lines = 0;
  let toward = 0;
  for (const [, [s, e]] of g.lineEnds) {
    const atS = isEndPointNode(s);
    const atE = isEndPointNode(e);
    if (atS === atE) continue;
    lines++;
    if (atE) toward++;
  }
  return { lines, towardEndPoint: toward, share: lines ? toward / lines : 0 };
}
