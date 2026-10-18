// Words for the weekly challenge strip. No DOM, so tests run it.
import type { Challenge } from '../../drive/challenge.ts';

/** What a tap shows first: how it's done, or how it went. */
export function challengeNote(c: Pick<Challenge, 'state' | 'kind' | 'need' | 'how'>): string {
  if (c.state === 'done') return c.kind === 'spot' ? `You drove past it ${c.need} times with no hard brake.` : 'Nice work. A new goal starts Monday.';
  if (c.state === 'missed') return c.kind === 'spot' ? 'You braked hard there this week. A new goal starts Monday.' : 'A new goal starts Monday.';
  return c.how;
}

/**
 * "4 smooth drives in a row. Best: 6." Null before the first smooth drive, so a new driver never reads "0 in a row",
 * and null after a goal met with no streak now, so a win doesn't sit next to a zero.
 */
export function streakNote(c: Pick<Challenge, 'streak' | 'best'> & { state?: Challenge['state'] }): string | null {
  if (!c.best || (c.state === 'done' && !c.streak)) return null;
  return `${c.streak} smooth ${c.streak === 1 ? 'drive' : 'drives'} in a row. Best: ${c.best}.`;
}

/** "4 days left", "Last day", "Goal met", "Missed" */
export function challengeLeft(c: Pick<Challenge, 'state' | 'daysLeft'>): string {
  return c.state === 'done' ? 'Goal met' : c.state === 'missed' ? 'Missed' : c.daysLeft <= 1 ? 'Last day' : `${c.daysLeft} days left`;
}
