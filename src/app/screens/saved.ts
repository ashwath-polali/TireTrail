// Drives saved on this device only, newest first. Plus the drive being recorded, so a reload can't lose it.
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
const REC = 'tt-rec';
const MAX = 8;

export function savedDrives(): SavedDrive[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedDrive[]).filter((d) => d && Array.isArray(d.fixes)); } catch { return []; }
}

/** Saves a drive, dropping the oldest saved ones if the device is full. False if it still doesn't fit. */
export function saveDrive(d: SavedDrive): boolean {
  const old = savedDrives().filter((s) => s.at !== d.at);
  for (let keep = Math.min(old.length, MAX - 1); keep >= 0; keep--) {
    // a failed write leaves the old list as it was
    try { localStorage.setItem(KEY, JSON.stringify([d, ...old.slice(0, keep)])); return true; } catch { /* full or blocked */ }
  }
  return false;
}

export function forgetDrive(at: number): void {
  try { localStorage.setItem(KEY, JSON.stringify(savedDrives().filter((s) => s.at !== at))); } catch { /* blocked */ }
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
