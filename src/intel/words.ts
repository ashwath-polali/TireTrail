// Words for rain and coho season: home's lines, the voice line and the sources. No DOM, so tests run it.
import type { Forecast, RainAhead, When } from './rain.ts';
import type { Season } from './season.ts';

export interface Source { label: string; href: string }

const inches = (mm: number) => Math.max(0.1, Math.round(mm / 25.4 * 10) / 10).toFixed(1);

/** "Rain tonight." */
export const rainTitle = (w: When) => `Rain ${w}.`;

/** After the rain title, what to do: "Rain tonight. Brake gently today." */
export const RAIN_DO = 'Brake gently today.';

/** Under it, the forecast in one line. */
export const rainLine = (f: Pick<Forecast, 'place'>, r: Pick<RainAhead, 'mm'>): string => `About ${inches(r.mm)} inches near ${f.place || 'you'} by this time tomorrow.`;

/** Said once a day as a drive starts. */
export const rainVoice = (w: When) => `Rain ${w}. Easy near the creeks.`;

/** Why rain matters, on About under Sources and methods. Each line short. */
export const RAIN_WHY = [
  'Rain washes tire dust off roads into storm drains, and some drains flow to creeks.',
  'Storm runoff kills many coho in city creeks. Researchers traced it to a chemical from tires.',
  'Gentle stops shed less tire dust, so less washes in.',
];

export const SEASON_LINE: Record<Season, string> = {
  returning: 'Coho are returning to Puget Sound creeks.',
  spawning: 'Coho are spawning in Puget Sound creeks.',
};

/** Under the season line. */
export const SEASON_SUB = 'Fall rain brings them in, and it also washes the roads.';

/** When coho come back, on About under Sources and methods. */
export const SEASON_WHY = [
  'Most coho swim up small Puget Sound streams in October and November.',
  'They spawn from November into February.',
];

export const SRC = {
  scholz: { label: 'Coho die-offs: Scholz and others, 2011', href: 'https://doi.org/10.1371/journal.pone.0028013' },
  tian: { label: 'The tire chemical: Tian and others, 2021', href: 'https://doi.org/10.1126/science.abd6951' },
  wear: { label: 'Tire wear: Giechaskiel and others, 2024', href: 'https://doi.org/10.3390/su16020522' },
  quinn: { label: 'When coho return: Quinn, 2025', href: 'https://www.eopugetsound.org/article/coho-salmon-and-estuary-use-in-puget-sound' },
} satisfies Record<string, Source>;

export const nwsSource = (href: string): Source => ({ label: 'Forecast: National Weather Service', href });

/** Home's way into My drives, never the same words as My drives' own line. Null with no drives at all. */
export function weekLine(drives: number, any: boolean): string | null {
  if (!any) return null;
  if (!drives) return 'No drives yet this week. See past drives on the map.';
  return drives === 1 ? '1 drive this week. See it on the map.' : `${drives} drives this week. See them on the map.`;
}
