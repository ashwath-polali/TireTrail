// Warning levels for the live drive, from the coach's own cues (live.ts): no event here is found any other way.
// NORMAL: the banner and the voice. CAUTION: an amber glow at the screen edge for about 2 s, plus the banner.
// SERIOUS: a short red pulse of the edge, the banner in red, a double chime, and the line cuts through what is being said.
// SERIOUS: a very hard brake (10 mph lost in a second), a hard brake within 300 m of a salmon crossing,
// 10 mph or more over a known limit, a salmon crossing in its warning window approached too fast ("Slow down for Fennel Creek.").
// CAUTION: a hard brake, a fast start, 5 to 9 mph over, a stop or hard-brake spot ahead approached fast.
// Never distracting: one alert at a time, a cooldown per kind, the edge flashes at most once per 15 s, nothing while parked.
import type { XY } from '../../geo/geo.ts';
import type { Cue, CueKind, LiveCoach, LiveEvent } from './live.ts';

const MPH = 0.44704;

export type AlertLevel = 'normal' | 'caution' | 'serious';
export type AlertKind = 'very-hard-brake' | 'brake-near-creek' | 'hard-brake' | 'fast-start' | 'speeding' | 'creek-fast' | 'spot-fast' | 'plain';

export interface Alert {
  level: AlertLevel;
  kind: AlertKind;
  /** the words: said, and the banner's headline */
  line: string;
  /** the banner's second line, '' to keep the cue's own */
  todo: string;
  /** ms */
  at: number;
  /** the screen edge glows (caution) or pulses (serious) */
  flash: boolean;
  /** a double chime first (serious) */
  chime: boolean;
  /** stops a line being said (serious) */
  cut: boolean;
  /** the voice's rank: serious 4, caution 2, normal 1 */
  rank: number;
  /** how long the edge shows, ms */
  edgeMs: number;
  /** the cue it came from */
  cue: CueKind;
}

export const ALERT = {
  /** the edge flashes at most this often, ms */
  flashEveryMs: 15_000,
  /** caution glow and serious pulse, ms */
  glowMs: 2000,
  pulseMs: 600,
  /** an alert holds this long: one of the same or lower level meanwhile shows plain, ms */
  holdMs: 6000,
  /** the same kind is raised again only after this long, ms */
  coolMs: { 'very-hard-brake': 30_000, 'brake-near-creek': 30_000, 'hard-brake': 45_000, 'fast-start': 45_000, speeding: 120_000, 'creek-fast': 30_000, 'spot-fast': 60_000, plain: 0 } as Record<AlertKind, number>,
  /** parked: under this speed (5 mph) for longer than parkedMs */
  movingMps: 5 * MPH,
  parkedMs: 10_000,
  /** a hard brake this close to a salmon crossing, m */
  creekBrakeM: 300,
  /** mph over a known limit: caution, serious */
  overMph: [5, 10] as const,
  /** into a salmon crossing's window faster than this with no known limit, mph (with one: 5 over it) */
  creekSafeMph: 40,
  /** a stop or hard-brake spot ahead approached at this or faster, mph */
  spotFastMph: 35,
};

export const RANK: Record<AlertLevel, number> = { normal: 1, caution: 2, serious: 4 };
const ORDER: Record<AlertLevel, number> = { normal: 0, caution: 1, serious: 2 };

export interface AlertIn {
  /** the cue the coach just gave */
  cue: Pick<Cue, 'kind' | 'say' | 'events'>;
  /** ms */
  now: number;
  /** m/s */
  v: number;
  /** the posted limit here, mph, null when not known */
  limitMph: number | null;
  /** the coach's events, for the cue's indexes */
  events?: readonly Pick<LiveEvent, 'kind' | 'veryHard'>[];
  /** the salmon crossing within 300 m of the cue's hard brake, if any */
  brakeCreek?: string | null;
}

