// County waters: WDFW coho reaches, the County's streams and lakes, and waters its layers lack
// (Puget Sound, NHD streams and lakes, wetlands, small ponds). "fennel" on a Water means
// WDFW Documented or Presumed coho water here.
import {
  bboxOf,
  dist,
  GridIndex,
  nearestOnPolyline,
  pointAlong,
  pointInPolygon,
  polygonsArea,
  polygonsCentroid,
  polylineLength,
  type Projection,
  type XY,
} from '../geo/geo.ts';
import { text, type FeatureCollection, type Geometry } from '../trace/geojson.ts';
import type { Water } from '../trace/waters.ts';

export interface CountyWaterLayers {
  swifdCoho: FeatureCollection;
  hydroCenterlines: FeatureCollection;
  hydroWaterbodies: FeatureCollection;
}

/** A water the County layers lack, in lon/lat. */
export interface ExtraWater {
  kind: 'stream' | 'lake' | 'wetland' | 'marine';
  /** GNIS name (trusted as a water name); marine waters carry the name to show, e.g. "Puget Sound". */
  name: string;
  lines?: number[][][];
  polygons?: number[][][][];
  /** Repeats a County line or lake (known from the source); undefined: check here. */
  covered?: boolean;
}

export interface CountyWaterOptions {
  extra?: readonly ExtraWater[];
  /** Drainage facility shapes: a small County water body inside one is a storm pond, not a receiving water. */
  stormPonds?: readonly XY[][][][];
}

/** WDFW distribution type, simplified: documented (Documented, Presumed, Transported, Artificial), modeled (Gradient Accessible, Potential, Modeled), historic. */
export type CohoStatus = 'documented' | 'modeled' | 'historic';

export function cohoStatus(distType: string): CohoStatus {
  if (/^historic/i.test(distType)) return 'historic';
  if (/documented|presumed/i.test(distType)) return 'documented';
  return 'modeled';
}

export interface CountyWater extends Water {
  /** coho: SWIFD reach (classification only, not drawn); stream, lake: the County's; pond: a County water body under 3,000 m²; nhd, wetland, marine: extra layers. */
  source: 'coho' | 'stream' | 'lake' | 'pond' | 'nhd' | 'wetland' | 'marine';
  coho: CohoStatus | null;
  /** Not one of the County's own layers or a SWIFD reach. */
  extra: boolean;
}

export interface WaterNear {
  water: CountyWater;
  d: number;
}

/** Ponds smaller than this aren't lakes (same as Bonney Lake); they count as ponds. */
const MIN_LAKE_AREA_M2 = 3000;
/** A stream counts as coho water of a kind if most of it runs within this of such a reach. */
const COHO_MATCH_M = 20;
/** Centerline types that are streams (not storm pipes). */
const STREAM_TYPES = new Set(['Stream', 'River', 'Culvert', 'Waterbody', 'Drainage']);
/** Stream line ends this close are one joint. */
const JOIN_M = 1;
/** An extra line repeats a County line if this share of it runs within COVER_M of one. */
const COVER_SHARE = 0.8;
const COVER_M = 25;
/** A small water body this close to a storm pond shape is that pond. */
const STORM_POND_M = 5;
/** A stream polygon takes the coho kind of the reaches inside it, if at least this many 10 m samples are. */
const MIN_REACH_SAMPLES_INSIDE = 5;
/** An unnamed stream or WDFW reach takes the name of a named one running along it, at most this much farther away. */
const NAME_SLACK_M = COHO_MATCH_M;
/** Polygons with more vertices than this get a banded point-in-polygon test. */
const BIG_POLYGON = 400;
const BAND_M = 100;

