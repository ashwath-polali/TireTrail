// Words for the first-open guide and About. No DOM, so tests run it.
// Sources: Scholz et al. 2011 (PLoS ONE), Tian et al. 2021 (Science), Giechaskiel et al. 2024, US Tire Manufacturers Association, Quinn 2025.

export interface Step {
  /** 'pics': a picture (several take turns when there are lines). 'road' and 'map': drawn stills (guide-art.ts) */
  art: 'pics' | 'road' | 'map';
  pics?: readonly string[];
  title: string;
  text?: string;
  lines?: readonly string[];
}

export const STEPS: readonly Step[] = [
  // what it does in the car first; the phone sits in a mount: set it up before you drive, then hands off
  { art: 'road', title: 'A voice warns you as you drive.', text: 'It tells you when a salmon creek or your hard-brake spot is coming up.' },
  { art: 'map', title: 'After each drive, one thing to fix.', text: 'Hard brakes waste gas. See what yours cost.' },
  // only some drains reach a creek, so "can"; the chemical's name and the science sit on About
  { art: 'pics', pics: ['hero'], title: 'Rain can wash tire dust into salmon creeks.', text: 'A chemical in it can kill coho within hours. Gentle stops leave less behind.' },
];

/** How long step i of a slide with lines stays lit, in ms: the first a little longer. */
export const beat = (i: number): number => (i === 0 ? 2200 : 1800);

/** Slide 1's voice line: what the coach says before Clover Creek (salmonWords in src/salmon/watch.ts). */
export const ROAD_SAY = 'Clover Creek ahead. Coho stream.';

/** Slide 2's line under the map: the sample drive's creeks (a test checks them against the data). */
export function mapSay(gentle: number, crossed: number): { n: string; rest: string } {
  return { n: `${gentle} of ${crossed}`, rest: crossed === 1 ? 'salmon creek crossed gently' : 'salmon creeks crossed gently' };
}

/** Why rain matters, each fact with its source. On About, under Sources and methods. */
export const SCIENCE: readonly { fact: string; source: string; href?: string }[] = [
  { fact: 'Rain washes tire dust off roads into storm drains, and some drains flow straight to creeks.', source: 'City and county pipe maps, traced by TireTrail' },
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
  { fact: 'Most coho swim up small Puget Sound streams in October and November. They spawn from November into February.', source: 'Quinn 2025, Encyclopedia of Puget Sound', href: 'https://www.eopugetsound.org/article/coho-salmon-and-estuary-use-in-puget-sound' },
];

/** How TireTrail figures each thing: one plain line and where it comes from. About's Sources and methods. */
export const METHODS: readonly { term: string; line: string; source: string }[] = [
  // dust.ts: wear grows with the square of tire force; scale from on-road tests and the UN R117 route
  { term: 'Tire dust', line: 'An estimate for each drive. Hard brakes and fast starts grind more rubber off.', source: 'Pohrt 2019; Giechaskiel et al. 2024; UN R117' },
  // events.ts: 7 mph in one second
  { term: 'Hard brake', line: 'Your speed drops 7 mph or more in one second. A fast start is the same, speeding up.', source: 'The rule many insurance driving apps use' },
  // SALMON.brakeM in src/salmon/watch.ts
  { term: 'Crossed gently', line: 'No hard brake within 150 m (about 500 feet) of the creek.', source: 'TireTrail' },
  // gas.ts and money.ts
  { term: 'Gas', line: 'Hard brakes and fast starts burn extra gas. We estimate the cents they add to each gallon.', source: 'fueleconomy.gov; Oak Ridge National Laboratory 2017; U.S. EIA weekly Washington price' },
  { term: 'Salmon creeks', line: 'Streams where the state records salmon or steelhead.', source: 'WDFW and NWIFC, SWIFD' },
];

/** About: the same pitch as home, then how it works on one picture: a spot to tap on the car, the drain and the creek. */
export const ABOUT = {
  // x and y: the spot's middle on art/hero.png, as a share of its width and height
  spots: [
    { key: 'car', icon: 'car', label: 'The car', x: 0.286, y: 0.33, line: 'Hard brakes grind more dust off your tires.' },
    { key: 'drain', icon: 'drop', label: 'The storm drain', x: 0.508, y: 0.495, line: 'Rain washes it into storm drains, and some flow straight to creeks.' },
    { key: 'creek', icon: 'fish', label: 'The creek', x: 0.49, y: 0.86, line: 'A chemical in tire dust can kill coho within hours.' },
  ],
  privacy: [
    'Signed out, your drives stay on this phone.',
    'Sign in to back them up and see them on any device.',
    // summary.ts drops points within 300 m of each end from the synced copy
    'Backups leave out the first and last 300 m of every route.',
    'To delete, open Account. You can clear your backup, this phone, or both.',
  ],
} as const;
