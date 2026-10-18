// Shared bits for the engine tests: hand-made drives, a tiny road file, a phone-sized localStorage.
import { deltas } from '../scripts/build-majorroads.ts';
import type { RoadsFile } from '../src/drive/limits.ts';
import type { Fix } from '../src/drive/types.ts';
import { localProjection, type XY } from '../src/geo/geo.ts';

export const P = localProjection();
export const MPH = 0.44704;
export const MI = 1609.344;
export const T0 = Date.UTC(2026, 9, 17, 17, 0, 0);

/**
 * Fixes once a second from [seconds, m/s²] phases, starting at v0 m/s.
 * Drives in a straight line from start toward heading (degrees from north). noise(k) adds to reading k's speed.
 */
export function drive(v0: number, phases: [number, number][], o: { heading?: number; start?: XY; t0?: number; noise?: (k: number) => number; every?: number } = {}): Fix[] {
  const rad = ((o.heading ?? 0) * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
  const [x0, y0] = o.start ?? [0, 0], every = o.every ?? 1;
  const fixes: Fix[] = [];
  let v = v0, s = 0, k = 0, steps = 0;
  const push = () => {
    const [lon, lat] = P.toLngLat([x0 + ux * s, y0 + uy * s]);
    fixes.push({ t: (o.t0 ?? T0) + k * 1000, lat, lon, speed: Math.max(0, v + (o.noise?.(fixes.length) ?? 0)), accuracy: 5 });
  };
  push();
  for (const [secs, a] of phases) {
    // 10 ms steps keep speed and position exact
    for (let j = 0; j < Math.round(secs * 100); j++) {
      const dv = Math.max(-v, a * 0.01);
      s += (v + dv / 2) * 0.01;
      v += dv;
      if (++steps % 100 === 0) {
        k++;
        if (k % every === 0) push();
      }
    }
  }
  return fixes;
}

/** a road file with straight roads: [mph, from, to] in meters around the origin (class 4 = primary) */
export function roads(list: [number, XY, XY][]): RoadsFile {
  return {
    roads: list.map(([, a, b], i) => [4, `SR ${i + 1}`, `Road ${i + 1}`, ...deltas([P.toLngLat(a), P.toLngLat(b)])]),
    mph: list.map(([m]) => m),
  };
}

/** localStorage with a size limit, like a phone's */
export class SmallStorage {
  private readonly m = new Map<string, string>();
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void {
    let used = 0;
    for (const [key, val] of this.m) if (key !== k) used += key.length + val.length;
    if (used + k.length + v.length > this.limit) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string): void { this.m.delete(k); }
}

export const useStorage = (limit: number): SmallStorage => {
  const s = new SmallStorage(limit);
  (globalThis as { localStorage?: unknown }).localStorage = s;
  return s;
};

/** a drain lookup with no drains */
export const NO_DRAINS = { nearestDrain: () => null, path: () => { throw new Error('no drains'); } };
