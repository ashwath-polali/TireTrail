// Traces every county drain to an ending and classifies it.
import type { XY } from '../geo/geo.ts';
import type { DrainClass, Ending, EndingCode, Trace } from '../trace/trace.ts';
import {
  describeCounty,
  endPointGroup,
  INFILTRATION_CELLS,
  isCountyDrain,
  isPossible,
  soaksThroughBottom,
  type CountyAsset,
} from './assets.ts';
import type { Graph } from './graph.ts';
import { drawnWalk, measureDirection, nodePath, route, DEFAULT_ROUTE_OPTIONS, type DirectionCheck, type RouteOptions, type Routing } from './route.ts';
import type { CountyWaters } from './waters.ts';

export interface CountyTraceOptions {
  route: RouteOptions;
  /** An ending this close to water discharges into it. */
  waterTolM: number;
}

export const DEFAULT_COUNTY_TRACE_OPTIONS: CountyTraceOptions = { route: DEFAULT_ROUTE_OPTIONS, waterTolM: 30 };

/** Network structures that soak water in. */
const INFILTRATION_STRUCTURES = new Set(['Infiltration Vault', 'Permeable Pavement']);

export interface Sink {
  node: number;
  /** Asset that decides the ending (end point, pond, culvert, ...). */
  asset: number;
  tier: 1 | 2;
}

export interface CountyTraced {
  traces: Trace[];
  routing: Routing;
  sinks: Map<number, Sink>;
  direction: DirectionCheck;
  /** Edges each trace crossed, by trace index (for bridge lists). */
  traceEdges: number[][];
}

function sinkPriority(a: CountyAsset): number {
  if (a.layer === 'endpoint') return 0;
  if (a.kind === 'pond' || a.layer === 'network') return 1;
  return 2;
}

