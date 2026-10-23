// What a recorded drive keeps beyond its route, for checking it later: when recording paused, what the voice said,
// and the motion sensor's summary. Plus the "Every event" rows and the shared drive file. No DOM, so tests run it.
import type { DriveReport } from './analyze.ts';
import type { CueKind } from './coach/live.ts';
import { packSeconds, unpackSeconds, type MotionLookup, type MotionSecond, type MotionWindow, type PackedSeconds } from './motion.ts';
import { SIGNAL_GAP_MS } from './recorder.ts';
import type { Fix, Gap } from './types.ts';

export type Said = 'said' | 'muted' | 'locked' | 'silent';

export interface CueLog {
  /** ms */
  at: number;
  kind: CueKind | 'creek';
  say: string;
  /** said out loud, muted, the voice wasn't on yet, or the phone can't speak */
  said: Said;
  /** hard-brake and fast-start lines: the events said, by kind and time of their strongest reading */
  ev?: { kind: 'brake' | 'start'; t: number }[];
}

export interface DriveLog {
  v: 1;
  /** the drive's start, as saved in My drives */
  at: number;
  gaps: Gap[];
  cues: CueLog[];
  /** the motion sensor: on, denied, or none on this phone */
  sensor: 'on' | 'denied' | 'none';
  motion: { sec: PackedSeconds; win: MotionWindow[] } | null;
}

export function makeLog(at: number, gaps: readonly Gap[], cues: readonly CueLog[], sensor: DriveLog['sensor'], seconds: readonly MotionSecond[], windows: readonly MotionWindow[]): DriveLog {
  return { v: 1, at, gaps: [...gaps], cues: [...cues], sensor, motion: seconds.length ? { sec: packSeconds(seconds), win: [...windows] } : null };
}

/** A stored log, checked; null if it isn't one. */
export function readLog(x: unknown): DriveLog | null {
  const l = x as DriveLog | null;
  if (!l || typeof l !== 'object' || l.v !== 1 || typeof l.at !== 'number' || !Array.isArray(l.gaps) || !Array.isArray(l.cues)) return null;
  return { ...l, gaps: l.gaps.filter((g) => g && typeof g.from === 'number' && typeof g.to === 'number'), motion: l.motion && Array.isArray(l.motion.sec?.rows) ? l.motion : null };
}

/** The motion seconds a log keeps, for the report. */
export function motionOf(l: DriveLog | null): MotionLookup | null {
  const s = unpackSeconds(l?.motion?.sec);
  return s.length ? { seconds: s } : null;
}

// ---------- gaps ----------

export interface ShownGap extends Gap {
  /** 'unknown' for drives saved before gaps were kept */
  why: Gap['reason'] | 'unknown';
}

/** When recording paused, 10 s or more: from the log, else from holes between the saved readings. */
export function gapsOf(fixes: readonly Fix[], log: DriveLog | null): ShownGap[] {
  const kept = (log?.gaps ?? []).filter((g) => g.to - g.from >= SIGNAL_GAP_MS).map((g) => ({ ...g, why: g.reason }));
  const ts = fixes.map((f) => f.t).filter(Number.isFinite).sort((a, b) => a - b);
  const out: ShownGap[] = [...kept];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] < SIGNAL_GAP_MS) continue;
    // a hole the log already explains
    if (kept.some((g) => g.from <= ts[i] && g.to >= ts[i - 1])) continue;
    out.push({ from: ts[i - 1], to: ts[i], reason: 'signal', why: log ? 'signal' : 'unknown' });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** "4 min", "40 seconds" */
