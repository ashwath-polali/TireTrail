// Directed drainage graph. Link sources, most trusted first:
// 1. city from/to IDs ("id")
// 2. snap: blank end touching an asset within 1.5 m, or a pond within 10 m
// 3. bridge: dead end to nearest asset within 5 m, then 10 m, or pond within 20 m
// A bridge never targets the asset's own upstream (would loop).
import {
  bboxOf,
  dist,
  distanceToPolygons,
  GridIndex,
  nearestOnPolyline,
  type XY,
} from '../geo/geo.ts';
import { ends, isDrain, isDrywell, POINT_KINDS, type Asset, type AssetKind, type AssetLoad } from './assets.ts';
import { FACILITY_TO_TYPES } from './facilities.ts';

export type LinkHow = 'id' | 'id-far' | 'snap' | 'snap-mid' | 'snap-pond' | 'bridge-5m' | 'bridge-10m' | 'bridge-pond';

export const LINK_HOWS: readonly LinkHow[] = ['id', 'id-far', 'snap', 'snap-mid', 'snap-pond', 'bridge-5m', 'bridge-10m', 'bridge-pond'];

export interface Link {
  from: number;
  to: number;
  how: LinkHow;
  /** Gap at the joint, meters (rounded to cm). */
  gapM: number;
  /** Joint partway along downstream line: meters from its start. */
  joinAlongM?: number;
}

/** Walk preference at a junction, lower first. */
export const LINK_RANK: Readonly<Record<LinkHow, number>> = {
  id: 0,
  snap: 1,
  'snap-pond': 1,
  'snap-mid': 2,
  'bridge-5m': 3,
  'bridge-pond': 3,
  'bridge-10m': 4,
  // ID link with ends >30 m apart is likely a typo: last resort only
  'id-far': 5,
};

/** Links resting on a guess over more than a few meters. */
export const WEAK_LINKS: ReadonlySet<LinkHow> = new Set(['bridge-10m', 'bridge-pond']);

export interface NetworkOptions {
  snapM: number;
  snapPondM: number;
  bridgeM: readonly [number, number];
  bridgePondM: number;
  idFarM: number;
}

export const DEFAULT_NETWORK_OPTIONS: NetworkOptions = {
  snapM: 1.5,
  snapPondM: 10,
  bridgeM: [5, 10],
  bridgePondM: 20,
  idFarM: 30,
};

export interface NetworkStats {
  assetsByKind: Record<AssetKind, number>;
  assets: number;
  drains: number;
  links: number;
  linksByHow: Record<LinkHow, number>;
  /** Snapped or bridged, not city-recorded. */
  inferredLinks: number;
  lineEndsBlank: { from: number; to: number };
  lineEndsUnresolved: { from: number; to: number };
  linesFlipped: number;
  /** Bridges refused because they would loop. */
  rejectedLoopBridges: number;
  /** Weakly connected components. */
  components: number;
  /** Cycle groups (strongly connected, size >= 2). */
  loops: number;
  assetsInLoops: number;
  /** No way out. */
  sinks: number;
  skippedNoGeometry: number;
  duplicateIds: number;
}

export interface Network {
  assets: Asset[];
  /** Outgoing links, sorted by walk preference. */
  out: Link[][];
  /** Incoming links. */
  inn: Link[][];
  links: Link[];
  /** Strongly connected groups of size >= 2. */
  loopGroups: number[][];
  stats: NetworkStats;
}

interface Hit {
  d: number;
  k: number;
  along?: number;
}

const byDistance = (a: Hit, b: Hit) => a.d - b.d || a.k - b.k;
const round2 = (x: number) => Math.round(x * 100) / 100;

function distTo(a: Asset, p: XY): number {
  if (a.line) return nearestOnPolyline(p, a.line).d;
  if (a.polygons) return distanceToPolygons(p, a.polygons);
  return dist(a.anchor, p);
}

