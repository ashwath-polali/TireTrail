// Words for the first-open guide and About's problem section. No DOM, so tests run it.
// Sources: Scholz et al. 2011 (PLoS ONE), Tian et al. 2021 (Science), US Tire Manufacturers Association.

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
    kicker: 'PUGET SOUND SALMON', title: "Tire dust is killing Puget Sound's coho.",
    // Longfellow Creek: 60 to 100% of each fall run died before spawning (Scholz 2011)
    text: 'In some city creeks, most coho die after rain, before they spawn.',
    art: ['tut-1-brake', 'tut-2-drain', 'tut-3-pipes', 'tut-4-salmon'],
    // "some": the Bonney Lake pipe maps show only some drains reach a creek
    lines: ['Hard brakes shed tire dust.', 'Rain washes it into storm drains.', 'Some drains flow straight to creeks.', '6PPD-quinone, from nearly every tire, can kill coho within hours.'],
  },
  // the phone sits in a mount: set it up before you drive, then hands off
  { kicker: 'WHAT TIRETRAIL DOES', art: ['tut-5-voice'], title: 'Drive smoother. Help the salmon.', text: 'A voice warns you before places where you often brake hard.' },
  { kicker: 'YOUR TURN', art: ['tut-2-drain'], title: "See where your street's rain goes.", text: 'Drive, then see if dust from your hard brakes reaches a salmon stream.' },
];

/** The facts behind slide 1, each with its source. Shown on a tap, and on About. */
export const SCIENCE: readonly { fact: string; source: string }[] = [
  { fact: "In Seattle's Longfellow Creek, 60 to 100% of coho died each fall before they could spawn.", source: 'Scholz et al. 2011, PLoS ONE' },
  { fact: 'In 2020, scientists traced it to 6PPD-quinone, made from a chemical in tire rubber.', source: 'Tian et al. 2021, Science' },
  { fact: '6PPD is in nearly every tire on the road.', source: 'US Tire Manufacturers Association' },
];

/** About's first line on the problem. */
export const PROBLEM = 'In some Puget Sound city creeks, most returning coho die after rain, before they spawn.';

/** How long step i of slide 1 stays lit, in ms: the first a little longer. */
export const beat = (i: number): number => (i === 0 ? 4000 : 3000);