export function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${Math.max(10, Math.round(s / 5) * 5)} seconds` : `${Math.round(s / 60)} min`;
}

/** One line for the report: "Not recorded for 4 min: TireTrail wasn't on screen." '' when nothing paused. */
export function gapLine(gaps: readonly ShownGap[]): string {
  if (!gaps.length) return '';
  const total = gaps.reduce((s, g) => s + (g.to - g.from), 0);
  const by = (w: ShownGap['why']) => gaps.filter((g) => g.why === w).reduce((s, g) => s + (g.to - g.from), 0);
  const why = by('hidden') >= total / 2 ? "TireTrail wasn't on screen" : by('signal') >= total / 2 ? "the phone couldn't find its location" : 'the screen may have locked';
  return `Not recorded for ${spanWords(total)}: ${why}.`;
}

// ---------- every event ----------

export interface EventRow {
  /** ms */
  t: number;
  what: 'Hard brake' | 'Very hard brake' | 'Fast start' | 'Over the limit';
  /** "9.4 mph in a second", "12 mph over 45" */
  strength: string;
  place: string;
  /** what the voice did; null when the drive didn't keep it */
  said: Said | 'not said' | null;
  /** where it happened */
  ll?: [number, number];
}

/**
 * Every hard brake, fast start and stretch over a posted limit, in order, and whether it was said out loud.
 * place: a place name at a point ('' if none).
 */
export function everyEvent(r: DriveReport, log: DriveLog | null, place: (ll: [number, number]) => string): EventRow[] {
  const cues = log?.cues ?? [];
  const saidFor = (kind: 'brake' | 'start', t: number): EventRow['said'] => {
    if (!log) return null;
    const c = cues.find((x) => x.ev?.some((e) => e.kind === kind && Math.abs(e.t - t) <= 2500));
    return c ? c.said : 'not said';
  };
  const rows: EventRow[] = r.events.map((e) => ({
    t: e.t,
    what: e.kind === 'start' ? 'Fast start' : e.veryHard ? 'Very hard brake' : 'Hard brake',
    strength: `${e.mphPerS.toFixed(1)} mph in a second`,
    place: (e.kind === 'brake' ? r.brakes.find((b) => b.t === e.t)?.name : '') || place(e.lngLat),
    said: saidFor(e.kind, e.t),
    ll: [e.lngLat[0], e.lngLat[1]],
  }));
  for (const s of r.speeding.stretches) {
    const c = cues.find((x) => x.kind === 'speeding' && x.at >= s.from - 1000 && x.at <= s.to + 15_000);
    rows.push({
      t: s.from,
      what: 'Over the limit',
      strength: `${Math.max(1, Math.round(s.topMph - s.limitMph))} mph over ${s.limitMph}`,
      place: s.road || (s.path.length ? place(s.path[s.path.length >> 1]) : ''),
      said: log ? (c ? c.said : 'not said') : null,
      ...(s.path.length ? { ll: [s.path[s.path.length >> 1][0], s.path[s.path.length >> 1][1]] as [number, number] } : {}),
    });
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** The said column's words. */
export const SAID_WORDS: Record<NonNullable<EventRow['said']>, string> = {
  said: 'Said out loud',
  muted: 'Voice was off',
  locked: 'Voice not on yet',
  silent: "Phone can't speak",
  'not said': 'Not said',
};

// ---------- the drive file ----------

export interface DriveFileIn {
  report: DriveReport;
  fixes: readonly Fix[];
  log: DriveLog | null;
  at: number;
  build: string;
  device: string;
}

/** Everything about one drive, as a plain object to save as JSON. */
export function driveFile(c: DriveFileIn): Record<string, unknown> {
  const r = c.report, gaps = gapsOf(c.fixes, c.log);
  return {
    app: 'TireTrail',
    file: 'drive data',
    v: 1,
    build: c.build || 'dev',
    exported: new Date().toISOString(),
    device: c.device,
    drive: { at: c.at, start: new Date(c.at).toISOString(), miles: +r.miles.toFixed(2), minutes: +(r.durationS / 60).toFixed(1), score: r.score.score },
    sensor: c.log ? c.log.sensor : 'not kept',
    readings: {
      cols: ['t ms', 'lat', 'lon', 'speed m/s', 'accuracy m', 'heading deg'],
      rows: c.fixes.map((f) => [f.t, f.lat, f.lon, f.speed ?? null, f.accuracy ?? null, f.heading ?? null]),
    },
    gaps: gaps.map((g) => ({ from: g.from, to: g.to, why: g.why })),
    motion: c.log?.motion
      ? {
        perSecond: { t0: c.log.motion.sec.t0, cols: ['s after t0', 'samples', 'mean x', 'mean y', 'mean z', 'peak x', 'peak y', 'peak z', 'peak m/s2', 'turn deg/s', 'handled'], rows: c.log.motion.sec.rows },
        windows: { cols: ['ms after t', 'x', 'y', 'z', 'turn deg/s'], list: c.log.motion.win },
      }
      : null,
    events: r.events.map((e) => ({ t: e.t, kind: e.kind, mphPerS: +e.mphPerS.toFixed(2), veryHard: e.veryHard, sensor: e.sensor, lat: e.lngLat[1], lon: e.lngLat[0] })),
    speeding: r.speeding.stretches.map((s) => ({ from: s.from, to: s.to, limitMph: s.limitMph, topMph: +s.topMph.toFixed(1), road: s.road })),
    cues: c.log?.cues ?? null,
  };
}

/** "tiretrail-drive-2026-10-19-1612.json" */
export function driveFileName(at: number): string {
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  return `tiretrail-drive-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
