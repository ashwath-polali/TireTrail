// Drives saved on this device only, newest first.
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

export function savedDrives(): SavedDrive[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedDrive[]).filter((d) => d && Array.isArray(d.fixes)); } catch { return []; }
}

export function saveDrive(d: SavedDrive): void {
  const list = savedDrives().filter((s) => s.at !== d.at);
  list.unshift(d);
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8))); } catch { /* full or blocked */ }
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
