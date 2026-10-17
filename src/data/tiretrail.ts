// Phone-side lookups over the decoded bundle.
import {
  dist,
  GridIndex,
  localProjection,
  nearestOnPolyline,
  polylineLength,
  slicePolyline,
  type LngLat,
  type XY,
} from '../geo/geo.ts';
import type { StreetClass } from '../trace/streets.ts';
import type { DrainClass, EndingCode } from '../trace/trace.ts';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  CLASSES,
  CONFIDENCES,
  COORD_SCALE,
  decodeCoords,
  decodePath,
  KINDS,
  type Bundle,
  type Confidence,
} from './bundle.ts';

export interface DrainInfo {
  index: number;
  /** city asset id, e.g. CB-M6-17 */
  id: string;
  lngLat: LngLat;
  cls: DrainClass;
  code: EndingCode;
  confidence: Confidence;
  /** e.g. "Fennel Creek" */
  receiving: string;
  reason: string;
  /** trace end / where water leaves the mapped system */
  terminalId: string;
  exitId: string;
}

export interface DrainPath {
  drain: number;
  /** asset ids, flow order */
  assets: string[];
  /** for the dot animation */
  coords: LngLat[];
  lengthM: number;
}

export interface StreetRunInfo {
  run: number;
  piece: number;
  name: string;
  cls: StreetClass;
  /** null = none within 50 m */
  drain: number | null;
  /** terrain-only guess */
  terrain: { cls: StreetClass; name: string };
}

export interface FixListEntry {
  rank: number;
  label: string;
  lngLat: LngLat;
  receiving: string;
  streetM: number;
  inferredStreetM: number;
  drains: number;
  streets: string[];
  bridges: string[];
}

type LineFeature = { type: 'Feature'; geometry: { type: 'LineString'; coordinates: LngLat[] }; properties: Record<string, unknown> };
type PolygonFeature = { type: 'Feature'; geometry: { type: 'Polygon'; coordinates: LngLat[][] }; properties: Record<string, unknown> };
export interface Collection<F> {
  type: 'FeatureCollection';
  features: F[];
}

const LINE_KINDS = new Set(['pipe', 'channel']);

export class TireTrailData {
  readonly bundle: Bundle;
  readonly credits: readonly string[];
  readonly disclaimer: string;
  readonly numbers: Bundle['numbers'];
  private readonly projection = localProjection();
  private readonly geomCache = new Map<number, LngLat[]>();
  private drainIndex?: GridIndex<number>;
  private byId?: Map<string, number>;

  constructor(bundle: Bundle) {
    if (bundle.format !== BUNDLE_FORMAT || bundle.version !== BUNDLE_VERSION) {
      throw new Error(`Unsupported data file (${bundle.format} v${bundle.version})`);
    }
    this.bundle = bundle;
    this.credits = bundle.credits;
    this.disclaimer = bundle.disclaimer;
    this.numbers = bundle.numbers;
  }

  get drainCount(): number {
    return this.bundle.drains.asset.length;
  }

  geometry(asset: number): LngLat[] {
    let g = this.geomCache.get(asset);
    if (!g) {
      g = decodeCoords(this.bundle.assets.geom[asset]);
      this.geomCache.set(asset, g);
    }
    return g;
  }

  drain(i: number): DrainInfo {
    const b = this.bundle;
    const asset = b.drains.asset[i];
    const e = b.endings[b.drains.ending[i]];
    return {
      index: i,
      id: b.assets.key[asset],
      lngLat: this.geometry(asset)[0],
      cls: CLASSES[e.cls] as DrainClass,
      code: e.code,
      confidence: CONFIDENCES[e.confidence],
      receiving: e.receiving,
      reason: e.reason,
      terminalId: b.assets.key[e.terminal],
      exitId: b.assets.key[e.exit],
    };
  }

  findDrain(id: string): DrainInfo | undefined {
    if (!this.byId) {
      this.byId = new Map();
      this.bundle.drains.asset.forEach((a, i) => this.byId!.set(this.bundle.assets.key[a], i));
    }
    const i = this.byId.get(id);
    return i === undefined ? undefined : this.drain(i);
  }

  path(i: number): DrainPath {
    const assets = decodePath(this.bundle, i);
    const coords = this.pathCoords(assets);
    const xy = coords.map((c) => this.projection.toXY(c));
    return { drain: i, assets: assets.map((a) => this.bundle.assets.key[a]), coords, lengthM: polylineLength(xy) };
  }

