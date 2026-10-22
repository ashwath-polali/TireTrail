// One call to get estimate(lon, lat) anywhere in King and Pierce (build time, Node only).
//   const terrain = await openTerrain([-122.5, 47.0, -122.2, 47.3]);
//   const e = await terrain.estimate(-122.3, 47.1); // { kind, name, coho, distanceM, ... }
import { DEM_DIR, KING_PIERCE_BOX } from './config.ts';
import { Dem, ensureTiles, tilesFor } from './dem.ts';
import { Estimator, type Estimate, type EstimateOptions } from './estimate.ts';
import { loadWaters, type Box } from './waters.ts';

export interface Terrain {
  estimate(lon: number, lat: number): Promise<Estimate>;
  estimateAll(points: readonly { lon: number; lat: number }[], log?: (s: string) => void): Promise<Estimate[]>;
  notes: string[];
  close(): Promise<void>;
}

/** Downloads what's missing, loads the waters meeting box (pad it past the points) and opens the DEM. */
export async function openTerrain(box: Box = KING_PIERCE_BOX, opts: Partial<EstimateOptions> = {}, log: (s: string) => void = () => {}): Promise<Terrain> {
  const tiles = tilesFor(KING_PIERCE_BOX);
  await ensureTiles(tiles, DEM_DIR, log);
  const dem = await Dem.open(tiles, DEM_DIR);
  const waters = await loadWaters(box, { log });
  const est = new Estimator(dem, waters, opts);
  return {
    estimate: (lon, lat) => est.estimate(lon, lat),
    estimateAll: (points, l) => est.estimateAll(points, l),
    notes: waters.notes,
    close: () => dem.close(),
  };
}
