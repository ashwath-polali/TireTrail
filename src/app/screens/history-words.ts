// Words for My drives: the sign-in line, the week's creeks, the spot to watch, trips and More. No DOM, so tests run it.
import type { Route } from '../../drive/coach/index.ts';
import { gramsText } from '../../drive/dust.ts';
import { salmonWater } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count, gasWho, pctVs, vsWord, waterName } from './drive-words.ts';

/** Signed out: one line, then Sign in. */
export function signedOutLine(n: number): string {
  return n ? `${count(n, 'drive')} on this phone. Sign in to see them on the map.` : 'Sign in to see your drives on the map.';
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

/** More's rain line, plainly: "You stopped gently 5 times on streets that drain to North Fork Clover Creek." */
export function salmonLine(x: SalmonStops): string {
  if (!x.gentle) return 'Gentle stops near salmon streams count here.';
  const times = x.gentle === 1 ? 'once' : `${x.gentle} times`;
  return `You stopped gently ${times} on streets that drain to ${x.water ?? 'a salmon creek'}.`;
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

/** "Clover Creek: gentle all 6 times", "Spanaway Creek: gentle 3 of 6 times" */
export function creekLine(c: { name: string; times: number; gentle: number }): string {
  const name = c.name || 'A salmon stream';
  if (c.times === 1) return c.gentle ? `${name}: crossed gently` : `${name}: a hard brake near it`;
  return c.gentle >= c.times ? `${name}: gentle all ${c.times} times` : `${name}: gentle ${c.gentle} of ${c.times} times`;
}

/** The spot to watch: what to do next time, then why it is yours. */
export function watchWords(s: { name: string; count: number }): { line: string; sub: string } {
  const times = s.count === 1 ? 'once' : `${s.count} times`;
  return { line: s.name ? `Next time, ease off at ${s.name}.` : 'Next time, ease off at your hard-brake spot.', sub: `You braked hard there ${times}. The voice warns you before you get there.` };
}

/** A drive's name in the strip: the first creek it crossed, else its main road, else its miles. */
export function driveName(d: { mi: number; ways?: readonly string[] }, crossings: readonly { name: string }[] | null): string {
  const creek = crossings?.find((c) => c.name)?.name;
  if (creek) return creek;
  return d.ways?.[0] ?? `${miWord(d.mi)} drive`;
}

export const DUST_WHY = 'Hard brakes and fast starts grind more rubber off.';
export const PPDQ = { line: 'Tire dust carries 6PPDQ, which can kill coho salmon within hours of a storm.', source: 'Tian and others, Science, 2021', href: 'https://doi.org/10.1126/science.abd6951' } as const;
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

/**
 * The week beyond salmon, in one line: hard brakes when they went down, else the gas they cost, else none at all.
 * Null with nothing true and useful to say.
 */
export function weekMore(w: { drives: number; hardBrakes: number; gas: { text: string; hard: boolean; speed: boolean } | null }, before: { drives: number; hardBrakes: number } | null): string | null {
  if (!w.drives) return null;
  if (before?.drives && before.hardBrakes > w.hardBrakes) return `Hard brakes: ${w.hardBrakes} this week, down from ${before.hardBrakes}.`;
  if (w.gas) return `This week, ${w.gas.text} of each gallon went to ${gasWho(w.gas)}.`;
  return w.hardBrakes ? null : 'No hard brakes this week.';
}

// ---------- the home for your drives ----------

/** "This week", "Last week", else "That week": the start of the hero's line. */
const weekWord = (start: number, now: number) => { const l = weekLabel(start, now); return l === 'This week' || l === 'Last week' ? l : 'That week'; };

type WeekCount = { drives: number; known: number; crossed: number; gentle: number };

/** The week's crossings, counted as times, never as creeks: "gentle all 9 times you crossed a salmon creek". Null without crossings. */
export function weekGist(w: WeekCount): string | null {
  const n = w.crossed, g = w.gentle;
  if (!w.drives || !w.known || !n) return null;
  if (n === 1) return g ? 'you crossed a salmon creek once, gently' : 'a hard brake near the one salmon creek you crossed';
  return g >= n ? `gentle all ${n} times you crossed a salmon creek` : `gentle ${g} of ${n} times you crossed a salmon creek`;
}

/** The hero's one line: "This week: gentle 8 of 9 times you crossed a salmon creek." */
export function heroLine(w: WeekCount, start: number, now = Date.now()): string {
  const thisWeek = start === monday(now);
  if (!w.drives) return thisWeek ? 'No drives yet this week.' : 'No drives that week.';
  if (!w.known) return 'Finding the salmon creeks on your drives.';
  const pre = weekWord(start, now), gist = weekGist(w);
  return gist ? `${pre}: ${gist}.` : `${pre}: no salmon creeks on your drives.`;
}

/** The share card's headline: the gist on its own. */
export function shareHead(w: WeekCount): string {
  const gist = weekGist(w);
  return gist ? `${gist.charAt(0).toUpperCase()}${gist.slice(1)}.` : 'No salmon creeks this week.';
}

/** Under the hero: what a coho in the scene means. */
export const COHO_KEY = 'Each coho is one gentle crossing.';

/** The change since the week before, only when it went up: "2 more than last week." */
export function changeLine(gentle: number, before: number | null, start: number, now = Date.now()): string | null {
  if (before == null || gentle <= before) return null;
  return `${gentle - before} more than ${start === monday(now) ? 'last week' : 'the week before'}.`;
}

const monthName = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'long' });

