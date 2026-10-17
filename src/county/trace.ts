// Traces every county drain to an ending and classifies it.
import { bboxOf, dist, distanceToPolygons, GridIndex, type XY } from '../geo/geo.ts';
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
import { drawnWalk, measureDirection, nodePath, otherEnd, route, DEFAULT_ROUTE_OPTIONS, type DirectionCheck, type RouteOptions, type Routing } from './route.ts';
import type { CountyWaters } from './waters.ts';

export interface CountyTraceOptions {
  route: RouteOptions;
  /** An ending this close to water discharges into it. */
  waterTolM: number;
  /** A discharge point this close to an infiltration facility soaks in there. */
  facilityTolM: number;
  /** Routes running more than this against the drawing are never high confidence. */
  highAgainstM: number;
  /** A stream that reaches coho water this far downstream (as the County draws it) counts as creek. */
  downstreamCohoM: number;
}

export const DEFAULT_COUNTY_TRACE_OPTIONS: CountyTraceOptions = { route: DEFAULT_ROUTE_OPTIONS, waterTolM: 30, facilityTolM: 10, highAgainstM: 20, downstreamCohoM: 2000 };

/** Network structures that soak water in. */
const INFILTRATION_STRUCTURES = new Set(['Infiltration Vault', 'Permeable Pavement']);

const isInfiltrationFacility = (a: CountyAsset) =>
  (a.kind === 'pond' && INFILTRATION_CELLS.has(a.type)) || (a.layer === 'network' && INFILTRATION_STRUCTURES.has(a.type));

export interface Sink {
  node: number;
  /** Asset that decides the ending (end point, pond, culvert, ...). */
  asset: number;
  tier: 1 | 2;
}

/** Mapped sign that water soaks in at a discharge point. */
interface Soak {
  /** bottom: open or perforated structure; perforated: pipe; facility: infiltration facility near; permit: NPDES discharge type. */
  how: 'bottom' | 'perforated' | 'facility' | 'permit';
  asset: number;
  d: number;
}

/** The node and the joints it touches partway along a line. */
function around(g: Graph, node: number): number[] {
  const out = [node];
  for (const ei of g.adj[node]) {
    const e = g.edges[ei];
    if (e.how === 'line' && e.asset < 0) out.push(otherEnd(e, node));
  }
  return out;
}

/** The node drains into a mapped pond. */
function joinsPond(g: Graph, node: number): boolean {
  return g.adj[node].some((ei) => g.edges[ei].how === 'pond' && g.edges[ei].asset >= 0);
}

/** A drawn pipe or ditch runs into the node and another runs on out of it. */
function linesThrough(g: Graph, node: number): boolean {
  let into = false;
  let out = false;
  for (const x of around(g, node)) {
    for (const ei of g.adj[x]) {
      const e = g.edges[ei];
      if (e.how !== 'line' || e.asset < 0 || !e.directed || e.a === e.b) continue;
      if (e.a === x) out = true;
      else into = true;
    }
  }
  return into && out;
}

/** Finds mapped signs that water soaks in at a discharge point. */
class SoakCheck {
  private readonly assets: readonly CountyAsset[];
  private readonly g: Graph;
  private readonly tolM: number;
  private readonly idx = new GridIndex<number>(50);

  constructor(assets: readonly CountyAsset[], g: Graph, tolM: number) {
    this.assets = assets;
    this.g = g;
    this.tolM = tolM;
    for (const a of assets) {
      if (!isInfiltrationFacility(a)) continue;
      if (a.polygons) this.idx.insert(a.index, bboxOf(a.polygons.flat(2)));
      else this.idx.insertPoint(a.index, a.anchor);
    }
  }

