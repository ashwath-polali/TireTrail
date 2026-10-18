// Small pixel pictures for the Drive screens, as SVG strings drawn on whole pixels.
import { answered, type StopClass } from '../../drive/tips.ts';
import { CAT } from '../map/palette.ts';
import type { Pin } from '../map/render.ts';
import type { Tone } from '../ui/ui.ts';

// 3x5 digits, as on the map pins
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
const rect = (x: number, y: number, w: number, ht: number, c: string) => `<rect x="${x}" y="${y}" width="${w}" height="${ht}" fill="${c}"/>`;

/** A hard brake's map pin with its number, as the map draws it: class color, or hollow for no answer. */
export function pinSVG(cls: StopClass, n: number, s = 3): string {
  const ok = answered(cls);
  let px = rect(0, 0, 9, 10, '#1a1712') + (ok ? rect(1, 1, 7, 8, CAT[cls]) : rect(1, 1, 7, 8, '#9aa39d') + rect(2, 2, 5, 6, '#3a413c'));
  px += rect(3, 10, 3, 2, '#1a1712') + rect(4, 12, 1, 1, '#1a1712');
  const d = DIGITS[n % 10];
  for (let k = 0; k < 15; k++) if (d[k] === '1') px += rect(3 + (k % 3), 3 + Math.floor(k / 3), 1, 1, ok ? '#1a1712' : '#eef2ec');
  return `<svg viewBox="0 0 9 13" width="${9 * s}" height="${13 * s}" shape-rendering="crispEdges" aria-hidden="true">${px}</svg>`;
}

/** The badge a pin wears for its answer. */
export const BADGE: Record<StopClass, Pin['badge']> = { creek: 'fish', ground: 'soak', elsewhere: 'waves', treatment: 'plant', unknown: 'q', none: 'q' };

/** The kit tone for an answer. */
export function clsTone(cls: StopClass): Tone {
  switch (cls) {
    case 'creek': return 'salmon';
    case 'ground': return 'soak';
    case 'elsewhere': return 'other';
    default: return 'plain';
  }
}

/** The kit glyph for an answer. */
export function clsGlyph(cls: StopClass): string {
  switch (cls) {
    case 'creek': return 'fish';
    case 'ground': return 'soak';
    case 'elsewhere': return 'wave';
    case 'treatment': return 'drop';
    case 'unknown': return 'info';
    default: return 'drop';
  }
}

/** The pixel art picture for an answer, as an img string the kit's insight takes. */
export function clsArt(cls: StopClass, code = ''): string {
  const pic = cls === 'creek' ? 'icon-salmon' : cls === 'ground' ? (/pond/.test(code) ? 'icon-pond' : 'icon-soil') : cls === 'elsewhere' ? 'icon-pond'
    : cls === 'unknown' ? 'icon-pipe' : cls === 'treatment' ? 'icon-pipe' : 'icon-grate';
  return `<img src="art/${pic}.png" width="48" height="48" alt="">`;
}

/** A map pin for a learned spot: amber, with a "!" */
export function spotPinSVG(s = 3): string {
  let px = rect(0, 0, 9, 10, '#1a1712') + rect(1, 1, 7, 8, '#ffd166') + rect(3, 10, 3, 2, '#1a1712') + rect(4, 12, 1, 1, '#1a1712');
  px += rect(4, 2, 1, 4, '#1a1712') + rect(4, 7, 1, 1, '#1a1712');
  return `<svg viewBox="0 0 9 13" width="${9 * s}" height="${13 * s}" shape-rendering="crispEdges" aria-hidden="true">${px}</svg>`;
}
