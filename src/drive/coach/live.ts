// The live coach: one GPS fix in, at most one cue out. Pure and deterministic; the clock is the fix time unless one is passed.
// Spoken cues: a learned hard-brake spot about 10 s ahead, a usual stop 8 to 12 s ahead (to coast), sustained speeding.
// Tones: right after a hard brake or a fast start (7 mph or more in one second), worked out the way events.ts does.
import { dist, localProjection, type LngLat, type XY } from '../../geo/geo.ts';
import { HARD_MPS2 } from '../events.ts';
import { bearing, turnBetween } from '../limits.ts';
import type { Spot } from '../spots.ts';
import type { Fix } from '../types.ts';
import { STOP_SPOT_M, type StopSpot } from './stopspots.ts';

const P = localProjection();
const MPH = 0.44704;

export type CueKind = 'spot-ahead' | 'coast' | 'speeding' | 'hard-brake' | 'fast-start';

export interface Cue {
  kind: CueKind;
  /** short words to speak; '' for a tone only */
  say: string;
  tone: 'soft' | 'alert';
  /** higher wins when two are due at once */
  priority: number;
  /** ms, when it was given */
  at: number;
  /** the spot, stop spot or road it is about, '' for events */
  ref: string;
}

/** what the live coach needs from limits.ts SpeedLimits */
export interface LimitLookup {
  at(p: LngLat, heading?: number | null, maxM?: number): { mph: number; ref: string; name: string } | null;
}

export interface LiveCoachInput {
  /** learned hard-brake spots (spots.ts) */
  spots?: readonly Spot[];
  /** learned stop spots (stopspots.ts) */
  stopSpots?: readonly StopSpot[];
  /** posted limits; without them no speeding cues */
  limits?: LimitLookup | null;
}

export const PRIORITY: Record<CueKind, number> = { 'hard-brake': 5, 'spot-ahead': 4, coast: 3, 'fast-start': 2, speeding: 1 };

export const LIVE = {
  /** no spoken cue within this long of the last one, ms */
  quietMs: 20_000,
  /** nothing spoken below this, m/s (15 mph) */
  minSpeakMps: 15 * MPH,
  /** spot-ahead: seconds ahead, latest and earliest */
  spotS: [3, 10.5] as const,
  /** coast: seconds ahead */
  coastS: [8, 12] as const,
  /** coast only above this, m/s (25 mph) */
  coastMps: 25 * MPH,
  /** speeding: mph over the limit, and how long, ms */
  overMph: 5,
  overMs: 10_000,
  /** at most one speeding cue per road this often, ms */
  roadMs: 120_000,
  /** a spot can be said again after the car has been this far from it, m */
  rearmM: 150,
  /** headings must match within this many degrees */
  sameWay: 35,
};

const WORDS: Record<'spot-ahead' | 'coast', string> = { 'spot-ahead': 'Hard-stop spot ahead. Ease off.', coast: 'Stop ahead. Coast.' };

/** "Limit 45. Easing off saves gas." Only says gas above 50 mph, where money.ts counts it. */
export function speedingWords(limitMph: number, mph: number): string {
  return mph > 50 ? `Limit ${limitMph}. Easing off saves gas.` : `Limit ${limitMph}. Ease off.`;
}

interface Target { id: string; lngLat: LngLat; heading: number | null }

/** Seconds until the car reaches p at its speed, if p is in front on the line it is going, else null. */
export function secondsTo(car: XY, heading: number, v: number, t: Target, sameWay = LIVE.sameWay): number | null {
  if (!(v > 0)) return null;
  if (t.heading != null && turnBetween(t.heading, heading) > sameWay) return null;
  const p = P.toXY(t.lngLat), rad = (heading * Math.PI) / 180, ux = Math.sin(rad), uy = Math.cos(rad);
  const dx = p[0] - car[0], dy = p[1] - car[1], along = dx * ux + dy * uy, cross = Math.abs(dx * uy - dy * ux);
  // in front, close to the line the car is on (roads bend a little)
  if (along < 0 || cross > Math.max(25, along * 0.3)) return null;
  return along / v;
}

const med3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

