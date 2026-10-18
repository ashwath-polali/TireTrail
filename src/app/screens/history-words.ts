// Words for My drives: the sign-in pitch, money leaks, trips, drive rows and salmon stops. No DOM, so tests run it.
import type { Leak, Leaks, Route } from '../../drive/coach/index.ts';
import { DEFAULT_MONEY_OPTIONS } from '../../drive/money.ts';
import { salmonWater } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count } from './drive-words.ts';

export const SIGN_IN = {
  title: 'Your progress',
  lines: ['See your score, money leaks and hard-brake spots add up.', 'Sign in once and they follow you to a new phone.'],
  privacy: 'Full GPS tracks stay on your phone.',
} as const;

/** "$4/mo", "$5/yr", "under $1/yr". Never cents. */
export function moneyTag(month: number): string {
  if (!(month > 0)) return '$0/mo';
  if (month >= 1) return `$${Math.round(month)}/mo`;
  const year = month * 12;
  return year >= 1 ? `$${Math.round(year)}/yr` : 'under $1/yr';
}

/** "4 dollars a month", for screen readers */
export function moneySaid(month: number): string {
  const t = moneyTag(month);
  const n = t.replace(/^(under )?\$/, '').replace(/\/(mo|yr)$/, '');
  return `${t.startsWith('under') ? 'under ' : 'about '}${n} dollar${n === '1' ? '' : 's'} a ${t.endsWith('mo') ? 'month' : 'year'}`;
}

/** One money leak as a row: amount, what, and the tip behind a tap. The title names the place, so the tip needn't. */
export function leakRow(l: Leak): { icon: 'gas' | 'tire'; amount: string; title: string; tip: string } {
  const fix = l.kind === 'hard-stops' && l.place ? l.fix.replace(` for ${l.place}`, '') : l.fix;
  return { icon: l.kind === 'speeding' ? 'gas' : 'tire', amount: moneyTag(l.month.typical), title: l.title, tip: `${fix} ${l.why}` };
}

/** How the monthly figures are made, said as an estimate. */
export const leakNote = (x: Leaks): string => x.note.replace(/^From /, 'Estimates from ');

/** When there are no leaks to show: too little driving, or nothing cost extra. One line each. */
export function noLeaks(x: Leaks, minMiles = DEFAULT_MONEY_OPTIONS.minMilesForYear): { title: string; body: string } {
  if (!(x.miles >= minMiles)) return { title: 'Not enough driving yet.', body: `After ${minMiles} miles, this shows what costs you money.` };
  return { title: 'No money leaks right now.', body: 'Nothing on your drives cost extra gas or tire wear.' };
}

/** A regular trip: its name, how often, and the last two drives day to day behind a tap. */
export function tripWords(r: Route, name = r.name): { title: string; sub: string; days: string[] } {
  return { title: name, sub: count(r.drives, 'drive'), days: splitDays(r.compare) };
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
  body: 'Drive the same trip twice and it compares them.',
} as const;

export const NO_SPOTS = {
  title: 'No hard-brake spots yet.',
  body: 'Brake hard twice in one place and it warns you there next time.',
} as const;

const miWord = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;

/** "4 drives · 23 mi" */
export function progressSub(drives: number, miles: number): string {
  return `${count(drives, 'drive')} · ${miWord(miles)}`;
}

/** One drive's row: "3.1 mi · 2 hard brakes", or "3.1 mi · smooth". */
export function driveLine(d: { mi: number; hardBrakes: number }): string {
  return `${miWord(d.mi)} · ${d.hardBrakes ? count(d.hardBrakes, 'hard brake') : 'smooth'}`;
}

/** where rain at a point goes: its nearest drain's class and receiving water, or null with none near */
export type DrainAt = (ll: LngLat) => { cls: string; receiving: string } | null;

export interface SalmonStops {
  /** gentle stops whose rain reaches a salmon stream */
  gentle: number;
  /** the salmon stream most of them reach, null if it has no name */
  water: string | null;
}

/** Gentle stops above salmon streams on saved drives, and the stream most of them reach. */
export function salmonStops(sums: readonly { stopPts?: readonly { lat: number; lon: number; hard: boolean }[] }[], drainAt: DrainAt): SalmonStops {
  let gentle = 0;
  const tally = new Map<string, number>();
  for (const s of sums) {
    for (const p of s.stopPts ?? []) {
      if (p.hard) continue;
      const d = drainAt([p.lon, p.lat]);
      if (d?.cls !== 'creek') continue;
      gentle++;
      const w = salmonWater(d.receiving);
      if (w.kind !== 'unnamed') tally.set(w.coho, (tally.get(w.coho) ?? 0) + 1);
    }
  }
  const top = [...tally].sort((a, b) => b[1] - a[1])[0];
  return { gentle, water: top ? top[0] : null };
}

/** The line under the salmon count. */
export function salmonLine(x: SalmonStops): string {
  if (!x.gentle) return 'Gentle stops near salmon streams count here.';
  const one = x.gentle === 1;
  if (x.water) return `${one ? 'It drains' : 'Most drain'} to ${x.water}, home to coho salmon.`;
  return `${one ? 'Its rain reaches a stream' : 'Their rain reaches streams'} with coho salmon.`;
}