/** Builds the graph. Lines drawn against the city's from/to flow are reversed in place. */
export function buildNetwork(
  load: AssetLoad,
  outfallPipeIds: ReadonlySet<string>,
  opts: NetworkOptions = DEFAULT_NETWORK_OPTIONS,
): Network {
  const { assets } = load;
  const n = assets.length;
  const out: Link[][] = Array.from({ length: n }, () => []);
  const inn: Link[][] = Array.from({ length: n }, () => []);
  const links: Link[] = [];
  const pairs = new Set<number>();
  const has = (a: number, b: number) => pairs.has(a * n + b);

  const push = (from: number, to: number, how: LinkHow, gapM: number, joinAlongM?: number) => {
    const link: Link = { from, to, how, gapM: round2(gapM) };
    if (joinAlongM !== undefined && joinAlongM > 0) link.joinAlongM = round2(joinAlongM);
    links.push(link);
    out[from].push(link);
    inn[to].push(link);
    pairs.add(from * n + to);
  };
  // city IDs are trusted, even two-way pairs
  const addId = (from: number, to: number, gapM: number, alwaysNear = false) => {
    if (from === to || has(from, to)) return;
    push(from, to, alwaysNear || gapM <= opts.idFarM ? 'id' : 'id-far', gapM);
  };
  // inferred links never duplicate or reverse an existing one
  const addInferred = (from: number, to: number, how: LinkHow, gapM: number, joinAlongM?: number): boolean => {
    if (from === to || has(from, to) || has(to, from)) return false;
    push(from, to, how, gapM, joinAlongM);
    return true;
  };

  const stats = {
    lineEndsBlank: { from: 0, to: 0 },
    lineEndsUnresolved: { from: 0, to: 0 },
    linesFlipped: 0,
    rejectedLoopBridges: 0,
  };

  // 1. city from/to IDs
  const byId = new Map<string, number[]>();
  for (const a of assets) {
    if (!a.id) continue;
    const list = byId.get(a.id);
    if (list) list.push(a.index);
    else byId.set(a.id, [a.index]);
  }
  // repeated ID: use the copy nearest the joint
  const resolve = (id: string, near: XY): number | null => {
    const ks = id ? byId.get(id) : undefined;
    if (!ks) return null;
    let best = ks[0];
    let bestD = distTo(assets[best], near);
    for (const k of ks.slice(1)) {
      const d = distTo(assets[k], near);
      if (d < bestD) [best, bestD] = [k, d];
    }
    return best;
  };

  const lines = assets.filter((a) => a.line);
  const points = assets.filter((a) => POINT_KINDS.has(a.kind));
  const ponds = assets.filter((a) => a.polygons);

  for (const a of lines) {
    let { A, B } = ends(a);
    let fr = resolve(a.fromId, A);
    let to = resolve(a.toId, B);
    // flip the rare line whose IDs say it runs backwards
    let flip = false;
    if (fr !== null && to !== null && fr !== to) {
      const F = assets[fr];
      const T = assets[to];
      flip = distTo(F, B) + distTo(T, A) + 0.5 < distTo(F, A) + distTo(T, B);
    } else if (fr !== null) {
      flip = distTo(assets[fr], B) < 5 && distTo(assets[fr], A) > 5;
    } else if (to !== null) {
      flip = distTo(assets[to], A) < 5 && distTo(assets[to], B) > 5;
    }
    if (flip) {
      a.line!.reverse();
      a.anchor = a.line![0];
      ({ A, B } = ends(a));
      stats.linesFlipped++;
      fr = resolve(a.fromId, A);
      to = resolve(a.toId, B);
    }
    if (fr !== null && fr !== a.index) addId(fr, a.index, distTo(assets[fr], A));
    if (to !== null && to !== a.index) addId(a.index, to, distTo(assets[to], B));
    if (!a.fromId) stats.lineEndsBlank.from++;
    else if (fr === null) stats.lineEndsUnresolved.from++;
    if (!a.toId) stats.lineEndsBlank.to++;
    else if (to === null) stats.lineEndsUnresolved.to++;
  }

  // pond outlines are rough, so ID links count as direct
  const joint = (a: Asset, upstream: boolean): XY => (a.line ? (upstream ? ends(a).B : ends(a).A) : a.anchor);
  for (const p of ponds) {
    const fr = resolve(p.fromId, p.anchor);
    const to = resolve(p.toId, p.anchor);
    if (fr !== null) addId(fr, p.index, distanceToPolygons(joint(assets[fr], true), p.polygons!), true);
    if (to !== null && to !== fr) addId(p.index, to, distanceToPolygons(joint(assets[to], false), p.polygons!), true);
  }

  // spatial indexes (after flips, so line starts are final)
  const pointIdx = new GridIndex<number>(25);
  const startIdx = new GridIndex<number>(25);
  const lineIdx = new GridIndex<number>(25);
  const pondIdx = new GridIndex<number>(50);
  for (const a of points) pointIdx.insertPoint(a.index, a.anchor);
  for (const a of lines) {
    startIdx.insertPoint(a.index, a.line![0]);
    lineIdx.insert(a.index, bboxOf(a.line!));
  }
  for (const a of ponds) pondIdx.insert(a.index, bboxOf(a.polygons!.flat(2)));

  const within = (hits: Hit[], tol: number) => hits.filter((h) => h.d <= tol).sort(byDistance);
  const nearPoints = (p: XY, tol: number) => within(pointIdx.near(p, tol).map((k) => ({ d: dist(assets[k].anchor, p), k })), tol);
  const nearStarts = (p: XY, tol: number) => within(startIdx.near(p, tol).map((k) => ({ d: dist(assets[k].line![0], p), k })), tol);
  const nearLines = (p: XY, tol: number) =>
    within(
      lineIdx.near(p, tol).map((k) => {
        const on = nearestOnPolyline(p, assets[k].line!);
        return { d: on.d, k, along: on.along };
      }),
      tol,
    );
  const nearPonds = (p: XY, tol: number) => within(pondIdx.near(p, tol).map((k) => ({ d: distanceToPolygons(p, assets[k].polygons!), k })), tol);
  const endOf = (k: number) => ends(assets[k]).B;

  // 2. snap blank ends that touch something
  const { snapM, snapPondM } = opts;

  // 2a. line with nothing upstream: starts at the point it touches
  for (const a of lines) {
    if (inn[a.index].length > 0) continue;
    const { A, B } = ends(a);
    for (const h of nearPoints(A, snapM)) {
      if (dist(assets[h.k].anchor, B) > snapM) {
        addInferred(h.k, a.index, 'snap', h.d);
        break;
      }
    }
  }

  // 2b. point with no exit: lines starting on it, else a line passing it, else a pond
  for (const p of points) {
    if (out[p.index].length > 0) continue;
    const P = p.anchor;
    let done = false;
    for (const h of nearStarts(P, snapM)) {
      if (dist(endOf(h.k), P) > snapM && !has(h.k, p.index)) done = addInferred(p.index, h.k, 'snap', h.d) || done;
    }
    if (!done) {
      for (const h of nearLines(P, snapM)) {
        if (!has(h.k, p.index) && dist(endOf(h.k), P) > snapM && addInferred(p.index, h.k, 'snap-mid', h.d, h.along)) {
          done = true;
          break;
        }
      }
    }
    if (!done) {
      const pond = nearPonds(P, snapPondM)[0];
      if (pond) addInferred(p.index, pond.k, 'snap-pond', pond.d);
    }
  }

  // 2c. line with nothing downstream: ends in the pond, point, line start or line it touches
  for (const a of lines) {
    if (out[a.index].length > 0) continue;
    const B = ends(a).B;
    const inside = nearPonds(B, 0);
    if (inside.length) {
      addInferred(a.index, inside[0].k, 'snap-pond', 0);
      continue;
    }
    const pts = nearPoints(B, snapM).filter((h) => !has(h.k, a.index));
    if (pts.length) {
      addInferred(a.index, pts[0].k, 'snap', pts[0].d);
      continue;
    }
    const starts = nearStarts(B, snapM).filter((h) => h.k !== a.index && !has(h.k, a.index));
    if (starts.length) {
      for (const h of starts) addInferred(a.index, h.k, 'snap', h.d);
      continue;
    }
    const pond = nearPonds(B, snapPondM)[0];
    if (pond) {
      addInferred(a.index, pond.k, 'snap-pond', pond.d);
      continue;
    }
    for (const h of nearLines(B, snapM)) {
      if (h.k !== a.index && !has(h.k, a.index) && dist(endOf(h.k), B) > snapM && addInferred(a.index, h.k, 'snap-mid', h.d, h.along)) break;
    }
  }

  // 3. bridge remaining dead ends
  // BFS with a reusable visited stamp: can water already get from src to target?
  const stamp = new Int32Array(n);
  const queue = new Int32Array(n);
  let generation = 0;
  const reaches = (src: number, target: number): boolean => {
    if (src === target) return true;
    generation++;
    let head = 0;
    let tail = 0;
    queue[tail++] = src;
    stamp[src] = generation;
    while (head < tail) {
      for (const l of out[queue[head++]]) {
        if (l.to === target) return true;
        if (stamp[l.to] !== generation) {
          stamp[l.to] = generation;
          queue[tail++] = l.to;
        }
      }
    }
    return false;
  };

  // outfalls, perforated pipes and pipes into a recorded facility are real endings
  const explained = (a: Asset) => outfallPipeIds.has(a.id) || a.perforated || FACILITY_TO_TYPES.has(a.toType);

  // 3a. pipe or ditch stopping within 20 m of a pond drains into it
  for (const a of lines) {
    if (out[a.index].length > 0 || explained(a)) continue;
    for (const h of nearPonds(ends(a).B, opts.bridgePondM)) {
      if (reaches(h.k, a.index)) {
        stats.rejectedLoopBridges++;
        continue;
      }
      addInferred(a.index, h.k, 'bridge-pond', h.d);
      break;
    }
  }

  // 3b. dead ends join nearest point, line start or line within 5 m, then 10 m
  // a drywell with no outlet isn't a gap (it soaks in by design)
  const isDead = (a: Asset) =>
    out[a.index].length === 0 && a.kind !== 'pond' && a.kind !== 'vault' && !isDrywell(a) && !(a.line && explained(a));
  const candidates = (src: number, P: XY, tol: number): Hit[] => {
    const hits: Hit[] = [];
    for (const h of nearPoints(P, tol)) if (h.k !== src && !has(h.k, src)) hits.push(h);
    for (const h of nearStarts(P, tol)) if (h.k !== src && !has(h.k, src) && dist(endOf(h.k), P) > tol) hits.push(h);
    // mid-line joins are less likely than joints at a start
    for (const h of nearLines(P, tol)) {
      if (h.k !== src && !has(h.k, src) && dist(endOf(h.k), P) > tol) hits.push({ ...h, d: h.d + 0.01 });
    }
    return hits.sort(byDistance);
  };
  const tiers: [number, LinkHow][] = [
    [opts.bridgeM[0], 'bridge-5m'],
    [opts.bridgeM[1], 'bridge-10m'],
  ];
  for (const [tol, how] of tiers) {
    for (const a of assets.filter(isDead)) {
      const P = a.line ? ends(a).B : a.anchor;
      for (const h of candidates(a.index, P, tol)) {
        if (reaches(h.k, a.index)) {
          stats.rejectedLoopBridges++;
          continue;
        }
        if (addInferred(a.index, h.k, how, h.d, h.along)) break;
      }
    }
  }

  // 4. walk preference: trusted link, then non-pond, then wider pipe
  for (const list of out) {
    list.sort(
      (x, y) =>
        LINK_RANK[x.how] - LINK_RANK[y.how] ||
        Number(assets[x.to].kind === 'pond') - Number(assets[y.to].kind === 'pond') ||
        assets[y.to].width - assets[x.to].width ||
        (assets[x.to].key < assets[y.to].key ? -1 : assets[x.to].key > assets[y.to].key ? 1 : 0),
    );
  }

  const loopGroups = stronglyConnectedGroups(out);
  const linksByHow = Object.fromEntries(LINK_HOWS.map((h) => [h, 0])) as Record<LinkHow, number>;
  for (const l of links) linksByHow[l.how]++;
  const assetsByKind = {} as Record<AssetKind, number>;
  for (const a of assets) assetsByKind[a.kind] = (assetsByKind[a.kind] ?? 0) + 1;

  return {
    assets,
    out,
    inn,
    links,
    loopGroups,
    stats: {
      assetsByKind,
      assets: n,
      drains: assets.filter(isDrain).length,
      links: links.length,
      linksByHow,
      inferredLinks: links.length - linksByHow.id - linksByHow['id-far'],
      ...stats,
      components: countComponents(n, links),
      loops: loopGroups.length,
      assetsInLoops: loopGroups.reduce((s, g) => s + g.length, 0),
      sinks: out.filter((l) => l.length === 0).length,
      skippedNoGeometry: load.skippedNoGeometry.length,
      duplicateIds: Object.keys(load.duplicateIds).length,
    },
  };
}

/** Weakly connected components (union-find). */
function countComponents(n: number, links: readonly Link[]): number {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const l of links) parent[find(l.from)] = find(l.to);
  let roots = 0;
  for (let i = 0; i < n; i++) if (find(i) === i) roots++;
  return roots;
}

/** Tarjan, iterative to avoid stack overflow. */
function stronglyConnectedGroups(out: readonly Link[][]): number[][] {
  const n = out.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const groups: number[][] = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const calls: [node: number, next: number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (calls.length) {
      const top = calls[calls.length - 1];
      const v = top[0];
      if (top[1] < out[v].length) {
        const w = out[v][top[1]++].to;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          calls.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        calls.pop();
        if (calls.length) {
          const u = calls[calls.length - 1][0];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          const group: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            group.push(w);
          } while (w !== v);
          if (group.length > 1) groups.push(group.sort((a, b) => a - b));
        }
      }
    }
  }
  return groups;
}
