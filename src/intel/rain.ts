// Rain ahead, from the National Weather Service grid forecast (api.weather.gov: no key, open to browsers).
// The math is pure so tests run it; load() does the fetching, caches for an hour and fails quietly.
import { pacific } from './season.ts';

/** a forecast stretch: start ms, length ms, value */
export type Span = [number, number, number];

export interface Forecast {
  /** fetched at, ms */
  at: number;
  /** the rounded point asked about */
  lat: number;
  lon: number;
  /** the town NWS names for the point, "" if none */
  place: string;
  /** rain in mm per stretch */
  qpf: Span[];
  /** chance of rain, percent */
  pop: Span[];
}

/** at least this much rain in the next 24 h counts (0.1 in) */
export const RAIN_MM = 2.54;
/** and at least this chance of rain in some hour */
export const RAIN_POP = 50;
/** a stretch is wet from this rate on, mm an hour */
const WET_MM_H = 0.1;
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** Pierce County (Graham), when there is no drive yet */
export const HOME_LL = { lat: 47.05, lon: -122.3 };

/** "PT6H", "P1DT12H", "PT30M" to ms; 0 when unreadable. */
export function durationMs(s: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s);
  if (!m) return 0;
  return (+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * HOUR + +(m[3] ?? 0) * 60_000;
}

/** An NWS layer ({ values: [{ validTime: "start/PT6H", value }] }) to spans; blanks are left out. */
export function spans(layer: unknown): Span[] {
  const vs = (layer as { values?: unknown })?.values;
  if (!Array.isArray(vs)) return [];
  const out: Span[] = [];
  for (const v of vs) {
    const [a, d] = String((v as { validTime?: unknown })?.validTime ?? '').split('/');
    const t = Date.parse(a), ms = durationMs(d ?? ''), x = (v as { value?: unknown }).value;
    if (Number.isFinite(t) && ms > 0 && typeof x === 'number' && Number.isFinite(x)) out.push([t, ms, x]);
  }
  return out;
}

/** The parts of a gridpoints response we keep. Null when it has no rain layer. */
export function parseGrid(json: unknown, at: number, ll: { lat: number; lon: number }, place = ''): Forecast | null {
  const p = (json as { properties?: Record<string, unknown> })?.properties;
  if (!p) return null;
  const unit = String((p.quantitativePrecipitation as { uom?: unknown })?.uom ?? '');
  const qpf = spans(p.quantitativePrecipitation);
  if (!qpf.length || (unit && !/mm$/.test(unit))) return null;
  return { at, lat: ll.lat, lon: ll.lon, place, qpf, pop: spans(p.probabilityOfPrecipitation) };
}

export type When = 'today' | 'tonight' | 'tomorrow';

export interface RainAhead {
  /** rain expected in the next 24 h, mm */
  mm: number;
  /** the highest chance of rain in that time, percent */
  pop: number;
  /** when it starts, ms */
  start: number;
  when: When;
}

const overlap = (s: Span, a: number, b: number) => Math.max(0, Math.min(s[0] + s[1], b) - Math.max(s[0], a));

/** Meaningful rain in the next 24 h, or null: 0.1 in or more, and a 50% chance or more in some hour. */
export function rainAhead(f: Pick<Forecast, 'qpf' | 'pop'>, now: number): RainAhead | null {
  const end = now + DAY;
  let mm = 0, start = Infinity;
  for (const s of f.qpf) {
    const o = overlap(s, now, end);
    if (!o) continue;
    mm += s[2] * (o / s[1]);
    if (s[2] / (s[1] / HOUR) >= WET_MM_H) start = Math.min(start, Math.max(s[0], now));
  }
  const pop = Math.max(0, ...f.pop.filter((s) => overlap(s, now, end) > 0).map((s) => s[2]));
  if (mm < RAIN_MM || pop < RAIN_POP || !Number.isFinite(start)) return null;
  return { mm: Math.round(mm * 10) / 10, pop, start, when: whenOf(start, now) };
}