/** The level and words for one cue, before cooldowns: a pure rule. */
export function classify(a: AlertIn): { level: AlertLevel; kind: AlertKind; line: string; todo: string } {
  const { cue, v, limitMph } = a, mph = v / MPH, say = cue.say;
  const plain = { level: 'normal' as const, kind: 'plain' as const, line: say, todo: '' };
  if (cue.kind === 'hard-brake') {
    const evs = (cue.events ?? []).map((k) => a.events?.[k]).filter((e) => !!e);
    if (evs.some((e) => e!.kind === 'brake' && e!.veryHard)) return { level: 'serious', kind: 'very-hard-brake', line: a.brakeCreek ? `Very hard brake near ${a.brakeCreek}.` : say, todo: '' };
    if (a.brakeCreek) return { level: 'serious', kind: 'brake-near-creek', line: `Hard brake near ${a.brakeCreek}.`, todo: 'Ease off sooner here.' };
    return { level: 'caution', kind: 'hard-brake', line: say, todo: '' };
  }
  if (cue.kind === 'fast-start') return { level: 'caution', kind: 'fast-start', line: say, todo: '' };
  if (cue.kind === 'speeding') {
    if (limitMph == null) return plain;
    const over = mph - limitMph;
    if (over >= ALERT.overMph[1]) return { level: 'serious', kind: 'speeding', line: say, todo: '' };
    if (over >= ALERT.overMph[0]) return { level: 'caution', kind: 'speeding', line: say, todo: '' };
    return plain;
  }
  if (cue.kind === 'salmon-ahead') {
    const safe = limitMph != null ? limitMph + ALERT.overMph[0] : ALERT.creekSafeMph;
    if (mph <= safe) return plain;
    // "Fennel Creek ahead. Coho stream." -> "Slow down for Fennel Creek."
    const m = /^(.+?) ahead\.\s*(.*)$/.exec(say), name = m?.[1] ?? '';
    return { level: 'serious', kind: 'creek-fast', line: name && name !== 'Salmon stream' ? `Slow down for ${name}.` : 'Slow down. Salmon stream ahead.', todo: m?.[2] ?? '' };
  }
  if ((cue.kind === 'spot-ahead' || cue.kind === 'coast') && mph >= ALERT.spotFastMph) return { level: 'caution', kind: 'spot-fast', line: say, todo: '' };
  return plain;
}

/** One alert at a time, a cooldown per kind, at most one flash per 15 s, nothing while parked. */
export class Alerts {
  private movedAt = -Infinity;
  private flashAt = -Infinity;
  private held: { level: AlertLevel; until: number } | null = null;
  private readonly last = new Map<AlertKind, number>();
  /** every alert raised this drive (caution and serious), in order */
  log: Alert[] = [];

  /** Each fix: the car's speed, so a parked car gets nothing. */
  fix(now: number, v: number): void {
    if (v >= ALERT.movingMps) this.movedAt = now;
  }

  /** Under 5 mph for the last 10 s. */
  parked(now: number): boolean {
    return now - this.movedAt > ALERT.parkedMs;
  }

  /** The alert for a cue the coach just gave. A plain one (no flash, no chime) when cooling down, held or parked. */
  take(a: AlertIn): Alert {
    const now = a.now, c = classify(a);
    const plain: Alert = { level: 'normal', kind: c.kind, line: c.line, todo: c.todo, at: now, flash: false, chime: false, cut: false, rank: RANK.normal, edgeMs: 0, cue: a.cue.kind };
    if (c.level === 'normal' || this.parked(now)) return plain;
    // the same kind again soon, or one as loud still up: words only
    if (now - (this.last.get(c.kind) ?? -Infinity) < ALERT.coolMs[c.kind]) return plain;
    if (this.held && now < this.held.until && ORDER[this.held.level] >= ORDER[c.level]) return plain;
    this.last.set(c.kind, now);
    const flash = now - this.flashAt >= ALERT.flashEveryMs;
    if (flash) this.flashAt = now;
    const serious = c.level === 'serious';
    this.held = { level: c.level, until: now + ALERT.holdMs };
    const out: Alert = {
      level: c.level, kind: c.kind, line: c.line, todo: c.todo, at: now, flash,
      // the chime goes with the flash, so a second serious line in 15 s is said but not chimed
      chime: serious && flash, cut: serious, rank: RANK[c.level], edgeMs: flash ? (serious ? ALERT.pulseMs : ALERT.glowMs) : 0, cue: a.cue.kind,
    };
    this.log.push(out);
    return out;
  }

  /** A new drive. */
  reset(): void {
    [this.movedAt, this.flashAt, this.held] = [-Infinity, -Infinity, null];
    this.last.clear();
    this.log = [];
  }
}

/** The salmon crossing within 300 m of a hard-brake cue's newest brake: one driven over or the next on this road; null if none. */
export function brakeCreek(coach: Pick<LiveCoach, 'events' | 'brakeAt' | 'salmon' | 'road'>, cue: Pick<Cue, 'kind' | 'events'>, maxM = ALERT.creekBrakeM): string | null {
  if (cue.kind !== 'hard-brake' || !cue.events?.length) return null;
  // brakeAt holds one spot per hard brake, in order
  const k = cue.events[cue.events.length - 1], n = coach.events.slice(0, k + 1).filter((e) => e.kind === 'brake').length - 1;
  const at: XY | undefined = coach.brakeAt[n];
  if (!at) return null;
  const ahead = coach.road().fish;
  const near: { name: string; at: XY }[] = coach.salmon.passed.slice(-3).map((p) => ({ name: p.name, at: p.at }));
  if (ahead) near.push({ name: ahead.c.stream.name, at: ahead.c.at });
  let best: string | null = null, bd = maxM;
  for (const c of near) {
    const d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]);
    if (d <= bd) [best, bd] = [c.name || 'a salmon stream', d];
  }
  return best;
}
