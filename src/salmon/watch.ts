// Salmon streams on the road ahead: which crossing comes next, when to name it, and which ones the car drove over.
// Pure: positions in the region map's meters (proj.ts), times in ms.
import type { LngLat, XY } from '../geo/geo.ts';
import { segDist } from './build.ts';
import { oneFish } from './species.ts';
import type { Crossing, Tile } from './tiles.ts';
import { toRegion } from './proj.ts';

const MPH = 0.44704;

export const SALMON = {
  /** the line goes this many seconds before the crossing: latest, earliest */
  aheadS: [6, 12] as const,
  /** nothing below this, m/s (15 mph) */
  minMps: 15 * MPH,
  /** a creek named this recently isn't named again, ms */
  nameMs: 120_000,
  /** the car went over a crossing: passed this close to it, m */
  passM: 35,
  /** a hard brake this close to a crossing counts against it, m */
  brakeM: 150,
  /** the road at the crossing runs within this many degrees of the car's heading */
  sameWay: 40,
  /** looked for this far ahead, m */
  lookM: 450,
};

/** what the coach reads: salmon tiles over a region box (tiles.ts SalmonData) */
export interface SalmonSource { near(x0: number, y0: number, x1: number, y1: number): Tile[] }

/** a crossing the car drove over */
export interface Passed { id: string; name: string; sp: number; t: number; at: XY }

/** Degrees between a heading and a road's direction (either way along it). */
export function offRoad(heading: number, dir: number): number {
  const d = (((heading - dir) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** Seconds to a crossing ahead on this road, else null. heading: degrees from north. */
export function secondsAhead(car: XY, heading: number, v: number, c: Pick<Crossing, 'at' | 'dir'>): number | null {
  if (!(v > 0) || offRoad(heading, c.dir) > SALMON.sameWay) return null;
  // y grows south in region meters
  const rad = (heading * Math.PI) / 180, ux = Math.sin(rad), uy = -Math.cos(rad);
  const dx = c.at[0] - car[0], dy = c.at[1] - car[1], along = dx * ux + dy * uy, side = Math.abs(dx * uy - dy * ux);
  if (along < 0 || side > Math.max(20, along * 0.2)) return null;
  return along / v;
}

/** "Clover Creek ahead. Coho stream." "Salmon stream ahead." */
export function salmonWords(c: { sp: number; stream: { name: string } }): string {
  const fish = oneFish(c.sp), name = c.stream.name;
  if (!name) return fish ? `${fish} stream ahead.` : 'Salmon stream ahead.';
  return `${name} ahead. ${fish ?? 'Salmon'} stream.`;
}

export class SalmonWatch {
  private prev: XY | null = null;
  private readonly said = new Set<string>();
  private readonly named = new Map<string, number>();
  private readonly gone = new Set<string>();
  /** crossings driven over, in order */
  passed: Passed[] = [];

  /** Crossings near the car from what's loaded. */
  private around(src: SalmonSource, car: XY): Crossing[] {
    const r = SALMON.lookM, out: Crossing[] = [];
    for (const t of src.near(car[0] - r, car[1] - r, car[0] + r, car[1] + r)) for (const c of t.crossings) {
      if (Math.abs(c.at[0] - car[0]) <= r && Math.abs(c.at[1] - car[1]) <= r) out.push(c);
    }
    return out;
  }

  /** A new position: notes any crossing just driven over. heading may be null. */
  move(src: SalmonSource, ll: LngLat, t: number, heading: number | null): XY {
    const car = toRegion(ll), prev = this.prev;
    this.prev = car;
    if (!prev || (prev[0] === car[0] && prev[1] === car[1])) return car;
    for (const c of this.around(src, car)) {
      if (this.gone.has(c.id) || segDist(c.at, prev, car) > SALMON.passM) continue;
      if (heading != null && offRoad(heading, c.dir) > SALMON.sameWay) continue;
      this.gone.add(c.id);
      this.passed.push({ id: c.id, name: c.stream.name, sp: c.sp, t, at: c.at });
    }
    return car;
  }

  /** The crossing to name now, if any: about 10 s ahead, fast enough, not said, its creek not named lately. */
  ahead(src: SalmonSource, car: XY, heading: number | null, v: number, now: number): Crossing | null {
    if (heading == null || v < SALMON.minMps) return null;
    let best: Crossing | null = null, bs = Infinity;
    for (const c of this.around(src, car)) {
      if (this.said.has(c.id) || this.gone.has(c.id)) continue;
      const s = secondsAhead(car, heading, v, c);
      if (s == null || s > SALMON.aheadS[1] || s < SALMON.aheadS[0] || s >= bs) continue;
      if (c.stream.name && now - (this.named.get(c.stream.name) ?? -Infinity) < SALMON.nameMs) continue;
      [best, bs] = [c, s];
    }
    return best;
  }

  /** The line for c was given. */
  told(c: Crossing, now: number): void {
    this.said.add(c.id);
    if (c.stream.name) this.named.set(c.stream.name, now);
  }

  reset(): void {
    this.prev = null;
    this.said.clear();
    this.named.clear();
    this.gone.clear();
    this.passed = [];
  }
}

/** a drive's salmon streams: crossings driven, how many had no hard brake within 150 m, the creeks by name, miles on roads beside one */
export interface SalmonTrip { crossed: number; gentle: number; names: string[]; sp: number; besideMi: number }

/** Sums up crossings against where the hard brakes were (region meters). */
export function salmonTrip(passed: readonly Passed[], brakes: readonly XY[], besideMi = 0): SalmonTrip {
  let gentle = 0, sp = 0;
  const names: string[] = [];
  for (const p of passed) {
    sp |= p.sp;
    if (!brakes.some((b) => Math.hypot(b[0] - p.at[0], b[1] - p.at[1]) <= SALMON.brakeM)) gentle++;
    if (p.name && !names.includes(p.name)) names.push(p.name);
  }
  return { crossed: passed.length, gentle, names, sp, besideMi };
}
