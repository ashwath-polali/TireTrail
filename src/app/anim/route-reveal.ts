// The report's reveal on the map: the route draws itself, each salmon creek gets its marker as the route gets there,
// and the one fix pins last. Pure, so tests run it; map-leaps.ts draws the coho and dust puffs.
import type { XY } from '../../geo/geo.ts';

/** the route draws itself in this long, ms */
export const DRAW_MS = 2000;
/** a coho's leap, or a dust puff */
export const LEAP_MS = 900;
/** the fix pins this long after the route is in */
export const PIN_AFTER = 200;

export interface RouteLine { i: number; path: XY[] }

const len = (a: XY, b: XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The drive's stretches in drive order, cut to any share of the whole route. */
export class RouteDraw {
  readonly total: number;
  private readonly parts: { i: number; path: XY[]; from: number; acc: number[] }[] = [];

  constructor(lines: readonly RouteLine[]) {
    let at = 0;
    for (const l of [...lines].sort((a, b) => a.i - b.i)) {
      const acc = [0];
      for (let k = 1; k < l.path.length; k++) acc.push(acc[k - 1] + len(l.path[k - 1], l.path[k]));
      this.parts.push({ i: l.i, path: l.path, from: at, acc });
      at += acc[acc.length - 1];
    }
    this.total = at;
  }

  /** Each stretch's path cut to the first k (0 to 1) of the route, by stretch index; ones not reached yet are left out. */
  cut(k: number): Map<number, XY[]> {
    const out = new Map<number, XY[]>(), upto = Math.max(0, Math.min(1, k)) * this.total;
    for (const p of this.parts) {
      const L = p.acc[p.acc.length - 1];
      if (k >= 1 || p.from + L <= upto) { out.set(p.i, p.path); continue; }
      if (p.from >= upto || p.path.length < 2) continue;
      const d = upto - p.from, path: XY[] = [p.path[0]];
      for (let q = 1; q < p.path.length; q++) {
        if (p.acc[q] <= d) { path.push(p.path[q]); if (p.acc[q] === d) break; continue; }
        const a = p.path[q - 1], b = p.path[q], t = (d - p.acc[q - 1]) / (p.acc[q] - p.acc[q - 1] || 1);
        path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      out.set(p.i, path);
    }
    return out;
  }

  /** How far along the route (0 to 1) it passes closest to pt. */
  reach(pt: XY): number {
    if (!this.total) return 1;
    let best = Infinity, at = 1;
    for (const p of this.parts) for (let q = 1; q < p.path.length; q++) {
      const a = p.path[q - 1], b = p.path[q], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2)) : 0;
      const d = Math.hypot(a[0] + dx * t - pt[0], a[1] + dy * t - pt[1]);
      if (d < best) [best, at] = [d, (p.from + p.acc[q - 1] + t * (p.acc[q] - p.acc[q - 1])) / this.total];
    }
    return at;
  }
}

export interface MapPlan {
  /** when each creek's leap (or puff) starts, ms */
  creeks: number[];
  /** when each other pin shows */
  pins: number[];
  /** when the fix pins */
  fix: number;
  end: number;
}

/** When things show, from how far along the route each creek and pin is (0 to 1). */
export function mapPlan(creeks: readonly number[], pins: readonly number[]): MapPlan {
  const at = (k: number) => Math.round(Math.max(0, Math.min(1, k)) * DRAW_MS);
  const c = creeks.map(at), fix = DRAW_MS + PIN_AFTER;
  return { creeks: c, pins: pins.map(at), fix, end: Math.max(fix + 400, ...c.map((t) => t + LEAP_MS)) };
}

/** A coho's leap at u (0 to 1): its offset from the creek, css px (up is negative). */
export function leapAt(u: number, rise = 30, run = 28): XY {
  const k = Math.max(0, Math.min(1, u));
  return [Math.round((k - 0.5) * run) || 0, Math.round(-Math.sin(Math.PI * k) * rise) || 0];
}
