// Traces every county drain to an ending and classifies it.
//
// Ending codes [class]:
//   outfall-creek [creek]           outfall within 30 m of WDFW Documented or Presumed coho water
//   stream-creek [creek]            another end point, a stream culvert or a natural channel at such water
//   downstream-creek [creek]        at a County stream that runs on into such water within 2 km
//   outfall-elsewhere, stream-elsewhere [elsewhere]
//                                   other water: a lake, pond, wetland, Puget Sound, or a stream WDFW maps
//                                   only as reachable by coho (Gradient Accessible, Potential) or as historic
//   bridge-creek, bridge-elsewhere  a bridge drain with no pipe, within 20 m of water: most likely drops into it
//   pipe-end-creek, pipe-end-elsewhere
//                                   the map stops at the open end of a pipe or ditch within 15 m of water:
//                                   most likely flows in (no outfall drawn)
//   infiltration-pond, infiltration-vault, drywell, perforated-pipe, discharge-point [ground]
//   discharge-by-water [ground]     a discharge point built to soak water in, beside water: some may still reach it
//   discharge-probable [unknown]    a discharge point with nothing drawn that soaks the water in: probably soaks in
//   pond-unmapped [unknown]         flows into a pond whose way out isn't mapped
//   outfall-unknown, outlet-unmapped, dead-end, loop, not-connected [unknown]
//   handoff [unknown]               an end point where the pipes go on into a system the map lacks (private, a city's)
// When the water is a WDFW coho stream, the reason ends with one of WDFW_SAYS.
// Roadside ditch intakes (traceIntakes) take the code of where the ditch's water ends; their drain asset is
// the ditch (a channel) and their reason starts with INTAKE_SAYS.
import { bboxOf, dist, distanceToPolygons, GridIndex, type XY } from '../geo/geo.ts';
import type { DrainClass, Ending, EndingCode, Trace } from '../trace/trace.ts';
import {
  describeCounty,
  endPointGroup,
  INFILTRATION_CELLS,
  isBridgeDrain,
  isCountyDrain,
  isPondCell,
  isPossible,
  soaksThroughBottom,
  type CountyAsset,
  type CountyLayer,
} from './assets.ts';
import type { Graph } from './graph.ts';
import { drawnWalk, measureDirection, nodePath, otherEnd, route, DEFAULT_ROUTE_OPTIONS, type DirectionCheck, type RouteOptions, type Routing } from './route.ts';
import { isUnnamedPond, unnamedWater, type CohoStatus, type CountyWater, type CountyWaters, type WaterNear } from './waters.ts';

export interface CountyTraceOptions {
  route: RouteOptions;
  /** An ending this close to water discharges into it. */
  waterTolM: number;
  /** A discharge point this close to an infiltration facility soaks in there. */
  facilityTolM: number;
  /** Routes running more than this against the drawing are never high confidence. */
  highAgainstM: number;
  /** A stream that reaches documented coho water this far downstream (as the County draws it) counts as creek. */
  downstreamCohoM: number;
  /** A bridge drain with no pipe this close to water drops into it. */
  bridgeTolM: number;
  /** A pipe or ditch the map stops at this close to water most likely flows into it. */
  lineEndTolM: number;
  /** An outfall with no water within waterTolM names the nearest water this close. */
  nearbyWaterM: number;
}

export const DEFAULT_COUNTY_TRACE_OPTIONS: CountyTraceOptions = {
  route: DEFAULT_ROUTE_OPTIONS,
  waterTolM: 30,
  facilityTolM: 10,
  highAgainstM: 20,
  downstreamCohoM: 2000,
  bridgeTolM: 20,
  lineEndTolM: 15,
  nearbyWaterM: 60,
};

/** Last sentences of a reason when the water is a WDFW coho stream, by distribution type. */
export const WDFW_SAYS: Record<CohoStatus, string> = {
  documented: 'WDFW records coho salmon in this stream.',
  modeled: "WDFW maps this stream as reachable by coho salmon. They haven't been confirmed here.",
  historic: 'WDFW lists coho salmon in this stream in the past.',
};

/** First sentence of a roadside ditch intake's reason. */
export const INTAKE_SAYS = 'Runs into a roadside ditch.';

