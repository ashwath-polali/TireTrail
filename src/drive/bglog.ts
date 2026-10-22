// The #bgtest log: does GPS or motion keep coming while TireTrail is behind another app? No DOM, so tests run it.

export type BgKind = 'boot' | 'start' | 'stop' | 'fix' | 'motion' | 'hidden' | 'visible' | 'pagehide' | 'pageshow' | 'freeze' | 'resume'
  | 'pip-on' | 'pip-off' | 'audio-on' | 'audio-off' | 'lock' | 'note';

export interface BgEntry {
  /** when it was logged, ms */
  t: number;
  k: BgKind;
  /** a fix's own GPS time, ms */
  g?: number;
  /** motion readings since the last motion entry; a fix's speed, m/s */
  n?: number;
  v?: string;
}

export interface Away {
  from: number;
  /** null: still away */
  to: number | null;
  /** fixes that arrived while away */
  fixes: number;
  /** fixes whose GPS time falls while away, even if they arrived later */
  gpsFixes: number;
  motion: number;
  /** the page was reloaded while away */
  reloaded: boolean;
}

/** most entries kept, oldest dropped first */
export const BG_MAX = 3000;

/** Adds an entry, keeping the log under BG_MAX. */
export function addEntry(log: BgEntry[], e: BgEntry): BgEntry[] {
  log.push(e);
  if (log.length > BG_MAX) log.splice(0, log.length - BG_MAX);
  return log;
}

/** Reads a stored log; anything broken is dropped. */
export function readLog(raw: string | null): BgEntry[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((e): e is BgEntry => !!e && typeof (e as BgEntry).t === 'number' && typeof (e as BgEntry).k === 'string') : [];
  } catch { return []; }
}

/** Each stretch away (hidden until visible again), with what still came in. */
export function aways(log: readonly BgEntry[]): Away[] {
  const out: Away[] = [];
  let cur: Away | null = null;
  for (const e of log) {
    if ((e.k === 'hidden' || e.k === 'pagehide' || e.k === 'freeze') && !cur) {
      cur = { from: e.t, to: null, fixes: 0, gpsFixes: 0, motion: 0, reloaded: false };
      out.push(cur);
    } else if ((e.k === 'visible' || e.k === 'pageshow') && cur) {
      cur.to = e.t;
      cur = null;
    } else if (cur && e.k === 'fix') cur.fixes++;
    else if (cur && e.k === 'motion') cur.motion += e.n ?? 0;
    else if (cur && e.k === 'boot') cur.reloaded = true;
  }
  // by GPS time: a fix that came in late still counts if it was taken while away
  for (const a of out) {
    const end = a.to ?? Infinity;
    a.gpsFixes = log.filter((e) => e.k === 'fix' && e.g !== undefined && e.g > a.from && e.g < end).length;
  }
  return out;
}

/** "2:05" */
export const span = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The answer for the last stretch away, in a few words. */
export function verdict(a: Away | undefined): string {
  if (!a || a.to === null) return 'Switch to another app for a minute, then come back.';
  if (a.to - a.from < 20_000) return 'Stay away longer: 1 minute or more.';
  if (a.fixes > 0 || a.gpsFixes > 0) return 'GPS kept coming while away.';
  if (a.motion > 0) return 'Motion kept coming, GPS did not.';
  return 'Nothing came in while away.';
}
