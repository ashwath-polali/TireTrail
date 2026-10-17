// Card text for a tapped street: normal-map guess vs real pipes.
import type { StreetClass } from '../trace/streets.ts';

export interface Twist {
  /** terrain-only guess */
  normalMap: string;
  /** what the pipes say */
  realPipes: string;
  /** answers disagree */
  differs: boolean;
  text: string;
}

// "Puyallup River (direct drainage)" -> "the Puyallup River"
function waterName(name: string): string {
  const plain = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return /\b(River|Creek)\b/.test(plain) && !/^the /i.test(plain) ? `the ${plain}` : plain;
}

function terrainPhrase(cls: StreetClass, name: string): string {
  if (cls === 'creek') return 'the creek';
  if (cls === 'ground') return 'the ground';
  if (cls === 'elsewhere') return name ? waterName(name) : 'somewhere else';
  return 'no clear answer';
}

function pipesPhrase(cls: StreetClass, receiving: string): string {
  if (cls === 'creek') return 'the creek';
  if (cls === 'ground') return 'the ground';
  if (cls === 'elsewhere') return receiving ? waterName(receiving) : 'somewhere else';
  if (cls === 'unknown') return 'not mapped';
  return 'no mapped drain nearby';
}

// `receiving` = the street's drain's receiving water, used for "elsewhere"
export function twist(terrain: { cls: StreetClass; name: string }, pipes: StreetClass, receiving = ''): Twist {
  const normalMap = terrainPhrase(terrain.cls, terrain.name);
  const realPipes = pipesPhrase(pipes, receiving);
  const known = pipes === 'creek' || pipes === 'ground' || pipes === 'elsewhere';
  const differs = known && terrain.cls !== 'unknown' && normalMap !== realPipes;
  const text =
    known && !differs
      ? `A normal map guesses: ${normalMap}. The real pipes agree: ${realPipes}.`
      : `A normal map guesses: ${normalMap}. The real pipes: ${realPipes}.`;
  return { normalMap, realPipes, differs, text };
}
