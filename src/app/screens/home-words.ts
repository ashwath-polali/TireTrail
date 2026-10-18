// Words for Drive home: this week's salmon line. No DOM, so tests run it.
import { weekStart } from '../../drive/challenge.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { StopClass } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count } from './drive-words.ts';

export interface SalmonCount {
  /** gentle stops whose rain drains to a salmon stream */
  gentle: number;
  /** hard brakes whose rain drains to a salmon stream */
  hard: number;
}

/** Counts this week's stops above salmon streams. Totals for every drive are on My drives. clsAt: where rain at a point goes. */
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
  if (c.gentle) return `${count(c.gentle, 'gentle stop')} above salmon streams`;
  if (c.hard) return `${count(c.hard, 'hard brake')} drained to salmon streams. Ease off there.`;
  return 'Gentle stops leave less tire dust to reach salmon streams';
}
