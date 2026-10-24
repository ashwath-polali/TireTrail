// Words for the first-open guide (How it works) and About. No DOM, so tests run it.
// Sources: Scholz et al. 2011 (PLoS ONE), Tian et al. 2021 (Science), Giechaskiel et al. 2024, US Tire Manufacturers Association, Quinn 2025.

import { gasPrice, roundCents } from '../../drive/gas.ts';

export interface Step {
  kicker: string;
  /** its pictures; several take turns, each with its line */
  art: readonly string[];
  title: string;
  text?: string;
  lines?: readonly string[];
}

export const STEPS: readonly Step[] = [
  {
    kicker: 'PUGET SOUND SALMON', title: 'Tire dust is killing coho in city creeks.',
    // Longfellow Creek: 60 to 100% of each fall run died before spawning (Scholz 2011)
    text: 'In some city creeks, most coho die after rain, before they spawn.',
    art: ['tut-1-brake', 'tut-2-drain', 'tut-3-pipes', 'tut-4-salmon'],
    // "some": the pipe maps show only some drains reach a creek; "can": 6PPDQ is from a chemical in the tire
    lines: ['Hard brakes shed more tire dust.', 'Rain washes it into storm drains.', 'Some drains flow to creeks.', '6PPDQ, from a chemical in nearly every tire, can kill coho within hours.'],
  },
  // the phone sits in a mount: set it up before you drive, then hands off
  { kicker: 'WHAT TIRETRAIL DOES', art: ['tut-5-voice'], title: 'Drive smoother. Help the salmon.', text: 'A voice warns you before places where you often brake hard.' },
  { kicker: 'YOUR TURN', art: ['tut-2-drain'], title: "See where your street's rain goes.", text: 'Drive, then see if dust from your hard brakes reaches a salmon stream.' },
];

/** How long step i of slide 1 stays lit, in ms: the first a little longer. */
export const beat = (i: number): number => (i === 0 ? 2200 : 1800);

/**
 * Slide 2's sample card: the sample drive's smooth score and the share of extra gas its habits burned
 * (public/data/sample-drive.json through the engine; a test checks both against it).
 */
export const SAMPLE_CARD = { score: 69, gasShare: 0.1346 } as const;

/** The sample drive's extra cents a gallon at today's price, rounded as its report shows it. Null with no price. */
export function sampleCents(p = gasPrice()): number | null {
  return p ? roundCents(100 * SAMPLE_CARD.gasShare * p.usdPerGal) : null;
}

/** Why rain matters, each fact with its source. Behind The science on slide 1, and on About under Sources and methods. */
export const SCIENCE: readonly { fact: string; source: string; href?: string }[] = [
  { fact: 'Rain washes tire dust off roads into storm drains, and some drains flow to creeks.', source: 'City and county pipe maps, traced by TireTrail' },
  // daily surveys 2002 to 2009; affected fish died within hours
  { fact: "In Seattle's Longfellow Creek, 60 to 100% of coho died each fall before they could spawn.", source: 'Scholz et al. 2011, PLoS ONE', href: 'https://doi.org/10.1371/journal.pone.0028013' },
  // online Dec 3 2020; lead author Zhenyu Tian, co-senior authors Ed Kolodziej (UW Tacoma) and Jenifer McIntyre (WSU)
  { fact: "In 2020, Ed Kolodziej's lab at UW Tacoma, with WSU, traced it to 6PPDQ, from a tire chemical.", source: 'Tian et al. 2021, Science', href: 'https://doi.org/10.1126/science.abd6951' },
  // USTMA: no new tire it knows of is made without 6PPD
  { fact: '6PPD is in nearly every tire on the road.', source: 'US Tire Manufacturers Association' },
  { fact: 'Gentle stops shed less tire dust, so less washes in.', source: 'Giechaskiel et al. 2024', href: 'https://doi.org/10.3390/su16020522' },
];

/** When coho come back, with its source. On About, under Sources and methods. */
export const SEASON_FACTS: readonly { fact: string; source: string; href?: string }[] = [
  { fact: 'In Big Beef Creek, a small Puget Sound stream, most coho swim in during October and November. Spawning can run from November into February.', source: 'Quinn 2025, Encyclopedia of Puget Sound', href: 'https://www.eopugetsound.org/article/coho-salmon-and-estuary-use-in-puget-sound' },
];

/** How TireTrail figures each thing: one plain line and where it comes from. About's Sources and methods. */
export const METHODS: readonly { term: string; line: string; source: string }[] = [
  // dust.ts: wear grows with the square of tire force; scale from on-road tests and the UN R117 route
  { term: 'Tire dust', line: 'An estimate for each drive. Hard brakes and fast starts grind more rubber off. Typical means the same roads driven like the UN tire wear test.', source: 'Pohrt 2019; Giechaskiel et al. 2024; UN R117' },
  // events.ts: 7 mph in one second
  { term: 'Hard brake', line: 'Your speed drops 7 mph or more in one second. A fast start is the same, speeding up.', source: 'Progressive Snapshot uses the same 7 mph rule' },
  // SALMON.brakeM in src/salmon/watch.ts
  { term: 'Crossed gently', line: 'No hard brake within 150 m (about 500 feet) of the creek.', source: 'TireTrail' },
  // gas.ts and money.ts
  { term: 'Gas', line: 'Hard brakes, fast starts and speeding burn extra gas. We estimate the cents they add to each gallon. Our scale: 2 a mile counts as fully aggressive.', source: 'fueleconomy.gov; Oak Ridge National Laboratory 2017; U.S. EIA weekly Washington price' },
  { term: 'Salmon creeks', line: 'Streams the state maps as salmon or steelhead habitat, documented or presumed.', source: 'WDFW and NWIFC, SWIFD' },
];

/** About, top to bottom. Its three rows: the problem, what it does, the data. {drains} is filled in. */
export const ABOUT = {
  title: 'A free drive coach that helps you brake gently near salmon creeks.',
  rows: [
    { icon: 'icon-salmon', head: 'Tire dust is killing coho in city creeks', line: 'Rain washes it into creeks. In some, most coho die before they spawn.' },
    { icon: 'icon-car', head: 'It coaches you as you drive', line: 'A voice warns you before salmon creeks and your hard-brake spots.' },
    { icon: 'icon-grate', head: 'Built on public maps', line: "The state's salmon stream map and {drains} drains from local pipe maps." },
  ],
  privacy: [
    'Signed out, your drives stay on this phone.',
    'Sign in to back them up and see them on any device.',
    // summary.ts drops points within 300 m of each end from the synced copy
    'Backups skip the first and last 300 m (about 1,000 feet) of every drive, so your home stays private.',
    'To delete, open Account. You can clear your backup, this phone, or both.',
  ],
} as const;