  // Joins asset geometry. Side connections enter mid-line, not at its start.
  private pathCoords(assets: readonly number[]): LngLat[] {
    const out: LngLat[] = [];
    for (const a of assets) {
      const g = this.geometry(a);
      const last = out[out.length - 1];
      if (last && LINE_KINDS.has(KINDS[this.bundle.assets.kind[a]]) && g.length > 1) {
        const xy = g.map((c) => this.projection.toXY(c));
        const from = this.projection.toXY(last);
        const on = nearestOnPolyline(from, xy);
        // joint must be >3 m from the start
        if (dist(from, xy[0]) > 3 && on.d < dist(from, xy[0])) {
          for (const p of slicePolyline(xy, on.along, polylineLength(xy))) out.push(this.projection.toLngLat(p));
          continue;
        }
      }
      out.push(...g);
    }
    return out.filter((c, i) => i === 0 || c[0] !== out[i - 1][0] || c[1] !== out[i - 1][1]);
  }

  /** nearest drain within maxM meters */
  nearestDrain(p: LngLat, maxM = 50): { drain: DrainInfo; distanceM: number } | null {
    if (!this.drainIndex) {
      this.drainIndex = new GridIndex<number>(50);
      for (let i = 0; i < this.drainCount; i++) this.drainIndex.insertPoint(i, this.drainXY(i));
    }
    const q: XY = this.projection.toXY(p);
    let best = -1;
    let bestD = Infinity;
    for (const i of this.drainIndex.near(q, maxM)) {
      const d = dist(q, this.drainXY(i));
      if (d <= maxM && (d < bestD || (d === bestD && i < best))) [best, bestD] = [i, d];
    }
    return best < 0 ? null : { drain: this.drain(best), distanceM: bestD };
  }

  private drainXY(i: number): XY {
    return this.projection.toXY(this.geometry(this.bundle.drains.asset[i])[0]);
  }

  get streetRunCount(): number {
    return this.bundle.streets.runs.piece.length;
  }

  street(run: number): StreetRunInfo {
    const r = this.bundle.streets.runs;
    const p = this.bundle.streets.pieces[r.piece[run]];
    return {
      run,
      piece: r.piece[run],
      name: p.name,
      cls: CLASSES[r.cls[run]],
      drain: r.drain[run] < 0 ? null : r.drain[run],
      terrain: { cls: CLASSES[p.terrainCls], name: p.terrainName },
    };
  }

  streetsGeoJSON(): Collection<LineFeature> {
    const r = this.bundle.streets.runs;
    return {
      type: 'FeatureCollection',
      features: r.geom.map((g, i) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: decodeCoords(g) },
        properties: { run: i, cls: CLASSES[r.cls[i]], name: this.bundle.streets.pieces[r.piece[i]].name },
      })),
    };
  }

  networkGeoJSON(): Collection<LineFeature> {
    const b = this.bundle;
    const features: LineFeature[] = [];
    b.assets.kind.forEach((k, i) => {
      if (!LINE_KINDS.has(KINDS[k])) return;
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: this.geometry(i) }, properties: { asset: i, id: b.assets.key[i], kind: KINDS[k] } });
    });
    return { type: 'FeatureCollection', features };
  }

  watersGeoJSON(): Collection<LineFeature | PolygonFeature> {
    const features: (LineFeature | PolygonFeature)[] = [];
    for (const w of this.bundle.waters) {
      const properties = { name: w.name, kind: w.kind, fennel: w.fennel };
      for (const l of w.lines) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decodeCoords(l) }, properties });
      for (const r of w.rings) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [decodeCoords(r)] }, properties });
    }
    return { type: 'FeatureCollection', features };
  }

  pondsGeoJSON(): Collection<PolygonFeature> {
    return {
      type: 'FeatureCollection',
      features: this.bundle.pondShapes.map(([asset, ring]) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [decodeCoords(ring)] },
        properties: { asset, id: this.bundle.assets.key[asset] },
      })),
    };
  }

  get fixList(): FixListEntry[] {
    return this.bundle.fixList.map((f) => ({
      rank: f.rank,
      label: f.label,
      lngLat: [f.at[0] / COORD_SCALE, f.at[1] / COORD_SCALE] as LngLat,
      receiving: f.receiving,
      streetM: f.streetM,
      inferredStreetM: f.inferredStreetM,
      drains: f.drains,
      streets: f.streets,
      bridges: f.bridges,
    }));
  }
}

export async function loadTireTrail(url = 'data/tiretrail.json', fetcher: typeof fetch = fetch): Promise<TireTrailData> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Could not load the city data (${res.status})`);
  return new TireTrailData((await res.json()) as Bundle);
}
