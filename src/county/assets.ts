// Pierce County drainage layers -> assets, in local meters. No from/to IDs here: links come from geometry (graph.ts).
import { polygonsCentroid, polylineLength, type Projection, type XY } from '../geo/geo.ts';
import type { Asset, AssetKind } from '../trace/assets.ts';
import { text, type Feature, type FeatureCollection, type Position } from '../trace/geojson.ts';

/** Which county layer an asset came from. */
export type CountyLayer =
  | 'drain'
  | 'network'
  | 'endpoint'
  | 'inlet'
  | 'outlet'
  | 'barrier'
  | 'pipe'
  | 'channel'
  | 'virtual'
  | 'facility'
  | 'basin';

export interface CountyAsset extends Asset {
  layer: CountyLayer;
  /** PropertyOwner: Public, Private, ... */
  owner: string;
  /** Pipe carries a live stream (LiveStreamCulvert = 1). */
  liveStream: boolean;
}

export interface CountyStormLayers {
  drainStructures: FeatureCollection;
  networkStructures: FeatureCollection;
  endPoints: FeatureCollection;
  inletComponents: FeatureCollection;
  outletComponents: FeatureCollection;
  barriers: FeatureCollection;
  mainLines: FeatureCollection;
  openChannels: FeatureCollection;
  virtualDrainlines: FeatureCollection;
  facilityPolygons: FeatureCollection;
  storageBasins: FeatureCollection;
}

interface LayerSpec {
  layer: CountyLayer;
  kind: AssetKind;
  source: keyof CountyStormLayers;
  type: string;
  id: string;
}

// order matters for keys: earlier layers keep the bare ID when IDs repeat
const SPECS: LayerSpec[] = [
  { layer: 'drain', kind: 'structure', source: 'drainStructures', type: 'StructureType', id: 'AssetID' },
  { layer: 'network', kind: 'vault', source: 'networkStructures', type: 'StructureType', id: 'AssetID' },
  { layer: 'endpoint', kind: 'outlet', source: 'endPoints', type: 'EndPointType', id: 'AssetID' },
  { layer: 'inlet', kind: 'inlet', source: 'inletComponents', type: 'InletType', id: 'AssetID' },
  { layer: 'outlet', kind: 'outlet', source: 'outletComponents', type: 'OutletType', id: 'AssetID' },
  { layer: 'barrier', kind: 'barrier', source: 'barriers', type: 'BarrierType', id: 'AssetID' },
  { layer: 'pipe', kind: 'pipe', source: 'mainLines', type: 'MainLineType', id: 'AssetID' },
  { layer: 'channel', kind: 'channel', source: 'openChannels', type: 'ChannelType', id: 'AssetID' },
  { layer: 'virtual', kind: 'pipe', source: 'virtualDrainlines', type: '', id: 'AssetID' },
  { layer: 'facility', kind: 'pond', source: 'facilityPolygons', type: 'ComponentType', id: 'AssetID' },
  { layer: 'basin', kind: 'pond', source: 'storageBasins', type: 'UNITDESC', id: 'UNITID' },
];

/** Catch basins and curb inlets: where street water goes in. */
const DRAIN_TYPES = new Set(['Catch Basin - Type1', 'Catch Basin - Type2', 'Curb Inlet', 'CBMF']);
/** Inlet components that take road water. */
const ROAD_INLET_TYPES = new Set(['Curb Cut', 'Bridge Scupper']);

export function isCountyDrain(a: CountyAsset): boolean {
  return (a.layer === 'drain' && DRAIN_TYPES.has(a.type)) || (a.layer === 'inlet' && ROAD_INLET_TYPES.has(a.type));
}

/** A drain in a bridge deck (County inlet type "Bridge Scupper"). */
export function isBridgeDrain(a: CountyAsset): boolean {
  return (a.layer === 'inlet' || a.layer === 'drain') && /bridge|scupper/i.test(a.type);
}

/** Open channels that can run along a road and take its rain: man-made ditches and swales, not streams or spillways. */
const ROADSIDE_CHANNEL_TYPES = new Set(['Man-made', 'Bioretention Swale', 'Biofiltration Swale']);

export function isRoadsideChannel(a: CountyAsset): boolean {
  return a.layer === 'channel' && a.line !== undefined && ROADSIDE_CHANNEL_TYPES.has(a.type);
}

/** Open or perforated bottom: water soaks out of the structure. */
export function soaksThroughBottom(a: CountyAsset): boolean {
  return (a.layer === 'drain' || a.layer === 'network') && (a.bottom === 'Open' || a.bottom === 'Perforated');
}

export interface CountyAssetLoad {
  assets: CountyAsset[];
  projection: Projection;
  skipped: { noGeometry: number; abandoned: number };
}

