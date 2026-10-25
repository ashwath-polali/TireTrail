// How often the voice may talk. Pure: the past lines in, yes or no out.
// Urgent lines (a creek or spot ahead, a serious alert) always come. Everything else waits 10 s after the last
// non-urgent line, and the same words never come again within 2 minutes, so the coach is heard often but never nags.

/** at or above this rank a line always comes, and cuts lower ones */
export const URGENT = 3;

export const PACE = {
  /** non-urgent lines at least this far apart, ms */
  gapMs: 10_000,
  /** the same non-urgent words not again within this long, ms */
  sameMs: 120_000,
};

/** a line handed to the phone: its words, when and how much it mattered */
export interface Spoken { text: string; at: number; rank: number }

/** May this line be said now, given the lines said before? */
export function mayCome(past: readonly Spoken[], text: string, rank: number, now: number): boolean {
  if (rank >= URGENT) return true;
  for (const p of past) {
    if (p.rank < URGENT && now - p.at < PACE.gapMs) return false;
    if (p.text === text && now - p.at < PACE.sameMs) return false;
  }
  return true;
}

/** The past with this line added, and anything too old to matter dropped. */
export function remember(past: readonly Spoken[], line: Spoken): Spoken[] {
  return [...past.filter((p) => line.at - p.at < PACE.sameMs), line];
}
