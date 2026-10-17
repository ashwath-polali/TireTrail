// Subset of GeoJSON (RFC 7946) the city layers use.

export type Position = number[];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export type Properties = Record<string, unknown>;

export interface Feature<P = Properties> {
  type: 'Feature';
  geometry: Geometry | null;
  properties: P;
}

export interface FeatureCollection<P = Properties> {
  type: 'FeatureCollection';
  features: Feature<P>[];
}

/** City blanks are ' ' or null; trim everything to strings. */
export function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(text(v));
  return Number.isFinite(n) ? n : 0;
}
