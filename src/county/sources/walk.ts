// Source assets with key links (src/county/source.ts) -> county assets and drain traces.
// Each drain follows its keys downstream to the nearest ending: an outfall, a sewer entry, a soak-in
// facility or a live stream. Line ends with no key snap to a structure or line within SNAP_M.
import { dist, GridIndex, nearestOnPolyline, polylineLength, type Projection, type XY } from '../../geo/geo.ts';
import type { DrainClass, EndingCode, Trace } from '../../trace/trace.ts';
import type { CountyAsset, CountyLayer } from '../assets.ts';
import type { AssetKind } from '../../trace/assets.ts';
import type { SourceAsset } from '../source.ts';

/** a line end with no key joins a structure or line this close */
export const SNAP_M = 1.5;

/** what an ending reached: the asset and how water leaves there */
export type Sink = 'water' | 'stream' | 'sewer' | 'ground';

/** custom ending codes; the app reads their reason as written */
export const SEWER_CODE = 'sewer' as EndingCode;
export const GAP_CODE = 'map-gap' as EndingCode;
export const SOAK_CODE = 'facility-ground' as EndingCode;

const LAYER: Record<SourceAsset['role'], [CountyLayer, AssetKind, string]> = {
  drain: ['drain', 'structure', 'Catch Basin - Type1'],
  junction: ['network', 'vault', 'Maintenance hole'],
  outfall: ['endpoint', 'outlet', 'Outfall'],
  discharge: ['endpoint', 'outlet', 'Sewer connection'],
  'facility-hold': ['facility', 'pond', 'Detention Cell'],
  'facility-infiltrate': ['facility', 'pond', 'Infiltration Cell'],
  pipe: ['pipe', 'pipe', 'Pipe'],
  ditch: ['channel', 'channel', 'Man-made'],
  culvert: ['pipe', 'pipe', 'Culvert'],
  'stream-culvert': ['pipe', 'pipe', 'Culvert'],
  virtual: ['virtual', 'pipe', 'Virtual Drainline'],
  stream: ['channel', 'channel', 'Natural'],
};

/** Source assets in local meters, in the shape the county slicer and encoder read. */
export function toCountyAssets(src: readonly SourceAsset[], projection: Projection): CountyAsset[] {
  return src.map((s, index) => {
    const [layer, kind, type] = LAYER[s.role];
    const pts = s.coords.map((c) => projection.toXY(c));
    const line = s.coords.length >= 2 && kind !== 'pond' ? pts : undefined;
    return {
      index,
      id: s.id,
      key: `${s.src}:${s.role}:${s.id}#${index}`,
      kind,
      layer,
      type,
      anchor: pts[0],
      line,
      lengthM: line ? polylineLength(line) : 0,
      width: s.width ?? 0,
      perforated: !!s.perforated,
      gallery: false,
      bottom: s.openBottom ? 'Open' : '',
      fromId: s.fromId ?? '',
      toId: s.toId ?? '',
      toType: '',
      owner: s.owner === 'private' ? 'Private' : 'Public',
      liveStream: !!s.liveStream,
    };
  });
}

export interface Reached {
  sink: Sink | 'gap' | 'loop' | 'not-connected';
  /** the deciding asset (the last one walked for a gap) */
  terminal: number;
  path: number[];
  /** meters of pipe and ditch walked */
  pipeM: number;
  /** a line end joined by distance, not by key */
  snapped: boolean;
}

interface Edge {
  /** line asset, or -1 for a snap */
  line: number;
  to: number;
  m: number;
}

/** The key graph: nodes are keys (or a keyless line end), edges are lines in flow order. */
export class KeyGraph {
  readonly src: readonly SourceAsset[];
  readonly xy: readonly XY[][];
  private readonly node = new Map<string, number>();
  private readonly at: XY[] = [];
  /** point asset at a node (a sink first) */
  private readonly point: number[] = [];
  private readonly out: Edge[][] = [];
  private readonly sinkOf = new Map<number, { sink: Sink; asset: number }>();
  private readonly best: Float64Array;
  private readonly via: Int32Array;

