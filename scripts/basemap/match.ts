// What the city's and county's own data already draws: OSM roads that copy their streets, buildings already on the map.
import { bboxOf, GridIndex, nearestOnPolyline, pointInPolygon, polylineLength, type XY } from '../../src/geo/geo.ts';

const WORDS: Record<string, string> = {
  road: 'rd', street: 'st', avenue: 'ave', av: 'ave', court: 'ct', drive: 'dr', boulevard: 'blvd', place: 'pl', lane: 'ln',
  highway: 'hwy', parkway: 'pkwy', terrace: 'ter', circle: 'cir', trail: 'trl', route: 'rte', point: 'pt',
  east: 'e', west: 'w', north: 'n', south: 's', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
const DIRS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/** Street name for matching: "Elhi Rim Road East" and "Elhi Rim Rd" both give "elhi rim rd", "State Route 410" gives "sr 410". */
export function normName(s: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => WORDS[w] ?? w);
  // a trailing direction only says which side of the county grid
  if (t.length > 1 && DIRS.has(t[t.length - 1])) t.pop();
  return t.join(' ').replace(/\b(?:state (?:rte|hwy)|wa) (?=\d)/g, 'sr ').replace(/\binterstate (?=\d)/g, 'i ');
}

export interface Street { line: XY[]; name: string; county: boolean }

const NEAR = 10; // m: any known street this close covers an OSM road
const BESIDE = 40; // m: one of the same name this close does too

/** The city's and county's streets, to find the OSM roads that only copy them. */
export class Known {
  private readonly idx = new GridIndex<number>(100);
  private readonly st: { line: XY[]; name: string; county: boolean; len: number; open: boolean[] }[] = [];

  constructor(streets: readonly Street[]) {
    streets.forEach((s, i) => {
      this.st.push({ line: s.line, name: normName(s.name), county: s.county, len: polylineLength(s.line), open: [false, false] });
      this.idx.insert(i, bboxOf(s.line));
    });
    // an end that meets more of the same street, from the same source, isn't a dead end
    for (const s of this.st) for (const e of [0, 1]) {
      const p = s.line[e ? s.line.length - 1 : 0];
      s.open[e] = !!s.name && this.idx.near(p, 3).some((j) => this.st[j] !== s && this.st[j].county === s.county && this.st[j].name === s.name && nearestOnPolyline(p, this.st[j].line).d < 3);
    }
  }

  /** 0 if no known street covers p, 1 if a city street does, 2 if only a county one does. `names` are the road's, normalized. */
  at(p: XY, names: readonly string[]): 0 | 1 | 2 {
    let out: 0 | 2 = 0;
    for (const i of this.idx.near(p, names.length ? BESIDE : NEAR)) {
      const s = this.st[i];
      if (out && s.county) continue;
      const o = nearestOnPolyline(p, s.line);
      // past a dead end, a road of the same name carries the street on, so it isn't a copy
      const past = (o.along < .5 && !s.open[0]) || (o.along > s.len - .5 && !s.open[1]);
      if (o.d < NEAR || (o.d < BESIDE && !past && names.includes(s.name))) {
        if (!s.county) return 1;
        out = 2;
      }
    }
    return out;
  }

  /** Distance from p to the nearest city or county street, up to r. */
  dist(p: XY, r: number, county: boolean): number {
    let d = r;
    for (const i of this.idx.near(p, r)) if (this.st[i].county === county) d = Math.min(d, nearestOnPolyline(p, this.st[i].line).d);
    return d;
  }
}

/** Ring area in m² (no repeated last point). */
export function ringArea(r: readonly XY[]): number {
  let a = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
  return Math.abs(a / 2);
}

function middle(r: readonly XY[]): XY {
  let a = 0, x = 0, y = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
    const c = r[j][0] * r[k][1] - r[k][0] * r[j][1];
    a += c; x += (r[j][0] + r[k][0]) * c; y += (r[j][1] + r[k][1]) * c;
  }
  if (a) return [x / (3 * a), y / (3 * a)];
  return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
}

/** Do two building rings share over `frac` of the smaller one's area, or hold each other's middle? */
export function overlaps(a: readonly XY[], b: readonly XY[], frac = .1): boolean {
  const A = bboxOf(a), B = bboxOf(b);
  const x0 = Math.max(A.minX, B.minX), y0 = Math.max(A.minY, B.minY), x1 = Math.min(A.maxX, B.maxX), y1 = Math.min(A.maxY, B.maxY);
  if (x0 >= x1 || y0 >= y1) return false;
  if (pointInPolygon(middle(a), [b]) || pointInPolygon(middle(b), [a])) return true;
  // shared area, counted on a grid fine enough for the smaller one
  const small = Math.min(ringArea(a), ringArea(b)), st = Math.max(.2, Math.sqrt(small / 200));
  let hit = 0;
  for (let y = y0 + st / 2; y < y1; y += st) for (let x = x0 + st / 2; x < x1; x += st) {
    if (pointInPolygon([x, y], [a]) && pointInPolygon([x, y], [b])) hit++;
  }
  return hit * st * st > frac * small;
}

/** Buildings kept so far, so a second source never draws over one. */
export class Footprints {
  private readonly idx = new GridIndex<number>(60);
  // every ring's x, y back to back (a million buildings fit in ~100 MB this way); ring i starts at at[i]
  private xy = new Float64Array(1 << 16);
  private readonly at: number[] = [0];

  add(r: XY[]): void {
    const i = this.at.length - 1, o = this.at[i];
    if (o + 2 * r.length > this.xy.length) {
      const grown = new Float64Array(Math.max(2 * this.xy.length, o + 2 * r.length));
      grown.set(this.xy);
      this.xy = grown;
    }
    r.forEach((p, k) => { this.xy[o + 2 * k] = p[0]; this.xy[o + 2 * k + 1] = p[1]; });
    this.at.push(o + 2 * r.length);
    this.idx.insert(i, bboxOf(r));
  }

  private ring(i: number): XY[] {
    const out: XY[] = [];
    for (let k = this.at[i]; k < this.at[i + 1]; k += 2) out.push([this.xy[k], this.xy[k + 1]]);
    return out;
  }

  hits(r: readonly XY[]): boolean {
    const b = bboxOf(r);
    const c: XY = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    return this.idx.near(c, Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2).some((i) => overlaps(r, this.ring(i)));
  }
}
