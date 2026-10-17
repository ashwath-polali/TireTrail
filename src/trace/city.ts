// Traced network, street classes, fix list, numbers.
import type { XY } from '../geo/geo.ts';
import { traceNetwork, type TraceInputs, type TracedNetwork } from './engine.ts';
import { buildFixList, type FixItem } from './fixlist.ts';
import type { FeatureCollection } from './geojson.ts';
import { computeNumbers, type AppNumbers } from './numbers.ts';
import { classifyStreets, type StreetResult } from './streets.ts';

export interface CityInputs extends TraceInputs {
  streets: FeatureCollection;
  fennelBasin: FeatureCollection;
}

export interface CityResult extends TracedNetwork {
  streets: StreetResult;
  fixList: FixItem[];
  numbers: AppNumbers;
  fennelBasin: XY[][][];
}

export function analyzeCity(inputs: CityInputs): CityResult {
  const traced = traceNetwork(inputs);
  const { net, traces, projection } = traced;
  const streets = classifyStreets(inputs.streets, net, traces, projection);
  const fixList = buildFixList(net, traces, streets, traced.outfalls);
  const fennelBasin: XY[][][] = [];
  for (const f of inputs.fennelBasin.features) {
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) fennelBasin.push(rings.map((r) => r.map((c) => projection.toXY([c[0], c[1]]))));
  }
  const numbers = computeNumbers(net, traces, streets, fixList, fennelBasin);
  return { ...traced, streets, fixList, numbers, fennelBasin };
}
