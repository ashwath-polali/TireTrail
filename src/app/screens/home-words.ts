// Words for Drive home: the money line, the salmon line. No DOM, so tests run it.
import { weekStart } from '../../drive/challenge.ts';
import { moneyText } from '../../drive/money.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { StopClass } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { count } from './drive-words.ts';

/** The one money line: a year of driving like this, never cents. null with too little driving to say. */
export function moneyLine(yearUsd: number | null): string | null {
  if (yearUsd === null) return null;
  if (!(yearUsd > 0)) return 'Nothing extra spent on gas or tires';
  return `Could save ${moneyText(yearUsd, 'year')} a year`;
}

export interface SalmonCount {
  /** gentle stops whose rain drains to a salmon stream */
  gentle: number;
  /** hard brakes whose rain drains to a salmon stream */
  hard: number;
  /** this week (the card already says so), or every drive when there are none this week */
  week: boolean;
}

/** Counts this week's stops above salmon streams. clsAt: where rain at a point goes. */
export function salmonCount(sums: readonly DriveSummary[], clsAt: (p: LngLat) => StopClass, now = Date.now()): SalmonCount {
  const from = weekStart(now), week = sums.filter((s) => s.at >= from);
  const use = week.length ? week : sums;
  let gentle = 0, hard = 0;
  for (const s of use) {
    hard += s.salmon;
    for (const p of s.stopPts ?? []) if (!p.hard && clsAt([p.lon, p.lat]) === 'creek') gentle++;
  }
  return { gentle, hard, week: week.length > 0 };
}

/** One salmon line, only from what the drives show. */
export function salmonLine(c: SalmonCount): string {
  const when = c.week ? '' : ' so far';
  if (c.gentle) return `${count(c.gentle, 'gentle stop')} above salmon streams${when}`;
  if (c.hard) return `${count(c.hard, 'hard brake')} drained to salmon streams${when}. Ease off there.`;
  return 'Gentle stops leave less tire dust to reach salmon streams';
}