  constructor(src: readonly SourceAsset[], projection: Projection) {
    this.src = src;
    this.xy = src.map((s) => s.coords.map((c) => projection.toXY(c)));
    const lines: number[] = [];
    src.forEach((s, i) => {
      if (s.key && s.coords.length === 1) {
        const n = this.nodeFor(s.key, this.xy[i][0]);
        const sink = pointSink(s);
        if (sink) this.sinkOf.set(n, { sink, asset: i });
        if (this.point[n] < 0 || sink) this.point[n] = i;
      } else if (s.coords.length >= 2 && s.trust !== 'none') lines.push(i);
    });
    for (const i of lines) {
      const s = src[i];
      const l = this.xy[i];
      const a = this.nodeFor(s.fromId || `start@${i}`, l[0]);
      const b = this.nodeFor(s.toId || `end@${i}`, l[l.length - 1]);
      this.out[a].push({ line: i, to: b, m: polylineLength(l) });
      // reaching a live stream line is reaching the stream
      if (s.role === 'stream' || s.liveStream) {
        if (!this.sinkOf.has(a)) this.sinkOf.set(a, { sink: 'stream', asset: i });
      }
    }
    this.snapEnds(lines);
    [this.best, this.via] = this.route();
  }

  private nodeFor(key: string, p: XY): number {
    let n = this.node.get(key);
    if (n === undefined) {
      n = this.at.length;
      this.node.set(key, n);
      this.at.push(p);
      this.point.push(-1);
      this.out.push([]);
    }
    return n;
  }

  /** Nodes with nothing going out and no ending: join the nearest line start or line within SNAP_M. */
  private snapEnds(lines: readonly number[]): void {
    const starts = new GridIndex<number>(25);
    const segs = new GridIndex<number>(25);
    this.out.forEach((edges, n) => {
      if (edges.length) starts.insertPoint(n, this.at[n]);
    });
    for (const i of lines) {
      const l = this.xy[i];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of l) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      segs.insert(i, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
    }
    const lineOf = new Map<number, number>();
    this.out.forEach((edges) => edges.forEach((e) => lineOf.set(e.line, e.to)));
    for (let n = 0; n < this.at.length; n++) {
      if (this.out[n].length || this.sinkOf.has(n)) continue;
      const p = this.at[n];
      let pick = -1, pickD = Infinity;
      for (const k of starts.near(p, SNAP_M)) {
        const d = dist(p, this.at[k]);
        if (k !== n && d <= SNAP_M && (d < pickD || (d === pickD && k < pick))) [pick, pickD] = [k, d];
      }
      if (pick >= 0) {
        this.out[n].push({ line: -1, to: pick, m: pickD });
        continue;
      }
      // a tap partway along a line: on to that line's downstream end
      let line = -1, lineD = Infinity, rest = 0;
      for (const i of segs.near(p, SNAP_M)) {
        const to = lineOf.get(i);
        if (to === undefined || to === n) continue;
        const hit = nearestOnPolyline(p, this.xy[i]);
        if (hit.d <= SNAP_M && (hit.d < lineD || (hit.d === lineD && i < line))) [line, lineD, rest] = [i, hit.d, polylineLength(this.xy[i]) - hit.along];
      }
      if (line >= 0) this.out[n].push({ line, to: lineOf.get(line)!, m: lineD + rest });
    }
  }

  /** Meters to the nearest ending from each node, and the edge to take (Dijkstra on the reversed graph). */
  private route(): [Float64Array, Int32Array] {
    const N = this.at.length;
    const best = new Float64Array(N).fill(Infinity);
    const via = new Int32Array(N).fill(-1);
    const into: { from: number; k: number }[][] = Array.from({ length: N }, () => []);
    this.out.forEach((edges, n) => edges.forEach((e, k) => into[e.to].push({ from: n, k })));
    const heap = new MinHeap();
    for (const n of this.sinkOf.keys()) {
      best[n] = 0;
      heap.push(0, n);
    }
    while (heap.size) {
      const [d, n] = heap.pop();
      if (d > best[n]) continue;
      for (const { from, k } of into[n]) {
        if (this.sinkOf.has(from)) continue;
        const e = this.out[from][k];
        // virtual connectors and snaps cost a little more, so a real pipe wins a tie
        const nd = d + e.m + (e.line < 0 || this.src[e.line].role === 'virtual' ? 1 : 0);
        if (nd < best[from] || (nd === best[from] && k < via[from])) {
          best[from] = nd;
          via[from] = k;
          heap.push(nd, from);
        }
      }
    }
    return [best, via];
  }