  at(node: number, point: CountyAsset): Soak | null {
    const { assets, g } = this;
    for (const k of g.nodes[node].assets) if (soaksThroughBottom(assets[k])) return { how: 'bottom', asset: k, d: 0 };
    let perforated = -1;
    for (const x of around(g, node)) {
      for (const ei of g.adj[x]) {
        const e = g.edges[ei];
        if (e.how === 'line' && e.asset >= 0 && assets[e.asset].perforated && (perforated < 0 || e.asset < perforated)) perforated = e.asset;
      }
    }
    if (perforated >= 0) return { how: 'perforated', asset: perforated, d: 0 };
    let best: Soak | null = null;
    for (const k of this.idx.near(point.anchor, this.tolM)) {
      const a = assets[k];
      const d = a.polygons ? distanceToPolygons(point.anchor, a.polygons) : dist(point.anchor, a.anchor);
      if (d <= this.tolM && (!best || d < best.d || (d === best.d && k < best.asset))) best = { how: 'facility', asset: k, d };
    }
    if (best) return best;
    if (point.type === 'NPDES_Discharge') return { how: 'permit', asset: point.index, d: 0 };
    return null;
  }
}

export interface CountyTraced {
  traces: Trace[];
  routing: Routing;
  sinks: Map<number, Sink>;
  direction: DirectionCheck;
  /** Edges each trace crossed, by trace index (for bridge lists). */
  traceEdges: number[][];
  /** Meters each trace runs against the drawn direction. */
  againstM: number[];
  /** Discharge points the map continues past, so they aren't endings. */
  passedDischarge: number;
}

function sinkPriority(a: CountyAsset): number {
  if (a.layer === 'endpoint') return 0;
  if (a.kind === 'pond' || a.layer === 'network') return 1;
  return 2;
}

