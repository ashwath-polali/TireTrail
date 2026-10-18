// Words for the weekly challenge strip. No DOM, so tests run it.
import type { Challenge } from '../../drive/challenge.ts';

/** What a tap shows first: how it's done, or how it went. */
export function challengeNote(c: Pick<Challenge, 'state' | 'kind' | 'need' | 'how'>): string {
  if (c.state === 'done') return c.kind === 'spot' ? `You drove past it ${c.need} times with no hard brake.` : `${c.need} smooth drives this week. Nice work.`;
  if (c.state === 'missed') return c.kind === 'spot' ? 'You braked hard there this week. A new goal starts Monday.' : 'A new goal starts Monday.';
  return c.how;
}

/** "4 smooth drives in a row. Best: 6." */
export function streakNote(c: Pick<Challenge, 'streak' | 'best'>): string {
  return `${c.streak} smooth ${c.streak === 1 ? 'drive' : 'drives'} in a row. Best: ${c.best}.`;
}

/** "4 days left", "Last day", "Done", "Missed" */
export function challengeLeft(c: Pick<Challenge, 'state' | 'daysLeft'>): string {
  return c.state === 'done' ? 'Done' : c.state === 'missed' ? 'Missed' : c.daysLeft <= 1 ? 'Last day' : `${c.daysLeft} days left`;
}
