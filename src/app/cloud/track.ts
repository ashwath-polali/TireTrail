// A drive's route for the backup: its GPS fixes, minus everything within 300 m of where it started or ended, packed into one string. Pure.
import { MIN_DRIVE } from '../../drive/enough.ts';
import { nearEnds } from '../../drive/summary.ts';
import type { Fix } from '../../drive/types.ts';
import type { LngLat } from '../../geo/geo.ts';

/** Firestore keeps at most 1 MiB in a document (firebase.google.com/docs/firestore/quotas); this leaves room */
export const TRACK_MAX = 900_000;

/** users/{uid}/tracks/{at} */
export interface TrackDoc {
  v: 1;
  at: number;
  /** fixes kept */
  n: number;
  /** every fix as 5 base-36 numbers: ms since the last, lat and lon in millionths since the last, speed in cm/s, accuracy in m ('' = unknown) */
  f: string;
  updated: number;
}

const good = (f: Fix) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && !(typeof f.accuracy === 'number' && f.accuracy > 50);

function meters(a: Fix, b: Fix): number {
  const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6_371_000;
}

/** The fixes that may leave the phone: none within HOME_M of the first or last good fix (the same ends the summary trims). */
export function trimTrack(fixes: readonly Fix[]): Fix[] {
  const ok = fixes.filter(good);
  if (!ok.length) return [];
  const ends: LngLat[] = [[ok[0].lon, ok[0].lat], [ok[ok.length - 1].lon, ok[ok.length - 1].lat]];
  return fixes.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && !nearEnds([f.lon, f.lat], ends));
}

/** Still a drive the report can read: MIN_DRIVE's miles, minutes and fixes. */
export function enoughTrack(fixes: readonly Fix[]): boolean {
  if (fixes.length < MIN_DRIVE.fixes || fixes[fixes.length - 1].t - fixes[0].t < MIN_DRIVE.s * 1000) return false;
  let m = 0;
  for (let i = 1; i < fixes.length; i++) m += meters(fixes[i - 1], fixes[i]);
  return m / 1609.344 >= MIN_DRIVE.mi;
}

const b36 = (x: number) => x.toString(36);
const opt = (x: number | null | undefined, k: number) => (x == null || !Number.isFinite(x) ? '' : b36(Math.round(x * k)));

function packFixes(fixes: readonly Fix[], at: number): string {
  const out: string[] = [];
  let t = at, la = 0, lo = 0;
  for (const f of fixes) {
    const ft = Math.round(f.t), fla = Math.round(f.lat * 1e6), flo = Math.round(f.lon * 1e6);
    out.push(b36(ft - t), b36(fla - la), b36(flo - lo), opt(f.speed, 100), opt(f.accuracy, 1));
    [t, la, lo] = [ft, fla, flo];
  }
  return out.join(',');
}

/** The backup's copy of one drive's route, or null when too little is left after the trim. Thinned evenly if it would pass TRACK_MAX. */
export function trackDoc(at: number, fixes: readonly Fix[], updated: number): TrackDoc | null {
  const kept = trimTrack(fixes);
  if (!enoughTrack(kept)) return null;
  for (let step = 1; ; step++) {
    const some = step === 1 ? kept : kept.filter((_, i) => i % step === 0 || i === kept.length - 1);
    const f = packFixes(some, at);
    if (f.length <= TRACK_MAX) return { v: 1, at, n: some.length, f, updated };
    if (some.length <= MIN_DRIVE.fixes) return null;
  }
}

/** The fixes a stored route holds, or null if it's damaged. */
export function readTrack(x: unknown, at: number): Fix[] | null {
  const d = x as Partial<TrackDoc> | null;
  if (!d || typeof d !== 'object' || d.v !== 1 || d.at !== at || typeof d.f !== 'string') return null;
  const p = d.f.split(',');
  if (p.length % 5 || !p.length) return null;
  const out: Fix[] = [];
  let t = at, la = 0, lo = 0;
  const int = (s: string) => (/^-?[0-9a-z]+$/.test(s) ? parseInt(s, 36) : NaN);
  for (let i = 0; i < p.length; i += 5) {
    t += int(p[i]); la += int(p[i + 1]); lo += int(p[i + 2]);
    if (!Number.isFinite(t + la + lo)) return null;
    const sp = p[i + 3] ? int(p[i + 3]) : null, ac = p[i + 4] ? int(p[i + 4]) : null;
    out.push({ t, lat: la / 1e6, lon: lo / 1e6, speed: sp == null || !Number.isFinite(sp) ? null : sp / 100, accuracy: ac == null || !Number.isFinite(ac) ? null : ac });
  }
  return out;
}

