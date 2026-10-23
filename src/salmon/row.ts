// The report's salmon streams row: crossings driven over, how many gently (no hard brake within 150 m), and the creeks.
import type { LngLat, XY } from '../geo/geo.ts';
import type { Fix } from '../drive/types.ts';
import { h } from '../app/dom.ts';
import { glyph, salmonSVG } from '../app/ui/glyphs.ts';
import { salmonData } from './index.ts';
import { toRegion } from './proj.ts';
import { oneFish, speciesList } from './species.ts';
import { TILE, type SalmonData, type Tile } from './tiles.ts';
import { besideAt, SALMON, SalmonWatch, salmonTrip, type SalmonSource, type SalmonTrip } from './watch.ts';

/** For "How we figure this": where the streams come from and what counts as gentle. */
export const SALMON_HOW = [
  'Salmon streams are where WDFW maps coho, chinook, chum, pink, sockeye or steelhead habitat, documented or presumed (SWIFD). Roads come from OpenStreetMap.',
  'A crossing counts as gentle when there was no hard brake within 150 m (about 500 feet) of it.',
];

/** "Clover Creek, Fennel Creek and 2 more" */
export function namesText(names: readonly string[], most = 2): string {
  if (names.length <= most) return names.join(names.length === 2 ? ' and ' : '');
  return `${names.slice(0, most).join(', ')} and ${names.length - most} more`;
}

/** The row's words; null with no crossings. */
export function salmonRowWords(t: SalmonTrip): { line: string; sub: string } | null {
  if (!t.crossed) return t.besideMi >= 0.2 ? { line: `Drove ${t.besideMi.toFixed(1)} mi beside salmon streams`, sub: t.names.length ? namesText(t.names) : speciesList(t.sp) } : null;
  const fish = oneFish(t.sp);
  if (t.crossed === 1) {
    const where = t.names[0] ?? `a ${(fish ?? 'salmon').toLowerCase()} stream`;
    return t.gentle ? { line: `Crossed ${where} gently`, sub: speciesList(t.sp) } : { line: `Hard brake near ${where}`, sub: `${speciesList(t.sp)}. Ease off sooner there.` };
  }
  const how = t.gentle === t.crossed ? 'all gently' : `${t.gentle} gently`;
  return { line: `Crossed salmon streams ${t.crossed} times, ${how}`, sub: t.names.length ? namesText(t.names) : speciesList(t.sp) };
}

/** The row, in the report's line style (.dv-line); null with no crossings. */
export function salmonRow(t: SalmonTrip | null, onClick?: () => void): HTMLElement | null {
  const w = t && salmonRowWords(t);
  if (!w) return null;
  const kids = [
    h('span.dv-line-ico', { 'aria-hidden': 'true', html: t.gentle ? salmonSVG(2) : glyph('fish', 2) }),
    h('span.dv-line-text', {}, h('b', {}, w.line), h('span', {}, w.sub)),
    onClick ? h('span.u-ico', { 'aria-hidden': 'true', html: glyph('chevron', 2) }) : null,
  ];
  return onClick
    ? h('button.dv-line.dv-salmon', { type: 'button', 'data-tone': 'salmon', onclick: () => onClick() }, ...kids)
    : h('div.dv-line.dv-salmon', { 'data-tone': 'salmon' }, ...kids);
}

/** Region tile keys a route passes within the coach's look-around of. */
export function routeTiles(pts: readonly XY[]): Set<string> {
  const out = new Set<string>(), r = SALMON.lookM;
  for (const [x, y] of pts) for (const dx of [-r, r]) for (const dy of [-r, r]) out.add(`${Math.floor((x + dx) / TILE)}_${Math.floor((y + dy) / TILE)}`);
  return out;
}

/** Replays a drive over the salmon crossings it passed. brakes: where the hard brakes were. */
export function tripOver(tiles: readonly Tile[], fixes: readonly Fix[], brakes: readonly LngLat[]): SalmonTrip {
  const src: SalmonSource = { near: () => tiles as Tile[] }, w = new SalmonWatch();
  let prev: XY | null = null, heading: number | null = null, last: XY | null = null, beside = 0, sp = 0;
  const names: string[] = [];
  for (const f of fixes) {
    const p = toRegion([f.lon, f.lat]);
    // a road beside a stream: the middle of each step within 25 m of one of the stretches
    if (last) {
      const mid: XY = [(p[0] + last[0]) / 2, (p[1] + last[1]) / 2], L = Math.hypot(p[0] - last[0], p[1] - last[1]);
      const b = L > 0 && L < 300 ? besideAt(tiles, mid) : null;
      if (b) { beside += L; sp |= b.sp; if (b.name && !names.includes(b.name)) names.push(b.name); }
    }
    last = p;
    // heading from the last 15 m or more, as the phone's own is often missing
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 15) {
      heading = ((Math.atan2(p[0] - prev[0], -(p[1] - prev[1])) * 180) / Math.PI + 360) % 360;
      prev = p;
    } else if (!prev) prev = p;
    w.move(src, [f.lon, f.lat], f.t, heading);
  }
  const trip = salmonTrip(w.passed, brakes.map((b) => toRegion(b)), beside / 1609.344);
  if (!trip.crossed) [trip.names, trip.sp] = [names, sp];
  return trip;
}

/** A drive's salmon streams, once its tiles are in; null if they can't load. */
export async function salmonTripFor(fixes: readonly Fix[], brakes: readonly LngLat[], data: SalmonData = salmonData): Promise<SalmonTrip | null> {
  if (!fixes.length) return null;
  const tiles = await data.some(routeTiles(fixes.map((f) => toRegion([f.lon, f.lat]))));
  if (!data.ready) return null;
  return tripOver(tiles, fixes, brakes);
}
