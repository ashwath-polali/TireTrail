// Outlines beyond the town: the US, Washington, Pierce County and its cities.
// They are in the region map's conic (scripts/lib/lcc.ts); toWorld puts them in street meters.
import { localProjection, ORIGIN, pointInPolygon, type XY } from '../../geo/geo.ts';

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
  return { rings: rs, box: boxOf(rs) };
}

// the conic's constants, as in scripts/lib/lcc.ts
const LP = localProjection();
const phi0 = (ORIGIN[1] * Math.PI) / 180, lam0 = (ORIGIN[0] * Math.PI) / 180;
const n = Math.sin(phi0);
const F = (Math.cos(phi0) * Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n)) / n;
const rho = (phi: number) => F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);
const kx = (LP.metersPerDegLon * 180) / Math.PI / Math.cos(phi0), ky = (LP.metersPerDegLat * 180) / Math.PI;

/** Region map point to world meters (as World.toWorld). */
export function worldPt([X, Y]: XY): XY {
  const x1 = X / kx, c = rho0 + Y / ky, r = Math.hypot(x1, c), th = Math.atan2(x1, c);
  const lat = 2 * Math.atan(Math.pow(F / r, 1 / n)) - Math.PI / 2, lon = lam0 + th / n;
  const p = LP.toXY([(lon * 180) / Math.PI, (lat * 180) / Math.PI]);
  return [p[0], -p[1]];
}

/** World meters to a region map point. */
export function regionPt([x, y]: XY): XY {
  const [lon, lat] = LP.toLngLat([x, -y]);
  const r = rho((lat * Math.PI) / 180), th = n * ((lon * Math.PI) / 180 - lam0);
  return [r * Math.sin(th) * kx, -(rho0 - r * Math.cos(th)) * ky];
}

function boxOf(rings: XY[][]): Shape['box'] {
  const box: Shape['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) {
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
  }
  return box;
}

function inside(sh: Shape, p: XY): boolean {
  return p[0] >= sh.box[0] && p[0] <= sh.box[2] && p[1] >= sh.box[1] && p[1] <= sh.box[3] && pointInPolygon(p, sh.rings);
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

  /** cities whose own pipe maps TireTrail has (the main data file is Bonney Lake's); the app may add more */
  readonly cityMaps = new Set<string>(['Bonney Lake']);
  private readonly inWorld = new WeakMap<Shape, Shape>();
  private readonly mapped = new Map<Place, boolean>();
  private readonly traced = new Map<County, boolean>();

  /** A shape in world meters, for street-zoom use. Cached. */
  toWorld(sh: Shape): Shape {
    let w = this.inWorld.get(sh);
    if (!w) {
      const rings = sh.rings.map((r) => r.map(worldPt));
      w = { rings, box: boxOf(rings) };
      this.inWorld.set(sh, w);
    }
    return w;
  }

  /** The city whose limits hold p (the smallest, if two do). drawn: p is on the region map as drawn. */
  placeAt(p: XY, drawn = false): Place | null {
    let best: Place | null = null;
    for (const pl of this.places) if ((!best || pl.area < best.area) && inside(drawn ? pl : this.toWorld(pl), p)) best = pl;
    return best;
  }

  /** The city has streets in TireTrail: its label point is inside the traced area (or it's in cityMaps). */
  isMapped(pl: Place): boolean {
    let m = this.mapped.get(pl);
    if (m === undefined) this.mapped.set(pl, (m = !!this.coverage && inside(this.coverage, pl.at)));
    return m || this.cityMaps.has(pl.name);
  }

  private mid: XY | null | undefined;

  /** The middle of the traced area, on the region map: the mean of 2 km samples inside it, or the sample nearest that. */
  get middle(): XY | null {
    if (this.mid !== undefined) return this.mid;
    const cv = this.coverage, S = 2000, pts: XY[] = [];
    if (cv) for (let y = cv.box[1] + S / 2; y < cv.box[3]; y += S) for (let x = cv.box[0] + S / 2; x < cv.box[2]; x += S) if (inside(cv, [x, y])) pts.push([x, y]);
    if (!pts.length) return (this.mid = cv ? [(cv.box[0] + cv.box[2]) / 2, (cv.box[1] + cv.box[3]) / 2] : null);
    const m: XY = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return (this.mid = inside(cv!, m) ? m : pts.reduce((a, p) => (Math.hypot(p[0] - m[0], p[1] - m[1]) < Math.hypot(a[0] - m[0], a[1] - m[1]) ? p : a)));
  }

  countyAt(p: XY, drawn = false): County | null {
    return this.counties.find((c) => inside(drawn ? c : this.toWorld(c), p)) ?? null;
  }

  /** The traced area reaches into this county by more than its edge spilling over (15 km² or more). */
  covered(c: County): boolean {
    let t = this.traced.get(c);
    if (t === undefined) {
      t = false;
      const cv = this.coverage, S = 500;
      if (cv) {
        // 500 m samples where the two boxes meet; 60 of them make 15 km²
        const x1 = Math.min(cv.box[2], c.box[2]), y1 = Math.min(cv.box[3], c.box[3]);
        let n = 0;
        for (let y = Math.max(cv.box[1], c.box[1]) + S / 2; y < y1 && !t; y += S) {
          for (let x = Math.max(cv.box[0], c.box[0]) + S / 2; x < x1; x += S) if (inside(cv, [x, y]) && inside(c, [x, y]) && ++n >= 60) { t = true; break; }
        }
      }
      this.traced.set(c, t);
    }
    return t;
  }

  /** Whose pipe map holds p: a city in cityMaps, else the county. */
  ownerAt(p: XY): 'city' | 'county' {
    const pl = this.placeAt(p);
    return pl && this.cityMaps.has(pl.name) ? 'city' : 'county';
  }

  inCoverage(p: XY, drawn = false): boolean {
    return !!this.coverage && inside(drawn ? this.coverage : this.toWorld(this.coverage), p);
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