export class LiveCoach {
  private spots: readonly Spot[] = [];
  private stopSpots: readonly StopSpot[] = [];
  private limits: LimitLookup | null = null;
  private prev: Fix | null = null;
  private lastSpoken = -Infinity;
  private readonly warned = new Map<string, XY>();
  private readonly roadSaid = new Map<string, number>();
  private over: { road: string; since: number; last: number } | null = null;
  /** recent readings: s, m/s */
  private hist: { t: number; v: number }[] = [];
  /** recent positions, for a heading when the phone gives none */
  private trail: { t: number; xy: XY }[] = [];
  private lastBurst = { brake: -Infinity, start: -Infinity };

  constructor(input: LiveCoachInput = {}) {
    this.setInput(input);
  }

  /** New spots or limits mid-drive (say, limits finished loading). */
  setInput(input: LiveCoachInput): void {
    if (input.spots) this.spots = input.spots;
    if (input.stopSpots) this.stopSpots = input.stopSpots;
    if (input.limits !== undefined) this.limits = input.limits;
  }

  /** Forget the drive so far (a new drive). Spots and limits stay. */
  reset(): void {
    this.prev = null;
    this.lastSpoken = -Infinity;
    this.warned.clear();
    this.roadSaid.clear();
    this.over = null;
    this.hist = [];
    this.trail = [];
    this.lastBurst = { brake: -Infinity, start: -Infinity };
  }

