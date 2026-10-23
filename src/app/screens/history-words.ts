// Words for My drives: the sign-in pitch, your spots, trips, drive rows and salmon stops. No DOM, so tests run it.
import type { Route } from '../../drive/coach/index.ts';
import { salmonWater } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count, pctVs, waterName } from './drive-words.ts';

export const SIGN_IN = {
  title: 'Your progress',
  lines: ['Your salmon streams and tire dust, week by week.', 'Sign in once and they follow you to a new phone.'],
  privacy: 'Routes leave out the first and last 300 m.',
} as const;

/** Signed out with drives here: how many, and what signing in does. */
export function savedHere(n: number): { title: string; line: string } {
  return { title: `${count(n, 'drive')} on this phone`, line: n === 1 ? 'Sign in to see it and keep it on a new phone.' : 'Sign in to see them and keep them on a new phone.' };
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
  title: 'No spots yet.',
  body: 'Brake hard twice in one place and it warns you there next time.',
} as const;

const miWord = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;

/** "4 drives · 23 mi" */
export function progressSub(drives: number, miles: number): string {
  return `${count(drives, 'drive')} · ${miWord(miles)}`;
}

/** One drive's row: "3.1 mi · 2 salmon streams · 2 hard brakes", or "3.1 mi · smooth". */
export function driveLine(d: { mi: number; hardBrakes: number; streams?: number }): string {
  const fish = d.streams ? ` · ${count(d.streams, 'salmon stream')}` : '';
  return `${miWord(d.mi)}${fish} · ${d.hardBrakes ? count(d.hardBrakes, 'hard brake') : 'smooth'}`;
}

/** where rain at a point goes: its nearest drain's class and receiving water, null with none near. local: on Bonney Lake's own map */
export type DrainAt = (ll: LngLat) => { cls: string; receiving: string; local?: boolean } | null;

export interface SalmonStops {
  /** gentle stops whose rain reaches a salmon stream */
  gentle: number;
  /** the salmon stream most of them reach, null if it has no name */
  water: string | null;
  /** that stream is on Bonney Lake's map, where coho spawn downstream; else the state records coho there */
  local: boolean;
}

/** Gentle stops where rain flows to salmon streams on saved drives, and the stream most of them reach. */
export function salmonStops(sums: readonly { stopPts?: readonly { lat: number; lon: number; hard: boolean }[] }[], drainAt: DrainAt): SalmonStops {
  let gentle = 0;
  const tally = new Map<string, { water: string; local: boolean; n: number }>();
  for (const s of sums) {
    for (const p of s.stopPts ?? []) {
      if (p.hard) continue;
      const d = drainAt([p.lon, p.lat]);
      if (d?.cls !== 'creek') continue;
      gentle++;
      const w = salmonWater(d.receiving), local = d.local ?? true;
      if (w.kind === 'unnamed') continue;
      // Bonney Lake's streams all lead to Fennel Creek; county streams go by their own names
      const water = local ? w.coho : waterName(d.receiving), key = `${local}|${water}`;
      const t = tally.get(key) ?? { water, local, n: 0 };
      t.n++;
      tally.set(key, t);
    }
  }
  const top = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  return { gentle, water: top ? top.water : null, local: top ? top.local : true };
}

/** The line under the salmon count, in the report's words: coho spawn downstream of Bonney Lake's streams. */
export function salmonLine(x: SalmonStops): string {
  if (!x.gentle) return 'Gentle stops near salmon streams count here.';
  const one = x.gentle === 1;
  if (x.water) return `${one ? 'That rain drains' : 'Most of that rain drains'} to ${x.water}. ${x.local ? 'Coho salmon spawn downstream.' : 'The state records coho salmon there.'}`;
  return `${one ? 'Its rain reaches a salmon stream' : 'Their rain reaches salmon streams'}.`;
}

// ---------- tire dust, this week ----------

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** the week's goal: this much under typical, whole percent */
export const WEEK_GOAL = 10;

export interface DustWeek {
  /** tire dust this week and typical driving on the same routes, mg */
  mg: number;
  typMg: number;
  drives: number;
  /** whole percent vs typical: -12 is 12% less */
  pct: number;
  /** the gentlest and roughest drive this week (2 drives or more) */
  best: { at: number; pct: number } | null;
  worst: { at: number; pct: number } | null;
}

/** The last 7 days of drives that kept their tire dust, or null with none. */
export function dustWeek(sums: readonly { at: number; dustMg?: number; typMg?: number }[], now = Date.now()): DustWeek | null {
  const wk = sums.filter((s) => s.at > now - WEEK_MS && s.at <= now && typeof s.dustMg === 'number' && typeof s.typMg === 'number' && s.typMg > 0);
  if (!wk.length) return null;
  const mg = wk.reduce((t, s) => t + s.dustMg!, 0), typMg = wk.reduce((t, s) => t + s.typMg!, 0);
  const each = wk.map((s) => ({ at: s.at, pct: pctVs(s.dustMg!, s.typMg!) })).sort((a, b) => a.pct - b.pct || b.at - a.at);
  const two = each.length >= 2 && each[0].pct !== each[each.length - 1].pct;
  return { mg, typMg, drives: wk.length, pct: pctVs(mg, typMg), best: two ? each[0] : null, worst: two ? each[each.length - 1] : null };
}

/** "Goal met", or the goal: "Goal: 10% less" */
export function goalWord(pct: number, goal = WEEK_GOAL): { text: string; met: boolean } {
  return pct <= -goal ? { text: 'Goal met', met: true } : { text: `Goal: ${goal}% less`, met: false };
}

// ---------- salmon streams and the trend ----------

export interface StreamsWeek {
  /** crossings over salmon streams in the last 7 days */
  n: number;
  /** drives in the last 7 days, and how many of them have their crossings counted */
  drives: number;
  known: number;
}

/** Salmon stream crossings in the last 7 days (the same days as dustWeek). */
export function streamsWeek(sums: readonly { at: number; streams?: number }[], now = Date.now()): StreamsWeek {
  const wk = sums.filter((s) => s.at > now - WEEK_MS && s.at <= now), known = wk.filter((s) => typeof s.streams === 'number');
  return { n: known.reduce((t, s) => t + s.streams!, 0), drives: wk.length, known: known.length };
}

/** "salmon streams crossed", "salmon stream crossed" */
export const streamsWord = (n: number): string => (n === 1 ? 'salmon stream crossed' : 'salmon streams crossed');

/** Tire dust vs typical on the last drives that kept it, oldest first, whole percent. */
export function dustTrend(sums: readonly { at: number; dustMg?: number; typMg?: number }[], most = 12): number[] {
  return sums.filter((s) => typeof s.dustMg === 'number' && typeof s.typMg === 'number' && s.typMg > 0)
    .sort((a, b) => b.at - a.at).slice(0, most).reverse().map((s) => pctVs(s.dustMg!, s.typMg!));
}
