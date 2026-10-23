// Salmon streams on the road ahead: which crossing comes next, when to name it, and which ones the car drove over.
// Pure: positions in the region map's meters (proj.ts), times in ms.
import type { LngLat, XY } from '../geo/geo.ts';
import { segDist } from './build.ts';
import { oneFish } from './species.ts';
import type { Crossing, Stream, Tile } from './tiles.ts';
import { fromRegion, toRegion } from './proj.ts';

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
  /** no traced-pipe salmon reminder with a crossing this close ahead on this road, m */
  pipeQuietM: 300,
  /** a road beside a stream: within this of its stretch, m */
  besideM: 25,
  /** the beside banner after this much of it, m */
  besideShowM: 200,
  /** a beside stretch survives gaps this long, m */
  besideGapM: 80,
};

/** what the coach reads: salmon tiles over a region box (tiles.ts SalmonData) */
export interface SalmonSource { near(x0: number, y0: number, x1: number, y1: number): Tile[] }

/** a crossing the car drove over */
export interface Passed { id: string; name: string; sp: number; t: number; at: XY; stream?: Stream }

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

/** "Beside Clover Creek. Coho stream." "Beside a coho stream." */
export function besideWords(s: { sp: number; name: string }): string {
  const fish = oneFish(s.sp);
  if (!s.name) return fish ? `Beside a ${fish.toLowerCase()} stream.` : 'Beside a salmon stream.';
  return `Beside ${s.name}. ${fish ?? 'Salmon'} stream.`;
}

/** The stream a road beside one runs along, at p (within r of its stretch). */
export function besideAt(tiles: readonly Tile[], p: XY, r = SALMON.besideM): Stream | null {
  for (const t of tiles) for (const l of t.beside) {
    if (!l.stream || l.box[0] > p[0] + r || l.box[2] < p[0] - r || l.box[1] > p[1] + r || l.box[3] < p[1] - r) continue;
    for (let k = 1; k < l.pts.length; k++) if (segDist(p, l.pts[k - 1], l.pts[k]) <= r) return l.stream;
  }
  return null;
}

export class SalmonWatch {
  private prev: XY | null = null;
  /** the stream the road runs beside now: how far along it, and how far since last beside it, m */
  private side: { stream: Stream; m: number; gap: number } | null = null;
  private readonly shownBeside = new Set<unknown>();
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
      this.passed.push({ id: c.id, name: c.stream.name, sp: c.sp, t, at: c.at, stream: c.stream });
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

  /** The nearest crossing ahead on this road within m meters (said or not), else null. */
  within(src: SalmonSource, car: XY, heading: number | null, m = SALMON.pipeQuietM): Crossing | null {
    if (heading == null) return null;
    let best: Crossing | null = null, bd = m;
    for (const c of this.around(src, car)) {
      if (this.gone.has(c.id)) continue;
      const d = secondsAhead(car, heading, 1, c);
      if (d != null && d <= bd) [best, bd] = [c, d];
    }
    return best;
  }

  /** A step from a to b: follows a road beside a stream. */
  beside(src: SalmonSource, a: XY, b: XY): void {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(L > 0) || L >= 300) return;
    const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r = SALMON.besideM;
    const s = besideAt(src.near(mid[0] - r, mid[1] - r, mid[0] + r, mid[1] + r), mid);
    const run = this.side;
    if (s && run && sameStream(run.stream, s)) [run.m, run.gap] = [run.m + L, 0];
    else if (s) this.side = { stream: s, m: L, gap: 0 };
    else if (run && (run.gap += L) > SALMON.besideGapM) this.side = null;
  }

  /** The stream to show the beside banner for now, once per stream per drive; null if none. Marks it shown. */
  takeBeside(now: number): Stream | null {
    const run = this.side;
    if (!run || run.gap || run.m < SALMON.besideShowM) return null;
    const s = run.stream, key = s.name || s;
    // not right after the voice named it
    if (this.shownBeside.has(key) || (s.name && now - (this.named.get(s.name) ?? -Infinity) < 60_000)) return null;
    this.shownBeside.add(key);
    return s;
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
    this.side = null;
    this.shownBeside.clear();
  }
}

function sameStream(a: Stream, b: Stream): boolean {
  return a === b || (!!a.name && a.name === b.name);
}

/** a drive's salmon streams: crossings driven, how many had no hard brake within 150 m, the creeks by name, miles on roads beside one */
/** streams: one per stream crossed (named ones by name), where it was first crossed */
export interface SalmonTrip { crossed: number; gentle: number; names: string[]; sp: number; besideMi: number; streams: { name: string; at: LngLat }[] }

/** Sums up crossings against where the hard brakes were (region meters). */
export function salmonTrip(passed: readonly Passed[], brakes: readonly XY[], besideMi = 0): SalmonTrip {
  let gentle = 0, sp = 0;
  const names: string[] = [], seen = new Set<unknown>(), streams: SalmonTrip['streams'] = [];
  for (const p of passed) {
    sp |= p.sp;
    if (!brakes.some((b) => Math.hypot(b[0] - p.at[0], b[1] - p.at[1]) <= SALMON.brakeM)) gentle++;
    if (p.name && !names.includes(p.name)) names.push(p.name);
    const who = p.name || p.stream || p.id;
    if (!seen.has(who)) { seen.add(who); streams.push({ name: p.name, at: fromRegion(p.at) }); }
  }
  return { crossed: passed.length, gentle, names, sp, besideMi, streams };
}
