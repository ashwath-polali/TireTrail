// The live coach: one GPS fix in, at most one cue out. Pure and deterministic; the clock is the fix time unless one is passed.
// Ahead: a learned hard-brake spot about 10 s ahead, a usual stop 8 to 12 s ahead (to coast), sustained speeding.
// After: every hard brake and fast start is said ("Hard brake."), found exactly as the report finds them (liverate.ts).
// Salmon: about 10 s before a road crosses a salmon stream, its name (src/salmon/watch.ts), once per crossing.
// Never two lines at once: a line waits until the last one is done, and events close together are said together.
import { dist, localProjection, type LngLat, type XY } from '../../geo/geo.ts';
import { BURST_S, HARD_MPS2, VERY_HARD_MPS2 } from '../events.ts';
import { bearing, turnBetween } from '../limits.ts';
import { LiveRates, type LiveMotion, type LiveRate } from '../liverate.ts';
import type { Spot } from '../spots.ts';
import type { Fix } from '../types.ts';
import { toRegion } from '../../salmon/proj.ts';
import { SalmonWatch, salmonWords, type SalmonSource } from '../../salmon/watch.ts';
import { STOP_SPOT_M, type StopSpot } from './stopspots.ts';

const P = localProjection();
const MPH = 0.44704;

export type CueKind = 'spot-ahead' | 'coast' | 'speeding' | 'hard-brake' | 'fast-start' | 'salmon-ahead';

export interface Cue {
  kind: CueKind;
  /** short words to speak */
  say: string;
  tone: 'soft' | 'alert';
  /** higher wins when two are due at once */
  priority: number;
  /** ms, when it was given */
  at: number;
  /** the spot, stop spot or road it is about, '' for events */
  ref: string;
  /** hard-brake and fast-start cues: the events it says (indexes into LiveCoach.events) */
  events?: number[];
}

/** a hard brake or fast start, found live */
export interface LiveEvent {
  kind: 'brake' | 'start';
  /** ms, the first reading over the line */
  t: number;
  /** ms, the strongest reading */
  peakT: number;
  /** mph gained or lost in one second, at the strongest */
  mphPerS: number;
  veryHard: boolean;
  /** the motion sensor checked it */
  sensor: boolean;
  /** index of the cue that said it, -1 if none */
  cue: number;
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
  /** the phone's motion sensor (motion.ts MotionTrack), for steadier hard brakes */
  motion?: LiveMotion | null;
  /** salmon stream crossings (src/salmon/tiles.ts SalmonData); without them no salmon lines */
  salmon?: SalmonSource | null;
}

export const PRIORITY: Record<CueKind, number> = { 'spot-ahead': 5, 'hard-brake': 4, 'fast-start': 4, coast: 3, 'salmon-ahead': 2, speeding: 1 };

export const LIVE = {
  /** no ahead or speeding cue within this long of the last one, ms */
  quietMs: 20_000,
  /** a pause after any line before the next, ms */
  gapMs: 1000,
  /** nothing ahead is said below this, m/s (15 mph) */
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
  /** a salmon line waits this long after a spot, stop or speeding line, ms */
  salmonQuietMs: 8000,
};

const WORDS: Record<'spot-ahead' | 'coast', string> = { 'spot-ahead': 'Hard-brake spot ahead. Ease off.', coast: 'Stop ahead. Coast.' };

/** "Limit 45. Easing off saves gas." Only says gas above 50 mph, where money.ts counts it. */
export function speedingWords(limitMph: number, mph: number): string {
  return mph > 50 ? `Limit ${limitMph}. Easing off saves gas.` : `Limit ${limitMph}. Ease off.`;
}

