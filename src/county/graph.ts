// Drainage graph from geometry alone (the county layers carry no from/to IDs).
// Nodes: point assets and line ends clustered within snapM, plus one node per pond.
// Edges: lines (split where another end or point touches them partway), pond joins, pond-to-pond links, short bridges.
import { bboxOf, dist, distanceToPolygons, GridIndex, nearestOnPolyline, pointInPolygon, type BBox, type XY } from '../geo/geo.ts';
import type { CountyAsset, CountyLayer } from './assets.ts';
import { HOLDING_CELLS, INFILTRATION_CELLS, soaksThroughBottom } from './assets.ts';

export interface GraphOptions {
  /** Ends and points this close are one joint. */
  snapM: number;
  /** A loose end this close to a pond drains into it. */
  pondM: number;
  /** Extra cost (in meters) to join an inlet or outlet that lines run through to its pond, so a mapped way on wins when there is one. */
  openingCostM: number;
  /** Ponds whose shapes come this close (or overlap) join each other. */
  pondTouchM: number;
  /** A holding pond this close to an infiltration cell spills into it (cells of one facility sit a berm apart). */
  pondFeedM: number;
  /** Loose downstream ends bridge to the nearest asset within these, in order. */
  bridgeM: readonly number[];
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { snapM: 1.5, pondM: 5, openingCostM: 200, pondTouchM: 1, pondFeedM: 10, bridgeM: [5, 10] };

export type EdgeHow = 'line' | 'pond' | 'bridge';

export interface Edge {
  index: number;
  /** Digitized start and end node (lines run a -> b as drawn). */
  a: number;
  b: number;
  how: EdgeHow;
  /** Line asset for line edges, pond asset for pond joins, -1 for bridges and pond-to-pond links. */
  asset: number;
  lengthM: number;
  /** Lines only: true if water can be trusted to follow the drawing direction at all. */
  directed: boolean;
}

export interface GraphNode {
  index: number;
  p: XY;
  /** Point or pond assets in this joint. */
  assets: number[];
  /** Asset shown in paths, -1 for a bare joint of lines. */
  primary: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  edgesByHow: Record<EdgeHow, number>;
  /** Line ends joined to a point or another end. */
  endsJoined: number;
  endsLoose: number;
  midLineJoins: number;
  bridges: number;
  pondJoins: number;
  /** Ponds joined because their shapes touch, or a holding pond sits by an infiltration cell. */
  pondLinks: number;
  components: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
  /** Edge indexes at each node. */
  adj: number[][];
  /** Node of each point/pond asset, -1 for lines. */
  nodeOf: Int32Array;
  /** Node at each line's start and end. */
  lineEnds: Map<number, [number, number]>;
  /** Connected piece of each node. */
  component: Int32Array;
  stats: GraphStats;
}

const POINT_LAYERS: ReadonlySet<CountyLayer> = new Set(['drain', 'network', 'endpoint', 'inlet', 'outlet', 'barrier']);
// shown in paths when several assets share a joint
const PRIMARY_RANK: Partial<Record<CountyLayer, number>> = { endpoint: 0, drain: 1, network: 2, outlet: 3, inlet: 4, barrier: 5 };

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export function buildGraph(assets: readonly CountyAsset[], opts: GraphOptions = DEFAULT_GRAPH_OPTIONS): Graph {
  const { snapM } = opts;
  // items: point assets, then two ends per line
  const itemP: XY[] = [];
  const itemAsset: number[] = [];
  const itemEnd: number[] = []; // -1 point, 0 start, 1 end
  for (const a of assets) {
    if (POINT_LAYERS.has(a.layer)) {
      itemP.push(a.anchor);
      itemAsset.push(a.index);
      itemEnd.push(-1);
    }
  }
  for (const a of assets) {
    if (!a.line) continue;
    itemP.push(a.line[0], a.line[a.line.length - 1]);
    itemAsset.push(a.index, a.index);
    itemEnd.push(0, 1);
  }

  // 1. cluster items within snapM
  const uf = new UnionFind(itemP.length);
  const itemIdx = new GridIndex<number>(Math.max(snapM, 1) * 4);
  itemP.forEach((p, i) => itemIdx.insertPoint(i, p));
  for (let i = 0; i < itemP.length; i++) {
    for (const j of itemIdx.near(itemP[i], snapM)) {
      if (j > i && dist(itemP[i], itemP[j]) <= snapM && !(itemAsset[i] === itemAsset[j] && itemEnd[i] >= 0)) uf.union(i, j);
    }
  }
  const nodes: GraphNode[] = [];
  const nodeOfRoot = new Map<number, number>();
  const nodeOfItem = new Int32Array(itemP.length);
  const sums = new Map<number, [number, number, number]>();
  for (let i = 0; i < itemP.length; i++) {
    const r = uf.find(i);
    let n = nodeOfRoot.get(r);
    if (n === undefined) {
      n = nodes.length;
      nodeOfRoot.set(r, n);
      nodes.push({ index: n, p: itemP[i], assets: [], primary: -1 });
    }
    nodeOfItem[i] = n;
    if (itemEnd[i] === -1) nodes[n].assets.push(itemAsset[i]);
    const s = sums.get(n) ?? [0, 0, 0];
    s[0] += itemP[i][0];
    s[1] += itemP[i][1];
    s[2]++;
    sums.set(n, s);
  }
  for (const node of nodes) {
    if (node.assets.length) {
      node.assets.sort((x, y) => (PRIMARY_RANK[assets[x].layer] ?? 9) - (PRIMARY_RANK[assets[y].layer] ?? 9) || x - y);
      node.primary = node.assets[0];
      node.p = assets[node.primary].anchor;
    } else {
      const s = sums.get(node.index)!;
      node.p = [s[0] / s[2], s[1] / s[2]];
    }
  }
  const nodeOf = new Int32Array(assets.length).fill(-1);
  const lineEnds = new Map<number, [number, number]>();
  for (let i = 0; i < itemP.length; i++) {
    if (itemEnd[i] === -1) nodeOf[itemAsset[i]] = nodeOfItem[i];
    else {
      const e = lineEnds.get(itemAsset[i]) ?? [-1, -1];
      e[itemEnd[i]] = nodeOfItem[i];
      lineEnds.set(itemAsset[i], e);
    }
  }

  // degree from whole lines, before splits
  const degree = new Int32Array(nodes.length + assets.length);
  for (const [, [s, e]] of lineEnds) {
    degree[s]++;
    degree[e]++;
  }
  let endsJoined = 0;
  let endsLoose = 0;
  for (const [, ends] of lineEnds) {
    for (const n of ends) {
      if (degree[n] > 1 || nodes[n].assets.length) endsJoined++;
      else endsLoose++;
    }
  }

  // 2. joints partway along a line: loose ends and lone points touching a line's middle
  const lineIdx = new GridIndex<number>(50);
  for (const a of assets) if (a.line && a.layer !== 'virtual') lineIdx.insert(a.index, bboxOf(a.line));
  const splits = new Map<number, { along: number; node: number; how: EdgeHow; gapM: number }[]>();
  const addSplit = (line: number, along: number, node: number, how: EdgeHow, gapM: number) => {
    const list = splits.get(line) ?? [];
    list.push({ along, node, how, gapM });
    splits.set(line, list);
  };
  const midHit = (node: number, tol: number, skip: (line: number) => boolean) => {
    let best: { line: number; along: number; d: number } | null = null;
    for (const k of lineIdx.near(nodes[node].p, tol)) {
      if (skip(k)) continue;
      const line = assets[k].line!;
      const on = nearestOnPolyline(nodes[node].p, line);
      if (on.d > tol || on.along <= snapM || on.along >= assets[k].lengthM - snapM) continue;
      if (!best || on.d < best.d || (on.d === best.d && k < best.line)) best = { line: k, along: on.along, d: on.d };
    }
    return best;
  };
  let midLineJoins = 0;
  // lines touching each node (for skip checks), built once
  const linesAt = new Map<number, Set<number>>();
  for (const [line, [a, b]] of lineEnds) {
    for (const n of [a, b]) {
      const s = linesAt.get(n) ?? new Set<number>();
      s.add(line);
      linesAt.set(n, s);
    }
  }
  for (const node of nodes) {
    if (degree[node.index] > 1) continue;
    const mine = linesAt.get(node.index);
    const hit = midHit(node.index, snapM, (k) => mine?.has(k) ?? false);
    if (hit) {
      addSplit(hit.line, hit.along, node.index, 'line', hit.d);
      degree[node.index]++;
      midLineJoins++;
    }
  }

  // 3. ponds: loose ends, lone points, and inlets and outlets inside or near a pond drain into it
  const nodeIdx = new GridIndex<number>(25);
  for (const node of nodes) nodeIdx.insertPoint(node.index, node.p);
  const pondEdges: { pond: number; node: number; cost: number }[] = [];
  // an inlet or outlet in a pond opens onto it, however many lines meet there
  const opening = (k: number) => nodes[k].assets.some((x) => assets[x].layer === 'inlet' || assets[x].layer === 'outlet');
  for (const a of assets) {
    if (!a.polygons) continue;
    const n = nodes.length;
    nodes.push({ index: n, p: a.anchor, assets: [a.index], primary: a.index });
    nodeOf[a.index] = n;
    const b = bboxOf(a.polygons.flat(2));
    const pad = opts.pondM;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + pad;
    for (const k of nodeIdx.near([cx, cy], r)) {
      const through = degree[k] > 1;
      if (through && !opening(k)) continue;
      const p = nodes[k].p;
      if (p[0] < b.minX - pad || p[0] > b.maxX + pad || p[1] < b.minY - pad || p[1] > b.maxY + pad) continue;
      const inside = a.polygons.some((rings) => pointInPolygon(p, rings));
      if (inside || distanceToPolygons(p, a.polygons) <= pad) {
        pondEdges.push({ pond: n, node: k, cost: Math.max(1, dist(p, a.anchor)) + (through ? opts.openingCostM : 0) });
      }
    }
  }
  const pondJoins = pondEdges.length;
  for (const e of pondEdges) degree[e.node]++;

  // ponds whose shapes touch join each other; a holding pond spills into an infiltration cell beside it
  const pondLinks: { a: number; b: number; cost: number }[] = [];
  const pondIdx = new GridIndex<number>(100);
  const pondBox = new Map<number, BBox>();
  for (const a of assets) {
    if (!a.polygons) continue;
    const b = bboxOf(a.polygons.flat(2));
    pondBox.set(a.index, b);
    pondIdx.insert(a.index, b);
  }
  const feeds = (x: CountyAsset, y: CountyAsset) => (HOLDING_CELLS.has(x.type) && INFILTRATION_CELLS.has(y.type)) || (HOLDING_CELLS.has(y.type) && INFILTRATION_CELLS.has(x.type));
  const reach = Math.max(opts.pondTouchM, opts.pondFeedM);
  for (const [k, b] of pondBox) {
    const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + reach;
    for (const j of pondIdx.near([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], r).sort((x, y) => x - y)) {
      const c = pondBox.get(j)!;
      const tol = feeds(assets[k], assets[j]) ? reach : opts.pondTouchM;
      if (j <= k || c.minX > b.maxX + tol || c.maxX < b.minX - tol || c.minY > b.maxY + tol || c.maxY < b.minY - tol) continue;
      if (shapeGap(assets[k].polygons!, assets[j].polygons!) <= tol) pondLinks.push({ a: nodeOf[k], b: nodeOf[j], cost: Math.max(1, dist(assets[k].anchor, assets[j].anchor)) });
    }
  }

  // 4. bridges: a line's loose downstream end, or a lone drain or structure, joins the nearest asset within reach
  const bridgeEdges: { a: number; b: number; gapM: number }[] = [];
  let bridges = 0;
  const lineAtEnd = new Map<number, number>(); // node -> line whose drawn end it is (if loose)
  for (const [line, [, e]] of lineEnds) if (degree[e] === 1 && !nodes[e].assets.length) lineAtEnd.set(e, line);
  for (const node of nodes) {
    if (node.index >= degree.length || degree[node.index] > 1) continue;
    const loneAsset = node.assets.length && degree[node.index] === 0 ? assets[node.primary] : null;
    const looseEnd = lineAtEnd.get(node.index);
    const lone = loneAsset && (loneAsset.layer === 'drain' || loneAsset.layer === 'network') && !soaksThroughBottom(loneAsset);
    if (!lone && looseEnd === undefined) continue;
    const mine = linesAt.get(node.index) ?? new Set<number>();
    const otherEnd = looseEnd !== undefined ? lineEnds.get(looseEnd)![0] : -1;
    for (const tol of opts.bridgeM) {
      let best: { node: number; d: number } | null = null;
      for (const k of nodeIdx.near(node.p, tol)) {
        if (k === node.index || k === otherEnd) continue;
        const d = dist(node.p, nodes[k].p);
        if (d <= tol && (!best || d < best.d)) best = { node: k, d };
      }
      const mid = midHit(node.index, tol, (k) => mine.has(k));
      if (mid && (!best || mid.d + 0.01 < best.d)) {
        addSplit(mid.line, mid.along, node.index, 'bridge', mid.d);
        degree[node.index]++;
        bridges++;
        break;
      }
      if (best) {
        bridgeEdges.push({ a: node.index, b: best.node, gapM: best.d });
        degree[node.index]++;
        degree[best.node]++;
        bridges++;
        break;
      }
    }
  }

  // 5. edges
  const edges: Edge[] = [];
  const push = (a: number, b: number, how: EdgeHow, asset: number, lengthM: number, directed: boolean) => {
    edges.push({ index: edges.length, a, b, how, asset, lengthM, directed });
  };
  const round = (x: number) => Math.round(x * 100) / 100;
  for (const [line, [s, e]] of lineEnds) {
    const a = assets[line];
    const directed = a.layer !== 'virtual';
    const cuts = (splits.get(line) ?? []).sort((x, y) => x.along - y.along);
    let prevNode = s;
    let prevAlong = 0;
    for (const c of cuts) {
      // the node joins the line at a new joint node
      const j = nodes.length;
      nodes.push({ index: j, p: nearestOnPolyline(nodes[c.node].p, a.line!).point, assets: [], primary: -1 });
      push(prevNode, j, 'line', line, round(c.along - prevAlong), directed);
      if (c.how === 'bridge') push(c.node, j, 'bridge', -1, round(c.gapM), false);
      else push(c.node, j, 'line', -1, round(c.gapM), false);
      prevNode = j;
      prevAlong = c.along;
    }
    push(prevNode, e, 'line', line, round(a.lengthM - prevAlong), directed);
  }
  for (const p of pondEdges) push(p.node, p.pond, 'pond', assets[nodes[p.pond].primary].index, round(p.cost), false);
  for (const l of pondLinks) push(l.a, l.b, 'pond', -1, round(l.cost), false);
  for (const b of bridgeEdges) push(b.a, b.b, 'bridge', -1, round(b.gapM), false);

  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.index);
    if (e.b !== e.a) adj[e.b].push(e.index);
  }

  const cuf = new UnionFind(nodes.length);
  for (const e of edges) cuf.union(e.a, e.b);
  const component = new Int32Array(nodes.length);
  let components = 0;
  for (let i = 0; i < nodes.length; i++) {
    component[i] = cuf.find(i);
    if (component[i] === i) components++;
  }

  const edgesByHow: Record<EdgeHow, number> = { line: 0, pond: 0, bridge: 0 };
  for (const e of edges) edgesByHow[e.how]++;
  return {
    nodes,
    edges,
    adj,
    nodeOf,
    lineEnds,
    component,
    stats: { nodes: nodes.length, edges: edges.length, edgesByHow, endsJoined, endsLoose, midLineJoins, bridges, pondJoins, pondLinks: pondLinks.length, components },
  };
}

/** Gap between two pond shapes, from each one's corners to the other (0 if they overlap). */
function shapeGap(p: XY[][][], q: XY[][][]): number {
  let best = Infinity;
  for (const [s, t] of [[p, q], [q, p]]) {
    for (const rings of s) {
      for (const ring of rings) {
        for (const v of ring) {
          best = Math.min(best, distanceToPolygons(v, t));
          if (best === 0) return 0;
        }
      }
    }
  }
  return best;
}