  /** Call with each new GPS fix. now: ms, defaults to the fix time. Returns the one cue to give now, or null. */
  update(fix: Fix, now: number = fix.t): Cue | null {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.t)) return null;
    const prev = this.prev;
    if (prev && fix.t <= prev.t) return null;
    this.prev = fix;
    const car = P.toXY([fix.lon, fix.lat]);
    this.trail = this.trail.filter((p) => fix.t - p.t <= 15_000);
    this.trail.push({ t: fix.t, xy: car });
    const v = speedOf(fix, prev), h = headingOf(fix, this.trail, v);
    for (const [id, xy] of this.warned) if (dist(car, xy) > LIVE.rearmM) this.warned.delete(id);

    const due: Omit<Cue, 'priority' | 'at'>[] = [];
    const ev = this.event(fix.t, v);
    if (ev) due.push(ev);

    const canSpeak = now - this.lastSpoken >= LIVE.quietMs && v >= LIVE.minSpeakMps && h != null;
    const sp = this.speeding(fix, v, h, now);
    if (canSpeak) {
      const spot = this.nearest(this.spots, car, h, v, LIVE.spotS);
      if (spot) due.push({ kind: 'spot-ahead', say: WORDS['spot-ahead'], tone: 'alert', ref: spot.id });
      if (v > LIVE.coastMps) {
        // a stop spot that is also a hard-brake spot gets the spot cue instead
        const stops = this.stopSpots.filter((s) => !this.spots.some((b) => dist(P.toXY(b.lngLat), P.toXY(s.lngLat)) <= STOP_SPOT_M && (b.heading == null || s.heading == null || turnBetween(b.heading, s.heading) <= 45)));
        const stop = this.nearest(stops, car, h, v, LIVE.coastS);
        if (stop) due.push({ kind: 'coast', say: WORDS.coast, tone: 'soft', ref: stop.id });
      }
      if (sp) due.push(sp);
    }
    if (!due.length) return null;
    const best = due.reduce((a, b) => (PRIORITY[b.kind] > PRIORITY[a.kind] ? b : a));
    if (best.say) {
      this.lastSpoken = now;
      if (best.kind === 'speeding') this.roadSaid.set(best.ref, now);
      else {
        const t = [...this.spots, ...this.stopSpots].find((s) => s.id === best.ref);
        if (t) this.warned.set(t.id, P.toXY(t.lngLat));
      }
    }
    return { ...best, priority: PRIORITY[best.kind], at: now };
  }

  private nearest(list: readonly Target[], car: XY, h: number, v: number, win: readonly [number, number]): Target | null {
    let best: Target | null = null, bs = Infinity;
    for (const t of list) {
      if (this.warned.has(t.id)) continue;
      const s = secondsTo(car, h, v, t);
      if (s != null && s >= win[0] && s <= win[1] && s < bs) [best, bs] = [t, s];
    }
    return best;
  }

  // sustained speeding on one road, at most once per road every 2 minutes
  private speeding(fix: Fix, v: number, h: number | null, now: number): Omit<Cue, 'priority' | 'at'> | null {
    const mph = v / MPH;
    const lim = this.limits && mph >= 15 ? this.limits.at([fix.lon, fix.lat], h) : null;
    if (!lim || mph <= lim.mph + LIVE.overMph) { this.over = null; return null; }
    const road = lim.ref || lim.name || `${lim.mph} mph road`;
    if (!this.over || this.over.road !== road || fix.t - this.over.last > 5000) this.over = { road, since: fix.t, last: fix.t };
    this.over.last = fix.t;
    if (fix.t - this.over.since < LIVE.overMs) return null;
    if (now - (this.roadSaid.get(road) ?? -Infinity) < LIVE.roadMs) return null;
    return { kind: 'speeding', say: speedingWords(lim.mph, mph), tone: 'soft', ref: road };
  }

  // hard brake or fast start, two readings late: speed is median-of-3 filtered, then a 3-reading slope, as events.ts does
  private event(tMs: number, v: number): Omit<Cue, 'priority' | 'at'> | null {
    const t = tMs / 1000, hist = this.hist;
    if (hist.length && t - hist[hist.length - 1].t > 10) hist.length = 0;
    hist.push({ t, v });
    if (hist.length > 6) hist.shift();
    const n = hist.length;
    if (n < 5) return null;
    // filtered speeds at n-4, n-3, n-2
    const f = (i: number) => med3(hist[i - 1].v, hist[i].v, hist[i + 1].v);
    const k = n - 3, ts = [hist[k - 1].t, hist[k].t, hist[k + 1].t], vs = [f(k - 1), f(k), f(k + 1)];
    if (ts[1] - ts[0] > 2.5 || ts[2] - ts[1] > 2.5) return null;
    const mt = (ts[0] + ts[1] + ts[2]) / 3, mv = (vs[0] + vs[1] + vs[2]) / 3;
    let num = 0, den = 0;
    for (let j = 0; j < 3; j++) [num, den] = [num + (ts[j] - mt) * (vs[j] - mv), den + (ts[j] - mt) ** 2];
    const r = den ? num / den : 0;
    if (Math.abs(r) > 10 || Math.max(vs[0], vs[2]) < 3) return null;
    const kind = r <= -HARD_MPS2 ? 'brake' : r >= HARD_MPS2 ? 'start' : null;
    if (!kind) return null;
    const fresh = ts[1] - this.lastBurst[kind] > 2;
    this.lastBurst[kind] = ts[1];
    if (!fresh) return null;
    return kind === 'brake' ? { kind: 'hard-brake', say: '', tone: 'alert', ref: '' } : { kind: 'fast-start', say: '', tone: 'soft', ref: '' };
  }
}

function speedOf(f: Fix, prev: Fix | null): number {
  if (typeof f.speed === 'number' && Number.isFinite(f.speed) && f.speed >= 0) return f.speed;
  if (!prev || f.t <= prev.t) return 0;
  return dist(P.toXY([prev.lon, prev.lat]), P.toXY([f.lon, f.lat])) / ((f.t - prev.t) / 1000);
}

// the phone's heading, else from the last position 20 m or more back
function headingOf(f: Fix, trail: readonly { xy: XY }[], v: number): number | null {
  if (typeof f.heading === 'number' && Number.isFinite(f.heading) && v >= 2) return ((f.heading % 360) + 360) % 360;
  const b = trail[trail.length - 1].xy;
  for (let k = trail.length - 2; k >= 0; k--) if (dist(trail[k].xy, b) >= 20) return bearing(trail[k].xy, b);
  return null;
}

/** Every cue a drive would have given, by running the live coach over its fixes (for a replay or a sample run). */
export function cuesFor(fixes: readonly Fix[], input: LiveCoachInput = {}): Cue[] {
  const coach = new LiveCoach(input), out: Cue[] = [];
  for (const f of [...fixes].sort((a, b) => a.t - b.t)) {
    const c = coach.update(f);
    if (c) out.push(c);
  }
  return out;
}
