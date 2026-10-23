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
    // wear grows with tire force, braking or speeding up (dust.ts). "some": only some drains reach a creek
    lines: ['Hard brakes and fast starts shed more tire dust.', 'Rain washes it into storm drains.', 'Some drains flow straight to creeks.', '6PPDQ, from nearly every tire, can kill coho within hours.'],
  },
  // the phone sits in a mount: set it up before you drive, then hands off
  { kicker: 'EVERY DRIVE', art: ['tut-5-voice'], title: 'See the salmon streams you cross.', text: 'Plus your tire dust, and the gas your habits cost.' },
  { kicker: 'YOUR TURN', art: ['tut-2-drain'], title: 'Set it up, then drive.', text: 'A voice helps along the way. Hands off the phone.' },
];

/** The facts behind slide 1, each with its source. Shown on a tap, and on About. */
export const SCIENCE: readonly { fact: string; source: string }[] = [
  // daily surveys 2002 to 2009; affected fish died within hours
  { fact: "In Seattle's Longfellow Creek, 60 to 100% of coho died each fall before they could spawn.", source: 'Scholz et al. 2011, PLoS ONE' },
  // online Dec 3 2020; lead author Zhenyu Tian, co-senior authors Ed Kolodziej (UW Tacoma) and Jenifer McIntyre (WSU)
  { fact: "In 2020, Ed Kolodziej's lab at UW Tacoma, with WSU, traced it to 6PPDQ, from a tire chemical.", source: 'Tian et al. 2021, Science' },
  // USTMA: no new tire it knows of is made without 6PPD
  { fact: '6PPD is in nearly every tire on the road.', source: 'US Tire Manufacturers Association' },
];

/** About's first line on the problem. */
export const PROBLEM = 'In some Puget Sound city creeks, most coho die before they spawn.';

/**
 * Slide 2's sample card: the sample drive's salmon stream crossings, the salmon stream its rain reaches,
 * and its tire dust (grams, and % more than typical). From public/data/sample-drive.json; a test checks they match.
 * gasCents: the cents its habits add to a gallon, once the gas module gives one; null shows no gas cell.
 */
export const SAMPLE_CARD: { grams: number; overPct: number; creek: string; streams: number; gasCents: number | null } = { grams: 0.34, overPct: 11, creek: 'Fennel Creek', streams: 0, gasCents: null };

/** The salmon cell's words: streams crossed, or the one its rain reaches. */
export function sampleSalmon(c: Pick<typeof SAMPLE_CARD, 'streams' | 'creek'> = SAMPLE_CARD): { n: number; unit: string; caption: string } {
  if (c.streams > 0) return { n: c.streams, unit: c.streams === 1 ? 'stream' : 'streams', caption: 'crossed' };
  return { n: 1, unit: 'stream', caption: `Rain reaches ${c.creek}` };
}

/** How long step i of slide 1 stays lit, in ms: the first a little longer. */
export const beat = (i: number): number => (i === 0 ? 2200 : 1800);
