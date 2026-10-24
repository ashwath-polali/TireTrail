// Which way lines with no direction of their own run, from the network they sit in: each connected piece drains
// to its outfalls (or, with none, to its lowest loose end) along the route with the least climb (USGS 3DEP).
// Lines whose direction is known let water through first -> last only. Used by black-diamond.ts.
import { NodeIndex, approxM, type LonLat } from '../bellevue.ts';
import type { Ground } from './downhill.ts';

export interface NetLine {
  coords: readonly LonLat[];
  /** direction known: water runs first -> last only */
  fixed?: boolean;
}

/** ends this close to a structure or another end are one node */
const SNAP_M = 1.5;
/** route meters that one meter of climb costs */
const CLIMB_M = 50;

export interface NetResult {
  /** per line: 1 = water runs as drawn, -1 = against the drawing, 0 = no route uses it (always 0 for fixed lines) */
  says: Int8Array;
  pieces: number;
  /** pieces with an outfall; the rest drain to their lowest loose end */
  withOutfall: number;
}

/** `points` are structures line ends join (catch basins, outfalls); `exits` are where water leaves the pipes. */
export function networkSays(lines: readonly NetLine[], points: readonly LonLat[], exits: readonly LonLat[], ground: Ground, origin: LonLat): NetResult {
  const idx = new NodeIndex(origin);
  const at: LonLat[] = [];
  const node = (p: LonLat): number => {
    const near = idx.nearest(p, SNAP_M);
    if (near) return Number(near.ref.key);
    idx.add(String(at.length), p);
    at.push(p);
    return at.length - 1;
  };
  for (const p of points) node(p);
  const isExit = new Set(exits.map(node));
  const ends = lines.map((l) => [node(l.coords[0]), node(l.coords[l.coords.length - 1])]);
  const adj: number[][] = at.map(() => []);
  ends.forEach(([a, b], i) => {
    if (a === b) return;
    adj[a].push(i);
    adj[b].push(i);
  });
  // pieces
  const up = at.map((_, i) => i);
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  for (const [a, b] of ends) up[root(a)] = root(b);
  const z = at.map((p) => ground.at(p));
  const seeds = new Set<number>();
  const has = new Set<number>();
  for (const n of isExit) if (adj[n].length) {
    seeds.add(n);
    has.add(root(n));
  }
  const lowest = new Map<number, number>();
  for (let n = 0; n < at.length; n++) {
    const r = root(n);
    if (adj[n].length !== 1 || has.has(r) || !Number.isFinite(z[n])) continue;
    const b = lowest.get(r);
    if (b === undefined || z[n] < z[b]) lowest.set(r, n);
  }
  for (const n of lowest.values()) seeds.add(n);
  const len = lines.map((l) => l.coords.slice(1).reduce((s, p, i) => s + approxM(l.coords[i], p), 0));
  // least-cost routes to the seeds, searched upstream from them
  const cost = new Float64Array(at.length).fill(Infinity);
  const next = new Int32Array(at.length).fill(-1);
  // min-heap of [cost when pushed, node]
  const heap: [number, number][] = [];
  const push = (c: number, n: number) => {
    heap.push([c, n]);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const n of seeds) {
    cost[n] = 0;
    push(0, n);
  }
  while (heap.length) {
    const [c0, n] = pop();
    if (c0 > cost[n]) continue;
    for (const li of adj[n]) {
      const [a, b] = ends[li];
      const m = a === n ? b : a;
      // water would run m -> n; a fixed line only lets it run first -> last
      if (lines[li].fixed && b !== n) continue;
      const climb = Math.max(0, z[n] - z[m]) || 0;
      const c = c0 + len[li] + CLIMB_M * climb;
      if (c < cost[m]) {
        cost[m] = c;
        next[m] = li;
        push(c, m);
      }
    }
  }
  const says = new Int8Array(lines.length);
  ends.forEach(([a, b], i) => {
    if (lines[i].fixed || a === b) return;
    if (next[a] === i && next[b] !== i) says[i] = 1;
    else if (next[b] === i && next[a] !== i) says[i] = -1;
  });
  return { says, pieces: new Set(ends.map(([a]) => root(a))).size, withOutfall: has.size };
}
