// City storm layers -> one asset list, in local meters. Links are built in network.ts.
import { localProjection, polygonsCentroid, polylineLength, type Projection, type XY } from '../geo/geo.ts';
import { num, text, type Feature, type FeatureCollection, type Position } from './geojson.ts';

export type AssetKind = 'structure' | 'inlet' | 'outlet' | 'vault' | 'barrier' | 'pipe' | 'channel' | 'pond';

/** Drains: catch basins, manholes, culvert and ditch inlets. */
export const DRAIN_KINDS: ReadonlySet<AssetKind> = new Set(['structure', 'inlet']);
export const POINT_KINDS: ReadonlySet<AssetKind> = new Set(['structure', 'inlet', 'outlet', 'vault', 'barrier']);
export const LINE_KINDS: ReadonlySet<AssetKind> = new Set(['pipe', 'channel']);

export interface Asset {
  index: number;
  /** City AssetID, '' if blank. */
  id: string;
  /** Unique key: ID, `ID#2` if repeated, `kind@row` if blank. */
  key: string;
  kind: AssetKind;
  /** Layer type field (StructureT, InletType, ...). */
  type: string;
  /** Point, line start, or pond centroid. */
  anchor: XY;
  /** Lines only, flow direction. */
  line?: XY[];
  /** Ponds only: polygons (outer ring + holes). */
  polygons?: XY[][][];
  lengthM: number;
  /** Width as recorded (inches for pipes). */
  width: number;
  /** Perforated pipe, soaks in. */
  perforated: boolean;
  /** "GALLERY" in the city description (maybe infiltration, unverified). */
  gallery: boolean;
  /** Structure bottom: Solid / Open / Perforated. */
  bottom: string;
  /** City-recorded from/to links. */
  fromId: string;
  toId: string;
  /** Downstream asset type; for ponds, the listed receiving water. */
  toType: string;
}

/** Source layers by asset kind. */
export type StormLayers = Record<AssetKind, FeatureCollection>;

export interface AssetLoad {
  assets: Asset[];
  projection: Projection;
  skippedNoGeometry: { kind: AssetKind; id: string }[];
  duplicateIds: Record<string, number>;
}

const TYPE_FIELD: Record<AssetKind, string> = {
  structure: 'StructureT',
  inlet: 'InletType',
  outlet: 'OutletType',
  vault: 'StructureT',
  barrier: 'BarrierTyp',
  pipe: 'MainLineTy',
  channel: 'ChannelTyp',
  pond: 'FacilityTy',
};

const KIND_ORDER: AssetKind[] = ['structure', 'inlet', 'outlet', 'vault', 'barrier', 'pipe', 'channel', 'pond'];

export function loadAssets(layers: StormLayers, projection: Projection = localProjection()): AssetLoad {
  const assets: Asset[] = [];
  const skippedNoGeometry: AssetLoad['skippedNoGeometry'] = [];
  const seenIds = new Map<string, number>();
  const duplicateIds: Record<string, number> = {};
  const xy = (p: Position): XY => projection.toXY([p[0], p[1]]);

  for (const kind of KIND_ORDER) {
    layers[kind].features.forEach((f: Feature, row) => {
      const p = f.properties ?? {};
      const id = text(p.AssetID);
      const g = f.geometry;
      let anchor: XY | undefined;
      let line: XY[] | undefined;
      let polygons: XY[][][] | undefined;
      if (g?.type === 'Point' && g.coordinates.length >= 2) anchor = xy(g.coordinates);
      else if (g?.type === 'LineString') line = g.coordinates.map(xy);
      // multi-part line: join parts in order (2 pipes)
      else if (g?.type === 'MultiLineString') line = g.coordinates.flat().map(xy);
      else if (g?.type === 'Polygon') polygons = [g.coordinates.map((r) => r.map(xy))];
      else if (g?.type === 'MultiPolygon') polygons = g.coordinates.map((poly) => poly.map((r) => r.map(xy)));
      // outer ring must be a real ring
      if (polygons) polygons = polygons.filter((rings) => rings.length > 0 && rings[0].length >= 3);
      if (line?.length) anchor = line[0];
      if (polygons?.length) anchor = polygonsCentroid(polygons);
      if (!anchor) {
        // no usable geometry: count and skip
        skippedNoGeometry.push({ kind, id });
        return;
      }

      // keys stay unique when IDs repeat or are blank
      const count = (seenIds.get(id) ?? 0) + 1;
      seenIds.set(id, count);
      if (id && count > 1) duplicateIds[id] = count - 1;
      const key = !id ? `${kind}@${row}` : count === 1 ? id : `${id}#${count}`;

      assets.push({
        index: assets.length,
        id,
        key,
        kind,
        type: text(p[TYPE_FIELD[kind]]),
        anchor,
        line,
        polygons,
        lengthM: line ? polylineLength(line) : 0,
        width: num(kind === 'pipe' ? p.PipeWidth : p.ChannelWid),
        perforated: kind === 'pipe' && text(p.PipeWallTy) === 'Perforated',
        gallery: text(p.Descriptio).toUpperCase().includes('GALLERY'),
        bottom: text(p.BottomType),
        fromId: text(p.AssetFromI),
        toId: text(p.AssetToID),
        toType: text(p.AssetToTyp),
      });
    });
  }
  return { assets, projection, skippedNoGeometry, duplicateIds };
}

export function isDrain(a: Asset): boolean {
  return DRAIN_KINDS.has(a.kind);
}

/** Drywells (DW- IDs, "Drum") and open/perforated-bottom structures soak in. */
export function isDrywell(a: Asset): boolean {
  return a.kind === 'structure' && (a.id.startsWith('DW-') || a.type === 'Drum' || a.bottom === 'Open' || a.bottom === 'Perforated');
}

/** Start and end of a line, in flow direction. */
export function ends(a: Asset): { A: XY; B: XY } {
  const line = a.line!;
  return { A: line[0], B: line[line.length - 1] };
}
