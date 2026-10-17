// Routes every node to an ending. The drawn direction of county lines points downstream
// only most of the time (measured in measureDirection), so it is a cost, not a rule:
// flowing against a line's drawing costs `againstFactor` times its length, and a route
// may run against the drawing for at most `maxAgainstM` in total.
// One search from all endings keeps, per node, the cheapest route and any route that
// runs less against the drawing (so a drain can still go around a capped one).
import type { Edge, Graph } from './graph.ts';

export interface RouteOptions {
  /** Cost multiplier for flowing against a line's drawn direction. */
  againstFactor: number;
  /** Most meters a route may run against the drawn direction, in total. */
  maxAgainstM: number;
  /** Cost per meter of bridged gap, plus a fixed cost per bridge. */
  bridgeFactor: number;
  bridgeFixedM: number;
}

// Ending at the drain's County circuit end point, by cap: 60 m 83.8%, 80 m 84.3%, 100 m 84.7%, none 85.2%.
// Past 80 m the extra routes hit the circuit's end point only about 2:1 over another one. Factor 10 still fits best.
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = { againstFactor: 10, maxAgainstM: 80, bridgeFactor: 2, bridgeFixedM: 5 };

/** Fallback endings start at this cost, so any explicit ending in reach wins. */
const TIER2_COST = 1e9;

export interface Routing {
  /** Cheapest route at each node: its first step (label), -1 if no ending is in reach. */
  first: Int32Array;
  /** Ending node of that route, -1 if none. */
  sink: Int32Array;
  /** 1: explicit ending, 2: fallback (structure bottom, perforated pipe), 0: none. */
  tier: Uint8Array;
  cost: Float64Array;
  /** Meters that route runs against the drawn direction. */
  againstM: Float64Array;
  /** Steps: edge taken from the step's node (-1 at the ending) and the next step. */
  stepEdge: Int32Array;
  stepNext: Int32Array;
}

/** Cost for water moving along edge e from node `from` to the other end. */
export function flowCost(e: Edge, from: number, opts: RouteOptions): number {
  const len = Math.max(e.lengthM, 0.01);
  if (e.how === 'bridge') return len * opts.bridgeFactor + opts.bridgeFixedM;
  if (e.how === 'pond' || !e.directed || e.asset < 0) return len;
  return from === e.a ? len : len * opts.againstFactor;
}

/** Meters run against the drawing when water moves along e from `from`. */
export function againstLength(e: Edge, from: number): number {
  return e.how === 'line' && e.directed && e.asset >= 0 && e.a !== e.b && from !== e.a ? e.lengthM : 0;
}

export const otherEnd = (e: Edge, n: number) => (e.a === n ? e.b : e.a);