  /** Walks one drain (a keyed point) to its ending. */
  walk(drain: number): Reached {
    const s = this.src[drain];
    const start = s.key ? this.node.get(s.key) : undefined;
    const path = [drain];
    const add = (k: number) => {
      if (k >= 0 && path[path.length - 1] !== k && this.src[k].role !== 'virtual') path.push(k);
    };
    let pipeM = 0, snapped = false, last = drain;
    if (start === undefined) return { sink: 'not-connected', terminal: drain, path, pipeM, snapped };
    const seen = new Set<number>();
    let n = start;
    for (;;) {
      const sink = this.sinkOf.get(n);
      if (sink) {
        if (sink.sink === 'stream') pipeM += polylineLength(this.xy[sink.asset]);
        add(sink.asset);
        return { sink: sink.sink, terminal: sink.asset, path, pipeM, snapped };
      }
      seen.add(n);
      const edges = this.out[n];
      // the route to the nearest ending; with none, the drawn way (real pipes, then the widest)
      const k = this.via[n] >= 0 ? this.via[n] : pickDrawn(edges, this.src);
      if (k < 0) {
        const cut = n === start ? 'not-connected' : 'gap';
        return { sink: cut, terminal: last, path, pipeM, snapped };
      }
      const e = edges[k];
      if (e.line < 0) snapped = true;
      else {
        pipeM += polylineLength(this.xy[e.line]);
        add(e.line);
        if (this.src[e.line].role !== 'virtual') last = e.line;
      }
      if (seen.has(e.to)) return { sink: 'loop', terminal: last, path, pipeM, snapped };
      n = e.to;
      const p = this.point[n];
      if (p >= 0 && !this.sinkOf.has(n)) {
        add(p);
        last = p;
      }
    }
  }

  /** The drain reaches an ending by keys or snaps. */
  reaches(drain: number): boolean {
    const n = this.src[drain].key ? this.node.get(this.src[drain].key!) : undefined;
    return n !== undefined && this.best[n] < Infinity;
  }
}

function pointSink(s: SourceAsset): Sink | null {
  if (s.role === 'outfall') return s.endHint === 'ground' ? 'ground' : s.endHint === 'treatment' ? 'sewer' : 'water';
  if (s.role === 'discharge') return s.endHint === 'treatment' ? 'sewer' : s.endHint === 'water' ? 'water' : s.endHint === 'ground' ? 'ground' : null;
  if (s.role === 'facility-infiltrate') return 'ground';
  return null;
}

function pickDrawn(edges: readonly Edge[], src: readonly SourceAsset[]): number {
  let k = -1;
  for (let i = 0; i < edges.length; i++) {
    const rank = (e: Edge) => (e.line < 0 ? 2 : src[e.line].role === 'virtual' ? 1 : 0);
    const w = (e: Edge) => (e.line < 0 ? 0 : src[e.line].width ?? 0);
    if (k < 0 || rank(edges[i]) < rank(edges[k]) || (rank(edges[i]) === rank(edges[k]) && w(edges[i]) > w(edges[k]))) k = i;
  }
  return k;
}

class MinHeap {
  private readonly d: number[] = [];
  private readonly v: number[] = [];
  get size(): number {
    return this.d.length;
  }
  push(d: number, v: number): void {
    const { d: D, v: V } = this;
    let i = D.length;
    D.push(d);
    V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (D[p] <= D[i]) break;
      [D[p], D[i]] = [D[i], D[p]];
      [V[p], V[i]] = [V[i], V[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const { d: D, v: V } = this;
    const top: [number, number] = [D[0], V[0]];
    const ld = D.pop()!, lv = V.pop()!;
    if (D.length) {
      D[0] = ld;
      V[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < D.length && D[l] < D[m]) m = l;
        if (r < D.length && D[r] < D[m]) m = r;
        if (m === i) break;
        [D[m], D[i]] = [D[i], D[m]];
        [V[m], V[i]] = [V[i], V[m]];
        i = m;
      }
    }
    return top;
  }
}

/** How a reached ending reads: code, class and reason. Water is decided by the caller (it knows the maps). */
export interface Decided {
  code: EndingCode;
  cls: DrainClass | 'treatment';
  receiving: string;
  reason: string;
}

/** Builds a trace from a walk and its decided ending. */
export function toTrace(r: Reached, e: Decided): Trace & { sewer: boolean } {
  const cls: DrainClass = e.cls === 'treatment' ? 'elsewhere' : e.cls;
  return {
    drain: r.path[0],
    path: r.path,
    ending: { code: e.code, cls, terminal: r.terminal, exit: r.terminal, receiving: e.receiving, reason: e.reason },
    confidence: e.cls === 'unknown' ? 'none' : r.snapped ? 'likely' : 'high',
    linkCounts: {},
    weakLinks: r.snapped ? 1 : 0,
    pipeM: r.pipeM,
    sewer: e.cls === 'treatment',
  };
}
