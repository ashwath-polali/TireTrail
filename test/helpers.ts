/** small hand-made storm networks, in meters around the origin */
import { localProjection, type XY } from '../src/geo/geo.ts';
import type { AssetKind, StormLayers } from '../src/trace/assets.ts';
import { traceNetwork, type TracedNetwork } from '../src/trace/engine.ts';
import type { Feature, FeatureCollection, Properties } from '../src/trace/geojson.ts';
import type { Link } from '../src/trace/network.ts';
import type { WaterLayers } from '../src/trace/waters.ts';

export const P = localProjection();
const ll = (p: XY) => P.toLngLat(p);

export const fc = (features: Feature[] = []): FeatureCollection => ({ type: 'FeatureCollection', features });

export const point = (properties: Properties, at: XY): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates: ll(at) },
});

export const line = (properties: Properties, pts: XY[]): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates: pts.map(ll) },
});

export const polygon = (properties: Properties, ring: XY[]): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(ll)] },
});

export const square = (cx: number, cy: number, half: number): XY[] => [
  [cx - half, cy - half],
  [cx + half, cy - half],
  [cx + half, cy + half],
  [cx - half, cy + half],
];

export const catchBasin = (id: string, at: XY, extra: Properties = {}) =>
  point({ AssetID: id, StructureT: 'Catch Basin - Type1', BottomType: 'Solid', Descriptio: '', ...extra }, at);

export const pipe = (id: string, from: string, to: string, pts: XY[], extra: Properties = {}) =>
  line({ AssetID: id, AssetFromI: from, AssetToID: to, AssetToTyp: '', MainLineTy: 'Conveyance Pipe', PipeWidth: 12, PipeWallTy: 'Solid', ...extra }, pts);

export const pond = (id: string, type: string, ring: XY[], extra: Properties = {}) =>
  polygon({ AssetID: id, FacilityTy: type, AssetFromI: '', AssetToID: '', AssetToTyp: '', FacilityNa: '', ...extra }, ring);

export const outfall = (pipeId: string, fennel: boolean | null, receiving: string, at: XY) =>
  point({ outfall_id: `OF-${pipeId}`, pipe: pipeId, receiving_water: receiving, fennel_system: fennel }, at);

export function storm(parts: Partial<Record<AssetKind, Feature[]>>): StormLayers {
  return {
    structure: fc(parts.structure),
    inlet: fc(parts.inlet),
    outlet: fc(parts.outlet),
    vault: fc(parts.vault),
    barrier: fc(parts.barrier),
    pipe: fc(parts.pipe),
    channel: fc(parts.channel),
    pond: fc(parts.pond),
  };
}

export function waters(parts: Partial<Record<keyof WaterLayers, Feature[]>> = {}): WaterLayers {
  return {
    fennelCreek: fc(parts.fennelCreek),
    fennelTributaries: fc(parts.fennelTributaries),
    streamClassification: fc(parts.streamClassification),
    nhdWaterbody: fc(parts.nhdWaterbody),
    nhdFlowline: fc(parts.nhdFlowline),
  };
}

export function build(
  parts: Partial<Record<AssetKind, Feature[]>>,
  extra: { waters?: Partial<Record<keyof WaterLayers, Feature[]>>; outfalls?: Feature[] } = {},
): TracedNetwork {
  return traceNetwork({ storm: storm(parts), waters: waters(extra.waters), outfalls: fc(extra.outfalls) });
}

export function link(t: TracedNetwork, fromKey: string, toKey: string): Link | undefined {
  const from = t.net.assets.find((a) => a.key === fromKey);
  return from ? t.net.out[from.index].find((l) => t.net.assets[l.to].key === toKey) : undefined;
}

export function traceOf(t: TracedNetwork, drainKey: string) {
  const trace = t.traces.find((x) => t.net.assets[x.drain].key === drainKey);
  if (!trace) throw new Error(`no drain ${drainKey}`);
  return { ...trace, keys: trace.path.map((k) => t.net.assets[k].key) };
}