export function loadCountyAssets(layers: CountyStormLayers, projection: Projection): CountyAssetLoad {
  const assets: CountyAsset[] = [];
  const seen = new Map<string, number>();
  const skipped = { noGeometry: 0, abandoned: 0 };
  const xy = (p: Position): XY => projection.toXY([p[0], p[1]]);

  for (const spec of SPECS) {
    layers[spec.source].features.forEach((f: Feature, row) => {
      const p = f.properties ?? {};
      if (text(p.Asset_Service_Status) === 'Abandoned') {
        skipped.abandoned++;
        return;
      }
      const g = f.geometry;
      let anchor: XY | undefined;
      let line: XY[] | undefined;
      let polygons: XY[][][] | undefined;
      if (g?.type === 'Point' && g.coordinates.length >= 2) anchor = xy(g.coordinates);
      else if (g?.type === 'LineString' && g.coordinates.length >= 2) line = g.coordinates.map(xy);
      else if (g?.type === 'MultiLineString') {
        const pts = g.coordinates.flat();
        if (pts.length >= 2) line = pts.map(xy);
      } else if (g?.type === 'Polygon') polygons = [g.coordinates.map((r) => r.map(xy))];
      else if (g?.type === 'MultiPolygon') polygons = g.coordinates.map((poly) => poly.map((r) => r.map(xy)));
      if (polygons) polygons = polygons.filter((rings) => rings.length > 0 && rings[0].length >= 3);
      if (line) anchor = line[0];
      if (polygons?.length) anchor = polygonsCentroid(polygons);
      else polygons = undefined;
      if (!anchor) {
        skipped.noGeometry++;
        return;
      }
      const id = text(p[spec.id]);
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      const key = !id ? `${spec.layer}@${row}` : count === 1 ? id : `${id}#${count}`;
      const type = spec.layer === 'virtual' ? 'Virtual Drainline' : text(p[spec.type]);
      assets.push({
        index: assets.length,
        id,
        key,
        kind: spec.kind,
        layer: spec.layer,
        type,
        anchor,
        line,
        polygons,
        lengthM: line ? polylineLength(line) : 0,
        width: Number(p.PipeWidth ?? p.ChannelWidth ?? 0) || 0,
        perforated: spec.layer === 'pipe' && text(p.PipeWallType) === 'Perforated',
        gallery: false,
        bottom: text(p.BottomType),
        fromId: '',
        toId: '',
        toType: '',
        owner: text(p.PropertyOwner),
        liveStream: spec.layer === 'pipe' && Number(p.LiveStreamCulvert) === 1,
      });
    });
  }
  return { assets, projection, skipped };
}

/** Everyday name with ID, e.g. "catch basin CB091701_1-34", or "an unnamed pond". No owner or facility names. */
export function describeCounty(a: CountyAsset): string {
  const t = a.type.toLowerCase();
  let label: string;
  switch (a.layer) {
    case 'drain':
      label = t.startsWith('catch basin') || t === 'cbmf' ? 'catch basin' : t === 'curb inlet' ? 'curb inlet' : t.startsWith('manhole') || t === 'mhmf' ? 'manhole' : 'structure';
      break;
    case 'network':
      label = t.includes('vault') ? t.replace(/\s*-\s*other$/, '') : t || 'structure';
      break;
    case 'endpoint':
      label = endPointLabel(a.type);
      break;
    case 'inlet':
      label = t === 'curb cut' ? 'curb cut' : t === 'bridge scupper' ? 'bridge drain' : 'inlet';
      break;
    case 'outlet':
      label = 'outlet';
      break;
    case 'barrier':
      label = 'ditch barrier';
      break;
    case 'pipe':
      label = a.liveStream ? 'stream culvert' : a.type === 'Culvert' ? 'culvert' : a.perforated ? 'perforated pipe' : 'pipe';
      break;
    case 'channel':
      label = t.includes('swale') ? t : t === 'natural' ? 'natural channel' : 'ditch';
      break;
    case 'virtual':
      label = 'connection';
      break;
    case 'facility':
    case 'basin':
      label = t && t !== 'other' && t !== 'unknown' ? t.replace(/_other$/, '').replace(/_/g, ' ') : 'pond';
      break;
  }
  return a.id ? `${label} ${a.id}` : `an unnamed ${label}`;
}

export type EndPointGroup = 'outfall' | 'discharge' | 'endpoint';

/** County end point types: outfalls to surface water, discharge points (into the ground), plain ends of the map. */
export function endPointGroup(type: string): EndPointGroup {
  if (/outfall|possibleof/i.test(type)) return 'outfall';
  if (/discharge|possibledp/i.test(type)) return 'discharge';
  return 'endpoint';
}

export function isPossible(type: string): boolean {
  return /possible/i.test(type);
}

function endPointLabel(type: string): string {
  const g = endPointGroup(type);
  const possible = isPossible(type) ? 'possible ' : '';
  return g === 'outfall' ? `${possible}outfall` : g === 'discharge' ? `${possible}discharge point` : 'end point';
}

/** Facility cells that soak water into the ground. */
export const INFILTRATION_CELLS: ReadonlySet<string> = new Set([
  'Infiltration Cell',
  'Infiltration Trench',
  'Bioretention Cell',
  'Raingarden',
  'Dispersal Trench',
  'Dispersal Flow Path',
]);

/** Facility cells that hold water and pass it on (e.g. a wet pond ahead of an infiltration cell). */
export const HOLDING_CELLS: ReadonlySet<string> = new Set([
  'Wet Pond Cell',
  'Detention Cell',
  'Sedimentation Cell',
  'Unclassified Pond Cell',
  'Water-quality Wetland Cell',
  'PVT Pond Cell',
  'Detention_Compensatory Storage',
]);

/** A pond that holds water (a holding cell, a storage basin, or a cell of no stated type), not a planting area or filter. */
export function isPondCell(a: CountyAsset): boolean {
  return a.kind === 'pond' && (HOLDING_CELLS.has(a.type) || a.layer === 'basin' || a.type === '' || a.type === 'Other' || a.type === 'Unknown');
}
