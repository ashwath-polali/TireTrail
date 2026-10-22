// A tap on the map: the salmon stream under it, and its one line.
import type { XY } from '../geo/geo.ts';
import { segDist } from './build.ts';
import { speciesList } from './species.ts';
import type { Stream, Tile } from './tiles.ts';

/** The stream nearest p (region meters) within r, from loaded tiles. */
export function streamAt(tiles: readonly Tile[], p: XY, r: number): Stream | null {
  let best: Stream | null = null, bd = r;
  for (const t of tiles) for (const l of t.lines) {
    if (!l.stream || l.box[0] > p[0] + bd || l.box[2] < p[0] - bd || l.box[1] > p[1] + bd || l.box[3] < p[1] - bd) continue;
    for (let k = 1; k < l.pts.length; k++) {
      const d = segDist(p, l.pts[k - 1], l.pts[k]);
      if (d < bd) [bd, best] = [d, l.stream];
    }
  }
  return best;
}

/** "Coho, steelhead. 14 road crossings." */
export function streamLine(s: Stream): string {
  const n = s.crossings;
  return `${speciesList(s.sp)}. ${n === 0 ? 'No road crossings' : n === 1 ? '1 road crossing' : `${n.toLocaleString('en-US')} road crossings`}.`;
}
