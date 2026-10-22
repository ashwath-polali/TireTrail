// Salmon and steelhead in WDFW's SWIFD (Statewide Washington Integrated Fish Distribution), as bits.

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