const PERMIT = 'In the state stormwater permit, a discharge point is where water leaves the pipes through something built to soak it into the ground.';
const UNNAMED = 'an unnamed stream';

/** Network structures that soak water in. */
const INFILTRATION_STRUCTURES = new Set(['Infiltration Vault', 'Permeable Pavement']);
/** Fittings that sit on a pipe or ditch end, so a walk stopping there stopped at the line's open end. */
const LINE_END_LAYERS: ReadonlySet<CountyLayer> = new Set(['inlet', 'outlet', 'barrier']);

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

/** Where water near an ending goes, and how to say it. */
interface WaterAnswer {
  cls: 'creek' | 'elsewhere';
  /** coho: documented coho water itself; downstream: a County stream that runs on into it; water: other water. */
  via: 'coho' | 'downstream' | 'water';
  /** Meters to the water beside the ending. */
  d: number;
  /** The water beside the ending, as said in a sentence: "Clover Creek", "an unnamed stream". */
  near: string;
  receiving: string;
  /** Sentence after the first (WDFW line, or where the stream runs on to). */
  say: string;
  /** The water beside the ending is a stream (not a lake, pond, wetland or the Sound). */
  stream: boolean;
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

/** Pond the node drains into, -1 if none. */
function pondAt(g: Graph, node: number): number {
  for (const ei of g.adj[node]) if (g.edges[ei].how === 'pond' && g.edges[ei].asset >= 0) return g.edges[ei].asset;
  return -1;
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

export interface IntakeTraced {
  /** One per ditch asked for, in order; the trace's drain is the ditch. */
  traces: Trace[];
  /** Edges each crossed, from the ditch's drawn downstream end. */
  traceEdges: number[][];
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

/** "private" -> "a private owner", "City of Seattle" -> "the City of Seattle" */
export function handoffWho(to: string): string {
  if (to === 'private') return 'a private owner';
  if (to === 'other public agency') return 'another public agency';
  if (to === 'another jurisdiction') return 'another city or agency';
  return /^(city|town) of /i.test(to) ? `the ${to}` : to;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Distance in plain words: "a few feet", "about 20 ft", "about 1,200 ft", "about 1.4 miles". */
export function feet(m: number): string {
  const f = m * 3.28084;
  if (f < 10) return 'a few feet';
  const tens = Math.round(f / 10) * 10;
  if (tens < 1000) return `about ${tens} ft`;
  if (f < 5280) return `about ${commas(Math.round(f / 100) * 100)} ft`;
  const mi = Math.round((f / 5280) * 10) / 10;
  return `about ${mi} ${mi === 1 ? 'mile' : 'miles'}`;
}

const isUnnamed = (name: string) => name.startsWith('an unnamed');

/** "Little Creek flows about 1,300 ft on into Clarks Creek"; "That stream flows ... on into another stream" when neither has a name. */
function flowsInto(near: string, into: string, m: number): string {
  const subject = isUnnamed(near) ? 'That stream' : near;
  return `${subject} flows ${feet(m)} on into ${isUnnamed(near) && isUnnamed(into) ? 'another stream' : into}`;
}

/** A stream that runs on into one WDFW maps only as reachable by coho, or lists as coho water in the past. */
function downstreamSays(near: string, into: string, m: number, status: CohoStatus): string {
  const same = into === near && !isUnnamed(near);
  if (status === 'historic') return same ? `WDFW lists coho salmon in this stream in the past, ${feet(m)} downstream.` : `${flowsInto(near, into, m)}, where WDFW lists coho salmon in the past.`;
  return same
    ? `WDFW maps this stream as reachable by coho salmon ${feet(m)} downstream. They haven't been confirmed there.`
    : `${flowsInto(near, into, m)}, which WDFW maps as reachable by coho salmon. They haven't been confirmed there.`;
}

/** "right by Clover Creek", "about 20 ft from Clover Creek" */
const beside = (d: number, name: string) => (d < 3 ? `right by ${name}` : `${feet(d)} from ${name}`);
const sentences = (...parts: string[]) => parts.filter(Boolean).join(' ');

interface TraceState {
  routing: Routing;
  sinks: Map<number, Sink>;
  endingCache: Map<number, Ending>;
}

export class CountyTracer {
  private readonly assets: readonly CountyAsset[];
  private readonly g: Graph;
  private readonly waters: CountyWaters;
  private readonly opts: CountyTraceOptions;
  private readonly soak: SoakCheck;
  private state: TraceState | null = null;

  constructor(assets: readonly CountyAsset[], g: Graph, waters: CountyWaters, opts: CountyTraceOptions = DEFAULT_COUNTY_TRACE_OPTIONS) {
    this.assets = assets;
    this.g = g;
    this.waters = waters;
    this.opts = opts;
    this.soak = new SoakCheck(assets, g, opts.facilityTolM);
  }

  /** A discharge point we'd read as unknown, where a drawn line or a mapped pond carries the water on. */
  private passesThrough(node: number, a: CountyAsset): boolean {
    if (endPointGroup(a.type) !== 'discharge' || !(linesThrough(this.g, node) || pondAt(this.g, node) >= 0)) return false;
    return !this.waters.mapped(a.anchor, this.opts.waterTolM, (w) => !isUnnamedPond(w)) && !this.soak.at(node, a);
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
    this.state = { routing, sinks, endingCache: new Map() };

    // explicit endings per connected piece, for confidence
    const perPiece = new Map<number, number>();
    for (const s of tier1) perPiece.set(g.component[s], (perPiece.get(g.component[s]) ?? 0) + 1);

    const traces: Trace[] = [];
    const traceEdges: number[][] = [];
    const againstM: number[] = [];
    for (const a of assets) {
      if (!isCountyDrain(a)) continue;
      const start = g.nodeOf[a.index];
      const { nodes, edges, ending, tier, sink } = this.follow(a, start);
      const path = this.assetPath(a.index, nodes, edges, tier ? sinks.get(routing.sink[start])!.asset : -1);
      const terminal = path[path.length - 1];
      const base: Ending = { ...ending, terminal, exit: ending.cls === 'unknown' && tier === 0 ? terminal : ending.exit };
      const done = this.intoPond(base, sink, path);
      const bridges = this.guessedLinks(edges);
      const against = tier ? routing.againstM[start] : 0;
      const sinkType = tier ? assets[sinks.get(routing.sink[start])!.asset].type : '';
      const confidence: Trace['confidence'] =
        done.cls === 'unknown'
          ? 'none'
          : done === base &&
              tier === 1 &&
              bridges === 0 &&
              against <= this.opts.highAgainstM &&
              !isPossible(sinkType) &&
              done.code !== 'discharge-point' &&
              done.code !== 'discharge-by-water' &&
              done.code !== 'downstream-creek' &&
              perPiece.get(g.component[start]) === 1
            ? 'high'
            : 'likely';
      traces.push({ drain: a.index, path, ending: done, confidence, linkCounts: {}, weakLinks: bridges, pipeM: Math.round(this.pipeMeters(edges, -1)) });
      traceEdges.push(edges);
      againstM.push(Math.round(against * 10) / 10);
    }
    return { traces, routing, sinks, direction, traceEdges, againstM, passedDischarge: passed };
  }

  /**
   * Roadside ditches as intakes: rain off a street with no drain runs into the ditch beside it, and from
   * the ditch's drawn downstream end on as the router sends it. Call after traceAll.
   */
  traceIntakes(channels: readonly number[]): IntakeTraced {
    const { g, assets } = this;
    const st = this.state;
    if (!st) throw new Error('traceIntakes needs traceAll first');
    const traces: Trace[] = [];
    const traceEdges: number[][] = [];
    for (const c of channels) {
      const a = assets[c];
      const start = g.lineEnds.get(c)![1];
      const { nodes, edges, ending, tier, sink } = this.follow(a, start);
      const path = this.assetPath(c, nodes, edges, tier ? st.sinks.get(st.routing.sink[start])!.asset : -1);
      const terminal = path[path.length - 1];
      const pipeM = this.pipeMeters(edges, c) + a.lengthM;
      const end = this.intoPond({ ...ending, terminal, exit: ending.cls === 'unknown' && tier === 0 ? terminal : ending.exit }, sink, path);
      // one wording for every ditch with this ending, so bundles share it; how far the map follows the water is the path's length
      const done: Ending = { ...end, reason: `${INTAKE_SAYS} ${end.reason}` };
      traces.push({ drain: c, path, ending: done, confidence: done.cls === 'unknown' ? 'none' : 'likely', linkCounts: {}, weakLinks: this.guessedLinks(edges), pipeM: Math.round(pipeM) });
      traceEdges.push(edges);
    }
    return { traces, traceEdges };
  }

  /** Route from a start node to its ending, or the drawn walk where no ending is in reach. */
  private follow(origin: CountyAsset, start: number): { nodes: number[]; edges: number[]; ending: Ending; tier: number; sink: Sink | null } {
    const { g, assets } = this;
    const st = this.state!;
    if (st.routing.sink[start] >= 0) {
      const { nodes, edges } = nodePath(g, st.routing, start);
      const s = st.sinks.get(st.routing.sink[start])!;
      let e = st.endingCache.get(s.node);
      if (!e) {
        e = this.sinkEnding(s);
        st.endingCache.set(s.node, e);
      }
      return { nodes, edges, ending: e, tier: s.tier, sink: s };
    }
    // no ending in reach: follow the drawing until the map stops
    const walk = drawnWalk(g, start, (k) => (k >= 0 ? assets[k].width : -1));
    let nodes = walk.nodes;
    let edges = walk.edges;
    // a loop through a pond ends in that pond (its way out isn't mapped)
    const pond = walk.loop ? nodes.findIndex((n, i) => i >= walk.loopAt && g.nodes[n].primary >= 0 && assets[g.nodes[n].primary].polygons !== undefined) : -1;
    if (pond >= 0) {
      nodes = nodes.slice(0, pond + 1);
      edges = edges.slice(0, pond);
    }
    return { nodes, edges, ending: this.stopEnding(origin, nodes, edges, walk.loop && pond < 0), tier: 0, sink: null };
  }

  /** An end point the map stops at beside a pond the water hasn't passed through: it flows into that pond (and soaks in, if the pond is built to). */
  private intoPond(e: Ending, sink: Sink | null, path: readonly number[]): Ending {
    if (!sink || (e.code !== 'dead-end' && e.code !== 'handoff') || this.assets[sink.asset].layer !== 'endpoint') return e;
    const pond = pondAt(this.g, sink.node);
    if (pond < 0 || path.includes(pond)) return e;
    const at = describeCounty(this.assets[sink.asset]);
    if (isInfiltrationFacility(this.assets[pond])) {
      return { ...this.make('infiltration-pond', 'ground', pond, `Flows into ${describeCounty(this.assets[pond])} at ${at}, and soaks into the ground there.`), terminal: e.terminal, exit: e.exit };
    }
    return { ...this.pondEnding(pond, at), terminal: e.terminal, exit: e.exit };
  }

  /** Guessed links: bridged gaps and pond-to-pond links. */
  private guessedLinks(edges: readonly number[]): number {
    return edges.filter((ei) => this.g.edges[ei].how === 'bridge' || (this.g.edges[ei].how === 'pond' && this.g.edges[ei].asset < 0)).length;
  }

  private pipeMeters(edges: readonly number[], skip: number): number {
    let m = 0;
    for (const ei of edges) {
      const e = this.g.edges[ei];
      if (e.how === 'line' && e.asset >= 0 && e.asset !== skip) m += e.lengthM;
    }
    return m;
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

  /** Closest hit over a deciding asset's points (its point, or a line's vertices). */
  private closest(pts: readonly XY[], find: (p: XY) => WaterNear | null): { p: XY; hit: WaterNear } | null {
    let best: { p: XY; hit: WaterNear } | null = null;
    for (const p of pts) {
      const hit = find(p);
      if (hit && (!best || hit.d < best.hit.d)) best = { p, hit };
    }
    return best;
  }

  /** Water within tol of the points that `keep` allows: documented coho water first, then the nearest other water (and where a stream runs on to). */
  private answer(pts: readonly XY[], tol: number, keep: (w: CountyWater) => boolean = () => true): WaterAnswer | null {
    const W = this.waters;
    const doc = this.closest(pts, (p) => W.nearest(p, tol, (w) => w.fennel && keep(w)));
    if (doc) {
      const name = W.nameFor(doc.p, doc.hit, tol) || UNNAMED;
      return { cls: 'creek', via: 'coho', d: doc.hit.d, near: name, receiving: name, say: WDFW_SAYS.documented, stream: true };
    }
    // a County stream that runs on into coho water a short way downstream: walked from the nearest of the
    // County's own waters and WDFW's, so a closer NHD line or wetland doesn't hide it
    const own = this.closest(pts, (p) => W.mapped(p, tol, (x) => !x.fennel && keep(x)));
    const stream = !own ? null : own.hit.water.source === 'stream' ? own : own.hit.water.source === 'coho' ? this.closest([own.p], (p) => W.nearest(p, tol, (x) => x.source === 'stream')) : null;
    const down = stream ? W.downstreamCoho(stream.hit.water, stream.p, this.opts.downstreamCohoM) : null;
    const streamName = stream ? W.nameFor(stream.p, stream.hit, tol) || unnamedWater(stream.hit.water) : '';
    if (stream && down?.status === 'documented') {
      const into = down.name || UNNAMED;
      const say = down.name && down.name === streamName ? `WDFW records coho salmon in this stream ${feet(down.m)} downstream.` : `${flowsInto(streamName, into, down.m)}, where WDFW records coho salmon.`;
      return { cls: 'creek', via: 'downstream', d: stream.hit.d, near: streamName, receiving: into, say, stream: true };
    }
    const hit = this.closest(pts, (p) => W.receiving(p, tol, keep));
    if (!hit) return null;
    const w = hit.hit.water;
    const near = W.nameFor(hit.p, hit.hit, tol) || unnamedWater(w);
    // other water; a modeled or historic coho stream says so, here or a short way down the same stream
    const sameStream = stream && (w === stream.hit.water || (w.name !== '' && near === streamName));
    const say = w.coho ? WDFW_SAYS[w.coho] : down && sameStream ? downstreamSays(near, down.name || UNNAMED, down.m, down.status) : '';
    const isStream = w.source === 'stream' || w.source === 'nhd' || w.source === 'coho';
    return { cls: 'elsewhere', via: 'water', d: hit.hit.d, near, receiving: near, say, stream: isStream };
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
        return `Ends at ${what}, ${s.d < 1 ? 'at' : `${feet(s.d)} from`} ${describeCounty(a)}, which is built to soak water into the ground.`;
      case 'permit':
        return `Ends at ${what}. ${PERMIT}`;
    }
  }

  private pondEnding(pond: number, at = ''): Ending {
    const a = this.assets[pond];
    const into = `Flows into ${describeCounty(a)}${at ? ` at ${at}` : ''}.`;
    // a planting area, sand filter or log jam drawn as a shape isn't a pond
    if (!isPondCell(a)) {
      return this.make('dead-end', 'unknown', pond, `${into} The County's map doesn't show where the water goes from there.`);
    }
    return this.make('pond-unmapped', 'unknown', pond, `${into} The County's map doesn't show where the pond drains.`);
  }

  sinkEnding(s: Sink): Ending {
    const a = this.assets[s.asset];
    const what = describeCounty(a);
    const tol = this.opts.waterTolM;
    if (s.tier === 2) {
      if (a.perforated) return this.make('perforated-pipe', 'ground', s.asset, `Soaks into the ground through ${what}. No other way out is mapped.`);
      const bottom = a.bottom === 'Perforated' ? 'perforated' : 'open';
      return this.make('drywell', 'ground', s.asset, `Soaks into the ground through the ${bottom} bottom of ${what}. No other way out is mapped.`);
    }
    if (a.kind === 'pond') return this.make('infiltration-pond', 'ground', s.asset, `Soaks into the ground at ${what}.`);
    if (a.layer === 'network') return this.make('infiltration-vault', 'ground', s.asset, `Soaks into the ground at ${what}.`);
    const pts = a.line ?? [a.anchor];

    if (a.layer === 'endpoint') {
      const group = endPointGroup(a.type);
      const discharge = group === 'discharge';
      // beside a discharge point, an unnamed pond may well be the soak-in pond itself
      const notPond = (w: CountyWater) => !isUnnamedPond(w);
      // a discharge point built to soak water in does that first, even beside water
      const soak = discharge ? this.soak.at(s.node, a) : null;
      if (soak) {
        const w = this.answer(pts, tol, notPond);
        if (w) return this.make('discharge-by-water', 'ground', s.asset, sentences(this.soakReason(what, soak), `It is ${beside(w.d, w.near)}, so some may still reach it.`, w.say), w.near);
        return this.make('discharge-point', 'ground', s.asset, this.soakReason(what, soak));
      }
      if (group === 'outfall') return this.outfallEnding(s.asset);
      // one with nothing drawn that soaks it in drains to water only by the County's own waters and WDFW's, as before;
      // the extra layers (NHD, wetlands, small ponds) are only mentioned
      const w = this.answer(pts, tol, discharge ? (x) => notPond(x) && !x.extra && x.source !== 'pond' : undefined);
      if (w) {
        const code: EndingCode = w.via === 'downstream' ? 'downstream-creek' : w.cls === 'creek' ? 'stream-creek' : 'stream-elsewhere';
        return this.make(code, w.cls, s.asset, sentences(`${discharge ? 'Ends' : 'Comes out'} at ${what}, ${beside(w.d, w.near)}.`, w.say), w.receiving);
      }
      if (discharge) {
        const by = this.answer(pts, tol, notPond);
        return this.make(
          'discharge-probable',
          'unknown',
          s.asset,
          sentences(`Ends at ${what}. ${PERMIT} The County's map doesn't show that part here, so TireTrail can't confirm it.`, by ? `It is ${beside(by.d, by.near)}.` : '', by?.say ?? ''),
        );
      }
      // the County's pipes hand the water to a system it doesn't map (a private one, a city's, WSDOT's)
      if (a.toType.startsWith('handoff:')) {
        const who = handoffWho(a.toType.slice(8));
        return this.make('handoff', 'unknown', s.asset, `The County's map hands the water on at ${what} to ${who}, whose pipes aren't on the map.`, who);
      }
      const pond = pondAt(this.g, s.node);
      return this.make('dead-end', 'unknown', s.asset, `The County's map ends at ${what}${pond >= 0 ? `, at ${describeCounty(this.assets[pond])},` : ''} and doesn't say where the water goes.`);
    }
    // stream culverts and natural channels
    const w = this.answer(pts, tol);
    if (w) {
      const code: EndingCode = w.via === 'downstream' ? 'downstream-creek' : w.cls === 'creek' ? 'stream-creek' : 'stream-elsewhere';
      return this.make(code, w.cls, s.asset, sentences(`Reaches ${what}, ${w.stream ? 'part of' : 'which runs into'} ${w.near}.`, w.say), w.receiving);
    }
    return this.make('outlet-unmapped', 'unknown', s.asset, `Reaches ${what}, which carries a stream, but no stream is mapped within ${feet(tol)} of it, so where it goes isn't known.`);
  }

  /** An outfall: the water within waterTolM, else unknown, naming the nearest water. */
  private outfallEnding(k: number): Ending {
    const a = this.assets[k];
    const what = describeCounty(a);
    const pts = [a.anchor];
    const w = this.answer(pts, this.opts.waterTolM);
    if (w) {
      const code: EndingCode = w.via === 'downstream' ? 'downstream-creek' : w.cls === 'creek' ? 'outfall-creek' : 'outfall-elsewhere';
      return this.make(code, w.cls, k, sentences(`Comes out at ${what}, ${beside(w.d, w.near)}.`, w.say), w.receiving);
    }
    const nearby = this.closest(pts, (p) => this.waters.nearest(p, this.opts.nearbyWaterM, () => true));
    const name = nearby ? this.waters.nameFor(nearby.p, nearby.hit, this.opts.nearbyWaterM) || unnamedWater(nearby.hit.water) : '';
    return this.make(
      'outfall-unknown',
      'unknown',
      k,
      sentences(`Comes out at ${what}, but the stream or pond it flows into isn't on the map.`, nearby ? `The nearest mapped water, ${name}, is ${feet(nearby.hit.d)} away.` : ''),
    );
  }

  private stopEnding(origin: CountyAsset, nodes: readonly number[], edges: readonly number[], loop: boolean): Ending {
    const { g, assets } = this;
    const intake = origin.layer === 'channel';
    if (!edges.length && !intake) {
      const start = g.nodeOf[origin.index];
      const into = g.adj[start].some((ei) => g.edges[ei].how === 'line' && g.edges[ei].asset >= 0 && g.edges[ei].directed);
      if (!into) {
        // a bridge drain with no pipe drops straight into the water below
        const w = isBridgeDrain(origin) ? this.answer([origin.anchor], this.opts.bridgeTolM) : null;
        if (w) {
          const where = w.d < 3 ? 'right below' : `${feet(w.d)} away`;
          return this.make(
            w.cls === 'creek' ? 'bridge-creek' : 'bridge-elsewhere',
            w.cls,
            origin.index,
            sentences(`${capitalize(describeCounty(origin))} has no pipe on the County's map, so rain most likely drops through it into ${w.near}, ${where}.`, w.say),
            w.receiving,
          );
        }
        return this.make('not-connected', 'unknown', origin.index, `${capitalize(describeCounty(origin))} isn't connected to any mapped pipe or ditch.`);
      }
      return this.make('dead-end', 'unknown', origin.index, `The County's map shows pipes or ditches flowing into ${describeCounty(origin)}, but none flowing out.`);
    }
    const end = nodes[nodes.length - 1];
    // last real asset on the walk (a ditch intake that went nowhere: the ditch, or what sits at its end)
    let last = edges.length ? -1 : g.nodes[end].primary >= 0 ? g.nodes[end].primary : origin.index;
    for (let i = edges.length - 1; i >= 0 && last < 0; i--) {
      const nodeAsset = g.nodes[nodes[i + 1]].primary;
      const e = g.edges[edges[i]];
      last = nodeAsset >= 0 ? nodeAsset : e.asset >= 0 && assets[e.asset].layer !== 'virtual' ? e.asset : -1;
    }
    if (last < 0) last = origin.index;
    const what = describeCounty(assets[last]);
    if (loop) return this.make('loop', 'unknown', last, `Following the pipes and ditches the way they're drawn, the County's map loops back on itself at ${what}.`);
    const primary = g.nodes[end].primary;
    if (primary >= 0 && assets[primary].kind === 'pond' && assets[primary].polygons) return this.pondEnding(primary);
    // an outfall the source didn't tag with its water (an outlet, so the walk could go on): the map stops at an outfall
    const outfall = g.nodes[end].assets.find((k) => assets[k].layer === 'outlet' && endPointGroup(assets[k].type) === 'outfall');
    if (outfall !== undefined) return this.outfallEnding(outfall);
    // the open end of a pipe or ditch
    const lastEdge = edges.length ? g.edges[edges[edges.length - 1]] : null;
    const line = !lastEdge ? origin.index : lastEdge.how === 'line' && lastEdge.asset >= 0 && assets[lastEdge.asset].layer !== 'virtual' ? lastEdge.asset : -1;
    if (line >= 0 && g.nodes[end].assets.every((k) => LINE_END_LAYERS.has(assets[k].layer))) {
      const w = this.answer([g.nodes[end].p], this.opts.lineEndTolM);
      if (w) {
        return this.make(
          w.cls === 'creek' ? 'pipe-end-creek' : 'pipe-end-elsewhere',
          w.cls,
          line,
          sentences(
            `Following the pipes and ditches the way they're drawn, the County's map stops at the end of ${describeCounty(assets[line])}, ${beside(w.d, w.near)}. It most likely flows in, but the map doesn't show an outfall.`,
            w.say,
          ),
          w.receiving,
        );
      }
    }
    return this.make('dead-end', 'unknown', last, `Following the pipes and ditches the way they're drawn, the County's map stops at ${what} without showing where the water goes.`);
  }
}
