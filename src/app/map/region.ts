// Outlines beyond the town: the US, Washington, Pierce County and its cities.
import type { XY } from '../../geo/geo.ts';

export interface Shape {
  rings: XY[][];
  box: [number, number, number, number];
}
export interface State extends Shape { id: string; name: string; west: boolean; at: XY }
export interface County extends Shape { name: string; home: boolean; at: XY }
export interface Place extends Shape { name: string; at: XY; area: number }
export interface Point { name: string; at: XY; kind: 'city' | 'peak' | 'water' }

interface Raw {
  states: { id: string; name: string; west: boolean; at: XY; rings: number[][] }[];
  detail: { id: string; rings: number[][] }[];
  abroad: number[][];
  counties: { name: string; home: boolean; at: XY; rings: number[][] }[];
  places: { name: string; at: XY; rings: number[][] }[];
  points: Point[];
}

function ring(d: number[]): XY[] {
  const out: XY[] = [];
  let x = 0, y = 0;
  for (let k = 0; k < d.length; k += 2) out.push([(x += d[k]), (y += d[k + 1])]);
  return out;
}

function shape(rings: number[][]): Shape {
  const rs = rings.map(ring);
  const box: Shape['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rs) for (const [x, y] of r) {
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
  }
  return { rings: rs, box };
}

function area(rings: XY[][]): number {
  let a = 0;
  for (const r of rings) for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
  return Math.abs(a / 2);
}

export class Region {
  readonly states: State[];
  readonly detail = new Map<string, Shape>();
  readonly abroad: Shape[];
  readonly counties: County[];
  readonly places: Place[];
  readonly points: Point[];
  /** lower 48 */
  readonly usBox: Shape['box'];
  /** everywhere TireTrail has traced drains (coverage.json) */
  readonly coverage: Shape | null;

  constructor(raw: Raw, cover?: { rings: number[][] } | null) {
    this.states = raw.states.map((s) => ({ ...shape(s.rings), id: s.id, name: s.name, west: s.west, at: s.at }));
    for (const d of raw.detail) this.detail.set(d.id, shape(d.rings));
    this.abroad = raw.abroad.map((r) => shape([r]));
    this.counties = raw.counties.map((c) => ({ ...shape(c.rings), name: c.name, home: c.home, at: c.at }));
    this.places = raw.places.map((p) => { const s = shape(p.rings); return { ...s, name: p.name, at: p.at, area: area(s.rings) }; });
    this.points = raw.points;
    const b = this.states.map((s) => s.box);
    this.usBox = [Math.min(...b.map((q) => q[0])), Math.min(...b.map((q) => q[1])), Math.max(...b.map((q) => q[2])), Math.max(...b.map((q) => q[3]))];
    this.coverage = cover?.rings.length ? shape(cover.rings) : null;
  }

  get home(): County | undefined {
    return this.counties.find((c) => c.home);
  }
}

export async function loadRegion(url = 'data/region.json', coverUrl = 'data/coverage.json'): Promise<Region | null> {
  try {
    const [res, cov] = await Promise.all([fetch(url), fetch(coverUrl).catch(() => null)]);
    if (!res.ok) return null;
    const cover = cov?.ok ? ((await cov.json().catch(() => null)) as { rings: number[][] } | null) : null;
    return new Region((await res.json()) as Raw, cover);
  } catch {
    return null;
  }
}
