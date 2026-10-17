// Jurisdiction polygons for King and Pierce (lon/lat), written by scripts/sources/context.ts.
import { readFileSync } from 'node:fs';
import { pointInPolygon, type XY } from '../../../src/geo/geo.ts';

export type County = 'King' | 'Pierce';
/** Polygons as rings of [lon, lat]; the first ring of each is the outer one. */
export type Polygons = [number, number][][][];
export type Box = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface Jurisdiction {
  /** 'Seattle', 'Tacoma', ..., 'Unincorporated King County' */
  name: string;
  kind: 'city' | 'unincorporated';
  /** counties the polygons cover (Auburn, Milton, Pacific, Enumclaw: both) */
  counties: County[];
  /** KC JURIS code or Pierce CITY_ID, where the source has one */
  code?: string;
  bbox: Box;
  polygons: Polygons;
}

export interface Boundaries {
  fetchedAt: string;
  credit: string;
  notes: string[];
  jurisdictions: Jurisdiction[];
  /** whole-county outlines (cities plus unincorporated) */
  counties: { name: County; bbox: Box; polygons: Polygons }[];
}

export const CONTEXT_DIR = `${process.env.TT_CACHE ?? '.cache'}/sources/context`;

export function readBoundaries(dir = CONTEXT_DIR): Boundaries {
  return JSON.parse(readFileSync(`${dir}/boundaries.json`, 'utf8')) as Boundaries;
}

export function boxOf(polygons: Polygons): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygons) {
    for (const [x, y] of poly[0] ?? []) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b;
}

const polyBoxes = new WeakMap<Polygons, Box[]>();

/** Point in any of the polygons (holes respected). */
export function inPolygons(polygons: Polygons, p: XY): boolean {
  let boxes = polyBoxes.get(polygons);
  if (!boxes) {
    boxes = polygons.map((poly) => boxOf([poly]));
    polyBoxes.set(polygons, boxes);
  }
  for (let i = 0; i < polygons.length; i++) {
    const b = boxes[i];
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
    if (pointInPolygon(p, polygons[i])) return true;
  }
  return false;
}

const inBox = (b: Box, p: XY): boolean => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** The jurisdiction a point is in: a city first, then a county's unincorporated area. */
export function jurisdictionAt(b: Boundaries, p: XY): Jurisdiction | null {
  let uninc: Jurisdiction | null = null;
  for (const j of b.jurisdictions) {
    if (!inBox(j.bbox, p) || (uninc && j.kind === 'unincorporated')) continue;
    if (!inPolygons(j.polygons, p)) continue;
    if (j.kind === 'city') return j;
    uninc = j;
  }
  if (uninc) return uninc;
  // slivers between the city and unincorporated layers: the county outline decides
  const c = countyAt(b, p);
  return c ? (b.jurisdictions.find((j) => j.kind === 'unincorporated' && j.counties[0] === c) ?? null) : null;
}

export function countyAt(b: Boundaries, p: XY): County | null {
  for (const c of b.counties) if (inBox(c.bbox, p) && inPolygons(c.polygons, p)) return c.name;
  return null;
}
