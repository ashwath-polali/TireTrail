// Timely lines: rain ahead (NWS) and coho season. Home asks what to show; a drive start asks what to say.
import { cached, HOME_LL, lastForecast, load, markSaid, rainAhead, readSaid, unsaidToday, type Forecast, type RainAhead } from './rain.ts';
import { cohoSeason, inPugetSound, type Season } from './season.ts';
import { rainVoice } from './words.ts';

export type Note = { kind: 'rain'; f: Forecast; r: RainAhead } | { kind: 'season'; season: Season } | null;

type Placed = { at: number; path?: number[]; stopPts?: readonly { lat: number; lon: number }[]; brakes?: readonly { lat: number; lon: number }[] };

/** Where the last drive went, else Pierce County. */
export function areaOf(drives: readonly Placed[]): { lat: number; lon: number } {
  const last = [...drives].sort((a, b) => b.at - a.at)[0];
  const p = last?.path, s = last?.stopPts?.[0] ?? last?.brakes?.[0];
  if (p && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) return { lat: p[1], lon: p[0] };
  if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) return { lat: s.lat, lon: s.lon };
  return HOME_LL;
}

/** One line for home: rain ahead beats the season; the Puget Sound season only for drives there; else nothing. */
export function noteFor(f: Forecast | null, now: number, ll: { lat: number; lon: number } = HOME_LL): Note {
  const r = f ? rainAhead(f, now) : null;
  if (f && r) return { kind: 'rain', f, r };
  const season = inPugetSound(ll) ? cohoSeason(now) : null;
  return season ? { kind: 'season', season } : null;
}

/** Home's line right now from what is kept, and the fresh one once the forecast comes in (null offline). */
export function homeNote(drives: readonly Placed[], now = Date.now()): { now: Note; next: Promise<Note> } {
  const ll = areaOf(drives);
  return { now: noteFor(cached(ll, now), now, ll), next: load(ll, now).then((f) => noteFor(f, Date.now(), ll)) };
}

/** True when rain is in the kept forecast (the home picture rains harder); null when unknown. */
export function rainKnown(drives: readonly Placed[], now = Date.now()): boolean | null {
  const f = cached(areaOf(drives), now);
  return f ? !!rainAhead(f, now) : null;
}

/** The voice line for a drive start: rain ahead, once a day. say returns true once it was spoken. */
export function startCue(say: (line: string) => boolean, now = Date.now(), f = lastForecast(now), said = readSaid()): string | null {
  const r = f ? rainAhead(f, now) : null;
  if (!r || !unsaidToday(now, said)) return null;
  const line = rainVoice(r.when);
  if (!say(line)) return null;
  markSaid(now);
  return line;
}
