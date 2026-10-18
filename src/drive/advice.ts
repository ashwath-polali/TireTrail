// What to do at a stop: start slowing sooner, so a gentle stop fits.
// Gentle = 1.4 m/s², what drivers use at lights (Pohrt 2019).
export const GENTLE_MPS2 = 1.4;
const FT = 3.28084;

/** feet a gentle stop takes from this speed (m/s), to the nearest 10 */
export function gentleStopFt(entryMps: number): number {
  return Math.round(((entryMps * entryMps) / (2 * GENTLE_MPS2)) * FT / 10) * 10;
}

/** seconds sooner to start slowing so the stop is gentle; 0 if it already was */
export function soonerS(entryMps: number, brakingM: number): number {
  if (!(entryMps > 0)) return 0;
  const gentleM = (entryMps * entryMps) / (2 * GENTLE_MPS2);
  return Math.max(gentleM - brakingM, 0) / entryMps;
}

/** "Start slowing about 3 seconds sooner here." null under half a second. */
export function soonerText(entryMps: number, brakingM: number): string | null {
  const s = Math.round(soonerS(entryMps, brakingM));
  if (soonerS(entryMps, brakingM) < 0.5) return null;
  return s <= 1 ? 'Start slowing about 1 second sooner here.' : `Start slowing about ${s} seconds sooner here.`;
}
