// Words for the weekly challenge strip. No DOM, so tests run it.
import type { Challenge } from '../../drive/challenge.ts';

/** Too late to meet this week (none done, fewer days left than drives needed): show next week's goal instead. */
export function startsNextWeek(c: Pick<Challenge, 'state' | 'got' | 'need' | 'daysLeft'>): boolean {
  return c.state === 'open' && c.got === 0 && c.daysLeft < c.need;
}

/** The goal's title, moved to next week when this one can't be met. */
export function challengeTitle(c: Pick<Challenge, 'title' | 'state' | 'got' | 'need' | 'daysLeft'>): string {
  return startsNextWeek(c) ? c.title.replace(/ this week$/, ' next week') : c.title;
}

/** What a tap shows first: how it's done, or how it went. */
export function challengeNote(c: Pick<Challenge, 'state' | 'kind' | 'need' | 'how'>): string {
  if (c.state === 'done') return c.kind === 'spot' ? `You drove past it ${c.need} times with no hard brake.` : `${c.need} smooth drives this week. Nice work.`;
  if (c.state === 'missed') return c.kind === 'spot' ? 'You braked hard there this week. A new goal starts Monday.' : 'A new goal starts Monday.';
  return c.how;
}

/** "4 smooth drives in a row. Best: 6." Null before the first smooth drive, and under a met goal when the run is 0. */
export function streakNote(c: Pick<Challenge, 'streak' | 'best'> & { state?: Challenge['state'] }): string | null {
  if (!c.best || (c.state === 'done' && !c.streak)) return null;
  return `${c.streak} smooth ${c.streak === 1 ? 'drive' : 'drives'} in a row. Best: ${c.best}.`;
}

/** "4 days left", "Last day", "Goal met", "Missed", or "Starts Monday" when this week is out of reach */
export function challengeLeft(c: Pick<Challenge, 'state' | 'daysLeft'> & Partial<Pick<Challenge, 'got' | 'need'>>): string {
  if (c.got !== undefined && c.need !== undefined && startsNextWeek({ state: c.state, daysLeft: c.daysLeft, got: c.got, need: c.need })) return 'Starts Monday';
  return c.state === 'done' ? 'Goal met' : c.state === 'missed' ? 'Missed' : c.daysLeft <= 1 ? 'Last day' : `${c.daysLeft} days left`;
}
