// What the share card says, from the report's facts only. Salmon first, then tire dust.
// No route, no times, no names of people, and no street or creek from near where the drive started or ended (usually home).
import type { DriveReport } from '../../drive/analyze.ts';
import { nearEnds } from '../../drive/summary.ts';
import { answered, salmonWater } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { gramsText } from '../../drive/dust.ts';
import { count, pctVs } from '../screens/drive-words.ts';

/** One salmon stream the drive crossed, where the road crossed it. */
export interface Crossing {
  name: string;
  at: LngLat;
}

export interface ShareFacts {
  /** "I crossed 3 salmon streams and shed 21% less tire dust than a typical drive." */
  headline: string;
  /** salmon streams crossed; null when crossings weren't checked */
  streams: number | null;
  /** named streams crossed away from the drive's ends, up to 3 */
  creeks: string[];
  /** tire dust vs a typical drive, in %: below 0 is less */
  dustPct: number;
  /** "0.34 g" */
  grams: string;
  hard: number;
  fast: number;
  /** where rain from the hard brakes goes */
  salmon: string;
  date: string;
}

type Brake = DriveReport['brakes'][number];
/** away from the start and end; with no ends known, none are */
const away = (p: LngLat | null | undefined, ends: readonly LngLat[]) => ends.length > 0 && !!p && !nearEnds(p, ends);

/** tire dust vs typical driving on the same route, as the report says it */
export const dustPct = (r: Pick<DriveReport, 'dust'>): number => pctVs(r.dust.mg.typical, r.dust.typicalMg.typical);

/** the report's own grams ("0.34 g") */
export { gramsText };

/** Salmon first; the dust part only when it was clearly less than typical. */
export function headline(streams: number | null, pct: number): string {
  const fish = streams ? `crossed ${count(streams, 'salmon stream')}` : '';
  const dust = pct <= -5 ? `shed ${-pct}% less tire dust than a typical drive` : '';
  if (fish && dust) return `I ${fish} and ${dust}.`;
  if (fish || dust) return `I ${fish || dust}.`;
  return "I'm tracking my tire dust for the salmon.";
}

export function salmonLine(r: DriveReport, ends: readonly LngLat[] = []): string {
  const fish = r.brakes.filter((b: Brake) => b.salmon);
  if (fish.length) {
    const ws = fish.map((b) => salmonWater(b.receiving));
    const where = fish.every((b) => away(b.lngLat, ends)) && ws.every((w) => w.coho === ws[0].coho) && ws[0].kind !== 'unnamed' ? ws[0].coho : 'a salmon stream';
    return `Rain from ${count(fish.length, 'hard brake')} runs ${ws.every((w) => w.kind === 'fennel' || w.kind === 'named') ? 'to' : 'toward'} ${where}.`;
  }
  const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length;
  if (n && !hard) return n === 1 ? 'The only stop was gentle.' : `All ${n} stops were gentle.`;
  if (r.brakes.length && r.brakes.every((b) => answered(b.cls))) return "These hard brakes don't drain to a salmon stream.";
  return 'Gentle stops shed less tire dust.';
}

export const dateLine = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** crossings: the salmon streams the drive crossed, if they were checked */
export function shareFacts(r: DriveReport, at: number, ends: readonly LngLat[] = [], crossings: readonly Crossing[] | null = null): ShareFacts {
  const pct = dustPct(r), streams = crossings ? crossings.length : null;
  const creeks = [...new Set((crossings ?? []).filter((c) => c.name && away(c.at, ends)).map((c) => c.name))].slice(0, 3);
  return {
    headline: headline(streams, pct), streams, creeks, dustPct: pct, grams: gramsText(r.dust.mg.typical),
    hard: r.brakes.length, fast: r.events.filter((e) => e.kind === 'start').length, salmon: salmonLine(r, ends), date: dateLine(at),
  };
}
