// synthetic drives on real streets, for drive analysis tests
import { dist, GridIndex, localProjection, pointAlong, polylineLength, slicePolyline, type XY } from '../src/geo/geo.ts';
import type { Fix } from '../src/drive/types.ts';
import { readGeoJSON } from '../scripts/lib/inputs.ts';

const P = localProjection();

/** route of targetM meters, preferring straight */
export function bonneyLakeRoute(targetM = 5000): XY[] {
  const lines: XY[][] = readGeoJSON('derived/roads_coho_bonneylake.geojson').features.map((f) => {
    const g = f.geometry as { coordinates: number[][] };
    return g.coordinates.map((c) => P.toXY([c[0], c[1]]));
  });
  // pieces share end points; merge ends within 2 m
  const nodes: XY[] = [];
  const index = new GridIndex<number>(10);
  const nodeOf = (p: XY) => {
    for (const i of index.near(p, 2)) if (dist(nodes[i], p) <= 2) return i;
    nodes.push(p);
    index.insertPoint(nodes.length - 1, p);
    return nodes.length - 1;
  };
  const edges = lines.map((line, i) => ({ i, a: nodeOf(line[0]), b: nodeOf(line[line.length - 1]), line, len: polylineLength(line) }));
  const at = new Map<number, number[]>();
  for (const e of edges) for (const n of [e.a, e.b]) at.set(n, [...(at.get(n) ?? []), e.i]);

  const heading = (a: XY, b: XY) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const turn = (h1: number, h2: number) => Math.abs(((h2 - h1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  for (const start of [...edges].sort((x, y) => y.len - x.len || x.i - y.i)) {
    let route = [...start.line];
    let node = start.b;
    const used = new Set([start.i]);
    for (;;) {
      if (polylineLength(route) >= targetM) return slicePolyline(route, 0, targetM);
      const h = heading(route[route.length - 2], route[route.length - 1]);
      const options = (at.get(node) ?? [])
        .filter((i) => !used.has(i))
        .map((i) => {
          const e = edges[i];
          const line = e.a === node ? e.line : [...e.line].reverse();
          return { e, line, turn: turn(h, heading(line[0], line[1])) };
        })
        .filter((o) => o.turn < (2 * Math.PI) / 3)
        .sort((x, y) => x.turn - y.turn || x.e.i - y.e.i);
      if (!options.length) break;
      const next = options[0];
      used.add(next.e.i);
      route = [...route, ...next.line.slice(1)];
      node = next.e.a === node ? next.e.b : next.e.a;
    }
  }
  throw new Error(`no ${targetM} m route found`);
}

export interface PlannedStop {
  s: number;
  decel: number;
  hard: boolean;
  xy: XY;
}

export interface SimOptions {
  cruiseMps?: number;
  accel?: number;
  dwellS?: number;
  posSigmaM?: number;
  /** white: independent per second. correlated: drifting, 30 s constant */
  noise?: 'white' | 'correlated';
  speedSigma?: number;
  withSpeed?: boolean;
  seed?: number;
  t0?: number;
}

/** mulberry32 PRNG and Box-Muller gaussians */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

interface Phase {
  t0: number;
  t1: number;
  s0: number;
  v0: number;
  a: number;
}

export function simulateDrive(route: XY[], plan: { at: number; decel: number }[], o: SimOptions = {}): { fixes: Fix[]; stops: PlannedStop[]; lengthM: number } {
  const V = o.cruiseMps ?? 13.4;
  const acc = o.accel ?? 1.5;
  const dwell = o.dwellS ?? 8;
  const L = polylineLength(route);
  const stops: PlannedStop[] = plan.map((p) => ({ s: p.at * L, decel: p.decel, hard: p.decel >= 2, xy: pointAlong(route, p.at * L) }));

  // phases: pull away, then per stop cruise, brake, wait, pull away; cruise to end
  const phases: Phase[] = [];
  let t = 0;
  let s = 0;
  const push = (dur: number, v0: number, a: number) => {
    phases.push({ t0: t, t1: t + dur, s0: s, v0, a });
    s += v0 * dur + 0.5 * a * dur * dur;
    t += dur;
  };
  const pullAway = () => push(V / acc, 0, acc);
  pullAway();
  for (const st of stops) {
    const brakeAt = st.s - (V * V) / (2 * st.decel);
    if (brakeAt < s) throw new Error('planned stops are too close together');
    push((brakeAt - s) / V, V, 0);
    push(V / st.decel, V, -st.decel);
    s = st.s; // kill float drift
    push(dwell, 0, 0);
    pullAway();
  }
  if (L > s) push((L - s) / V, V, 0);

  const gauss = rng(o.seed ?? 1);
  const sigma = o.posSigmaM ?? 4;
  const rho = Math.exp(-1 / 30);
  let ex = gauss() * sigma;
  let ey = gauss() * sigma;
  const t0 = o.t0 ?? Date.UTC(2026, 9, 17, 17, 0, 0);
  const fixes: Fix[] = [];
  for (let k = 0; k <= Math.floor(t); k++) {
    const ph = phases.find((p) => k <= p.t1 + 1e-9) ?? phases[phases.length - 1];
    const dt = Math.min(k, ph.t1) - ph.t0;
    const v = Math.max(0, ph.v0 + ph.a * dt);
    const pos = pointAlong(route, ph.s0 + ph.v0 * dt + 0.5 * ph.a * dt * dt);
    if ((o.noise ?? 'white') === 'white') {
      ex = gauss() * sigma;
      ey = gauss() * sigma;
    } else {
      ex = rho * ex + Math.sqrt(1 - rho * rho) * sigma * gauss();
      ey = rho * ey + Math.sqrt(1 - rho * rho) * sigma * gauss();
    }
    const [lon, lat] = P.toLngLat([pos[0] + ex, pos[1] + ey]);
    const fix: Fix = { t: t0 + k * 1000, lat, lon, accuracy: 5 };
    if (o.withSpeed ?? true) fix.speed = Math.max(0, v + gauss() * (o.speedSigma ?? 0.3));
    fixes.push(fix);
  }
  return { fixes, stops, lengthM: L };
}

/** 3 hard (3 m/s²) and 3 gentle (1 m/s²) stops, alternating */
export const MIXED_PLAN = [1, 2, 3, 4, 5, 6].map((k) => ({ at: k / 7, decel: k % 2 ? 3 : 1 }));
