// Words for Drive home: the line under the title and this week's salmon line. No DOM, so tests run it.
import { weekStart } from '../../drive/challenge.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { StopClass } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count } from './drive-words.ts';

/** Smoother driving wears tires less and wastes less gas (dust.ts, money.ts). It can't keep dust out of streams. */
export const HOME_LINE = 'Shed less tire dust. Spend less on gas.';

export interface SalmonCount {
  /** gentle stops whose rain drains to a salmon stream */
  gentle: number;
  /** hard brakes whose rain drains to a salmon stream */
  hard: number;
}

/** Counts this week's stops at spots that drain to salmon streams. Totals for every drive are on My drives. clsAt: where rain at a point goes. */
export function salmonCount(sums: readonly DriveSummary[], clsAt: (p: LngLat) => StopClass, now = Date.now()): SalmonCount {
  const from = weekStart(now);
  let gentle = 0, hard = 0;
  for (const s of sums) {
    if (s.at < from) continue;
    hard += s.salmon;
    for (const p of s.stopPts ?? []) if (!p.hard && clsAt([p.lon, p.lat]) === 'creek') gentle++;
  }
  return { gentle, hard };
}

/** One salmon line for this week, only from what the drives show. */
export function salmonLine(c: SalmonCount): string {
  // the place drains, not the stop
  const at = (n: number) => (n === 1 ? 'where rain flows to a salmon stream' : 'where rain flows to salmon streams');
  if (c.gentle) return `${count(c.gentle, 'gentle stop')} ${at(c.gentle)}`;
  if (c.hard) return `${count(c.hard, 'hard brake')} ${at(c.hard)}. Ease off there.`;
  return 'Gentle stops leave less tire dust for salmon streams';
}
