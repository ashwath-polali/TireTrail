// Words for My drives: the sign-in line, the week's creeks, the spot to watch, trips and More. No DOM, so tests run it.
import type { Route } from '../../drive/coach/index.ts';
import { gramsText } from '../../drive/dust.ts';
import { salmonWater } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count, pctVs, vsWord, waterName } from './drive-words.ts';

/** Signed out, over the sample creeks: one line, then Sign in. */
export function signedOutLine(n: number): string {
  return n ? `${count(n, 'drive')} on this phone. Sign in to see your creeks.` : 'Sign in to see the salmon creeks you cross.';
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

const miWord = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;

/** "4 drives · 23 mi" */
export function progressSub(drives: number, miles: number): string {
  return `${count(drives, 'drive')} · ${miWord(miles)}`;
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

// ---------- your creeks, one week at a time ----------

const monthDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const monday = (t: number, back = 0) => { const n = new Date(t); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - ((n.getDay() + 6) % 7) - back).getTime(); };

/** "This week", "Last week", "Oct 5 to 11", "Sep 28 to Oct 4" */
export function weekLabel(start: number, now = Date.now()): string {
  if (start === monday(now)) return 'This week';
  if (start === monday(now, 7)) return 'Last week';
  const d = new Date(start), end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
  return `${monthDay(start)} to ${end.getMonth() === d.getMonth() ? end.getDate() : monthDay(end.getTime())}`;
}

/** The week's one sentence: "Gentle at 6 of 7 creek crossings." */
export function weekSentence(w: { drives: number; known: number; crossed: number; gentle: number }, thisWeek: boolean): string {
  if (!w.drives) return thisWeek ? 'No drives yet this week.' : 'No drives that week.';
  if (!w.known) return 'Finding the salmon creeks on your drives.';
  if (!w.crossed) return 'No salmon creeks on these drives.';
  if (w.gentle >= w.crossed) return w.crossed === 1 ? 'Gentle at your one creek crossing.' : `Gentle at all ${w.crossed} creek crossings.`;
  return `Gentle at ${w.gentle} of ${w.crossed} creek crossings.`;
}

/** The coho row, for screen readers: "6 gentle, 1 with a hard brake near" */
export function cohoWords(gentle: number, crossed: number): string {
  const rough = crossed - gentle;
  return `${gentle} gentle${rough ? `, ${rough} with a hard brake near` : ''}`;
}

/** "Clover Creek: gentle all 6 times", "Spanaway Creek: gentle 3 of 6 times" */
export function creekLine(c: { name: string; times: number; gentle: number }): string {
  const name = c.name || 'A salmon stream';
  if (c.times === 1) return c.gentle ? `${name}: crossed gently` : `${name}: a hard brake near it`;
  return c.gentle >= c.times ? `${name}: gentle all ${c.times} times` : `${name}: gentle ${c.gentle} of ${c.times} times`;
}

/** The spot to watch, in one line and a short second one. */
export function watchWords(s: { name: string; count: number }): { line: string; sub: string } {
  return { line: s.name ? `Ease off at ${s.name}` : 'Ease off at your spot', sub: `${count(s.count, 'hard brake')} here. The voice warns you ahead.` };
}

/** A drive's name in the strip: the first creek it crossed, else its main road, else its miles. */
export function driveName(d: { mi: number; ways?: readonly string[] }, crossings: readonly { name: string }[] | null): string {
  const creek = crossings?.find((c) => c.name)?.name;
  if (creek) return creek;
  return d.ways?.[0] ?? `${miWord(d.mi)} drive`;
}

export const DUST_WHY = 'Hard brakes and fast starts grind more rubber off.';
export const PPDQ = { line: 'Tire dust carries 6PPDQ, which can kill coho salmon within hours of a storm.', source: 'Tian and others, Science, 2021' } as const;
export const ESTIMATES = 'Gas and tire dust are estimates.';

/** More: the week against the week before, one plain line each. */
export function moreLines(
  w: { hardBrakes: number; fastStarts: number; dust: { mg: number; typMg: number } | null; gas: { text: string; amount: string; habits: string } | null },
  before: { hardBrakes: number; gas: { amount: string } | null } | null,
): { brakes: string; gas: string | null; dust: string | null } {
  const was = (x: string | null) => (before && x ? ` The week before: ${x}.` : '');
  const brakes = `${count(w.hardBrakes, 'hard brake')}${w.fastStarts ? `, ${count(w.fastStarts, 'fast start')}` : ''}.${was(before ? String(before.hardBrakes) : null)}`;
  const gas = w.gas ? `${w.gas.habits} added ${w.gas.text} a gallon.${was(before?.gas?.amount ?? null)}` : null;
  let dust: string | null = null;
  if (w.dust) {
    const pct = pctVs(w.dust.mg, w.dust.typMg);
    dust = `Tire dust: about ${gramsText(w.dust.mg)}. ${Math.abs(pct) < 3 ? 'About typical for the same roads.' : `${vsWord(pct)} than typical on the same roads.`}`;
  }
  return { brakes, gas, dust };
}
