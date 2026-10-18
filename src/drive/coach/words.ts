// Small plain-word helpers shared by the coach.
import { moneyText, type Usd } from '../money.ts';

const FT_PER_MI = 5280;

/** "0.6 miles", "1 mile", "300 feet" */
export function distText(mi: number): string {
  if (mi < 0.1) return `${Math.max(10, Math.round((mi * FT_PER_MI) / 10) * 10)} feet`;
  const r = mi < 10 ? Math.round(mi * 10) / 10 : Math.round(mi);
  return r === 1 ? '1 mile' : `${r} miles`;
}

/** "about 4¢", "under 1¢", "about $1.20" */
export const centsText = (usd: number): string => moneyText(usd, 'drive');

/** "about $6", "under $1", "$0", for a month */
export function monthText(usd: number): string {
  if (!(usd > 0)) return '$0';
  if (usd < 1) return 'under $1';
  return `about $${Math.round(usd)}`;
}

/** "$3 to $9 a month", "up to $2 a month", "under $1 a month" */
export function monthRange(u: Usd): string {
  const one = (x: number) => (x < 1 ? 'under $1' : `$${Math.round(x)}`);
  const lo = one(u.low), hi = one(u.high);
  if (lo === hi) return `${monthText(u.typical)} a month`;
  return lo === 'under $1' ? `up to ${hi} a month` : `${lo} to ${hi} a month`;
}

/** "once", "twice", "3 times" */
export const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** "1 hard brake", "3 hard brakes" */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
