// Words for the first-open guide and About. No DOM, so tests run it.
// Sources: Scholz et al. 2011 (PLoS ONE), Tian et al. 2021 (Science), US Tire Manufacturers Association.

export interface Step {
  /** 'pics': its pictures take turns, each with its line. 'road' and 'map': drawn stills (guide-art.ts) */
  art: 'pics' | 'road' | 'map';
  pics?: readonly string[];
  title: string;
  text?: string;
  lines?: readonly string[];
}

export const STEPS: readonly Step[] = [
  {
    art: 'pics', title: 'Tire dust is killing coho salmon.',
    pics: ['tut-1-brake', 'tut-2-drain', 'tut-3-pipes', 'tut-4-salmon'],
    // wear grows with tire force, braking or speeding up (dust.ts). "some": only some drains reach a creek.
    // the chemical is 6PPDQ (Tian 2021); its name stays behind "How we figure this"
    lines: ['Hard brakes grind more dust off your tires.', 'Rain washes it into storm drains.', 'Some drains flow straight to creeks.', 'A chemical in it can kill coho within hours.'],
  },
  // the phone sits in a mount: set it up before you drive, then hands off
  { art: 'road', title: 'TireTrail rides along.', text: 'It says when a salmon creek is ahead, and learns where you brake hard.' },
  { art: 'map', title: 'After each drive, see how you did.', text: 'How gently you crossed each creek, one thing to fix, and the gas it cost.' },
];

/** How long step i of slide 1 stays lit, in ms: the first a little longer. */
export const beat = (i: number): number => (i === 0 ? 2200 : 1800);

/** Slide 2's voice line: what the coach says before Clover Creek (salmonWords in src/salmon/watch.ts). */
export const ROAD_SAY = 'Clover Creek ahead. Coho stream.';

/** Slide 3's line under the map: the sample drive's creeks (a test checks them against the data). */
export function mapSay(gentle: number, crossed: number): { n: string; rest: string } {
  return { n: `${gentle} of ${crossed}`, rest: crossed === 1 ? 'salmon creek crossed gently' : 'salmon creeks crossed gently' };
}

/** The facts behind slide 1, each with its source. On About, under Sources and methods. */
export const SCIENCE: readonly { fact: string; source: string }[] = [
  // daily surveys 2002 to 2009; affected fish died within hours
  { fact: "In Seattle's Longfellow Creek, 60 to 100% of coho died each fall before they could spawn.", source: 'Scholz et al. 2011, PLoS ONE' },
  // online Dec 3 2020; lead author Zhenyu Tian, co-senior authors Ed Kolodziej (UW Tacoma) and Jenifer McIntyre (WSU)
  { fact: "In 2020, Ed Kolodziej's lab at UW Tacoma, with WSU, traced it to 6PPDQ, from a tire chemical.", source: 'Tian et al. 2021, Science' },
  // USTMA: no new tire it knows of is made without 6PPD
  { fact: '6PPD is in nearly every tire on the road.', source: 'US Tire Manufacturers Association' },
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

/** About, top to bottom. Its three rows: the problem, what it does, the data. {drains} is filled in. */
export const ABOUT = {
  title: 'A free drive coach that helps you brake gently near salmon creeks.',
  rows: [
    { icon: 'icon-salmon', head: 'Tire dust is killing coho', line: 'Rain washes it into creeks. In some, most coho die before they spawn.' },
    { icon: 'icon-car', head: 'It coaches you as you drive', line: 'A voice warns you before salmon creeks and where you often brake hard.' },
    { icon: 'icon-grate', head: 'Built on real maps', line: "The state's salmon stream map and {drains} drains from local pipe maps." },
  ],
  privacy: [
    'Signed out, your drives stay on this phone.',
    'Sign in to back them up and see them on any device.',
    // summary.ts drops points within 300 m of each end from the synced copy
    'Backups leave out the first and last 300 m of every route.',
    'To delete, open Account. You can clear your backup, this phone, or both.',
  ],
} as const;
