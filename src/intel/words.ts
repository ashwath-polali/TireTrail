// Words for rain and coho season: home's lines, the voice line and the sources. No DOM, so tests run it.
import type { Forecast, RainAhead, When } from './rain.ts';
import type { Season } from './season.ts';

export interface Source { label: string; href: string }

/** "Rain tonight." */
export const rainTitle = (w: When) => `Rain ${w}.`;

/** Under the rain title: what rain does, and what to do today. */
export const RAIN_BODY = 'It washes tire dust off roads into salmon creeks. Brake gently today.';

/** Said once a day as a drive starts. */
export const rainVoice = (w: When) => `Rain ${w}. Easy near the creeks.`;

const inches = (mm: number) => Math.max(0.1, Math.round(mm / 25.4 * 10) / 10).toFixed(1);

/** Behind a tap: the forecast, then why it matters. Each line short. */
export function rainWhy(f: Pick<Forecast, 'place'>, r: Pick<RainAhead, 'mm'>): string[] {
  return [
    `The weather service expects about ${inches(r.mm)} in near ${f.place || 'you'} by this time tomorrow.`,
    'Storm runoff kills many coho in city creeks.',
    'Researchers traced it to a chemical from tires.',
    'Gentle stops shed less tire dust, so less washes in.',
  ];
}

export const SEASON_LINE: Record<Season, string> = {
  returning: 'Coho are returning to Puget Sound creeks now.',
  spawning: 'Coho are spawning in Puget Sound creeks now.',
};

export const SEASON_WHY = [
  'Most coho swim up small Puget Sound streams in October and November.',
  'They spawn from November into winter.',
  'Fall rain brings them in, and it also washes the roads.',
];

export const SRC = {
  scholz: { label: 'Coho die-offs: Scholz and others, 2011', href: 'https://doi.org/10.1371/journal.pone.0028013' },
  tian: { label: 'The tire chemical: Tian and others, 2021', href: 'https://doi.org/10.1126/science.abd6951' },
  quinn: { label: 'When coho return: Quinn, 2025', href: 'https://www.eopugetsound.org/article/coho-salmon-and-estuary-use-in-puget-sound' },
} satisfies Record<string, Source>;

export const nwsSource = (href: string): Source => ({ label: 'Forecast: National Weather Service', href });

/** Home's one line for the week, from weekStats. Null with no drives at all. */
export function weekLine(w: { drives: number; known: number; crossed: number; gentle: number }, any: boolean): string | null {
  if (!w.drives) return any ? 'No drives yet this week' : null;
  if (!w.known) return 'This week: finding your creeks';
  if (!w.crossed) return 'This week: no salmon creeks on your drives';
  if (w.gentle >= w.crossed) return w.crossed === 1 ? 'This week: gentle at your one creek crossing' : `This week: gentle at all ${w.crossed} creek crossings`;
  return `This week: gentle at ${w.gentle} of ${w.crossed} creek crossings`;
}
