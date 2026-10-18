// Words for My drives: the sign-in panel, money leaks and regular trips. No DOM, so tests run it.
import type { Leak, Leaks, Route } from '../../drive/coach/index.ts';
import { DEFAULT_MONEY_OPTIONS } from '../../drive/money.ts';
import { count } from './drive-words.ts';

export const SIGN_IN = {
  value: 'Sign in to keep your progress, learn your hard-brake spots and take them to a new phone.',
  free: 'You can still drive, see each drive and use the map without signing in.',
} as const;

/** One money leak as an insight: what it costs a month, the fix and why. The title names the place, so the fix needn't. */
export function leakWords(l: Leak): { icon: 'gas' | 'tire'; title: string; body: string } {
  const fix = l.kind === 'hard-stops' && l.place ? l.fix.replace(` for ${l.place}`, '') : l.fix;
  return { icon: l.kind === 'speeding' ? 'gas' : 'tire', title: l.line, body: `${fix} ${l.why}` };
}

/** How the monthly figures are made, said as an estimate. */
export const leakNote = (x: Leaks): string => x.note.replace(/^From /, 'Estimates from ');

/** When there are no leaks to show: too little driving, or nothing cost extra. */
export function noLeaks(x: Leaks, minMiles = DEFAULT_MONEY_OPTIONS.minMilesForYear): { title: string; body: string } {
  if (!(x.miles >= minMiles)) return { title: 'Drive a little more to see your money leaks.', body: `After ${minMiles} miles, TireTrail shows what hard stops and speeding cost you each month.` };
  return { title: 'No money leaks right now.', body: 'No hard stops or speeding cost you extra gas or tire wear on your saved drives.' };
}

/** A regular trip: its name, how often and how smooth, and the last two drives day to day, one line each. */
export function tripWords(r: Route, name = r.name): { title: string; sub: string; days: string[] } {
  return { title: name, sub: `${count(r.drives, 'drive')} · average score ${r.avgScore}`, days: splitDays(r.compare) };
}

const partOfDay = (ats: readonly number[]): string => {
  const hs = ats.map((t) => new Date(t).getHours()).sort((a, b) => a - b), hr = hs[Math.floor(hs.length / 2)] ?? 12;
  return hr < 12 ? 'in the morning' : hr < 17 ? 'in the afternoon' : 'in the evening';
};

/** Trip names, told apart by time of day when two share one (the way there and the way back), else numbered. */
export function tripNames(routes: readonly Pick<Route, 'name' | 'ats'>[]): string[] {
  const twice = (n: string, all: string[]) => all.filter((x) => x === n).length > 1;
  const named = routes.map((r) => r.name);
  const timed = named.map((n, i) => (twice(n, named) ? `${n} ${partOfDay(routes[i].ats)}` : n));
  const seen = new Map<string, number>();
  return timed.map((n) => {
    if (!twice(n, timed)) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k > 1 ? `${n} (${k})` : n;
  });
}

/** "Monday: 0 hard brakes. Tuesday: 3, all at 192nd Ave E." to its two sentences. */
export function splitDays(line: string): string[] {
  const m = /^(.+?: [^.]*\.) (.+?: .*)$/.exec(line.trim());
  return m ? [m[1], m[2]] : [line.trim()];
}

export const NO_TRIPS = {
  title: 'No regular trips yet.',
  body: 'Drive the same trip twice, like home to school, and TireTrail compares them day to day.',
} as const;

/** "4 drives and 23 miles so far." */
export function progressSub(drives: number, miles: number): string {
  return `${count(drives, 'drive')} and ${miles < 10 ? miles.toFixed(1) : Math.round(miles)} ${miles === 1 ? 'mile' : 'miles'} so far.`;
}
