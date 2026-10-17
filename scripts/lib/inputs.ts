// reads data/ layers (Node only)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { StormLayers } from '../../src/trace/assets.ts';
import type { FeatureCollection } from '../../src/trace/geojson.ts';
import type { WaterLayers } from '../../src/trace/waters.ts';

const DATA = new URL('../../data/', import.meta.url);

export function readGeoJSON(relativePath: string): FeatureCollection {
  return JSON.parse(readFileSync(new URL(relativePath, DATA), 'utf8')) as FeatureCollection;
}

export interface Inputs {
  storm: StormLayers;
  waters: WaterLayers;
  outfalls: FeatureCollection;
  streets: FeatureCollection;
  fennelBasin: FeatureCollection;
  cohoReaches: FeatureCollection;
  cityLimits: FeatureCollection;
}

export function loadInputs(): Inputs {
  return {
    storm: {
      structure: readGeoJSON('raw/swcp_drainage_structure.geojson'),
      inlet: readGeoJSON('raw/swcp_inlet.geojson'),
      outlet: readGeoJSON('raw/swcp_outlet.geojson'),
      vault: readGeoJSON('raw/swcp_vaults.geojson'),
      barrier: readGeoJSON('raw/swcp_open_channel_barrier.geojson'),
      pipe: readGeoJSON('raw/swcp_pipe.geojson'),
      channel: readGeoJSON('raw/swcp_open_channel.geojson'),
      pond: readGeoJSON('raw/swcp_pond.geojson'),
    },
    waters: {
      fennelCreek: readGeoJSON('raw/blportal_fennel_creek.geojson'),
      fennelTributaries: readGeoJSON('raw/blportal_fennel_tributaries.geojson'),
      streamClassification: readGeoJSON('raw/blportal_stream_classification.geojson'),
      nhdWaterbody: readGeoJSON('raw/nhd_waterbody.geojson'),
      nhdFlowline: readGeoJSON('raw/nhd_flowline.geojson'),
    },
    outfalls: readGeoJSON('derived/outfalls_receiving.geojson'),
    streets: readGeoJSON('derived/roads_coho_bonneylake.geojson'),
    fennelBasin: readGeoJSON('raw/nldi_fennel_basin.geojson'),
    cohoReaches: readGeoJSON('raw/swifd_coho_bonneylake.geojson'),
    cityLimits: readGeoJSON('raw/blportal_city_limits.geojson'),
  };
}

/** SHA-256 prefix of each input layer */
export function sourceHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ['raw', 'derived']) {
    const base = new URL(`${dir}/`, DATA);
    for (const file of readdirSync(base).filter((f) => f.endsWith('.geojson')).sort()) {
      out[`${dir}/${file}`] = createHash('sha256').update(readFileSync(new URL(file, base))).digest('hex').slice(0, 16);
    }
  }
  return out;
}

/** reference trace, only for agreement */
export function loadAnswerKey(): FeatureCollection {
  return readGeoJSON('reference/inlet_outcomes.geojson');
}
