// The shortest drive that gets a score. Shorter ones aren't saved or counted anywhere.

/** half a mile, 2 minutes and 30 usable GPS readings */
export const MIN_DRIVE = { mi: 0.5, s: 120, fixes: 30 } as const;

/** A drive long enough to score. Takes a DriveReport. */
export function enoughDrive(r: { miles: number; durationS: number; usedFixes: number }): boolean {
  return r.miles >= MIN_DRIVE.mi && r.durationS >= MIN_DRIVE.s && r.usedFixes >= MIN_DRIVE.fixes;
}

/** A saved summary long enough to count. Summaries don't keep the GPS count, so miles and minutes. */
export function countsSummary(s: { mi: number; min: number }): boolean {
  return s.mi >= MIN_DRIVE.mi && s.min >= MIN_DRIVE.s / 60;
}
