// Ground elevation at line ends (USGS 3DEP 1/3 arc-second, the terrain cache), to check which way lines are drawn.
import { DEM_DIR } from '../../terrain/config.ts';
import { Dem, PPD, tilesFor } from '../../terrain/dem.ts';

type LonLat = [number, number];

export interface Ground {
  /** meters, bilinear; NaN outside the window */
  at(p: LonLat): number;
}

/** One DEM window over a lon/lat box (w, s, e, n). */
export async function openGround(box: readonly [number, number, number, number]): Promise<Ground> {
  const dem = await Dem.open(tilesFor(box), DEM_DIR);
  const row0 = Dem.rowOf(box[3]) - 1, col0 = Dem.colOf(box[0]) - 1;
  const rows = Dem.rowOf(box[1]) - row0 + 2, cols = Dem.colOf(box[2]) - col0 + 2;
  const z = await dem.window(row0, col0, rows, cols);
  await dem.close();
  return {
    at([lon, lat]) {
      // pixel centers sit at +0.5
      const fr = (90 - lat) * PPD - 0.5 - row0, fc = (lon + 180) * PPD - 0.5 - col0;
      const r = Math.floor(fr), c = Math.floor(fc);
      if (r < 0 || c < 0 || r + 1 >= rows || c + 1 >= cols) return NaN;
      const dr = fr - r, dc = fc - c, i = r * cols + c;
      return (z[i] * (1 - dc) + z[i + 1] * dc) * (1 - dr) + (z[i + cols] * (1 - dc) + z[i + cols + 1] * dc) * dr;
    },
  };
}

/** 1 = the ground falls from the first vertex to the last by at least minDrop m, -1 = it rises, 0 = flat or unknown. */
export function groundSign(g: Ground, line: readonly LonLat[], minDrop = 0.5): number {
  const d = g.at(line[0]) - g.at(line[line.length - 1]);
  if (!Number.isFinite(d) || Math.abs(d) < minDrop) return 0;
  return d > 0 ? 1 : -1;
}