/** Words that make a name a water name. */
const WATER_WORD =
  /\b(creeks?|rivers?|lakes?|ponds?|sloughs?|bays?|sounds?|streams?|brooks?|runs?|channels?|ditch(es)?|springs?|inlets?|harbou?rs?|canals?|reservoirs?|wetlands?|marsh(es)?|forks?|branch(es)?|waterways?|lagoons?|passages?|narrows|coves?|flumes?|basins?|swamps?|falls|estuar(y|ies)|tributar(y|ies)|outlets?|outflows?|drainages?|bogs?|reach|flats|bight)\b/i;
const SMALL_WORDS = new Set(['of', 'the', 'and', 'at', 'in', 'on']);

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * A water name fit to show, or '' if it isn't one. Keeps names with a water word (creek, lake, ...)
 * or a known GNIS name, so a person's name in a name field reads as unnamed; "A/B" reads "A, then B".
 */
export function cleanWaterName(raw: string, known?: ReadonlySet<string>): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s || /^(none|null|unnamed|unknown|n\/a)$/i.test(s)) return '';
  if (s === s.toUpperCase() || s === s.toLowerCase()) s = titleCase(s);
  const parts = s
    .split(/\s*\/\s*/)
    .filter((x) => x && (WATER_WORD.test(x) || (known?.has(x.toLowerCase()) ?? false)));
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
}

/** "Unnamed stream [1220954471946]" -> "" */
export function swifdName(raw: string): string {
  return /^unnamed/i.test(raw) ? '' : raw.replace(/\s*\[\d+\]\s*$/, '').trim();
}

const isStreamLike = (w: CountyWater) => w.source === 'coho' || w.source === 'stream' || w.source === 'nhd';

/** An unnamed lake or pond, which beside a discharge point may well be the soak-in pond itself. */
export const isUnnamedPond = (w: CountyWater) => (w.source === 'lake' || w.source === 'pond') && !w.name;

/** How an unnamed water reads in a sentence. */
export function unnamedWater(w: CountyWater): string {
  switch (w.source) {
    case 'marine':
      return 'Puget Sound';
    case 'wetland':
      return 'a wetland';
    case 'lake':
      return 'an unnamed lake or pond';
    case 'pond':
      return 'an unnamed pond';
    default:
      return 'an unnamed stream';
  }
}

/** One drawn piece of the County's stream lines (drawn downstream: 2254 joints merge, 81 split). */
interface StreamLink {
  line: XY[];
  lengthM: number;
  from: number;
  to: number;
  /** Kind of coho reach it runs along. */
  coho: CohoStatus | null;
}

function linesOf(g: Geometry | null, xy: (p: number[]) => XY): XY[][] {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates.map(xy)];
  if (g.type === 'MultiLineString') return g.coordinates.map((part) => part.map(xy));
  return [];
}

function polygonsOf(g: Geometry | null, xy: (p: number[]) => XY): XY[][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates.map((r) => r.map(xy))];
  if (g.type === 'MultiPolygon') return g.coordinates.map((poly) => poly.map((r) => r.map(xy)));
  return [];
}

/** Distance from p to the segment stored at s[k..k+3] (ax, ay, bx, by). */
function segDist(p: XY, s: readonly number[], k: number): number {
  const [ax, ay, bx, by] = [s[k], s[k + 1], s[k + 2], s[k + 3]];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
  return Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
}

/** Point-in-polygon over many rings, testing only the edges in the point's row band. */
class BandedPolygon {
  private readonly bands = new Map<number, number[]>();

