// Coho season in Puget Sound, by the month in Washington.
// Most coho enter small Puget Sound streams in October and November and spawn from November into winter
// (Quinn 2025, Encyclopedia of Puget Sound: Big Beef Creek counts, 46% in October, 39% in November).

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });

/** Washington's date and hour for a moment: day "2026-10-22", month 1 to 12, hour 0 to 23. */
export function pacific(ms: number): { day: string; month: number; hour: number } {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, month: +p.month, hour: +p.hour % 24 };
}

export type Season = 'returning' | 'spawning';

/** October and November: coho are coming back; December and January: spawning. Else null. */
export function cohoSeason(ms: number): Season | null {
  const m = pacific(ms).month;
  return m === 10 || m === 11 ? 'returning' : m === 12 || m === 1 ? 'spawning' : null;
}
