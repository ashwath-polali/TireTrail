// Drives saved on this device only, newest first. Plus the drive being recorded, so a reload can't lose it.
// Full tracks for the last 8 drives; a small summary of up to 100 (for progress and hard-brake spots).
import { countsSummary } from '../../drive/enough.ts';
import { readPath, readSummary, type DriveSummary } from '../../drive/summary.ts';
import type { Fix } from '../../drive/types.ts';

export interface SavedDrive {
  at: number;
  mi: string;
  /** e.g. "4 of 6 stops smooth" */
  smooth: string;
  creek: number;
  fixes: (number | null)[][];
}

const KEY = 'tt-drives';
const SUMS = 'tt-sums';
const REC = 'tt-rec';
/** coarse routes by drive, this phone only (never synced) */
const PATHS = 'tt-paths';
const MAX = 8;
export const MAX_SUMMARIES = 100;

export function savedDrives(): SavedDrive[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedDrive[]).filter((d) => d && typeof d.at === 'number' && Array.isArray(d.fixes)); } catch { return []; }
}

/** Saves a drive (and its summary, when given), dropping the oldest saved tracks if the device is full. False if it still doesn't fit. */
export function saveDrive(d: SavedDrive, sum?: DriveSummary): boolean {
  if (sum) saveSummary({ ...sum, at: d.at });
  const old = savedDrives().filter((s) => s.at !== d.at);
  for (let keep = Math.min(old.length, MAX - 1); keep >= 0; keep--) {
    // a failed write leaves the old list as it was
    try { localStorage.setItem(KEY, JSON.stringify([d, ...old.slice(0, keep)])); return true; } catch { /* full or blocked */ }
  }
  return false;
}

export function forgetDrive(at: number): void {
  try { localStorage.setItem(KEY, JSON.stringify(savedDrives().filter((s) => s.at !== at))); } catch { /* blocked */ }
  try { localStorage.setItem(SUMS, JSON.stringify(allSummaries().filter((s) => s.at !== at).map(({ path: _, ...s }) => s))); } catch { /* blocked */ }
  const p = paths();
  if (delete p[at]) writePaths(p);
}

function paths(): Record<string, number[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(PATHS) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number[]>) : {};
  } catch { return {}; }
}

function writePaths(p: Record<string, number[]>): void {
  try { localStorage.setItem(PATHS, JSON.stringify(p)); } catch { /* full or blocked: routes just skip these drives */ }
}

/** The drives that count, newest first: old ones too short to score are skipped (but kept). */
export function driveSummaries(): DriveSummary[] {
  return allSummaries().filter(countsSummary);
}

/** Every saved summary, newest first, short ones too (for the backup). Damaged ones are skipped. */
export function allSummaries(): DriveSummary[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SUMS) ?? '[]') as unknown;
    const p = paths();
    return (Array.isArray(raw) ? raw : []).flatMap((x) => readSummary(x) ?? []).sort((a, b) => b.at - a.at)
      .map((s) => { const path = readPath(p[s.at]); return path ? { ...s, path } : s; });
  } catch { return []; }
}

/** Adds or replaces one drive's summary, keeping the newest 100. False if it can't be written. */
export function saveSummary(sum: DriveSummary): boolean {
  const list = [sum, ...allSummaries().filter((s) => s.at !== sum.at)].sort((a, b) => b.at - a.at).map(({ path: _, ...s }) => s);
  for (let keep = Math.min(list.length, MAX_SUMMARIES); keep >= 1; keep = keep > 10 ? keep - 10 : keep - 1) {
    try {
      localStorage.setItem(SUMS, JSON.stringify(list.slice(0, keep)));
      // routes only for drives still kept
      const ats = new Set(list.slice(0, keep).map((s) => String(s.at))), p = paths(), next: Record<string, number[]> = {};
      for (const k of Object.keys(p)) if (ats.has(k)) next[k] = p[k];
      const path = readPath(sum.path);
      if (path) next[sum.at] = path;
      writePaths(next);
      return true;
    } catch { /* full or blocked */ }
  }
  return false;
}

/** Saved drives from before summaries (or whose summary was lost). Analyze each and pass it to saveSummary. */
export function unsummarized(): SavedDrive[] {
  const have = new Set(allSummaries().map((s) => s.at));
  return savedDrives().filter((d) => !have.has(d.at));
}

/** Fills in missing summaries with make (which may return null to skip one). Returns how many were added. Never throws. */
export function fillSummaries(make: (fixes: Fix[], d: SavedDrive) => DriveSummary | null): number {
  let n = 0;
  for (const d of unsummarized()) {
    try {
      const sum = make(d.fixes.map(unpack), d);
      if (sum && saveSummary({ ...sum, at: d.at })) n++;
    } catch { /* a broken old drive stays as it is */ }
  }
  return n;
}

// [t, lat, lon, speed, accuracy]
export function pack(f: Fix): (number | null)[] {
  return [f.t, +f.lat.toFixed(6), +f.lon.toFixed(6), f.speed == null ? null : +f.speed.toFixed(2), f.accuracy == null ? null : Math.round(f.accuracy)];
}

export function unpack(a: (number | null)[]): Fix {
  return { t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] };
}

/** Keeps the drive being recorded, packed. */
export function keepRecording(at: number, fixes: (number | null)[][]): void {
  try { localStorage.setItem(REC, JSON.stringify({ at, fixes })); } catch { /* full or blocked */ }
}

/** A recording that never finished (the page closed mid-drive), or null. */
export function lostRecording(): { at: number; fixes: Fix[] } | null {
  try {
    const r = JSON.parse(localStorage.getItem(REC) ?? 'null') as { at: number; fixes: (number | null)[][] } | null;
    return r && typeof r.at === 'number' && Array.isArray(r.fixes) ? { at: r.at, fixes: r.fixes.map(unpack) } : null;
  } catch { return null; }
}

export function dropRecording(): void {
  try { localStorage.removeItem(REC); } catch { /* blocked */ }
}
