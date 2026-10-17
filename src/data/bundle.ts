// Data file the app loads. Built by scripts/build-data.ts.
// Coords: integer microdegrees (~0.1 m), delta-encoded [lon0, lat0, dlon, dlat, ...].
import type { LngLat } from '../geo/geo.ts';
import type { AssetKind } from '../trace/assets.ts';
import type { AppNumbers } from '../trace/numbers.ts';
import type { StreetClass } from '../trace/streets.ts';
import type { EndingCode } from '../trace/trace.ts';

export const BUNDLE_FORMAT = 'tiretrail-bundle';
export const BUNDLE_VERSION = 1;
export const COORD_SCALE = 1e6;

export const KINDS: readonly AssetKind[] = ['structure', 'inlet', 'outlet', 'vault', 'barrier', 'pipe', 'channel', 'pond'];
export const CLASSES: readonly StreetClass[] = ['creek', 'ground', 'elsewhere', 'unknown', 'none'];
export const CONFIDENCES = ['high', 'likely', 'none'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CREDITS: readonly string[] = [
  'City of Bonney Lake storm data (SWCP 2026 layers, consultant-hosted, unofficial screening data)',
  'Pierce County GIS',
  'WDFW SWIFD',
  'USGS NHD',
];
export const DISCLAIMER =
  'Independent student project, not endorsed by Pierce County, the City of Bonney Lake, UW or WDFW. Planning-level estimates.';

/** County area bundles (scripts/build-county.ts). */
export const COUNTY_CREDITS: readonly string[] = [
  'Pierce County GIS drainage, road and hydrography layers (unincorporated Pierce County), provided as is, without warranty',
  'WDFW SWIFD (coho distribution)',
  'US Census Bureau TIGERweb (place names)',
];
export const COUNTY_DISCLAIMER =
  'Independent student project. Not made, reviewed or endorsed by Pierce County, UW or WDFW. Pierce County data is provided as is, without warranty of any kind. Planning-level estimates.';

export interface BundleEnding {
  code: EndingCode;
  cls: number;
  confidence: number;
  terminal: number;
  exit: number;
  receiving: string;
  reason: string;
}

export interface BundleFixItem {
  rank: number;
  label: string;
  exit: number;
  receiving: string;
  streetM: number;
  inferredStreetM: number;
  drains: number;
  streets: string[];
  bridges: string[];
  /** microdegrees */
  at: [number, number];
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  credits: readonly string[];
  disclaimer: string;
  /** first 16 hex of SHA-256 per input file */
  sources: Record<string, string>;
  assets: {
    key: string[];
    kind: number[];
    /** point: 1 coord. line: vertices in flow order. pond: centroid. */
    geom: number[][];
  };
  /** pond outer rings: [asset index, ring] */
  pondShapes: [number, number[]][];
  /** next asset downstream, -1 = none */
  next: number[];
  /** deduped; drains index into this */
  endings: BundleEnding[];
  drains: {
    asset: number[];
    ending: number[];
    /** paths next[] can't rebuild, by drain index */
    explicitPaths: Record<string, number[]>;
  };
  streets: {
    pieces: { id: number; name: string; lengthM: number; cls: number; terrainCls: number; terrainName: string }[];
    runs: { piece: number[]; drain: number[]; cls: number[]; geom: number[][] };
  };
  /** fennel: in the Fennel Creek system; in county area bundles, coho-bearing water instead. */
  waters: { name: string; kind: 'creek' | 'lake' | 'nhd'; fennel: boolean; lines: number[][]; rings: number[][] }[];
  fixList: BundleFixItem[];
  numbers: AppNumbers;
}

export function encodeCoords(coords: readonly LngLat[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out;
}

export function decodeCoords(enc: readonly number[]): LngLat[] {
  const out: LngLat[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < enc.length; i += 2) {
    x += enc[i];
    y += enc[i + 1];
    out.push([x / COORD_SCALE, y / COORD_SCALE]);
  }
  return out;
}

// rebuild a drain's path from next[], or its explicit path
export function decodePath(b: Pick<Bundle, 'next' | 'endings' | 'drains'>, drain: number): number[] {
  const explicit = b.drains.explicitPaths[String(drain)];
  if (explicit) return explicit;
  const terminal = b.endings[b.drains.ending[drain]].terminal;
  const path = [b.drains.asset[drain]];
  while (path[path.length - 1] !== terminal) {
    const next = b.next[path[path.length - 1]];
    if (next < 0 || path.length > b.next.length) throw new Error(`broken path for drain ${drain}`);
    path.push(next);
  }
  return path;
}