/** Today until 5 PM, tonight until 6 AM, then tomorrow; Washington time. */
export function whenOf(start: number, now: number): When {
  const s = pacific(start), n = pacific(now);
  const today = s.day === n.day, next = s.day === pacific(now + DAY).day;
  if (today) return s.hour < 17 ? 'today' : 'tonight';
  if (next && s.hour < 6 && n.hour >= 6) return 'tonight';
  return 'tomorrow';
}

// ---------- fetch and cache ----------

const KEY = 'tt-rain', SAID = 'tt-rain-said';
/** refetch after an hour; an older forecast still answers for 6 hours */
export const FRESH_MS = HOUR, KEEP_MS = 6 * HOUR;

/** Rounds to 0.05° (about 3 mi), so the weather service only gets the area. */
export const roundLL = (ll: { lat: number; lon: number }) => ({ lat: Math.round(ll.lat * 20) / 20, lon: Math.round(ll.lon * 20) / 20 });

function read(): Forecast | null {
  try {
    const f = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Forecast | null;
    return f && Array.isArray(f.qpf) && Array.isArray(f.pop) ? f : null;
  } catch { return null; }
}

/** The kept forecast for this area while it still answers, else null. */
export function cached(ll: { lat: number; lon: number }, now = Date.now()): Forecast | null {
  const f = read(), r = roundLL(ll);
  return f && f.lat === r.lat && f.lon === r.lon && now - f.at < KEEP_MS && now >= f.at ? f : null;
}

/** The kept forecast, wherever it was for (the drive start uses it). */
export function lastForecast(now = Date.now()): Forecast | null {
  const f = read();
  return f && now - f.at < KEEP_MS && now >= f.at ? f : null;
}

const getJson = async (url: string, ms: number): Promise<unknown> => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { Accept: 'application/geo+json' } });
    return r.ok ? await r.json() : null;
  } finally { clearTimeout(t); }
};

/** one fetch at a time for each area */
const pending = new Map<string, Promise<Forecast | null>>();

/** The forecast for an area: kept for an hour, else fetched. Null offline or on any error. */
export function load(ll: { lat: number; lon: number }, now = Date.now()): Promise<Forecast | null> {
  const r = roundLL(ll), have = cached(r, now);
  if (have && now - have.at < FRESH_MS) return Promise.resolve(have);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(have);
  const id = `${r.lat},${r.lon}`, going = pending.get(id);
  if (going) return going;
  const p = (async () => {
    try {
      const pt = await getJson(`https://api.weather.gov/points/${r.lat},${r.lon}`, 8000) as { properties?: { forecastGridData?: string; relativeLocation?: { properties?: { city?: string } } } } | null;
      const grid = pt?.properties?.forecastGridData;
      if (!grid || !/^https:\/\/api\.weather\.gov\//.test(grid)) return have;
      const f = parseGrid(await getJson(grid, 12000), Date.now(), r, pt?.properties?.relativeLocation?.properties?.city ?? '');
      if (!f) return have;
      try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* storage blocked */ }
      return f;
    } catch { return have; } finally { pending.delete(id); }
  })();
  pending.set(id, p);
  return p;
}

/** The NWS page for the area, for the source link. */
export const forecastPage = (f: Pick<Forecast, 'lat' | 'lon'>) => `https://forecast.weather.gov/MapClick.php?lat=${f.lat}&lon=${f.lon}`;

// ---------- once a day out loud ----------

/** The day's key in Washington time, "2026-10-22". */
export const dayKey = (ms: number) => pacific(ms).day;

/** True when the rain line hasn't been said today. */
export function unsaidToday(now = Date.now(), last = readSaid()): boolean {
  return last !== dayKey(now);
}

/** The day the rain line was last said, or null. */
export function readSaid(): string | null {
  try { return localStorage.getItem(SAID); } catch { return null; }
}

/** Notes that the rain line was said today. */
export function markSaid(now = Date.now()): void {
  try { localStorage.setItem(SAID, dayKey(now)); } catch { /* storage blocked */ }
}
