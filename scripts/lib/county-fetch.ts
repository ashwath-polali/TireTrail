// Downloads Pierce County layers into .cache/county/ (Node only). Skips files already there.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { FeatureCollection } from '../../src/trace/geojson.ts';

export const CACHE = '.cache/county';
const PIERCE = 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services';
const SWIFD = 'https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/SWIFD/MapServer/0';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023/Places_CouSub_ConCity_SubMCD/MapServer';
/** lon/lat box around the county, for the WDFW query */
export const PIERCE_BOX = [-122.86, 46.72, -121.38, 47.42] as const;

interface LayerSpec {
  url: string;
  fields: string[];
  where?: string;
  box?: boolean;
  /** server page size */
  page?: number;
}

const pierce = (service: string, fields: string[], layer = 0, page = 2000): LayerSpec => ({
  url: `${PIERCE}/${service}/FeatureServer/${layer}`,
  fields,
  page,
});

export const COUNTY_LAYERS = {
  drainStructures: pierce('Drainage_Drain_Structures', ['AssetID', 'StructureType', 'UICSystemID', 'PropertyOwner', 'BottomType', 'WallType', 'Description', 'Comment', 'Asset_Service_Status', 'Enabled']),
  networkStructures: pierce('Drainage_Network_Structures', ['AssetID', 'StructureType', 'UICSystemID', 'PropertyOwner', 'BottomType', 'Description', 'Comment', 'Asset_Service_Status', 'Enabled']),
  networkStructurePolygons: pierce('Drainage_Network_Structure_Polygons', ['NetworkStructureID', 'Asset_Service_Status']),
  mainLines: pierce('Drainage_Main_Lines', ['AssetID', 'MainLineType', 'UICSystemID', 'PropertyOwner', 'PipeWallType', 'PipeWidth', 'LiveStreamCulvert', 'UpstreamInvertDepth', 'DownstreamInvertDepth', 'Slope', 'UpstreamInvertElevation', 'DownstreamInvertElevation', 'Description', 'Asset_Service_Status', 'Enabled']),
  openChannels: pierce('Drainage_Open_Channels', ['AssetID', 'ChannelType', 'UICSystemID', 'PropertyOwner', 'ChannelWidth', 'Slope', 'UpstreamInvertElevation', 'DownstreamInvertElevation', 'Description', 'Asset_Service_Status', 'Enabled']),
  virtualDrainlines: pierce('Drainage_Virtual_Drainlines', ['AssetID', 'Description', 'Asset_Service_Status', 'Enabled']),
  endPoints: pierce('Drainage_End_Points', ['AssetID', 'EndPointType', 'UICSystemID', 'PropertyOwner', 'Description', 'Comment', 'DrainsTo', 'Enabled']),
  circuits: pierce('Drainage_Circuits', ['CircuitID', 'LastStructureID']),
  inletComponents: pierce('Drainage_Inlet_Components', ['AssetID', 'InletType', 'Description', 'Asset_Service_Status', 'Enabled']),
  outletComponents: pierce('Drainage_Outlet_Components', ['AssetID', 'OutletType', 'Description', 'Asset_Service_Status', 'Enabled']),
  barriers: pierce('Drainage_Open_Channel_Barriers', ['AssetID', 'BarrierType']),
  breakPoints: pierce('Drainage_Break_Points', ['AssetID', 'BreakDirection']),
  facilityPolygons: pierce('Drainage_Facility_Component_Polygons', ['AssetID', 'FacilityID', 'ComponentType', 'Description', 'Asset_Service_Status']),
  storageBasins: pierce('Stormwater_Storage_Basins', ['UNITID', 'NetworkStructureID', 'UNITDESC'], 1),
  privatePonds: pierce('Stormwater_Private_Ponds_Unincorporated', ['FacilityID', 'ComponentT', 'Comment'], 1),
  outfallInventory: pierce('MO_Outfalls_022726', ['of_status', 'asset_class', 'owner', 'emergency_overflow', 'wetland'], 19),
  roads: pierce('Roads', ['ROADS_ID', 'FULLNAME', 'LCITY', 'RCITY', 'MAP_CLASS']),
  hydroCenterlines: pierce('Hydro_Centerlines', ['FeatureName', 'FeatureType', 'Label', 'StreamTypeNPDES', 'Confidence']),
  hydroWaterbodies: pierce('Hydro_Waterbodies', ['FeatureName', 'FeatureType', 'Label', 'Acres']),
  huc12: pierce('Watersheds_Huc12_Phase1', ['HUC12', 'HUC10', 'Name', 'HUC10Name', 'HUC8Name', 'Acres'], 1),
  watersheds: pierce('Watersheds', ['WRIA_NAME', 'WRP_NAME', 'SUB_NAME', 'HUC12_NAME'], 0, 1000),
  swifdCoho: {
    url: SWIFD,
    fields: ['LLID', 'LLID_STRM_NAME', 'SPECIESRUN', 'DISTTYPE_DESC', 'USETYPE_DESC', 'LIFEHIST_DESC'],
    where: "SPECIESRUN = 'Coho'",
    box: true,
    page: 500,
  },
  // area names only
  places: { url: `${TIGER}/11`, fields: ['BASENAME', 'GEOID'], where: "STATE='53'", box: true, page: 100 },
  cities: { url: `${TIGER}/10`, fields: ['BASENAME', 'GEOID'], where: "STATE='53'", box: true, page: 100 },
} satisfies Record<string, LayerSpec>;