/** Min-heap of [cost, id]. */
class Heap {
  private readonly c: number[] = [];
  private readonly n: number[] = [];
  get size(): number {
    return this.c.length;
  }
  push(cost: number, id: number): void {
    const c = this.c;
    const n = this.n;
    let i = c.length;
    c.push(cost);
    n.push(id);
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
 * Routes nodes to endings. Explicit (tier 1) endings win over fallbacks (tier 2) whenever
 * one is in reach. Each step is a label: a route from its node with a cost and meters
 * against the drawing. A node keeps a label only if it runs less against the drawing than
 * every cheaper one there, so routes never loop. Ties: lower cost, then creation order.
 */
export function route(g: Graph, tier1: readonly number[], tier2: readonly number[], opts: RouteOptions = DEFAULT_ROUTE_OPTIONS): Routing {
  const n = g.nodes.length;
  const first = new Int32Array(n).fill(-1);
  const minAgainst = new Float64Array(n).fill(Infinity);
  const sinkTier = new Uint8Array(n);
  const node: number[] = [];
  const cost: number[] = [];
  const against: number[] = [];
  const edge: number[] = [];
  const next: number[] = [];
  const sink: number[] = [];
  const heap = new Heap();
  const add = (x: number, c: number, a: number, e: number, nx: number, s: number) => {
    const id = node.length;
    node.push(x);
    cost.push(c);
    against.push(a);
    edge.push(e);
    next.push(nx);
    sink.push(s);
    heap.push(c, id);
  };
  for (const s of [...new Set(tier1)].sort((a, b) => a - b)) {
    sinkTier[s] = 1;
    add(s, 0, 0, -1, -1, s);
  }
  for (const s of [...new Set(tier2)].sort((a, b) => a - b)) {
    if (sinkTier[s]) continue;
    sinkTier[s] = 2;
    add(s, TIER2_COST, 0, -1, -1, s);
  }
  const eps = 1e-6;
  while (heap.size) {
    const [c, id] = heap.pop();
    const x = node[id];
    if (minAgainst[x] <= against[id] + eps) continue;
    minAgainst[x] = against[id];
    if (first[x] < 0) first[x] = id;
    for (const ei of g.adj[x]) {
      const e = g.edges[ei];
      const y = otherEnd(e, x);
      if (y === x) continue;
      // water flows y -> x
      const a = against[id] + againstLength(e, y);
      if (a > opts.maxAgainstM + eps || minAgainst[y] <= a + eps) continue;
      add(y, c + flowCost(e, y, opts), a, ei, id, sink[id]);
    }
  }

  const sinkOut = new Int32Array(n).fill(-1);
  const tier = new Uint8Array(n);
  const costOut = new Float64Array(n).fill(Infinity);
  const againstOut = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    const id = first[x];
    if (id < 0) continue;
    sinkOut[x] = sink[id];
    tier[x] = sinkTier[sink[id]];
    costOut[x] = cost[id] - (tier[x] === 2 ? TIER2_COST : 0);
    againstOut[x] = against[id];
  }
  return { first, sink: sinkOut, tier, cost: costOut, againstM: againstOut, stepEdge: Int32Array.from(edge), stepNext: Int32Array.from(next) };
}

/** Node sequence from `start` to its ending (just [start] if it has none). */
export function nodePath(g: Graph, r: Routing, start: number): { nodes: number[]; edges: number[] } {
  const nodes = [start];
  const edges: number[] = [];
  let cur = start;
  for (let id = r.first[start]; id >= 0 && r.stepEdge[id] >= 0; id = r.stepNext[id]) {
    const e = g.edges[r.stepEdge[id]];
    edges.push(e.index);
    cur = otherEnd(e, cur);
    nodes.push(cur);
  }
  return { nodes, edges };
}

/**
 * Where water goes when no ending is in reach: follow lines as drawn (pipes before ditches,
 * then wider) until the map stops or comes back on itself. Connectors (ponds, bridges) go
 * either way, but not out to a dead end, which would only show where other water came in.
 */
export function drawnWalk(
  g: Graph,
  start: number,
  width: (asset: number) => number,
  maxSteps = 5000,
): { nodes: number[]; edges: number[]; loop: boolean; loopAt: number } {
  const nodes = [start];
  const edges: number[] = [];
  const used = new Set<number>();
  const at = new Map([[start, 0]]);
  const drawn = (e: Edge) => e.how === 'line' && e.asset >= 0 && e.directed;
  // drawn downstream: lines leaving at their start; connectors either way
  const out = (e: Edge, x: number) => (drawn(e) ? e.a === x : true) && otherEnd(e, x) !== x;
  const leadsOn = (y: number, via: number) => g.adj[y].some((k) => k !== via && !used.has(k) && out(g.edges[k], y));
  let cur = start;
  let loopAt = -1;
  while (nodes.length < maxSteps) {
    let best: Edge | null = null;
    for (const ei of g.adj[cur]) {
      const e = g.edges[ei];
      if (!out(e, cur) || used.has(ei)) continue;
      const y = otherEnd(e, cur);
      const intoPond = e.how === 'pond' && (e.asset < 0 || y === e.b);
      if (!drawn(e) && !intoPond && !leadsOn(y, ei)) continue;
      if (!best || width(e.asset) > width(best.asset) || (width(e.asset) === width(best.asset) && e.index < best.index)) best = e;
    }
    if (!best) break;
    const nx = otherEnd(best, cur);
    if (at.has(nx)) {
      loopAt = at.get(nx)!;
      break;
    }
    edges.push(best.index);
    used.add(best.index);
    at.set(nx, nodes.length);
    nodes.push(nx);
    cur = nx;
  }
  return { nodes, edges, loop: loopAt >= 0, loopAt };
}

/** Nodes water can reach from `start` going only the drawn way (connectors either way). */
export function drawnReach(g: Graph, start: number, limit = 20000): Set<number> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length && seen.size < limit) {
    const x = stack.pop()!;
    for (const ei of g.adj[x]) {
      const e = g.edges[ei];
      const y = otherEnd(e, x);
      if (againstLength(e, x) > 0 || seen.has(y)) continue;
      seen.add(y);
      stack.push(y);
    }
  }
  return seen;
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