/** Endings at each node: explicit ones (tier 1) and fallbacks (tier 2). End points `passes` says the map carries on past are left out. */
export function findSinks(g: Graph, assets: readonly CountyAsset[], passes: (node: number, endPoint: CountyAsset) => boolean = () => false): Map<number, Sink> {
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
      if (a.layer === 'endpoint') {
        if (!passes(node.index, a)) offer(node.index, k, 1);
      } else if (isInfiltrationFacility(a)) offer(node.index, k, 1);
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
const far = (d: number) => (d < 950 ? `${Math.max(10, Math.round(d / 10) * 10)} m` : `${(d / 1000).toFixed(1)} km`);

export class CountyTracer {
  private readonly assets: readonly CountyAsset[];
  private readonly g: Graph;
  private readonly waters: CountyWaters;
  private readonly opts: CountyTraceOptions;
  private readonly soak: SoakCheck;

  constructor(assets: readonly CountyAsset[], g: Graph, waters: CountyWaters, opts: CountyTraceOptions = DEFAULT_COUNTY_TRACE_OPTIONS) {
    this.assets = assets;
    this.g = g;
    this.waters = waters;
    this.opts = opts;
    this.soak = new SoakCheck(assets, g, opts.facilityTolM);
  }

  /** A discharge point we'd read as unknown, where a drawn line or a mapped pond carries the water on. */
  private passesThrough(node: number, a: CountyAsset): boolean {
    if (endPointGroup(a.type) !== 'discharge' || !(linesThrough(this.g, node) || joinsPond(this.g, node))) return false;
    const tol = this.opts.waterTolM;
    return !this.waters.coho(a.anchor, tol) && !this.waters.other(a.anchor, tol) && !this.soak.at(node, a);
  }

  traceAll(): CountyTraced {
    const { g, assets } = this;
    let passed = 0;
    const sinks = findSinks(g, assets, (node, a) => {
      const through = this.passesThrough(node, a);
      if (through) passed++;
      return through;
    });
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
    const againstM: number[] = [];
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
        // no ending in reach: follow the drawing until the map stops
        const walk = drawnWalk(g, start, (k) => (k >= 0 ? assets[k].width : -1));
        nodes = walk.nodes;
        edges = walk.edges;
        // a loop through a pond ends in that pond (its way out isn't mapped)
        const pond = walk.loop ? nodes.findIndex((n, i) => i >= walk.loopAt && g.nodes[n].primary >= 0 && assets[g.nodes[n].primary].polygons !== undefined) : -1;
        if (pond >= 0) {
          nodes = nodes.slice(0, pond + 1);
          edges = edges.slice(0, pond);
        }
        ending = this.stopEnding(a, nodes, edges, walk.loop && pond < 0);
      }
      const path = this.assetPath(a.index, nodes, edges, tier ? sinks.get(routing.sink[start])!.asset : -1);
      const terminal = path[path.length - 1];
      ending = { ...ending, terminal, exit: ending.cls === 'unknown' && tier === 0 ? terminal : ending.exit };
      // guessed links: bridged gaps and pond-to-pond links
      const bridges = edges.filter((ei) => g.edges[ei].how === 'bridge' || (g.edges[ei].how === 'pond' && g.edges[ei].asset < 0)).length;
      let pipeM = 0;
      for (const ei of edges) if (g.edges[ei].how === 'line' && g.edges[ei].asset >= 0) pipeM += g.edges[ei].lengthM;
      const against = tier ? routing.againstM[start] : 0;
      const sinkType = tier ? assets[sinks.get(routing.sink[start])!.asset].type : '';
      const confidence: Trace['confidence'] =
        ending.cls === 'unknown'
          ? 'none'
          : tier === 1 &&
              bridges === 0 &&
              against <= this.opts.highAgainstM &&
              !isPossible(sinkType) &&
              ending.code !== 'discharge-point' &&
              ending.code !== 'downstream-creek' &&
              perPiece.get(g.component[start]) === 1
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
      againstM.push(Math.round(against * 10) / 10);
    }
    return { traces, routing, sinks, direction, traceEdges, againstM, passedDischarge: passed };
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

  /** Why a discharge point counts as soaking in, in plain words. */
  private soakReason(what: string, s: Soak): string {
    const a = this.assets[s.asset];
    switch (s.how) {
      case 'bottom':
        return `Ends at ${what}, where ${describeCounty(a)} has ${a.bottom === 'Perforated' ? 'a perforated' : 'an open'} bottom that lets water soak into the ground.`;
      case 'perforated':
        return `Ends at ${what}, where ${describeCounty(a)} lets water soak into the ground.`;
      case 'facility':
        return `Ends at ${what}, ${s.d < 1 ? 'at' : `${m(s.d)} from`} ${describeCounty(a)}, so we count it as soaking into the ground.`;
      case 'permit':
        return `Ends at ${what}, which the County marks as a stormwater permit discharge point. The state permit defines those as places water leaves through a facility built to soak it in, so we count it as soaking into the ground.`;
    }
  }

  sinkEnding(s: Sink): Ending {
    const a = this.assets[s.asset];
    const what = describeCounty(a);
    const tol = this.opts.waterTolM;
    if (s.tier === 2) {
      if (a.perforated) return this.make('perforated-pipe', 'ground', s.asset, `Soaks into the ground through ${what} (no other way out is mapped).`);
      const bottom = a.bottom === 'Perforated' ? 'perforated' : 'open';
      return this.make('drywell', 'ground', s.asset, `Soaks into the ground through the ${bottom} bottom of ${what} (no other way out is mapped).`);
    }
    if (a.kind === 'pond') return this.make('infiltration-pond', 'ground', s.asset, `Soaks into the ground at ${what}.`);
    if (a.layer === 'network') return this.make('infiltration-vault', 'ground', s.asset, `Soaks into the ground at ${what}.`);

    const coho = this.near(a, (p) => this.waters.coho(p, tol));
    const other = coho ? null : this.near(a, (p) => this.waters.other(p, tol));
    const otherHit = other ? this.waters.other(other.p, tol) : null;
    const otherName = otherHit ? otherHit.water.name || (otherHit.water.kind === 'lake' ? 'an unnamed lake or pond' : 'an unnamed stream') : '';
    const cohoName = coho ? this.waters.cohoName(coho.p, this.waters.coho(coho.p, tol)!, tol) : '';
    // a stream that runs on into coho water a short way downstream
    const down = other && otherHit?.water.source === 'stream' ? this.waters.downstreamCoho(otherHit.water, other.p, this.opts.downstreamCohoM) : null;
    const downName = down?.name || 'Unnamed coho stream';
    const downSay = !down
      ? ''
      : down.name && down.name === otherHit!.water.name
        ? `${otherName}, which WDFW maps as coho habitat about ${far(down.m)} downstream`
        : `${otherName}, which runs about ${far(down.m)} on into ${down.name || 'an unnamed coho stream'}, a stream WDFW maps as coho habitat`;

    if (a.layer === 'endpoint') {
      const group = endPointGroup(a.type);
      const start = `Leaves the pipes at ${what}`;
      if (coho) {
        return this.make(group === 'outfall' ? 'outfall-creek' : 'stream-creek', 'creek', s.asset, `${start}, ${m(coho.d)} from ${cohoName}, a stream WDFW maps as coho habitat.`, cohoName);
      }
      if (down) return this.make('downstream-creek', 'creek', s.asset, `${start}, ${m(other!.d)} from ${downSay}.`, downName);
      if (other) {
        return this.make(group === 'outfall' ? 'outfall-elsewhere' : 'stream-elsewhere', 'elsewhere', s.asset, `${start}, ${m(other.d)} from ${otherName}.`, otherName);
      }
      if (group === 'discharge') {
        const soak = this.soak.at(s.node, a);
        if (soak) return this.make('discharge-point', 'ground', s.asset, this.soakReason(what, soak));
        return this.make('discharge-unknown', 'unknown', s.asset, `The County's map ends at ${what}; where the water goes from there isn't mapped.`);
      }
      if (group === 'outfall') {
        return this.make('outfall-unknown', 'unknown', s.asset, `${start}, but no mapped stream or lake is within ${tol} m, so where it flows next isn't known.`);
      }
      return this.make('dead-end', 'unknown', s.asset, `The County's map stops at ${what} and doesn't say where the water goes.`);
    }
    // stream culverts and natural channels
    if (coho) return this.make('stream-creek', 'creek', s.asset, `Reaches ${what}, part of ${cohoName}, a stream WDFW maps as coho habitat.`, cohoName);
    if (down) return this.make('downstream-creek', 'creek', s.asset, `Reaches ${what}, part of ${downSay}.`, downName);
    if (other) return this.make('stream-elsewhere', 'elsewhere', s.asset, `Reaches ${what}, part of ${otherName}.`, otherName);
    return this.make('outlet-unmapped', 'unknown', s.asset, `Reaches ${what}, which carries a stream, but no mapped stream is within ${tol} m, so where it goes isn't known.`);
  }

  private stopEnding(drain: CountyAsset, nodes: readonly number[], edges: readonly number[], loop: boolean): Ending {
    const { g, assets } = this;
    if (!edges.length) {
      const start = g.nodeOf[drain.index];
      const into = g.adj[start].some((ei) => g.edges[ei].how === 'line' && g.edges[ei].asset >= 0 && g.edges[ei].directed);
      if (!into) return this.make('not-connected', 'unknown', drain.index, `${capitalize(describeCounty(drain))} isn't connected to any mapped pipe or ditch.`);
      return this.make('dead-end', 'unknown', drain.index, `The County's map shows pipes or ditches flowing into ${describeCounty(drain)}, but none flowing out.`);
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
    if (loop) return this.make('loop', 'unknown', last, `Following the pipes the way they're drawn, the County's map loops back on itself at ${what}.`);
    return this.make('dead-end', 'unknown', last, `Following the pipes the way they're drawn, the County's map stops at ${what} without showing where the water goes.`);
  }
}
