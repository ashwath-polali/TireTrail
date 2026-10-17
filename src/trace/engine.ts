// Source layers -> traced network.
import { localProjection, type Projection } from '../geo/geo.ts';
import { loadAssets, type StormLayers } from './assets.ts';
import type { FeatureCollection } from './geojson.ts';
import { buildNetwork, DEFAULT_NETWORK_OPTIONS, type Network, type NetworkOptions } from './network.ts';
import { DEFAULT_TRACE_OPTIONS, loadOutfalls, Tracer, type OutfallInfo, type Trace, type TraceOptions } from './trace.ts';
import { Waters, type WaterLayers } from './waters.ts';

export interface TraceInputs {
  storm: StormLayers;
  waters: WaterLayers;
  outfalls: FeatureCollection;
}

export interface TracedNetwork {
  projection: Projection;
  net: Network;
  waters: Waters;
  outfalls: Map<string, OutfallInfo>;
  tracer: Tracer;
  /** One trace per drain. */
  traces: Trace[];
}

export function traceNetwork(
  inputs: TraceInputs,
  options: { network?: NetworkOptions; trace?: TraceOptions } = {},
): TracedNetwork {
  const projection = localProjection();
  const load = loadAssets(inputs.storm, projection);
  const outfalls = loadOutfalls(inputs.outfalls);
  const net = buildNetwork(load, new Set(outfalls.keys()), options.network ?? DEFAULT_NETWORK_OPTIONS);
  const waters = new Waters(inputs.waters, projection);
  const tracer = new Tracer({ net, waters, outfalls, opts: options.trace ?? DEFAULT_TRACE_OPTIONS });
  return { projection, net, waters, outfalls, tracer, traces: tracer.traceAll() };
}