/** "October: 32 gentle creek crossings. September: 24." Null with no crossings this month. */
export function monthLine(m: { start: number; gentle: number; crossed: number }, prev: { start: number; gentle: number; crossed: number } | null): string | null {
  if (!m.crossed) return null;
  const was = prev?.crossed ? ` ${monthName(prev.start)}: ${prev.gentle}.` : '';
  return `${monthName(m.start)}: ${count(m.gentle, 'gentle creek crossing')}.${was}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** When a drive was, as its name: "Today, 4:19 PM", "Tuesday, 1:59 PM", else "Oct 13, 1:59 PM". */
export function whenName(at: number, now = Date.now()): string {
  const d = new Date(at), n = new Date(now), day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(n) - day(d)) / 86_400_000);
  if (ago === 0) return `Today, ${clock(at)}`;
  if (ago === 1) return `Yesterday, ${clock(at)}`;
  if (ago > 1 && ago < 7) return `${DAYS[d.getDay()]}, ${clock(at)}`;
  const year = d.getFullYear() !== n.getFullYear() ? { year: 'numeric' as const } : {};
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year })}, ${clock(at)}`;
}

/** What a drive was: its regular trip, else its main street, else its miles. */
export function driveWhat(d: { mi: number; ways?: readonly string[] }, trip: string | null): string {
  if (trip) return trip;
  return d.ways?.[0] ? `On ${d.ways[0]}` : `A ${miWord(d.mi)} drive`;
}

/** A drive's creeks in a few words, counted by creek as the report does: "Gentle at 2 of 3 salmon creeks". Null while not known. */
export function driveCreeks(cs: readonly { name: string; ll: readonly [number, number]; gentle: boolean }[] | null): { text: string; gentle: boolean } | null {
  if (!cs) return null;
  const creeks: { key: string; gentle: boolean }[] = [];
  for (const c of cs) {
    // unnamed streams count by place, about 100 m
    const key = c.name || `${c.ll[0].toFixed(3)},${c.ll[1].toFixed(3)}`, k = creeks.find((x) => x.key === key);
    if (k) k.gentle &&= c.gentle;
    else creeks.push({ key, gentle: c.gentle });
  }
  const n = creeks.length, g = creeks.filter((c) => c.gentle).length;
  if (!n) return { text: 'No salmon creeks', gentle: true };
  if (n === 1) return g ? { text: 'Gentle at 1 salmon creek', gentle: true } : { text: 'Hard brake near a salmon creek', gentle: false };
  return { text: g >= n ? `Gentle at all ${n} salmon creeks` : `Gentle at ${g} of ${n} salmon creeks`, gentle: g >= n };
}

/** The creek page: how many times and how gently. */
export function creekTimes(c: { times: number; gentle: number }): string {
  if (c.times === 1) return c.gentle ? 'You crossed it once, gently.' : 'You crossed it once, with a hard brake near.';
  if (c.gentle >= c.times) return `You crossed it ${c.times} times, gently every time.`;
  return `You crossed it ${c.times} times. ${c.gentle ? `${c.gentle} were gentle.` : 'None were gentle yet.'}`;
}

/** "Roads cross it in 14 places in Washington." */
export function roadsLine(n: number): string | null {
  return n > 1 ? `Roads cross it in ${n.toLocaleString('en-US')} places in Washington.` : null;
}

export const HABITAT = 'This creek is salmon habitat. Rain off the road here can reach it.';
export const SPECIES_SOURCE = 'Fish from WDFW salmon stream maps (SWIFD).';

/** A creek's name, or what to call one without a name */
export const creekName = (name: string): string => name || 'A salmon stream';