/** About how long a line takes to say, ms. */
export function sayMs(text: string): number {
  return 500 + 380 * text.split(/\s+/).filter(Boolean).length;
}

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number) => NUM[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Hard brake.", "Two hard brakes.", "Hard brake and a fast start." */
export function eventWords(list: readonly Pick<LiveEvent, 'kind' | 'veryHard'>[]): string {
  const b = list.filter((e) => e.kind === 'brake'), s = list.filter((e) => e.kind === 'start');
  const brakes = b.length === 1 ? (b[0].veryHard ? 'very hard brake' : 'hard brake') : `${num(b.length)} hard brakes`;
  const starts = s.length === 1 ? 'fast start' : `${num(s.length)} fast starts`;
  if (!b.length) return `${cap(starts)}.`;
  if (!s.length) return `${cap(brakes)}.`;
  return `${cap(brakes)} and ${s.length === 1 ? 'a fast start' : starts}.`;
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

export class LiveCoach {
  private spots: readonly Spot[] = [];
  private stopSpots: readonly StopSpot[] = [];
  private limits: LimitLookup | null = null;
  private motion: LiveMotion | null = null;
  private salmonSrc: SalmonSource | null = null;
  /** salmon crossings ahead and driven over */
  readonly salmon = new SalmonWatch();
  /** where each hard brake was found, region meters, for the salmon crossings */
  brakeAt: XY[] = [];
  private prev: Fix | null = null;
  private lastAdvice = -Infinity;
  private busyUntil = -Infinity;
  private readonly warned = new Map<string, XY>();
  private readonly roadSaid = new Map<string, number>();
  private over: { road: string; since: number; last: number } | null = null;
  /** recent positions, for a heading when the phone gives none */
  private trail: { t: number; xy: XY }[] = [];
  private rates: LiveRates;
  private lastHit = { brake: -Infinity, start: -Infinity };
  private open = { brake: -1, start: -1 };
  private pending: number[] = [];
  /** every hard brake and fast start this drive, in order */
  events: LiveEvent[] = [];
  /** every cue given this drive, in order */
  cues: Cue[] = [];

  constructor(input: LiveCoachInput = {}) {
    this.setInput(input);
    this.rates = new LiveRates(this.motion);
  }

  /** New spots or limits mid-drive (say, limits finished loading). */
  setInput(input: LiveCoachInput): void {
    if (input.spots) this.spots = input.spots;
    if (input.stopSpots) this.stopSpots = input.stopSpots;
    if (input.limits !== undefined) this.limits = input.limits;
    if (input.motion !== undefined) this.motion = input.motion;
    if (input.salmon !== undefined) this.salmonSrc = input.salmon;
  }

  /** Forget the drive so far (a new drive). Spots, limits and the motion track stay. */
  reset(): void {
    this.prev = null;
    this.lastAdvice = -Infinity;
    this.busyUntil = -Infinity;
    this.warned.clear();
    this.roadSaid.clear();
    this.over = null;
    this.trail = [];
    this.rates = new LiveRates(this.motion);
    this.lastHit = { brake: -Infinity, start: -Infinity };
    this.open = { brake: -1, start: -1 };
    this.pending = [];
    this.events = [];
    this.cues = [];
    this.salmon.reset();
    this.brakeAt = [];
  }

  /** Nothing is being said or waiting: another line (a creek reminder) may go. */
  quiet(now: number): boolean {
    return now >= this.busyUntil && !this.pending.length;
  }

  /** Something else was said (say, "Voice on."): the next line waits for it. */
  spoke(text: string, now: number): void {
    this.busyUntil = Math.max(this.busyUntil, now + sayMs(text) + LIVE.gapMs);
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
    const src = this.salmonSrc, here = src ? this.salmon.move(src, [fix.lon, fix.lat], fix.t, h) : null;
    const brakes = this.events.length;
    for (const d of this.rates.push(fix)) this.hit(d);
    // a new hard brake: where it was, from the trail at its strongest reading
    for (let k = brakes; k < this.events.length; k++) if (this.events[k].kind === 'brake') this.brakeAt.push(this.where(this.events[k].peakT));
    for (const [id, xy] of this.warned) if (dist(car, xy) > LIVE.rearmM) this.warned.delete(id);

    const sp = this.speeding(fix, v, h, now);
    if (now < this.busyUntil) return null;
    const advise = now - this.lastAdvice >= LIVE.quietMs && v >= LIVE.minSpeakMps && h != null;
    // what's ahead first (it can't wait), then what just happened, then coasting and speeding
    let cue: Omit<Cue, 'priority' | 'at'> | null = null;
    if (advise) {
      const spot = this.nearest(this.spots, car, h, v, LIVE.spotS);
      if (spot) cue = { kind: 'spot-ahead', say: WORDS['spot-ahead'], tone: 'alert', ref: spot.id };
    }
    if (!cue && this.pending.length) {
      const list = this.pending.map((k) => this.events[k]);
      cue = { kind: list[0].kind === 'brake' ? 'hard-brake' : 'fast-start', say: eventWords(list), tone: list.some((e) => e.kind === 'brake') ? 'alert' : 'soft', ref: '', events: [...this.pending] };
      for (const e of list) e.cue = this.cues.length;
      this.pending = [];
    }
    let fish: ReturnType<SalmonWatch['ahead']> = null;
    if (!cue && src && here && now - this.lastAdvice >= LIVE.salmonQuietMs && (fish = this.salmon.ahead(src, here, h, v, now))) {
      cue = { kind: 'salmon-ahead', say: salmonWords(fish), tone: 'soft', ref: fish.id };
    }
    if (!cue && advise && v > LIVE.coastMps) {
      // a stop spot that is also a hard-brake spot gets the spot cue instead
      const stops = this.stopSpots.filter((s) => !this.spots.some((b) => dist(P.toXY(b.lngLat), P.toXY(s.lngLat)) <= STOP_SPOT_M && (b.heading == null || s.heading == null || turnBetween(b.heading, s.heading) <= 45)));
      const stop = this.nearest(stops, car, h!, v, LIVE.coastS);
      if (stop) cue = { kind: 'coast', say: WORDS.coast, tone: 'soft', ref: stop.id };
    }
    if (!cue && advise && sp) cue = sp;
    if (!cue) return null;
    this.busyUntil = now + sayMs(cue.say) + LIVE.gapMs;
    if (cue.kind === 'speeding') {
      this.roadSaid.set(cue.ref, now);
      this.lastAdvice = now;
    } else if (cue.kind === 'salmon-ahead') {
      this.lastAdvice = now;
      if (fish) this.salmon.told(fish, now);
    } else if (cue.kind === 'spot-ahead' || cue.kind === 'coast') {
      this.lastAdvice = now;
      const ref = cue.ref, t = [...this.spots, ...this.stopSpots].find((s) => s.id === ref);
      if (t) this.warned.set(t.id, P.toXY(t.lngLat));
    }
    const out: Cue = { ...cue, priority: PRIORITY[cue.kind], at: now };
    this.cues.push(out);
    return out;
  }

  /** The drive ended: finds the last few events too (too late to say), as the report will. */
  finish(): LiveEvent[] {
    for (const d of this.rates.flush()) this.hit(d);
    this.pending = [];
    return this.events;
  }

  /** Where the car was at time t, region meters (the salmon tiles' coordinates). */
  private where(t: number): XY {
    let best = this.trail[this.trail.length - 1];
    for (const p of this.trail) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return toRegion(P.toLngLat(best.xy));
  }

  // one decided reading: a new event, or a stronger reading of the one going on (within 2 s, as events.ts joins them)
  private hit(d: LiveRate): void {
    for (const kind of ['brake', 'start'] as const) {
      const x = (kind === 'brake' ? -1 : 1) * d.r;
      if (x < HARD_MPS2 || !d.moving) continue;
      if (this.open[kind] < 0 || d.T - this.lastHit[kind] > BURST_S * 1000) {
        this.open[kind] = this.events.push({ kind, t: d.T, peakT: d.T, mphPerS: x / MPH, veryHard: x >= VERY_HARD_MPS2, sensor: d.sensor, cue: -1 }) - 1;
        this.pending.push(this.open[kind]);
      } else {
        const e = this.events[this.open[kind]];
        if (x / MPH > e.mphPerS) [e.mphPerS, e.peakT, e.sensor] = [x / MPH, d.T, d.sensor];
        e.veryHard ||= x >= VERY_HARD_MPS2;
      }
      this.lastHit[kind] = d.T;
    }
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
