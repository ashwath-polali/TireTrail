// What the share card says, from the report's facts only. No route, no times, no names of people.
import type { DriveReport } from '../../drive/analyze.ts';
import { moneyText } from '../../drive/money.ts';
import { answered, salmonWater } from '../../drive/tips.ts';

export interface ShareFacts {
  score: number;
  money: string;
  /** the hardest brake's street, or a plain line when there were none */
  spot: string;
  salmon: string;
  date: string;
}

export function moneyLine(r: DriveReport): string {
  const gas = r.money.gas.typical, tires = r.money.tires.typical, both = gas + tires;
  if (!(both > 0)) return 'No extra gas or tire wear from speeding or hard stops.';
  if (gas > 0 && tires > 0) return `Speeding and hard stops cost ${moneyText(both, 'drive')} in extra gas and tire wear.`;
  return gas > 0 ? `Speeding cost ${moneyText(gas, 'drive')} in extra gas.` : `Hard stops cost ${moneyText(tires, 'drive')} in extra tire wear.`;
}

export function spotLine(r: DriveReport): string {
  if (!r.brakes.length) return 'No hard brakes on this drive.';
  const top = [...r.brakes].sort((a, b) => b.rate - a.rate)[0];
  return top.name ? `Hardest brake: ${top.name}` : 'Hardest brake: a street with no name on the map';
}

export function salmonLine(r: DriveReport): string {
  const fish = r.brakes.filter((b) => b.salmon);
  if (fish.length) {
    const ws = fish.map((b) => salmonWater(b.receiving));
    const where = ws.every((w) => w.coho === ws[0].coho) && ws[0].kind !== 'unnamed' ? `${ws[0].coho}, where coho salmon live` : 'streams where coho salmon live';
    return `Rain from ${fish.length === 1 ? '1 hard brake' : `${fish.length} hard brakes`} on this drive runs ${ws.every((w) => w.kind === 'fennel' || w.kind === 'named') ? 'to' : 'toward'} ${where}.`;
  }
  const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length;
  if (n && !hard) return `${n === 1 ? 'The only stop was' : `All ${n} stops were`} gentle. Gentle stops leave less tire dust to wash into salmon streams.`;
  if (r.brakes.length && r.brakes.every((b) => answered(b.cls))) return 'None of the hard brakes drain to a salmon stream.';
  return 'Gentle stops leave less tire dust to wash into salmon streams.';
}

export const dateLine = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function shareFacts(r: DriveReport, at: number): ShareFacts {
  return { score: r.score.score, money: moneyLine(r), spot: spotLine(r), salmon: salmonLine(r), date: dateLine(at) };
}
