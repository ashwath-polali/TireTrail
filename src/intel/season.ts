// Coho season in Puget Sound, by the month in Washington.
// In Big Beef Creek, a small Puget Sound stream, most coho swim in during October and November; spawning can run from November into February
// (Quinn 2025, Encyclopedia of Puget Sound: Big Beef Creek counts, 46% in October, 39% in November).

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });

/** Washington's date and hour for a moment: day "2026-10-22", month 1 to 12, hour 0 to 23. */
export function pacific(ms: number): { day: string; month: number; hour: number } {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, month: +p.month, hour: +p.hour % 24 };
}

export type Season = 'returning' | 'spawning';

/** October and November: coho are coming back; December to February: spawning (Quinn: "from November into February"). Else null. */
export function cohoSeason(ms: number): Season | null {
  const m = pacific(ms).month;
  return m === 10 || m === 11 ? 'returning' : m === 12 || m <= 2 ? 'spawning' : null;
}

/** The Puget Sound lowlands, roughly: west of the Cascade crest, east of the Olympics, Olympia to the border. */
export function inPugetSound(ll: { lat: number; lon: number }): boolean {
  return ll.lon >= -123.4 && ll.lon <= -121.3 && ll.lat >= 46.75 && ll.lat <= 49.1;
}