  constructor(polygons: readonly XY[][][]) {
    for (const rings of polygons) {
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j];
          const b = ring[i];
          for (let k = Math.floor(Math.min(a[1], b[1]) / BAND_M); k <= Math.floor(Math.max(a[1], b[1]) / BAND_M); k++) {
            const list = this.bands.get(k);
            if (list) list.push(a[0], a[1], b[0], b[1]);
            else this.bands.set(k, [a[0], a[1], b[0], b[1]]);
          }
        }
      }
    }
  }

  contains(p: XY): boolean {
    const e = this.bands.get(Math.floor(p[1] / BAND_M));
    if (!e) return false;
    let inside = false;
    for (let k = 0; k < e.length; k += 4) {
      const [ax, ay, bx, by] = [e[k], e[k + 1], e[k + 2], e[k + 3]];
      if (ay > p[1] !== by > p[1] && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }
}

export class CountyWaters {
  readonly all: CountyWater[] = [];
  /** Water segments, for distances: [water, ax, ay, bx, by]. */
  private readonly segs: number[] = [];
  private readonly segIdx = new GridIndex<number>(50);
  /** Polygon waters by bbox, for inside tests. */
  private readonly polyIdx = new GridIndex<number>(500);
  private readonly banded = new Map<number, BandedPolygon>();
  /** SWIFD reach segments: [status, ax, ay, bx, by]. */
  private readonly reachSegs: number[] = [];
  private readonly reachIdx = new GridIndex<number>(50);
  /** Every County stream line piece, MS4 ones too, for walking downstream. */
  private readonly links: StreamLink[] = [];
  private readonly linksOf = new Map<CountyWater, number[]>();
  private readonly outOf = new Map<number, number[]>();

  constructor(layers: CountyWaterLayers, projection: Projection, opts: CountyWaterOptions = {}) {
    const xy = (p: number[]): XY => projection.toXY([p[0], p[1]]);
    const extra = opts.extra ?? [];
    // GNIS names from NHD count as water names
    const known = new Set(extra.filter((e) => e.kind !== 'marine' && e.name).map((e) => e.name.toLowerCase()));

    for (const f of layers.swifdCoho.features) {
      const status = cohoStatus(text(f.properties.DISTTYPE_DESC));
      const lines = linesOf(f.geometry, xy);
      const name = cleanWaterName(swifdName(text(f.properties.LLID_STRM_NAME)), known);
      if (this.add({ name, kind: 'creek', fennel: status === 'documented', source: 'coho', coho: status, extra: false, lines }) < 0) continue;
      for (const l of lines) for (let k = 1; k < l.length; k++) this.addReachSeg(status, l[k - 1], l[k]);
    }

    for (const f of layers.hydroCenterlines.features) {
      const p = f.properties;
      const lines = linesOf(f.geometry, xy);
      const samples = lines.map((l) => this.cohoSamples(l));
      const receiving = STREAM_TYPES.has(text(p.FeatureType)) && text(p.StreamTypeNPDES) !== 'MS4';
      const status = statusOf(sumSamples(samples));
      const w: CountyWater | null = receiving
        ? { name: cleanWaterName(text(p.FeatureName), known), kind: 'creek', fennel: status === 'documented', source: 'stream', coho: status, extra: false, lines }
        : null;
      if (w) this.add(w);
      lines.forEach((line, i) => {
        if (line.length < 2) return;
        if (w) this.linksOf.set(w, [...(this.linksOf.get(w) ?? []), this.links.length]);
        this.links.push({ line, lengthM: polylineLength(line), from: -1, to: -1, coho: statusOf(samples[i]) });
      });
    }

    const stormIdx = new GridIndex<number>(200);
    const storm = opts.stormPonds ?? [];
    storm.forEach((s, i) => stormIdx.insert(i, bboxOf(s.flat(2))));
    const stormMid = storm.map((s) => polygonsCentroid(s));
    // the pond's middle is on a storm pond, or a storm pond lies inside it (a crescent's middle can miss)
    const isStormPond = (polygons: XY[][][]) => {
      const c = polygonsCentroid(polygons);
      if (stormIdx.near(c, STORM_POND_M).some((i) => distanceToShape(c, storm[i]) <= STORM_POND_M)) return true;
      const b = bboxOf(polygons.flat(2));
      return stormIdx
        .near([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2)
        .some((i) => polygons.some((rings) => pointInPolygon(stormMid[i], rings)));
    };
    const countyLakes: number[] = [];
    for (const f of layers.hydroWaterbodies.features) {
      const polygons = polygonsOf(f.geometry, xy).filter((rings) => rings.length > 0 && rings[0].length >= 3);
      if (!polygons.length) continue;
      const big = polygonsArea(polygons) >= MIN_LAKE_AREA_M2;
      if (!big && isStormPond(polygons)) continue;
      const i = this.add({ name: cleanWaterName(text(f.properties.FeatureName), known), kind: 'lake', fennel: false, source: big ? 'lake' : 'pond', coho: null, extra: false, polygons });
      if (i >= 0) countyLakes.push(i);
    }

    this.joinLinks();
    this.respell();
    this.addExtra(extra, xy, countyLakes, isStormPond);
  }

  /** A WDFW name one letter off the County stream drawn along that reach is a typo ("Swam Creek" on Swan Creek). */
  private respell(): void {
    for (const w of this.all) {
      if (w.source !== 'coho' || !w.name) continue;
      const along = new Map<string, number>();
      for (const l of w.lines ?? []) {
        const len = polylineLength(l);
        for (let s = 0; s <= len; s += 50) {
          const hit = this.nearest(pointAlong(l, s), COHO_MATCH_M, (x) => x.source === 'stream' && x.name !== '');
          if (hit) along.set(hit.water.name, (along.get(hit.water.name) ?? 0) + 1);
        }
      }
      const top = [...along].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (top && top[0] !== w.name && oneEditApart(top[0], w.name)) w.name = top[0];
    }
  }

  private addExtra(extra: readonly ExtraWater[], xy: (p: number[]) => XY, countyLakes: readonly number[], isStormPond: (polygons: XY[][][]) => boolean): void {
    // County lines and lakes, to drop extra waters that repeat them
    const cover = new GridIndex<number>(50);
    this.links.forEach((l, k) => cover.insert(k, bboxOf(l.line)));
    const coveredLine = (line: XY[]) => {
      let near = 0;
      let total = 0;
      const len = polylineLength(line);
      for (let s = 0; s <= len; s += 10) {
        const p = pointAlong(line, s);
        total++;
        if (cover.near(p, COVER_M).some((k) => nearestOnPolyline(p, this.links[k].line).d <= COVER_M)) near++;
      }
      return total > 0 && near / total >= COVER_SHARE;
    };
    const lakeIdx = new GridIndex<number>(200);
    for (const i of countyLakes) lakeIdx.insert(i, bboxOf(this.all[i].polygons!.flat(2)));
    const coveredBody = (polygons: XY[][][]) => {
      const c = polygonsCentroid(polygons);
      return lakeIdx.near(c, 0).some((i) => this.all[i].polygons!.some((rings) => pointInPolygon(c, rings)));
    };
    for (const e of extra) {
      if (e.covered) continue;
      const lines = (e.lines ?? []).map((l) => l.map(xy)).filter((l) => l.length >= 2);
      const polygons = (e.polygons ?? []).map((poly) => poly.map((r) => r.map(xy))).filter((rings) => rings.length > 0 && rings[0].length >= 3);
      if (!lines.length && !polygons.length) continue;
      if (e.covered === undefined && e.kind !== 'marine') {
        if (lines.length && lines.every(coveredLine)) continue;
        if (!lines.length && coveredBody(polygons)) continue;
      }
      const name = e.kind === 'marine' ? e.name : cleanWaterName(e.name, new Set([e.name.toLowerCase()]));
      if (e.kind === 'stream') {
        const status = lines.length ? statusOf(sumSamples(lines.map((l) => this.cohoSamples(l)))) : this.cohoInside(polygons);
        // a river's water area takes the name of the streams drawn inside it
        const named = name || (lines.length ? '' : this.nameInside(polygons));
        this.add({ name: named, kind: lines.length ? 'nhd' : 'lake', fennel: status === 'documented', source: 'nhd', coho: status, extra: true, lines, polygons });
      } else {
        // an NHD pond on a drainage facility is that storm pond
        if (e.kind === 'lake' && polygons.length && isStormPond(polygons)) continue;
        const source = e.kind === 'lake' ? (polygonsArea(polygons) >= MIN_LAKE_AREA_M2 ? 'lake' : 'pond') : e.kind;
        this.add({ name, kind: 'lake', fennel: false, source, coho: null, extra: true, lines, polygons });
      }
    }
  }

  /** Stream line ends within JOIN_M share a joint. */
  private joinLinks(): void {
    const pts = this.links.flatMap((l) => [l.line[0], l.line[l.line.length - 1]]);
    const parent = pts.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    const idx = new GridIndex<number>(10);
    pts.forEach((p, i) => {
      for (const j of idx.near(p, JOIN_M)) if (dist(p, pts[j]) <= JOIN_M) parent[find(i)] = find(j);
      idx.insertPoint(i, p);
    });
    this.links.forEach((l, k) => {
      l.from = find(2 * k);
      l.to = find(2 * k + 1);
      this.outOf.set(l.from, [...(this.outOf.get(l.from) ?? []), k]);
    });
  }

  /**
   * Coho water a County stream carries water to within maxM downstream of p, following the County's stream
   * lines as drawn: the first documented reach, else the first modeled or historic one. Stops where the lines
   * split or end, so the answer is never a guess between ways.
   */
  downstreamCoho(w: CountyWater, p: XY, maxM: number): { name: string; m: number; status: CohoStatus } | null {
    let cur = -1;
    let along = 0;
    let best = Infinity;
    for (const k of this.linksOf.get(w) ?? []) {
      const on = nearestOnPolyline(p, this.links[k].line);
      if (on.d < best) [cur, along, best] = [k, on.along, on.d];
    }
    if (cur < 0) return null;
    let m = this.links[cur].lengthM - along;
    const seen = new Set([cur]);
    let other: { name: string; m: number; status: CohoStatus } | null = null;
    // name it: a named County stream along it, else the WDFW name
    const nameAt = (at: XY, status: CohoStatus) =>
      (this.nearest(at, COHO_MATCH_M, (x) => x.coho === status && x.source === 'stream' && x.name !== '') ?? this.nearest(at, COHO_MATCH_M, (x) => x.coho === status && x.name !== ''))?.water.name ?? '';
    while (m <= maxM) {
      const outs = this.outOf.get(this.links[cur].to) ?? [];
      if (outs.length !== 1 || seen.has(outs[0])) break;
      cur = outs[0];
      seen.add(cur);
      const l = this.links[cur];
      if (l.coho === 'documented') return { name: nameAt(l.line[0], 'documented'), m, status: 'documented' };
      if (l.coho && !other) other = { name: nameAt(l.line[0], l.coho), m, status: l.coho };
      m += l.lengthM;
    }
    return other;
  }

  private addReachSeg(status: CohoStatus, a: XY, b: XY): void {
    const k = this.reachSegs.length;
    this.reachSegs.push(status === 'documented' ? 0 : status === 'modeled' ? 1 : 2, a[0], a[1], b[0], b[1]);
    this.reachIdx.insert(k, bboxOf([a, b]));
  }

  /** Coho kind of the reaches within COHO_MATCH_M of p (documented beats modeled beats historic), -1 if none. */
  private reachAt(p: XY): number {
    let best = 3;
    for (const k of this.reachIdx.near(p, COHO_MATCH_M)) {
      const s = this.reachSegs;
      if (s[k] < best && segDist(p, s, k + 1) <= COHO_MATCH_M) best = s[k];
    }
    return best < 3 ? best : -1;
  }

  /** Points every 10 m along a line, by coho kind near them: [documented, modeled, historic, all]. */
  private cohoSamples(l: XY[]): number[] {
    const out = [0, 0, 0, 0];
    const len = polylineLength(l);
    for (let s = 0; s <= len; s += 10) {
      out[3]++;
      const k = this.reachAt(pointAlong(l, s));
      if (k >= 0) out[k]++;
    }
    return out;
  }

  /** Coho kind of a stream polygon (an NHD river), from the reaches running inside it. */
  private cohoInside(polygons: XY[][][]): CohoStatus | null {
    const b = bboxOf(polygons.flat(2));
    const out = [0, 0, 0, 0];
    const seen = new Set<number>();
    const s = this.reachSegs;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    for (const k of this.reachIdx.near([cx, cy], Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2)) {
      if (seen.has(k)) continue;
      seen.add(k);
      const a: XY = [s[k + 1], s[k + 2]];
      const c: XY = [s[k + 3], s[k + 4]];
      const len = dist(a, c);
      for (let t = 0; t <= len; t += 10) {
        const p: XY = len ? [a[0] + ((c[0] - a[0]) * t) / len, a[1] + ((c[1] - a[1]) * t) / len] : a;
        if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
        if (!polygons.some((rings) => pointInPolygon(p, rings))) continue;
        out[s[k]]++;
        out[3]++;
      }
    }
    return out[3] >= MIN_REACH_SAMPLES_INSIDE ? statusOf(out) : null;
  }

  /** Name of the County streams (else WDFW reaches) with the most length inside a polygon, or ''. */
  private nameInside(polygons: XY[][][]): string {
    const b = bboxOf(polygons.flat(2));
    const byKind = [new Map<string, number>(), new Map<string, number>()];
    const s = this.segs;
    for (const k of this.segIdx.near([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2], Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2)) {
      const w = this.all[s[k]];
      if (!w.name || (w.source !== 'stream' && w.source !== 'coho')) continue;
      const mid: XY = [(s[k + 1] + s[k + 3]) / 2, (s[k + 2] + s[k + 4]) / 2];
      if (mid[0] < b.minX || mid[0] > b.maxX || mid[1] < b.minY || mid[1] > b.maxY || !polygons.some((rings) => pointInPolygon(mid, rings))) continue;
      const t = byKind[w.source === 'stream' ? 0 : 1];
      t.set(w.name, (t.get(w.name) ?? 0) + Math.hypot(s[k + 3] - s[k + 1], s[k + 4] - s[k + 2]));
    }
    for (const t of byKind) {
      const best = [...t].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
      if (best) return best[0];
    }
    return '';
  }

  /** Adds a water, returns its index (-1 if it has no geometry). */
  private add(w: CountyWater): number {
    if (!w.lines?.length && !w.polygons?.length) return -1;
    const i = this.all.length;
    this.all.push(w);
    const addSeg = (a: XY, b: XY) => {
      const k = this.segs.length;
      this.segs.push(i, a[0], a[1], b[0], b[1]);
      this.segIdx.insert(k, bboxOf([a, b]));
    };
    for (const l of w.lines ?? []) {
      if (l.length === 1) addSeg(l[0], l[0]);
      for (let k = 1; k < l.length; k++) addSeg(l[k - 1], l[k]);
    }
    if (w.polygons?.length) {
      let n = 0;
      for (const rings of w.polygons) for (const ring of rings) for (let k = 0; k < ring.length; k++) {
        addSeg(ring[k], ring[(k + 1) % ring.length]);
        n++;
      }
      this.polyIdx.insert(i, bboxOf(w.polygons.flat(2)));
      if (n > BIG_POLYGON) this.banded.set(i, new BandedPolygon(w.polygons));
    }
    return i;
  }

  private inside(i: number, p: XY): boolean {
    const big = this.banded.get(i);
    return big ? big.contains(p) : this.all[i].polygons!.some((rings) => pointInPolygon(p, rings));
  }

  /** Nearest documented coho water within tol: a WDFW reach, or a stream that runs along one. */
  coho(p: XY, tol: number): WaterNear | null {
    return this.nearest(p, tol, (w) => w.fennel);
  }

  /** Nearest water within tol that isn't documented coho water: modeled or historic reaches, streams, lakes, ponds, wetlands, Puget Sound. */
  receiving(p: XY, tol: number, keep: (w: CountyWater) => boolean = () => true): WaterNear | null {
    return this.nearest(p, tol, (w) => !w.fennel && keep(w));
  }

  /** Nearest water within tol from the County's own streams and lakes or WDFW (the layers the tracer had before the extra ones). */
  mapped(p: XY, tol: number, keep: (w: CountyWater) => boolean = () => true): WaterNear | null {
    return this.nearest(p, tol, (w) => !w.extra && w.source !== 'pond' && keep(w));
  }

  /**
   * Name of the water hit at p: its own; for a WDFW reach or an unnamed stream, a County or NHD stream name
   * running along it (at most NAME_SLACK_M farther), else the WDFW name; else ''.
   */
  nameFor(p: XY, hit: WaterNear, tol: number): string {
    const w = hit.water;
    if ((w.name && w.source !== 'coho') || !isStreamLike(w)) return w.name;
    const r = Math.min(tol, hit.d) + NAME_SLACK_M;
    const mapped = this.nearest(p, r, (x) => x.name !== '' && (x.source === 'stream' || x.source === 'nhd'));
    if (mapped) return mapped.water.name;
    return w.name || (this.nearest(p, r, (x) => x.name !== '' && x.source === 'coho')?.water.name ?? '');
  }

  nearest(p: XY, tol: number, keep: (w: CountyWater) => boolean): WaterNear | null {
    const best = new Map<number, number>();
    const s = this.segs;
    for (const k of this.segIdx.near(p, tol)) {
      const i = s[k];
      if (!keep(this.all[i])) continue;
      const d = segDist(p, s, k + 1);
      if (d <= tol && d < (best.get(i) ?? Infinity)) best.set(i, d);
    }
    for (const i of this.polyIdx.near(p, 0)) {
      if (best.get(i) === 0 || !keep(this.all[i])) continue;
      if (this.inside(i, p)) best.set(i, 0);
    }
    let out: { d: number; i: number } | null = null;
    for (const [i, d] of best) if (!out || d < out.d || (d === out.d && i < out.i)) out = { d, i };
    return out ? { water: this.all[out.i], d: out.d } : null;
  }

  /** Drawn waters (the County's streams and lakes) touching a box, in local meters. */
  drawable(box: { minX: number; minY: number; maxX: number; maxY: number }): CountyWater[] {
    return this.all.filter((w) => {
      if (w.source !== 'stream' && w.source !== 'lake') return false;
      if (w.extra) return false;
      const b = bboxOf([...(w.lines ?? []).flat(), ...(w.polygons ?? []).flat(2)]);
      return !(b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY);
    });
  }
}

function sumSamples(samples: readonly number[][]): number[] {
  const out = [0, 0, 0, 0];
  for (const s of samples) for (let k = 0; k < 4; k++) out[k] += s[k];
  return out;
}

/** [documented, modeled, historic, all] samples -> kind: documented if half or more are, else coho of some kind if half or more are. */
function statusOf(s: readonly number[]): CohoStatus | null {
  const [doc, mod, hist, all] = s;
  if (!all) return null;
  if (doc / all >= 0.5) return 'documented';
  if ((doc + mod + hist) / all < 0.5) return null;
  return doc + mod >= hist ? 'modeled' : 'historic';
}

/** Same length and one letter different, or one letter added or dropped. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function distanceToShape(p: XY, polygons: readonly XY[][][]): number {
  let best = Infinity;
  for (const rings of polygons) {
    if (pointInPolygon(p, rings)) return 0;
    for (const ring of rings) best = Math.min(best, nearestOnPolyline(p, ring).d);
  }
  return best;
}