/** Endings at each node: explicit ones (tier 1) and fallbacks (tier 2). */
export function findSinks(g: Graph, assets: readonly CountyAsset[]): Map<number, Sink> {
  const sinks = new Map<number, Sink>();
  const offer = (node: number, asset: number, tier: 1 | 2) => {
    const cur = sinks.get(node);
    if (!cur || tier < cur.tier || (tier === cur.tier && (sinkPriority(assets[asset]) < sinkPriority(assets[cur.asset]) || (sinkPriority(assets[asset]) === sinkPriority(assets[cur.asset]) && asset < cur.asset)))) {
      sinks.set(node, { node, asset, tier });
    }
  };
  for (const node of g.nodes) {
    for (const k of node.assets) {
      const a = assets[k];
      if (a.layer === 'endpoint') offer(node.index, k, 1);
      else if (a.kind === 'pond' && INFILTRATION_CELLS.has(a.type)) offer(node.index, k, 1);
      else if (a.layer === 'network' && INFILTRATION_STRUCTURES.has(a.type)) offer(node.index, k, 1);
      else if (soaksThroughBottom(a)) offer(node.index, k, 2);
    }
  }
  for (const e of g.edges) {
    if (e.how !== 'line' || e.asset < 0) continue;
    const a = assets[e.asset];
    if (a.liveStream || (a.layer === 'channel' && a.type === 'Natural')) {
      offer(e.a, e.asset, 1);
      offer(e.b, e.asset, 1);
    } else if (a.perforated) {
      offer(e.a, e.asset, 2);
      offer(e.b, e.asset, 2);
    }
  }
  return sinks;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const m = (d: number) => `${Math.max(1, Math.round(d))} m`;

export class CountyTracer {
  private readonly assets: readonly CountyAsset[];
  private readonly g: Graph;
  private readonly waters: CountyWaters;
  private readonly opts: CountyTraceOptions;

  constructor(assets: readonly CountyAsset[], g: Graph, waters: CountyWaters, opts: CountyTraceOptions = DEFAULT_COUNTY_TRACE_OPTIONS) {
    this.assets = assets;
    this.g = g;
    this.waters = waters;
    this.opts = opts;
  }

  traceAll(): CountyTraced {
    const { g, assets } = this;
    const sinks = findSinks(g, assets);
    const tier1 = [...sinks.values()].filter((s) => s.tier === 1).map((s) => s.node);
    const tier2 = [...sinks.values()].filter((s) => s.tier === 2).map((s) => s.node);
    const routing = route(g, tier1, tier2, this.opts.route);
    const direction = measureDirection(g, (n) => g.nodes[n].assets.some((k) => assets[k].layer === 'endpoint'));

    // explicit endings per connected piece, for confidence
    const perPiece = new Map<number, number>();
    for (const s of tier1) perPiece.set(g.component[s], (perPiece.get(g.component[s]) ?? 0) + 1);

    const endingCache = new Map<number, Ending>();
    const traces: Trace[] = [];
    const traceEdges: number[][] = [];
    for (const a of assets) {
      if (!isCountyDrain(a)) continue;
      const start = g.nodeOf[a.index];
      let nodes: number[];
      let edges: number[];
      let ending: Ending;
      let tier = 0;
      if (routing.sink[start] >= 0) {
        ({ nodes, edges } = nodePath(g, routing, start));
        const s = sinks.get(routing.sink[start])!;
        tier = s.tier;
        let e = endingCache.get(s.node);
        if (!e) {
          e = this.sinkEnding(s);
          endingCache.set(s.node, e);
        }
        ending = e;
      } else {
        const walk = drawnWalk(g, start, (k) => (k >= 0 ? assets[k].width : -1));
        nodes = walk.nodes;
        edges = walk.edges;
        ending = this.stopEnding(a, nodes, edges, walk.loop);
      }
      const path = this.assetPath(a.index, nodes, edges, tier ? sinks.get(routing.sink[start])!.asset : -1);
      const terminal = path[path.length - 1];
      ending = { ...ending, terminal, exit: ending.cls === 'unknown' && tier === 0 ? terminal : ending.exit };
      const bridges = edges.filter((ei) => g.edges[ei].how === 'bridge').length;
      let pipeM = 0;
      for (const ei of edges) if (g.edges[ei].how === 'line' && g.edges[ei].asset >= 0) pipeM += g.edges[ei].lengthM;
      const sinkType = tier ? assets[sinks.get(routing.sink[start])!.asset].type : '';
      const confidence: Trace['confidence'] =
        ending.cls === 'unknown'
          ? 'none'
          : tier === 1 && bridges === 0 && !isPossible(sinkType) && ending.code !== 'discharge-point' && perPiece.get(g.component[start]) === 1
            ? 'high'
            : 'likely';
      traces.push({
        drain: a.index,
        path,
        ending,
        confidence,
        linkCounts: {},
        weakLinks: bridges,
        pipeM: Math.round(pipeM),
      });
      traceEdges.push(edges);
    }
    return { traces, routing, sinks, direction, traceEdges };
  }

  /** Asset sequence for a node path: lines walked and the assets at joints, ending at the deciding asset. */
  private assetPath(drain: number, nodes: readonly number[], edges: readonly number[], sinkAsset: number): number[] {
    const { g, assets } = this;
    const path = [drain];
    const add = (k: number) => {
      if (k >= 0 && path[path.length - 1] !== k) path.push(k);
    };
    for (let i = 0; i < edges.length; i++) {
      const e = g.edges[edges[i]];
      if (e.how === 'line' && e.asset >= 0 && assets[e.asset].layer !== 'virtual') add(e.asset);
      add(g.nodes[nodes[i + 1]].primary);
    }
    if (sinkAsset >= 0 && !path.includes(sinkAsset)) add(sinkAsset);
    return path;
  }

  private make(code: EndingCode, cls: DrainClass, exit: number, reason: string, receiving = ''): Ending {
    return { code, cls, terminal: exit, exit, receiving, reason };
  }

  /** Closest water to a deciding asset (its point, or the nearest of a line's vertices). */
  private near(a: CountyAsset, find: (p: XY) => { d: number } | null): { p: XY; d: number } | null {
    const pts = a.line ?? [a.anchor];
    let best: { p: XY; d: number } | null = null;
    for (const p of pts) {
      const hit = find(p);
      if (hit && (!best || hit.d < best.d)) best = { p, d: hit.d };
    }
    return best;
  }

  sinkEnding(s: Sink): Ending {
    const a = this.assets[s.asset];
    const what = describeCounty(a);
    const tol = this.opts.waterTolM;
    if (s.tier === 2) {
      if (a.perforated) return this.make('perforated-pipe', 'ground', s.asset, `Soaks into the ground through ${what} (no other way out is mapped).`);
      return this.make('drywell', 'ground', s.asset, `Soaks into the ground through the open bottom of ${what} (no other way out is mapped).`);
    }
    if (a.kind === 'pond') return this.make('infiltration-pond', 'ground', s.asset, `Soaks into the ground at ${what}.`);
    if (a.layer === 'network') return this.make('infiltration-vault', 'ground', s.asset, `Soaks into the ground at ${what}.`);

    const coho = this.near(a, (p) => this.waters.coho(p, tol));
    const other = coho ? null : this.near(a, (p) => this.waters.other(p, tol));
    const otherHit = other ? this.waters.other(other.p, tol) : null;
    const otherName = otherHit ? otherHit.water.name || (otherHit.water.kind === 'lake' ? 'an unnamed lake or pond' : 'an unnamed stream') : '';
    const cohoName = coho ? this.waters.cohoName(coho.p, this.waters.coho(coho.p, tol)!, tol) : '';

    if (a.layer === 'endpoint') {
      const group = endPointGroup(a.type);
      const start = `Leaves the County's pipes at ${what}`;
      if (coho) {
        return this.make(group === 'outfall' ? 'outfall-creek' : 'stream-creek', 'creek', s.asset, `${start}, ${m(coho.d)} from ${cohoName}, a stream WDFW maps as coho habitat.`, cohoName);
      }
      if (other) {
        return this.make(group === 'outfall' ? 'outfall-elsewhere' : 'stream-elsewhere', 'elsewhere', s.asset, `${start}, ${m(other.d)} from ${otherName}, which isn't mapped as coho habitat.`, otherName);
      }
      if (group === 'discharge') {
        return this.make('discharge-point', 'ground', s.asset, `${start}, a point where the County lists the water as leaving into the ground (no stream or lake is mapped within ${tol} m).`);
      }
      if (group === 'outfall') {
        return this.make('outfall-unknown', 'unknown', s.asset, `${start}, but no mapped stream or lake is within ${tol} m, so where it flows next isn't known.`);
      }
      return this.make('dead-end', 'unknown', s.asset, `The County's map stops at ${what} and doesn't say where the water goes.`);
    }
    // stream culverts and natural channels
    if (coho) return this.make('stream-creek', 'creek', s.asset, `Reaches ${what}, part of ${cohoName}, a stream WDFW maps as coho habitat.`, cohoName);
    if (other) return this.make('stream-elsewhere', 'elsewhere', s.asset, `Reaches ${what}, part of ${otherName}, which isn't mapped as coho habitat.`, otherName);
    return this.make('outlet-unmapped', 'unknown', s.asset, `Reaches ${what}, a natural stream the County's stream maps don't show, so where it goes isn't known.`);
  }

  private stopEnding(drain: CountyAsset, nodes: readonly number[], edges: readonly number[], loop: boolean): Ending {
    const { g, assets } = this;
    if (!edges.length) {
      return this.make('not-connected', 'unknown', drain.index, `${capitalize(describeCounty(drain))} isn't connected to any mapped pipe or ditch.`);
    }
    // last real asset on the walk
    let last = -1;
    for (let i = edges.length - 1; i >= 0 && last < 0; i--) {
      const nodeAsset = g.nodes[nodes[i + 1]].primary;
      const e = g.edges[edges[i]];
      last = nodeAsset >= 0 ? nodeAsset : e.asset >= 0 && assets[e.asset].layer !== 'virtual' ? e.asset : -1;
    }
    if (last < 0) last = drain.index;
    const what = describeCounty(assets[last]);
    if (loop) return this.make('loop', 'unknown', last, `The County's map loops back on itself at ${what}.`);
    return this.make('dead-end', 'unknown', last, `The County's map stops at ${what} (no outfall, discharge point or infiltration facility is mapped downstream).`);
  }
}