export type CountyLayerName = keyof typeof COUNTY_LAYERS;
export type CountyLayers = Record<CountyLayerName, FeatureCollection>;

async function getJSON(url: string, body?: URLSearchParams): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, body ? { method: 'POST', body } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

function baseParams(spec: LayerSpec): Record<string, string> {
  const p: Record<string, string> = { where: spec.where ?? '1=1' };
  if (spec.box) {
    Object.assign(p, {
      geometry: PIERCE_BOX.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
    });
  }
  return p;
}

/** All features of one layer, by object id chunks (works on MapServer and FeatureServer). */
async function download(name: string, spec: LayerSpec, log: (s: string) => void): Promise<FeatureCollection> {
  const ids: number[] = (await getJSON(`${spec.url}/query`, new URLSearchParams({ ...baseParams(spec), returnIdsOnly: 'true', f: 'json' }))).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const size = spec.page ?? 2000;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const parts: FeatureCollection['features'][] = new Array(chunks.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const body = new URLSearchParams({
        objectIds: chunks[k].join(','),
        outFields: spec.fields.join(','),
        outSR: '4326',
        geometryPrecision: '7',
        f: 'geojson',
      });
      const json = await getJSON(`${spec.url}/query`, body);
      parts[k] = json.features ?? [];
      done++;
      if (done % 10 === 0 || done === chunks.length) log(`  ${name}: ${done}/${chunks.length} pages`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, worker));
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${name}: got ${features.length} of ${ids.length} features`);
  return { type: 'FeatureCollection', features };
}

export async function fetchCounty(log: (s: string) => void = console.log): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  for (const [name, spec] of Object.entries(COUNTY_LAYERS) as [CountyLayerName, LayerSpec][]) {
    const file = `${CACHE}/${name}.geojson`;
    if (existsSync(file)) continue;
    log(`Downloading ${name}`);
    const fc = await download(name, spec, log);
    writeFileSync(`${file}.part`, JSON.stringify(fc));
    renameSync(`${file}.part`, file);
    log(`  ${name}: ${fc.features.length} features`);
  }
}

export function readCounty(): CountyLayers {
  const out = {} as CountyLayers;
  for (const name of Object.keys(COUNTY_LAYERS) as CountyLayerName[]) {
    out[name] = JSON.parse(readFileSync(`${CACHE}/${name}.geojson`, 'utf8')) as FeatureCollection;
  }
  return out;
}

/** Source URL and query of each layer, for the credits file. */
export function layerSources(): Record<string, string> {
  return Object.fromEntries(Object.entries(COUNTY_LAYERS).map(([k, v]) => [k, (v as LayerSpec).where ? `${v.url} (${(v as LayerSpec).where})` : v.url]));
}
