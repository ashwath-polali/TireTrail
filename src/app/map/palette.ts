// Map colors and line codes in one place, for the map, the legend and the cards.
import type { Cls } from './world.ts';

/** chip and text color per answer; treatment stays apart from the rest for color-blind eyes too */
export const CAT: Record<Cls, string> = {
  creek: '#e98552', ground: '#7fd8c0', elsewhere: '#b6aaff', unknown: '#9aa39d', none: '#9aa39d', treatment: '#ffffff',
};
/** salmon streams on the map: bright water with coral flecks (coral alone means a street draining to one) */
export const SALMON = '#e98552';
export const SALMON_WATER = '#74c8ec';
/** a coral fleck every this many px along a salmon stream */
export const FLECK = 5;
export const ROAD = { fill: '#7d847e', fillFar: '#6b726c', casing: '#1e2721', asphalt: ['#4b5056', '#464b51'], edge: '#2b2e31' } as const;
export const PICK = { band: '#ffe08a', casing: '#1a1712' } as const;
export const ROUTE = { fill: '#f2d27a', casing: '#1a1712' } as const;
export const TRIP = { dot: '#5ec6ee', hi: '#c4ecfa', casing: '#0d1b21' } as const;
/** other water: art px on, then off */
export const DASH = [3, 2];
export const HATCH = { stripe: '#0c100e', wash: '#1a201c', edge: '#93a48d' } as const;

/** w: art px wide, near: stripe width at mpp <= 1.3, dash: art px on and off (null = solid) */
export interface LineCode { w: number; near: number; dash: readonly number[] | null }
export const LINE: Record<'creek' | 'ground' | 'elsewhere' | 'treatment', LineCode> = {
  creek: { w: 2, near: 3, dash: null },
  ground: { w: 1, near: 2, dash: null },
  elsewhere: { w: 1, near: 2, dash: DASH },
  // dash-dot
  treatment: { w: 2, near: 2, dash: [4, 1, 1, 1] },
};

const LAND = '#3c5334';

export type Swatch = Cls | 'stream' | 'coho' | 'salmon' | 'drain' | 'hatch' | 'traced' | 'pick';
export type Band = 'town' | 'overview' | 'region';

/** A 36x12 legend mark drawn like the map at that zoom (12x4 art px). */
export function swatchSVG(kind: Swatch, band: Band): string {
  const px: string[] = [];
  const put = (x: number, y: number, w: number, h: number, c: string) => px.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`);
  const dashed = (y: number, h: number, on: string, off: string, dash: readonly number[]) => {
    for (let x = 0, k = 0; x < 12; x += dash[k % dash.length], k++) put(x, y, Math.min(dash[k % dash.length], 12 - x), h, k % 2 ? off : on);
  };
  const town = band === 'town', cased = band === 'overview';
  const cls = kind === 'unknown' ? 'none' : kind;
  if (cls === 'creek' || cls === 'ground' || cls === 'elsewhere' || cls === 'treatment' || cls === 'none' || cls === 'drain') {
    if (town || cls === 'drain') {
      // asphalt, with the stripe down the middle
      for (let x = 0; x < 12; x++) put(x, 0, 1, 4, ROAD.asphalt[x & 1]);
      if (cls === 'drain') { put(5, 1, 3, 2, '#1f2326'); put(6, 1, 1, 1, '#7c8389'); }
      else if (cls !== 'none') {
        const L = LINE[cls], y = L.w > 1 ? 1 : 2;
        if (L.dash) dashed(y, L.w, CAT[cls], ROAD.asphalt[0], L.dash);
        else put(0, y, 12, L.w, CAT[cls]);
      }
    } else {
      put(0, 0, 12, 4, LAND);
      const w = cls === 'none' ? 1 : LINE[cls].w, y = w > 1 ? 1 : 2;
      if (cased) { put(0, y - 1, 12, 1, ROAD.casing); put(0, y + w, 12, 1, ROAD.casing); }
      const col = cls === 'none' ? ROAD.fill : CAT[cls], dash = cls === 'none' ? null : LINE[cls].dash;
      if (dash) dashed(y, w, col, cased ? ROAD.casing : LAND, dash);
      else put(0, y, 12, w, col);
    }
  } else if (cls === 'stream' || cls === 'coho' || cls === 'salmon') {
    // a creek cased in dark water; a salmon stream brighter, with coral flecks and, up close, a coho
    const sal = cls !== 'stream';
    put(0, 0, 12, 4, LAND);
    put(0, 1, 12, 3, '#22404a');
    put(0, 2, 12, 1, sal ? SALMON_WATER : '#5591a3');
    if (cls === 'salmon') for (let x = 2; x < 12; x += FLECK) put(x, 2, 1, 1, SALMON);
    if (cls === 'coho') {
      // a tiny coho on the line, facing left: outline, body and belly, eye, tail
      const ink = '#1a1712';
      put(3, 0, 5, 1, ink); put(3, 3, 5, 1, ink); put(2, 1, 1, 2, ink);
      put(3, 1, 5, 1, CAT.creek); put(3, 2, 1, 1, CAT.creek); put(4, 2, 4, 1, '#f4f1e6');
      put(4, 1, 1, 1, ink);
      put(8, 1, 1, 2, ink); put(9, 0, 1, 4, CAT.creek); put(10, 0, 1, 4, ink);
    }
  } else if (cls === 'hatch') {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 12; i++) put(i, j, 1, 1, (i + j) % 6 === 0 ? mix(LAND, HATCH.stripe, .45) : mix(LAND, HATCH.wash, .18));
    for (let i = 0; i < 12; i += 4) put(i, 0, 2, 1, HATCH.edge);
  } else if (cls === 'traced') {
    // the land under a light yellow, inside a yellow edge, as the region map draws it
    put(0, 0, 12, 4, ROUTE.fill);
    put(1, 1, 10, 2, mix(LAND, ROUTE.fill, .3));
  } else {
    // the picked street: a light band with dark edges
    put(0, 0, 12, 4, PICK.casing);
    put(0, 1, 12, 2, PICK.band);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="12" viewBox="0 0 12 4" shape-rendering="crispEdges" aria-hidden="true">${px.join('')}</svg>`;
}

/** a mixed t of the way from color a to color b */
export function mix(a: string, b: string, t: number): string {
  const p = parseInt(a.slice(1), 16), q = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((p >> s) & 255) + (((q >> s) & 255) - ((p >> s) & 255)) * t).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
