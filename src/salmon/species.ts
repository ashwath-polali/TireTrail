// Salmon and steelhead in WDFW's SWIFD (Statewide Washington Integrated Fish Distribution), as bits.
import { bitmapSVG } from '../app/ui/glyphs.ts';

export const COHO = 1, CHINOOK = 2, CHUM = 4, PINK = 8, SOCKEYE = 16, STEELHEAD = 32;

/** SWIFD's SPECIES values, in the order the words list them */
export const SPECIES: readonly { bit: number; swifd: string; word: string }[] = [
  { bit: COHO, swifd: 'Coho Salmon', word: 'coho' },
  { bit: CHINOOK, swifd: 'Chinook Salmon', word: 'chinook' },
  { bit: CHUM, swifd: 'Chum Salmon', word: 'chum' },
  { bit: PINK, swifd: 'Pink Salmon', word: 'pink' },
  { bit: SOCKEYE, swifd: 'Sockeye Salmon', word: 'sockeye' },
  { bit: STEELHEAD, swifd: 'Steelhead Trout', word: 'steelhead' },
];

/** The species in bits, in the words' order. */
export function speciesIn(bits: number): (typeof SPECIES)[number][] {
  return SPECIES.filter((s) => bits & s.bit);
}

/** "Coho, chinook, steelhead" */
export function speciesList(bits: number): string {
  const w = SPECIES.filter((s) => bits & s.bit).map((s) => s.word).join(', ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * The one fish to name: coho if there, else the only one, else none. Coho are the salmon 6PPDQ kills at the
 * lowest levels found so far (LC50 95 ng/L, Tian and others, ES&T Letters 2022).
 */
export function oneFish(bits: number): string | null {
  if (bits & COHO) return 'Coho';
  const one = SPECIES.filter((s) => bits & s.bit);
  return one.length === 1 ? one[0].word.charAt(0).toUpperCase() + one[0].word.slice(1) : null;
}

// a small fish facing right: back, side, belly
const FISH = [
  '....BBBBB....',
  'B.BBBBBBBBB..',
  'BBSSSSSSS.SS.',
  '.SSSSSSSSSSSS',
  'LLLLLLLLLLLL.',
  'L.LLLLLLLLL..',
  '....LLLLL....',
];
/** each fish in its spawning colors: back, side, belly */
const LOOK: Record<number, [string, string, string]> = {
  [COHO]: ['#4f9ea3', '#e3503f', '#e3503f'],
  [CHINOOK]: ['#5e6b4f', '#a8574e', '#c9b8a8'],
  [CHUM]: ['#6e8f55', '#a58bd8', '#c7b26a'],
  [PINK]: ['#5d6b78', '#f29bb3', '#f1ece4'],
  [SOCKEYE]: ['#5f9e4a', '#e8483a', '#e8483a'],
  [STEELHEAD]: ['#6d8a8f', '#e98aa0', '#dfe5e8'],
};

/** One species as a small pixel fish in its spawning colors. */
export function speciesSVG(bit: number, scale = 2): string {
  const [B, S, L] = LOOK[bit] ?? LOOK[COHO];
  return bitmapSVG(FISH, scale, { B, S, L }, 'u-fish');
}
