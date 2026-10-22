// Seattle Public Utilities drainage -> <cache>/sources/seattle/assets.ndjson + meta.json (see src/county/source.ts).
// Usage: node scripts/sources/seattle.ts [--box=minLon,minLat,maxLon,maxLat] [--refresh] [--fetch-only]
// SPU feature keys link drains -> laterals -> mainlines, ditches and curbs -> outfalls. Each drain's lateral
// chain becomes one lead line, and mainlines are split where leads join them. Combined and sanitary sewers
// end where street water first enters them (endHint 'treatment'); sanitary pipes themselves are dropped.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { GridIndex, localProjection, nearestOnPolyline, pointInPolygon, type XY } from '../../src/geo/geo.ts';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';

const ORG = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services';
const KC_CITIES = 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/CITY_AREA_448/FeatureServer/0';
const CACHE = process.env.TT_CACHE ?? '.cache';
const KEY = 'seattle';
const PAGE = 2000;
const KEYS_PER_QUERY = 250;
const PER_HOST = 4;
/** a blank line end this close to a structure (else a keyed line end) takes its key */
const FILL_M = 0.5;
/** a wye this close to a mainline end joins that end instead of splitting the line */
const SPLIT_END_M = 0.3;

type Props = Record<string, unknown>;
interface Feat {
  geometry: { type: string; coordinates: any } | null;
  properties: Props;
}

interface LayerSpec {
  url: string;
  fields: string[];
  where?: string;
  /** fetched whole even in a box run */
  whole?: boolean;
}

// explicit allowlists: no addresses, location text, owner or staff names, notes or links (plan section F)
const MNL = ['MNL_FEA_KEY', 'MNL_UPS_FEATURE_KEY', 'MNL_DNS_FEATURE_KEY', 'MNL_MNLPT_ID', 'MNL_FEATYPE_CODE', 'MNL_OWNER_CODE', 'MNL_PRBL_FLOW_CODE', 'MNL_LIFECYCLE_CODE', 'MNL_PERF_PIPE_FLAG', 'MNL_WIDTH_IN_NBR', 'MNL_UPS_ELEV_FT_NBR', 'MNL_DNS_ELEV_FT_NBR', 'MNL_STREAM_NAME'];
const MNLEP = ['MNLEP_FEA_KEY', 'MNLEP_S_ENDPT_ID', 'MNLEP_D_ENDPT_ID', 'MNLEP_FEATYPE_CODE', 'MNLEP_OWNER_CODE', 'MNLEP_LIFECYCLE_CODE'];
const CB = ['CB_FEA_KEY', 'CB_CB_ID', 'CB_FEATYPE_CODE', 'CB_OWNER_CODE', 'CB_LIFECYCLE_CODE', 'CB_ROLE_CODE', 'CB_REC_WTRBDY_NAME'];
const NMNL = ['NMNL_FEA_KEY', 'NMNL_UPS_FEATURE_KEY', 'NMNL_DNS_FEATURE_KEY', 'NMNL_FEATYPE_CODE', 'NMNL_OWNER_CODE', 'NMNL_PRBL_FLOW_CODE', 'NMNL_LIFECYCLE_CODE', 'NMNL_PERF_PIPE_FLAG', 'NMNL_WIDTH_IN_NBR', 'NMNL_STREAM_NAME'];
const DCH = ['DCH_FEA_KEY', 'DCH_UPS_FEATURE_KEY', 'DCH_DNS_FEATURE_KEY', 'DCH_EQNUM_ID', 'DCH_FEATYPE_CODE', 'DCH_OWNER_CODE', 'DCH_PRBL_FLOW_CODE', 'DCH_LIFECYCLE_CODE', 'DCH_PERF_PIPE_FLAG', 'DCH_WIDTH_IN_NBR', 'DCH_UPS_ELEV_FT_NBR', 'DCH_DNS_ELEV_FT_NBR', 'DCH_STREAM_NAME'];
const OUT = ['OUT_FEA_KEY', 'OUT_OUTFALL_ID', 'OUT_NPDES_ID', 'OUT_OWNER_CODE', 'OUT_LIFECYCLE_CODE', 'OUT_ROLE_CODE', 'OUT_PRBL_FLOW_CODE', 'OUT_PIPE_FEA_KEY', 'OUT_REC_WTRBDY_NAME', 'OUT_CWSHD_NAME'];
const SDP = ['SDP_FEA_KEY', 'SDP_ASSET_ID', 'SDP_FEA_TYPE_TEXT', 'SDP_OWNER_TEXT', 'SDP_LIFECYCLE_TEXT', 'SDP_RC_WTRBDY_NAME'];

const CBS = `${ORG}/SPU_DWW_Catch_Basins_Inlets_Junction_Boxes_Sandboxes_and_Trash_Racks/FeatureServer`;
const LAYERS = {
  mainlines: { url: `${ORG}/SPU_DWW_Mainlines_External/FeatureServer/11`, fields: MNL },
  forceMains: { url: `${ORG}/SPU_DWW_Mainlines_External/FeatureServer/14`, fields: MNL },
  detentionLines: { url: `${ORG}/SPU_DWW_Mainlines_External/FeatureServer/15`, fields: MNL },
  endPoints: { url: `${ORG}/SPU_DWW_Mainline_Points_External/FeatureServer/1`, fields: MNLEP },
  wyes: { url: `${ORG}/SPU_DWW_Mainline_Points_External/FeatureServer/5`, fields: ['MNLCP_FEA_KEY', 'MNLCP_MNL_FEATURE_KEY'] },
  catchBasins: { url: `${CBS}/2`, fields: CB },
  inlets: { url: `${CBS}/3`, fields: CB },
  boxes: { url: `${CBS}/4`, fields: CB },
  laterals: { url: `${ORG}/SPU_DWW_Non_Mainlines_External_DSO_view/FeatureServer/1`, fields: NMNL },
  ditches: { url: `${ORG}/SPU_DWW_Ditches_and_Culverts/FeatureServer/1`, fields: DCH },
  curbs: { url: `${ORG}/SPU_DWW_Surface_Drainage_Curb_and_Gutter/FeatureServer/1`, fields: DCH },
  outfalls: { url: `${ORG}/SPU_DWW_Storm_Outfalls/FeatureServer/0`, fields: OUT },
  surfacePoints: { url: `${ORG}/SPU_DWW_Surface_Drainage_Points/FeatureServer/1`, fields: SDP },
  areas: { url: `${ORG}/SPU_DWW_Sewer_Classification_Areas_Internal/FeatureServer/0`, fields: ['SCA_KEY', 'SCA_CLASS_CODE'], whole: true },
  csoBasins: { url: `${ORG}/SPU_DWW_CSO_Basins_/FeatureServer/0`, fields: ['CSOB_CSO_OUTFALL_NUM', 'CSOB_REC_WTR_BDY_NAME'], whole: true },
  creekWatersheds: { url: `${ORG}/Creek_Watersheds/FeatureServer/1`, fields: ['UCWS_NAME', 'UCWS_ALT_NAME', 'UCWS_REC_WTRBDY_NAME'], whole: true },
  city: { url: KC_CITIES, fields: ['CITYNAME'], where: "CITYNAME='Seattle'", whole: true },
} satisfies Record<string, LayerSpec>;
type LayerName = keyof typeof LAYERS;
/** Non-SPU laterals, 1.9M mostly house side sewers: fetched only by key, downstream from drains. */
const PRIVATE_LATERALS: LayerSpec = { url: `${ORG}/SPU_DWW_Non_Mainlines_External_DSO_view/FeatureServer/2`, fields: NMNL };

// fields that could hold personal data; agency category codes are allowed
const PII = /addr|adrs|owner|phone|email|contact|parcel|grantor|taxpayer|user|editor|creator|inspector|staff|loc_text|lctn|desc|note|comment|link|photo/i;
const CATEGORY = /_OWNER_CODE$|^SDP_OWNER_TEXT$/;
function guard(spec: LayerSpec): void {
  const bad = spec.fields.filter((f) => f === '*' || (PII.test(f) && !CATEGORY.test(f)));
  if (bad.length) throw new Error(`${spec.url}: refusing fields ${bad.join(', ')}`);
}

// ---------------------------------------------------------------- fetching

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

/** Runs `run` once fewer than PER_HOST requests are open to the URL's host. */
async function slot<T>(url: string, run: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  const n = busy.get(host) ?? 0;
  if (n >= PER_HOST) {
    await new Promise<void>((r) => {
      const q = waiting.get(host) ?? [];
      q.push(r);
      waiting.set(host, q);
    });
  } else busy.set(host, n + 1);
  try {
    return await run();
  } finally {
    // hand the slot straight to the next waiter
    const next = waiting.get(host)?.shift();
    if (next) next();
    else busy.set(host, (busy.get(host) ?? 1) - 1);
  }
}

async function post(url: string, params: Record<string, string>): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const json = await slot(url, async () => {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

const GEO = { outSR: '4326', geometryPrecision: '7', f: 'geojson' };

/** All features of a layer (in the box, if one is given), by object id chunks. */
async function fetchLayer(name: string, spec: LayerSpec, box: number[] | null, log: (s: string) => void): Promise<Feat[]> {
  guard(spec);
  const base: Record<string, string> = { where: spec.where ?? '1=1' };
  if (box && !spec.whole) Object.assign(base, { geometry: box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
  const ids: number[] = (await post(`${spec.url}/query`, { ...base, returnIdsOnly: 'true', f: 'json' })).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += PAGE) chunks.push(ids.slice(i, i + PAGE));
  let done = 0;
  const parts = await Promise.all(
    chunks.map(async (c) => {
      const json = await post(`${spec.url}/query`, { objectIds: c.join(','), outFields: spec.fields.join(','), ...GEO });
      if (++done % 25 === 0) log(`  ${name}: ${done}/${chunks.length} pages`);
      return (json.features ?? []) as Feat[];
    }),
  );
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${name}: got ${features.length} of ${ids.length} features`);
  return features;
}

/** Features whose `field` is one of `keys`. */
async function fetchByKeys(spec: LayerSpec, field: string, keys: readonly number[]): Promise<Feat[]> {
  guard(spec);
  const chunks: number[][] = [];
  for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) chunks.push(keys.slice(i, i + KEYS_PER_QUERY));
  const parts = await Promise.all(
    chunks.map(async (c) => {
      const json = await post(`${spec.url}/query`, { where: `${field} IN (${c.join(',')})`, outFields: spec.fields.join(','), ...GEO });
      if (json.exceededTransferLimit || json.properties?.exceededTransferLimit) throw new Error(`${spec.url}: too many features for one key query`);
      return (json.features ?? []) as Feat[];
    }),
  );
  return parts.flat();
}

function writeJSON(file: string, value: unknown): void {
  writeFileSync(`${file}.part`, JSON.stringify(value));
  renameSync(`${file}.part`, file);
}

const readFeatures = (file: string): Feat[] => JSON.parse(readFileSync(file, 'utf8')).features;

/** Downloads every layer into raw/ (skipping files already there) and reads them back. */
async function fetchAll(raw: string, box: number[] | null, refresh: boolean, log: (s: string) => void): Promise<Record<LayerName, Feat[]>> {
  mkdirSync(raw, { recursive: true });
  const out = {} as Record<LayerName, Feat[]>;
  for (const [name, spec] of Object.entries(LAYERS) as [LayerName, LayerSpec][]) {
    const file = `${raw}/${name}.geojson`;
    if (refresh || !existsSync(file)) {
      log(`Downloading ${name}`);
      writeJSON(file, { type: 'FeatureCollection', features: await fetchLayer(name, spec, box, log) });
    }
    out[name] = readFeatures(file);
    log(`  ${name}: ${out[name].length} features`);
  }
  return out;
}

// ---------------------------------------------------------------- model

type LonLat = [number, number];
type PointLayer = 'endpoint' | 'cb' | 'inlet' | 'box' | 'outfall' | 'surface' | 'wye';
type LineLayer = 'main' | 'lateral' | 'private' | 'ditch' | 'curb';
type System = NonNullable<SourceAsset['system']>;

interface Pt {
  key: number;
  layer: PointLayer;
  /** type code (type text for surface points) */
  type: string;
  id: string;
  p: LonLat;
  /** agency code: SPU, PRI, KC, ... */
  owner: string;
  /** receiving water body as SPU records it */
  water: string;
  /** outfalls: the creek it runs into, when SPU puts it in a creek watershed */
  creek: string;
  /** outfalls: probable flow D, C or S */
  flow: string;
  /** wyes: the mainline they sit on */
  host: number;
}

interface Ln {
  key: number;
  layer: LineLayer;
  type: string;
  /** probable flow: D drainage, C combined, S sanitary, '' phantom connector */
  flow: string;
  ups: number;
  dns: number;
  coords: LonLat[];
  id: string;
  owner: string;
  width: number;
  perforated: boolean;
  stream: string;
  upInv?: number;
  downInv?: number;
  trust: Trust;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const keyOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
/** feet -> meters; SPU writes 0 for unknown */
const feet = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? Math.round(v * 30.48) / 100 : undefined);
const inches = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 2.54) / 100 : 0);

function pointOf(f: Feat): LonLat | null {
  const g = f.geometry;
  return g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2 ? [g.coordinates[0], g.coordinates[1]] : null;
}

function lineOf(f: Feat): LonLat[] | null {
  const g = f.geometry;
  const raw: number[][] = g?.type === 'LineString' ? g.coordinates : g?.type === 'MultiLineString' ? g.coordinates.flat() : [];
  const out: LonLat[] = [];
  for (const c of raw) if (!out.length || c[0] !== out[out.length - 1][0] || c[1] !== out[out.length - 1][1]) out.push([c[0], c[1]]);
  return out.length >= 2 ? out : null;
}

/** Creek named by an outfall's creek watershed ("Thornton Creek Watershed", or a code like LW_CW_019). */
function creekNames(L: Record<LayerName, Feat[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of L.creekWatersheds) {
    const alt = text(f.properties.UCWS_ALT_NAME);
    if (/creek/i.test(alt)) out.set(text(f.properties.UCWS_NAME), alt);
  }
  return out;
}

// same structure in two layers (an outfall that is also a mainline end point, ...): lower wins
const PRIORITY: Record<PointLayer, number> = { outfall: 0, cb: 1, inlet: 1, box: 2, endpoint: 3, surface: 4, wye: 5 };

function loadPoints(L: Record<LayerName, Feat[]>): Map<number, Pt> {
  const pts = new Map<number, Pt>();
  const add = (layer: PointLayer, f: Feat, key: unknown, o: Partial<Pt>) => {
    const p = pointOf(f);
    const k = keyOf(key);
    if (!p || !k) return;
    const pt: Pt = { key: k, layer, p, type: '', id: '', owner: '', water: '', creek: '', flow: '', host: 0, ...o };
    const cur = pts.get(k);
    if (!cur) {
      pts.set(k, pt);
      return;
    }
    const [win, lose] = PRIORITY[layer] < PRIORITY[cur.layer] ? [pt, cur] : [cur, pt];
    // pipes meet at the mainline end point
    if (lose.layer === 'endpoint') win.p = lose.p;
    win.water ||= lose.water;
    pts.set(k, win);
  };
  const creeks = creekNames(L);
  for (const f of L.endPoints) {
    const P = f.properties;
    add('endpoint', f, P.MNLEP_FEA_KEY, { type: text(P.MNLEP_FEATYPE_CODE), id: text(P.MNLEP_D_ENDPT_ID) || text(P.MNLEP_S_ENDPT_ID), owner: text(P.MNLEP_OWNER_CODE) });
  }
  for (const [layer, feats] of [['cb', L.catchBasins], ['inlet', L.inlets], ['box', L.boxes]] as const) {
    for (const f of feats) {
      const P = f.properties;
      add(layer, f, P.CB_FEA_KEY, { type: text(P.CB_FEATYPE_CODE), id: text(P.CB_CB_ID), owner: text(P.CB_OWNER_CODE), water: text(P.CB_REC_WTRBDY_NAME) });
    }
  }
  for (const f of L.outfalls) {
    const P = f.properties;
    const num = keyOf(P.OUT_OUTFALL_ID);
    const shed = text(P.OUT_CWSHD_NAME);
    add('outfall', f, P.OUT_FEA_KEY, {
      type: text(P.OUT_ROLE_CODE),
      id: text(P.OUT_NPDES_ID) || (num ? `outfall ${num}` : ''),
      owner: text(P.OUT_OWNER_CODE),
      water: text(P.OUT_REC_WTRBDY_NAME),
      creek: creeks.get(shed) ?? (/creek watershed$/i.test(shed) ? shed.replace(/\s+watershed$/i, '') : ''),
      flow: text(P.OUT_PRBL_FLOW_CODE),
    });
  }
  for (const f of L.surfacePoints) {
    const P = f.properties;
    add('surface', f, P.SDP_FEA_KEY, { type: text(P.SDP_FEA_TYPE_TEXT), id: text(P.SDP_ASSET_ID), owner: ownerCode(text(P.SDP_OWNER_TEXT)), water: text(P.SDP_RC_WTRBDY_NAME) });
  }
  for (const f of L.wyes) {
    const P = f.properties;
    add('wye', f, P.MNLCP_FEA_KEY, { type: 'wye', host: keyOf(P.MNLCP_MNL_FEATURE_KEY) });
  }
  return pts;
}

function loadLines(feats: readonly Feat[], layer: LineLayer, into: Map<number, Ln>): void {
  const pre = layer === 'main' ? 'MNL' : layer === 'ditch' || layer === 'curb' ? 'DCH' : 'NMNL';
  for (const f of feats) {
    const P = f.properties;
    const key = keyOf(P[`${pre}_FEA_KEY`]);
    const coords = lineOf(f);
    if (!key || !coords || into.has(key)) continue;
    const type = text(P[`${pre}_FEATYPE_CODE`]);
    into.set(key, {
      key,
      layer,
      type,
      flow: type === 'PHM' ? '' : text(P[`${pre}_PRBL_FLOW_CODE`]),
      ups: keyOf(P[`${pre}_UPS_FEATURE_KEY`]),
      dns: keyOf(P[`${pre}_DNS_FEATURE_KEY`]),
      coords,
      id: pre === 'MNL' ? text(P.MNL_MNLPT_ID) : pre === 'DCH' ? text(P.DCH_EQNUM_ID) : '',
      owner: text(P[`${pre}_OWNER_CODE`]),
      width: inches(P[`${pre}_WIDTH_IN_NBR`]),
      perforated: text(P[`${pre}_PERF_PIPE_FLAG`]) === 'Y',
      stream: text(P[`${pre}_STREAM_NAME`]),
      upInv: feet(P[`${pre}_UPS_ELEV_FT_NBR`]),
      downInv: feet(P[`${pre}_DNS_ELEV_FT_NBR`]),
      trust: 'id',
    });
  }
}

/** Surface point owner text -> the agency codes the other layers use. */
function ownerCode(t: string): string {
  if (/^private$/i.test(t)) return 'PRI';
  if (!t || /^unknown$/i.test(t)) return 'UNK';
  return /^other$/i.test(t) ? 'OTH' : 'PUB';
}

/** Owner category only: never a name. */
function ownerCategory(code: string): SourceAsset['owner'] {
  if (code === 'PRI') return 'private';
  return !code || code === 'UNK' || code === 'OTH' ? 'other' : 'public';
}

/** Non-SPU laterals downstream of drains, fetched hop by hop by key (never the whole layer). */
async function fetchPrivateChains(L: Record<LayerName, Feat[]>, file: string, refresh: boolean, log: (s: string) => void): Promise<Feat[]> {
  if (!refresh && existsSync(file)) return readFeatures(file);
  const pts = loadPoints(L);
  const lines = new Map<number, Ln>();
  loadLines(L.mainlines, 'main', lines);
  loadLines(L.ditches, 'ditch', lines);
  loadLines(L.curbs, 'curb', lines);
  loadLines(L.laterals, 'lateral', lines);
  // the public network takes over at these keys
  const network = new Set<number>();
  for (const l of lines.values()) {
    if (l.layer === 'lateral') continue;
    network.add(l.ups);
    network.add(l.dns);
  }
  for (const p of pts.values()) if (p.layer === 'endpoint' || p.layer === 'wye' || p.layer === 'outfall') network.add(p.key);
  network.delete(0);
  const out = new Map<number, number[]>();
  const link = (u: number, d: number) => {
    const list = out.get(u);
    if (list) list.push(d);
    else out.set(u, [d]);
  };
  for (const l of lines.values()) if (l.layer === 'lateral' && l.ups) link(l.ups, l.dns);
  const asked = new Set<number>();
  const got: Feat[] = [];
  let frontier = [...pts.values()].filter((p) => p.layer === 'cb' || p.layer === 'inlet' || p.layer === 'box').map((p) => p.key);
  const seen = new Set(frontier);
  for (let hop = 1; frontier.length; hop++) {
    const ask = frontier.filter((k) => !out.has(k) && !network.has(k) && !asked.has(k));
    for (const k of ask) asked.add(k);
    if (ask.length) {
      const feats = await fetchByKeys(PRIVATE_LATERALS, 'NMNL_UPS_FEATURE_KEY', ask);
      for (const f of feats) {
        const u = keyOf(f.properties.NMNL_UPS_FEATURE_KEY);
        if (!u) continue;
        got.push(f);
        link(u, keyOf(f.properties.NMNL_DNS_FEATURE_KEY));
      }
      log(`  hop ${hop}: ${ask.length} keys asked, ${feats.length} laterals`);
    }
    const next: number[] = [];
    for (const k of frontier) {
      for (const d of out.get(k) ?? []) {
        if (d && !seen.has(d)) {
          seen.add(d);
          next.push(d);
        }
      }
    }
    frontier = next;
  }
  writeJSON(file, { type: 'FeatureCollection', features: got });
  return got;
}

// ---------------------------------------------------------------- roles

/** Street drains: catch basins and inlets, and catch basins and catch basin maintenance holes on mainlines. */
const DRAIN_TYPES = new Set(['CB', 'CBL', 'FCB', 'INL', 'CMH', 'AD']);
const isDrain = (p: Pt) => p.layer === 'cb' || p.layer === 'inlet' || (p.layer === 'endpoint' && DRAIN_TYPES.has(p.type)) || (p.layer === 'surface' && p.type === 'Catch Basin MH');
const INFILTRATION = /injection|dry well|rock pocket|infiltration/i;
const isOutfall = (p: Pt) => p.layer === 'outfall' || (p.layer === 'endpoint' && p.type === 'OUT') || (p.layer === 'surface' && p.type === 'Outfall');
// fittings a lateral chain runs straight through
const FITTING = /^(cleanout|surface cleanout|weephole|rubber coupler|reducer|other|unknown|horizontal bend|vertical bend|unknown bend|test tee)$/i;
const isFitting = (p: Pt) => p.layer === 'surface' && FITTING.test(p.type);
const COMBINED_WATER = /urban combined/i;

function pointRole(p: Pt): Role {
  if (isDrain(p)) return 'drain';
  if (isOutfall(p)) return COMBINED_WATER.test(p.water) ? 'discharge' : 'outfall';
  if (p.layer === 'surface' && INFILTRATION.test(p.type)) return 'facility-infiltrate';
  return 'junction';
}

function lineRole(l: Ln): Role {
  if (l.type === 'PHM') return 'virtual';
  const creek = !!l.stream && l.flow !== 'C' && l.flow !== 'S';
  if (l.layer === 'ditch') return l.type === 'CUL' ? (creek ? 'stream-culvert' : 'culvert') : creek ? 'stream' : 'ditch';
  if (l.layer === 'curb') return 'ditch';
  return creek ? 'stream-culvert' : 'pipe';
}

// ---------------------------------------------------------------- build

interface Built {
  assets: SourceAsset[];
  stats: Record<string, number>;
  /** sewer class area at each drain key */
  drainArea: Map<string, System | ''>;
  /** recorded receiving water body at each drain and outfall key */
  water: Map<string, string>;
}

function build(L: Record<LayerName, Feat[]>, privateFeats: readonly Feat[]): Built {
  const proj = localProjection([-122.33, 47.62]);
  const xy = (p: LonLat): XY => proj.toXY(p);
  const gap = (a: LonLat, b: LonLat) => {
    const p = xy(a);
    const q = xy(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  };
  const S: Record<string, number> = {};
  const count = (k: string, n = 1) => (S[k] = (S[k] ?? 0) + n);

  const pts = loadPoints(L);
  const all = new Map<number, Ln>();
  loadLines(L.mainlines, 'main', all);
  loadLines(L.forceMains, 'main', all);
  loadLines(L.detentionLines, 'main', all);
  loadLines(L.laterals, 'lateral', all);
  loadLines(privateFeats, 'private', all);
  loadLines(L.ditches, 'ditch', all);
  loadLines(L.curbs, 'curb', all);
  count('source points', pts.size);
  count('source lines', all.size);

  // 0. drawn direction against the keys, as SPU publishes it
  for (const l of all.values()) {
    const u = pts.get(l.ups)?.p;
    const d = pts.get(l.dns)?.p;
    if (!u || !d || l.ups === l.dns || l.type === 'PHM') continue;
    const A = l.coords[0];
    const B = l.coords[l.coords.length - 1];
    const tag = l.layer === 'private' ? 'lateral' : l.layer;
    count(`direction ${tag}: checked`);
    if (gap(A, d) + gap(B, u) + 0.5 < gap(A, u) + gap(B, d)) count(`direction ${tag}: drawn against keys`);
  }

  // 1. blank line ends take the key of a structure (else a keyed line end) right at that end;
  // phantom connectors join a structure's wall points to its center this way
  {
    const ptIdx = new GridIndex<number>(10);
    for (const p of pts.values()) if (p.layer !== 'wye') ptIdx.insertPoint(p.key, xy(p.p));
    const endIdx = new GridIndex<[number, LonLat]>(10);
    for (const l of all.values()) {
      if (l.ups) endIdx.insertPoint([l.ups, l.coords[0]], xy(l.coords[0]));
      if (l.dns) endIdx.insertPoint([l.dns, l.coords[l.coords.length - 1]], xy(l.coords[l.coords.length - 1]));
    }
    const nearest = (q: LonLat, not: number): number => {
      let best = 0;
      let bestD = FILL_M;
      for (const k of ptIdx.near(xy(q), FILL_M)) {
        const d = gap(pts.get(k)!.p, q);
        if (k !== not && d <= bestD) [best, bestD] = [k, d];
      }
      if (best) return best;
      for (const [k, at] of endIdx.near(xy(q), FILL_M)) {
        const d = gap(at, q);
        if (k !== not && d <= bestD) [best, bestD] = [k, d];
      }
      return best;
    };
    const keyAt = (k: number): LonLat | undefined => pts.get(k)?.p;
    for (const l of all.values()) {
      if (l.ups && l.dns) continue;
      const A = l.coords[0];
      const B = l.coords[l.coords.length - 1];
      const known = l.ups || l.dns;
      count('line ends with a blank key', known ? 1 : 2);
      if (known) {
        // the blank key belongs to whichever end the known structure isn't at (phantoms often name the far one)
        const kp = keyAt(known);
        const free = kp ? (gap(A, kp) <= gap(B, kp) ? B : A) : l.ups ? B : A;
        const k = nearest(free, known);
        if (!k) continue;
        if (l.ups) l.dns = k;
        else l.ups = k;
        count('line ends with a blank key, filled from a structure at that end');
      } else {
        const a = nearest(A, 0);
        const b = nearest(B, a);
        if (a) l.ups = a;
        if (b) l.dns = b;
        count('line ends with a blank key, filled from a structure at that end', (a ? 1 : 0) + (b ? 1 : 0));
      }
      // phantom keys follow the drawing; their direction is settled from their neighbors below
      const u = keyAt(l.ups);
      const d = keyAt(l.dns);
      if (l.type === 'PHM' && u && d && gap(A, d) + gap(B, u) < gap(A, u) + gap(B, d)) [l.ups, l.dns] = [l.dns, l.ups];
    }
  }

  // 2. laterals reached downstream from drains and structures; each chain becomes one lead line
  const latOut = new Map<number, Ln[]>();
  for (const l of all.values()) {
    if ((l.layer !== 'lateral' && l.layer !== 'private') || !l.ups) continue;
    const list = latOut.get(l.ups);
    if (list) list.push(l);
    else latOut.set(l.ups, [l]);
  }
  const networkNode = new Set<number>();
  for (const l of all.values()) {
    if (l.layer === 'lateral' || l.layer === 'private') continue;
    networkNode.add(l.ups);
    networkNode.add(l.dns);
  }
  networkNode.delete(0);
  const picked = new Set<Ln>();
  {
    const seeds = [...pts.values()].filter((p) => p.layer === 'cb' || p.layer === 'inlet' || p.layer === 'box' || (p.layer === 'surface' && !isFitting(p)) || isDrain(p)).map((p) => p.key);
    const seen = new Set<number>(seeds);
    const stack = [...seeds];
    while (stack.length) {
      for (const l of latOut.get(stack.pop()!) ?? []) {
        if (picked.has(l)) continue;
        picked.add(l);
        if (l.dns && !seen.has(l.dns)) {
          seen.add(l.dns);
          stack.push(l.dns);
        }
      }
    }
  }
  const indeg = new Map<number, number>();
  const outdeg = new Map<number, number>();
  for (const l of picked) {
    indeg.set(l.dns, (indeg.get(l.dns) ?? 0) + 1);
    outdeg.set(l.ups, (outdeg.get(l.ups) ?? 0) + 1);
  }
  const joint = (k: number) => {
    const p = pts.get(k);
    return !k || (!!p && !isFitting(p)) || networkNode.has(k) || indeg.get(k) !== 1 || outdeg.get(k) !== 1;
  };
  const leads: Ln[] = [];
  const covered = new Set<Ln>();
  for (const first of picked) {
    if (!joint(first.ups)) continue;
    const pieces = [first];
    let cur = first;
    while (!joint(cur.dns) && pieces.length < 500) {
      const nx = (latOut.get(cur.dns) ?? []).find((x) => picked.has(x));
      if (!nx || covered.has(nx) || pieces.includes(nx)) break;
      pieces.push(nx);
      cur = nx;
    }
    for (const p of pieces) covered.add(p);
    leads.push(makeLead(pieces, gap));
  }
  count('laterals reached from drains', picked.size);
  count('laterals on a loop, left out', picked.size - covered.size);
  count('lead lines', leads.length);

  // 3. network lines: drainage and combined; sanitary kept aside to find where drains enter it
  const kept: Ln[] = [];
  const sanitary: Ln[] = [];
  for (const l of all.values()) {
    if (l.layer !== 'main' && l.layer !== 'ditch') continue;
    if (l.flow === 'S') sanitary.push(l);
    else if (l.flow === 'D' || l.flow === 'C' || l.type === 'PHM') kept.push(l);
    else count('lines with no flow type, left out');
  }
  for (const l of leads) kept.push(l);
  // curbs and surface paths only where water from a drain or structure runs along them
  {
    const curbOut = new Map<number, Ln[]>();
    for (const l of all.values()) {
      if (l.layer !== 'curb' || l.flow === 'S' || !l.ups) continue;
      const list = curbOut.get(l.ups);
      if (list) list.push(l);
      else curbOut.set(l.ups, [l]);
    }
    const stack: number[] = [];
    for (const p of pts.values()) if (curbOut.has(p.key) && !isFitting(p) && p.layer !== 'wye') stack.push(p.key);
    for (const l of kept) if (curbOut.has(l.dns)) stack.push(l.dns);
    const took = new Set<Ln>();
    while (stack.length) {
      for (const l of curbOut.get(stack.pop()!) ?? []) {
        if (took.has(l)) continue;
        took.add(l);
        if (curbOut.has(l.dns)) stack.push(l.dns);
      }
    }
    for (const l of took) kept.push(l);
    count('curb and surface lines on a drain path', took.size);
  }

  // phantom connectors: only where they touch kept lines, oriented from the pipe flowing in to the pipe flowing out
  const touches = new Map<number, { into: number; out: number }>();
  for (const l of kept) {
    if (l.type === 'PHM') continue;
    for (const [k, end] of [[l.ups, 'out'], [l.dns, 'into']] as const) {
      const t = touches.get(k) ?? { into: 0, out: 0 };
      t[end]++;
      touches.set(k, t);
    }
  }
  const upstream = (t?: { into: number; out: number }) => !!t && t.into > 0 && t.out === 0;
  const downstream = (t?: { into: number; out: number }) => !!t && t.out > 0 && t.into === 0;
  const network = kept.filter((l) => {
    if (l.type !== 'PHM' || l.layer !== 'main') return true;
    const a = touches.get(l.ups);
    const b = touches.get(l.dns);
    if (!a && !b) return false;
    if (upstream(b) || downstream(a)) flip(l);
    else if (!(upstream(a) || downstream(b))) {
      l.trust = 'none';
      count('phantom connectors with no clear direction');
    }
    count('phantom connectors kept');
    return true;
  });

  // 4. every line runs from its upstream key to its downstream key: reverse the rare drawing that doesn't
  for (const l of network) {
    if (l.type === 'PHM') continue;
    const u = pts.get(l.ups)?.p;
    const d = pts.get(l.dns)?.p;
    const A = l.coords[0];
    const B = l.coords[l.coords.length - 1];
    const back = u && d ? gap(A, d) + gap(B, u) + 0.5 < gap(A, u) + gap(B, d) : u ? gap(B, u) + 0.5 < gap(A, u) : d ? gap(A, d) + 0.5 < gap(B, d) : false;
    if (back) {
      l.coords.reverse();
      count('lines reversed to run with their keys');
    }
    if (!l.ups || !l.dns) l.trust = 'digitized';
  }

  // 5. split mainlines where leads (or other lines) join them at a wye
  const keptMain = new Map<number, Ln>();
  for (const l of network) if (l.layer === 'main') keptMain.set(l.key, l);
  const sanitaryMain = new Set(sanitary.map((l) => l.key));
  const cuts = new Map<number, { along: number; key: number; at: LonLat }[]>();
  const alias = new Map<number, number>();
  const sanitaryWyes = new Set<number>();
  for (const l of network) {
    for (const k of [l.ups, l.dns]) {
      const w = pts.get(k);
      if (w?.layer !== 'wye' || alias.has(k) || sanitaryWyes.has(k)) continue;
      const host = keptMain.get(w.host);
      if (!host) {
        if (sanitaryMain.has(w.host)) sanitaryWyes.add(k);
        else count('wyes on a mainline not in the data');
        continue;
      }
      if (cuts.get(host.key)?.some((c) => c.key === k)) continue;
      const line = host.coords.map(xy);
      const on = nearestOnPolyline(xy(w.p), line);
      let len = 0;
      for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (on.d > 5) count('wyes more than 5 m from their mainline');
      if (on.along < SPLIT_END_M) alias.set(k, host.ups);
      else if (on.along > len - SPLIT_END_M) alias.set(k, host.dns);
      else {
        const list = cuts.get(host.key) ?? [];
        list.push({ along: on.along, key: k, at: proj.toLngLat(on.point) });
        cuts.set(host.key, list);
      }
    }
  }
  // wyes at the same spot on a line share one joint
  for (const list of cuts.values()) {
    list.sort((a, b) => a.along - b.along);
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i].along - list[i - 1].along > 0.05) continue;
      alias.set(list[i].key, list[i - 1].key);
      list.splice(i, 1);
    }
  }
  for (const l of network) {
    l.ups = alias.get(l.ups) ?? l.ups;
    l.dns = alias.get(l.dns) ?? l.dns;
  }
  const lines: Ln[] = [];
  for (const l of network) {
    const list = cuts.get(l.key);
    if (!list) {
      lines.push(l);
      continue;
    }
    for (const piece of splitLine(l, list, gap)) lines.push(piece);
    count('mainlines split at wyes');
    count('wye joints made by splits', list.length);
  }

  // 6. where street water first enters a combined or sanitary sewer: the trace ends there ('treatment')
  const outOf = new Map<number, Ln[]>();
  const intoOf = new Map<number, Ln[]>();
  const index = (l: Ln) => {
    for (const [map, k] of [[outOf, l.ups], [intoOf, l.dns]] as const) {
      if (!k) continue;
      const list = map.get(k);
      if (list) list.push(l);
      else map.set(k, [l]);
    }
  };
  for (const l of lines) index(l);
  for (const l of sanitary) index(l);
  const sewer = (l: Ln) => l.flow === 'C' || l.flow === 'S';
  const lateral = (l: Ln) => l.layer === 'lateral' || l.layer === 'private';
  // every way on is a sewer main (looking through phantom connectors); a drain's own lead is storm side
  // even when labeled sanitary, so the entry is where it meets the main
  const sewerOnly = (k: number, depth = 0): boolean => {
    const outs = outOf.get(k) ?? [];
    return outs.length > 0 && outs.every((l) => !lateral(l) && (l.type === 'PHM' ? depth < 3 && sewerOnly(l.dns, depth + 1) : sewer(l)));
  };
  const combinedOn = (k: number, depth = 0): boolean => (outOf.get(k) ?? []).some((l) => l.flow === 'C' || (l.type === 'PHM' && depth < 3 && combinedOn(l.dns, depth + 1)));
  const stormIn = (k: number, depth = 0): boolean =>
    (intoOf.get(k) ?? []).some((l) => (l.type === 'PHM' && !lateral(l) ? depth < 3 && stormIn(l.ups, depth + 1) : lateral(l) || !sewer(l)));
  const entries = new Map<number, System>();
  const drainKeys = [...pts.values()].filter(isDrain).map((p) => p.key);
  for (const k of new Set([...intoOf.keys(), ...drainKeys])) {
    const p = pts.get(k);
    if (!sewerOnly(k) || !(stormIn(k) || (p && isDrain(p)))) continue;
    entries.set(k, combinedOn(k) ? 'combined' : 'separated');
  }
  for (const k of sanitaryWyes) if (!entries.has(k)) entries.set(k, 'separated');
  count('sewer entries', entries.size);

  // 7. sewer classification areas and CSO basins
  const areas = new Areas(proj);
  for (const f of L.areas) {
    const c = text(f.properties.SCA_CLASS_CODE);
    areas.add(f, c === 'C' ? 'combined' : c === 'P' ? 'partially-separated' : c === 'S' ? 'separated' : '');
  }
  const cso = new Areas(proj);
  for (const f of L.csoBasins) cso.add(f, text(f.properties.CSOB_REC_WTR_BDY_NAME));
  const areaAt = (p: LonLat) => areas.at(p) as System | '';
  // a storm-only line or structure in a combined area is a partial separation there
  const stormSystem = (p: LonLat): System | undefined => {
    const a = areaAt(p);
    return a === 'combined' ? 'partially-separated' : a || undefined;
  };

  // 8. assets
  const assets: SourceAsset[] = [];
  const onCombined = new Set<number>();
  const used = new Set<number>();
  for (const l of lines) {
    used.add(l.ups);
    used.add(l.dns);
    if (l.flow !== 'C') continue;
    onCombined.add(l.ups);
    onCombined.add(l.dns);
  }
  for (const l of lines) {
    const a: SourceAsset = {
      role: lineRole(l),
      id: l.id || String(l.key),
      src: KEY,
      fromId: l.ups ? String(l.ups) : undefined,
      toId: l.dns ? String(l.dns) : undefined,
      coords: l.coords,
      trust: l.trust,
      owner: ownerCategory(l.owner),
    };
    if (!a.fromId) delete a.fromId;
    if (!a.toId) delete a.toId;
    if (l.width) a.width = l.width;
    if (l.perforated) a.perforated = true;
    if (a.role === 'stream' || a.role === 'stream-culvert') {
      a.liveStream = true;
      a.receivingHint = l.stream;
    }
    const phantomOnCombined = l.type === 'PHM' && (onCombined.has(l.ups) || onCombined.has(l.dns));
    const sys = l.flow === 'C' || phantomOnCombined ? 'combined' : stormSystem(l.coords[Math.floor(l.coords.length / 2)]);
    if (sys) a.system = sys;
    if (l.upInv !== undefined) a.upInv = l.upInv;
    if (l.downInv !== undefined) a.downInv = l.downInv;
    assets.push(a);
  }
  const drainArea = new Map<string, System | ''>();
  const water = new Map<string, string>();
  // points: every drain and outfall, infiltration points, and structures the lines use
  const emitted = new Set<number>();
  for (const p of pts.values()) {
    let role = pointRole(p);
    const entry = entries.get(p.key);
    if (role === 'junction' && !used.has(p.key) && !entry) continue;
    if ((role === 'outfall' && p.flow === 'S') || (p.layer === 'wye' && !used.has(p.key))) continue;
    if (entry && role !== 'drain') role = 'discharge';
    const k = String(p.key);
    const a: SourceAsset = { role, id: p.id || k, src: KEY, key: k, coords: [p.p], trust: 'id', owner: ownerCategory(p.owner) };
    if (role === 'outfall') {
      a.endHint = 'water';
      if (p.creek || p.water) a.receivingHint = p.creek || p.water;
      a.system = p.flow === 'C' ? 'combined' : stormSystem(p.p);
      if (p.water) water.set(k, p.water);
    } else if (role === 'discharge') {
      a.endHint = 'treatment';
      a.system = entry ?? 'combined';
      const overflow = a.system === 'combined' ? cso.at(p.p) : '';
      if (overflow) a.receivingHint = overflow;
    } else if (role === 'drain') {
      if (p.water) {
        a.receivingHint = p.water;
        water.set(k, p.water);
      }
      drainArea.set(k, areaAt(p.p));
    } else a.system = onCombined.has(p.key) ? 'combined' : stormSystem(p.p);
    if (!a.system) delete a.system;
    assets.push(a);
    emitted.add(p.key);
  }
  // entries at a drain sitting right on a sewer, or at a bare joint of lines: a discharge point there too
  for (const [k, system] of entries) {
    const p = pts.get(k);
    if (p && emitted.has(k) && !isDrain(p)) continue;
    const at = p?.p ?? endPosition(k, outOf, intoOf);
    if (!at) continue;
    const a: SourceAsset = { role: 'discharge', id: p?.id || String(k), src: KEY, key: String(k), coords: [at], trust: 'id', endHint: 'treatment', system };
    const overflow = system === 'combined' ? cso.at(at) : '';
    if (overflow) a.receivingHint = overflow;
    assets.push(a);
    count(p ? 'sewer entries at a drain right on the sewer' : 'sewer entries at a bare joint');
  }
  return { assets, stats: S, drainArea, water };
}

/** A lead line from a chain of laterals, joined end to start. */
function makeLead(pieces: Ln[], gap: (a: LonLat, b: LonLat) => number): Ln {
  const coords: LonLat[] = [...pieces[0].coords];
  let joined = true;
  for (const p of pieces.slice(1)) {
    const end = coords[coords.length - 1];
    const c = gap(p.coords[0], end) <= gap(p.coords[p.coords.length - 1], end) ? p.coords : [...p.coords].reverse();
    if (gap(c[0], end) > 1) joined = false;
    for (const q of gap(c[0], end) === 0 ? c.slice(1) : c) coords.push(q);
  }
  const flows = new Set(pieces.map((p) => p.flow));
  const first = pieces.find((p) => p.type !== 'PHM') ?? pieces[0];
  return {
    ...first,
    key: pieces[0].key,
    type: pieces.every((p) => p.type === 'PHM') ? 'PHM' : first.type,
    flow: flows.has('S') ? 'S' : flows.has('C') ? 'C' : flows.has('D') ? 'D' : '',
    ups: pieces[0].ups,
    dns: pieces[pieces.length - 1].dns,
    coords,
    id: String(pieces[0].key),
    layer: pieces.every((p) => p.layer === 'lateral') ? 'lateral' : 'private',
    trust: joined ? 'id' : 'digitized',
    upInv: undefined,
    downInv: undefined,
  };
}

/** Pieces of a line cut at the given points (sorted by distance along it). */
function splitLine(l: Ln, cuts: readonly { along: number; key: number; at: LonLat }[], gap: (a: LonLat, b: LonLat) => number): Ln[] {
  const out: Ln[] = [];
  let walked = 0;
  let from = l.ups;
  let cur: LonLat[] = [l.coords[0]];
  let ci = 0;
  for (let i = 1; i < l.coords.length; i++) {
    const seg = gap(l.coords[i - 1], l.coords[i]);
    while (ci < cuts.length && cuts[ci].along <= walked + seg) {
      if (gap(cur[cur.length - 1], cuts[ci].at) > 0) cur.push(cuts[ci].at);
      if (cur.length < 2) cur.push(cuts[ci].at);
      out.push({ ...l, ups: from, dns: cuts[ci].key, coords: cur, upInv: out.length ? undefined : l.upInv, downInv: undefined });
      from = cuts[ci].key;
      cur = [cuts[ci].at];
      ci++;
    }
    if (gap(cur[cur.length - 1], l.coords[i]) > 0) cur.push(l.coords[i]);
    walked += seg;
  }
  out.push({ ...l, ups: from, dns: l.dns, coords: cur, upInv: undefined, downInv: l.downInv });
  return out;
}

function flip(l: Ln): void {
  [l.ups, l.dns] = [l.dns, l.ups];
  l.coords.reverse();
}

/** Where a key sits when no point carries it: the end of a line that names it. */
function endPosition(k: number, outOf: Map<number, Ln[]>, intoOf: Map<number, Ln[]>): LonLat | undefined {
  const o = outOf.get(k)?.[0];
  if (o) return o.coords[0];
  const i = intoOf.get(k)?.[0];
  return i ? i.coords[i.coords.length - 1] : undefined;
}

/** Labeled polygons, for point lookups. */
class Areas {
  private readonly idx = new GridIndex<number>(500);
  private readonly polys: { rings: XY[][]; label: string }[] = [];
  private readonly toXY: (p: LonLat) => XY;

  constructor(proj: { toXY(p: LonLat): XY }) {
    this.toXY = (p) => proj.toXY(p);
  }

  add(f: Feat, label: string): void {
    const g = f.geometry;
    const parts: number[][][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of parts) {
      const rings = poly.map((r) => r.map((c) => this.toXY([c[0], c[1]])));
      if (!rings.length || rings[0].length < 3) continue;
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const [x, y] of rings[0]) {
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
      }
      this.idx.insert(this.polys.length, box);
      this.polys.push({ rings, label });
    }
  }

  at(p: LonLat): string {
    const q = this.toXY(p);
    for (const k of this.idx.near(q, 0)) if (pointInPolygon(q, this.polys[k].rings)) return this.polys[k].label;
    return '';
  }
}

// ---------------------------------------------------------------- check: walk each drain down its keys

type Outcome = 'water' | 'creek' | 'treatment' | 'ground' | 'dead-end' | 'loop' | 'not-connected';

interface Walk {
  outcome: Outcome;
  /** asset that ends it (outfall, discharge, facility, stream line, or the last line or point reached) */
  at?: SourceAsset;
  steps: number;
}

/** Follows each drain down its keys, the widest real line at a fork. Sets each drain's system from where it ends. */
function walkDrains(built: Built): { walks: Map<SourceAsset, Walk>; stats: Record<string, number> } {
  const { assets, drainArea, water } = built;
  const S: Record<string, number> = {};
  const count = (k: string, n = 1) => (S[k] = (S[k] ?? 0) + n);
  const sinkAt = new Map<string, SourceAsset>();
  const pointAt = new Map<string, SourceAsset>();
  const outBy = new Map<string, SourceAsset[]>();
  for (const a of assets) {
    if (a.key) {
      if (a.role === 'outfall' || a.role === 'discharge' || a.role === 'facility-infiltrate') sinkAt.set(a.key, a);
      else if (!pointAt.has(a.key) || a.role === 'drain') pointAt.set(a.key, a);
    } else if (a.fromId) {
      const list = outBy.get(a.fromId);
      if (list) list.push(a);
      else outBy.set(a.fromId, [a]);
    }
  }
  const rank = (a: SourceAsset) => (a.role === 'virtual' ? 1 : 0);
  for (const list of outBy.values()) list.sort((x, y) => rank(x) - rank(y) || (y.width ?? 0) - (x.width ?? 0));
  const walks = new Map<SourceAsset, Walk>();
  for (const d of assets) {
    if (d.role !== 'drain' || !d.key) continue;
    let k: string | undefined = d.key;
    let steps = 0;
    let last: SourceAsset = d;
    const seen = new Set<string>();
    let w: Walk | null = null;
    while (!w) {
      const sink = sinkAt.get(k);
      if (sink) {
        w = { outcome: sink.role === 'outfall' ? 'water' : sink.role === 'facility-infiltrate' ? 'ground' : sink.endHint === 'treatment' ? 'treatment' : 'dead-end', at: sink, steps };
        break;
      }
      seen.add(k);
      const next: SourceAsset | undefined = outBy.get(k)?.[0];
      if (!next) {
        w = { outcome: steps ? 'dead-end' : 'not-connected', at: pointAt.get(k) ?? last, steps };
        break;
      }
      steps++;
      last = next;
      if (next.liveStream) w = { outcome: 'creek', at: next, steps };
      else if (!next.toId) w = { outcome: 'dead-end', at: next, steps };
      else if (seen.has(next.toId)) w = { outcome: 'loop', at: next, steps };
      else k = next.toId;
    }
    walks.set(d, w);
    count(`outcome ${w.outcome}`);
    // the drain's system: the sewer it enters, else its area (a combined area draining to water is partly separated)
    const area = drainArea.get(d.key) ?? '';
    const sys: System | '' =
      w.outcome === 'treatment' ? (w.at?.system === 'combined' ? 'combined' : area || 'separated') : w.outcome === 'water' || w.outcome === 'creek' ? (area === 'combined' ? 'partially-separated' : area) : area;
    if (sys) d.system = sys;
    count(`drains ${sys || 'outside the sewer areas'}`);
    // recorded receiving water against the outfall the keys lead to
    const rec = water.get(d.key);
    if (rec && w.outcome === 'water' && w.at?.key) {
      const got = water.get(w.at.key);
      if (got && !COMBINED_WATER.test(rec)) {
        count('receiving water: drains with a recorded water reaching a recorded outfall');
        if (got.toLowerCase() === rec.toLowerCase()) count('receiving water: same water');
      }
    }
    if (rec && COMBINED_WATER.test(rec)) {
      count('receiving water: drains SPU records as going to the combined system');
      if (w.outcome === 'treatment') count('receiving water: ... and the keys lead into the combined or sanitary sewer');
    }
  }
  return { walks, stats: S };
}

// ---------------------------------------------------------------- report and output

function resolution(assets: readonly SourceAsset[]): Record<string, number> {
  const pointKeys = new Set<string>();
  const endUse = new Map<string, number>();
  for (const a of assets) {
    if (a.key) pointKeys.add(a.key);
    for (const k of [a.fromId, a.toId]) if (k) endUse.set(k, (endUse.get(k) ?? 0) + 1);
  }
  const r = { 'line ends': 0, 'line ends with a key': 0, 'line ends at a point with that key': 0, 'line ends at a point or another line with that key': 0 };
  for (const a of assets) {
    if (a.key) continue;
    for (const k of [a.fromId, a.toId]) {
      r['line ends']++;
      if (!k) continue;
      r['line ends with a key']++;
      if (pointKeys.has(k)) r['line ends at a point with that key']++;
      if (pointKeys.has(k) || (endUse.get(k) ?? 0) > 1) r['line ends at a point or another line with that key']++;
    }
  }
  return r;
}

/** Drops line-end keys that no point or other line carries (structures SPU doesn't publish), so a tracer can snap those ends by geometry. */
function clearDangling(assets: readonly SourceAsset[]): number {
  const pointKeys = new Set<string>();
  const endUse = new Map<string, number>();
  for (const a of assets) {
    if (a.key) pointKeys.add(a.key);
    for (const k of [a.fromId, a.toId]) if (k) endUse.set(k, (endUse.get(k) ?? 0) + 1);
  }
  let n = 0;
  for (const a of assets) {
    if (a.key) continue;
    if (a.fromId && !pointKeys.has(a.fromId) && endUse.get(a.fromId) === 1) {
      delete a.fromId;
      n++;
    }
    if (a.toId && !pointKeys.has(a.toId) && endUse.get(a.toId) === 1) {
      delete a.toId;
      n++;
    }
  }
  return n;
}

function writeAssets(file: string, assets: readonly SourceAsset[]): void {
  const fd = openSync(`${file}.part`, 'w');
  let buf: string[] = [];
  for (const a of assets) {
    buf.push(JSON.stringify(a));
    if (buf.length >= 5000) {
      writeSync(fd, buf.join('\n') + '\n');
      buf = [];
    }
  }
  if (buf.length) writeSync(fd, buf.join('\n') + '\n');
  closeSync(fd);
  renameSync(`${file}.part`, file);
}

function boundaryOf(city: readonly Feat[]): [number, number][][][] {
  const out: [number, number][][][] = [];
  for (const f of city) {
    const g = f.geometry;
    const polys: number[][][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) out.push(poly.map((ring) => ring.map((c) => [c[0], c[1]] as [number, number])));
  }
  return out;
}

const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;

function report(built: Built, keyed: Record<string, number>, walked: ReturnType<typeof walkDrains>, log: (s: string) => void): Record<string, number> {
  const { assets, stats } = built;
  const counts: Record<string, number> = {};
  for (const a of assets) {
    counts[a.role] = (counts[a.role] ?? 0) + 1;
    if (a.endHint) counts[`endHint ${a.endHint}`] = (counts[`endHint ${a.endHint}`] ?? 0) + 1;
    if (!a.key) counts[`trust ${a.trust}`] = (counts[`trust ${a.trust}`] ?? 0) + 1;
  }
  const drains = counts.drain ?? 0;
  log('Assets by role');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) log(`  ${k}: ${v}`);
  log('Build');
  for (const [k, v] of Object.entries(stats)) log(`  ${k}: ${v}`);
  const r = keyed;
  log('Key resolution (before keys nothing else carries were dropped)');
  for (const [k, v] of Object.entries(r)) log(`  ${k}: ${v} (${pct(v, r['line ends'])})`);
  log(`  keys dropped so those ends can snap by geometry: ${stats['line-end keys nothing else carries, dropped'] ?? 0}`);
  log('Drawn direction against the keys (lines with a structure at both ends)');
  for (const tag of ['main', 'lateral', 'ditch', 'curb']) {
    const n = stats[`direction ${tag}: checked`] ?? 0;
    const bad = stats[`direction ${tag}: drawn against keys`] ?? 0;
    if (n) log(`  ${tag}: ${n - bad} of ${n} drawn upstream to downstream (${pct(n - bad, n)})`);
  }
  log('Drains followed down their keys');
  const ws = walked.stats;
  for (const [k, v] of Object.entries(ws).sort((a, b) => b[1] - a[1])) log(`  ${k}: ${v}${k.startsWith('outcome') || k.startsWith('drains') ? ` (${pct(v, drains)})` : ''}`);
  const same = ws['receiving water: same water'] ?? 0;
  const both = ws['receiving water: drains with a recorded water reaching a recorded outfall'] ?? 0;
  if (both) log(`  recorded receiving water matches the outfall reached: ${pct(same, both)}`);
  const out: Record<string, number> = { ...counts, ...r };
  for (const [k, v] of Object.entries(ws)) out[k] = v;
  return out;
}

function samples(walks: Map<SourceAsset, Walk>, log: (s: string) => void, n = 12): void {
  const list = [...walks.entries()];
  log('Sample endings');
  for (let i = 0; i < n && list.length; i++) {
    const [d, w] = list[Math.floor(((i + 0.5) * list.length) / n)];
    const at = w.at ? `${w.at.role} ${w.at.id}${w.at.endHint ? ` (${w.at.endHint}${w.at.receivingHint ? `, ${w.at.receivingHint}` : ''})` : w.at.receivingHint ? ` (${w.at.receivingHint})` : ''}` : '';
    log(`  drain ${d.id} [${d.system ?? '-'}${d.receivingHint ? `, recorded ${d.receivingHint}` : ''}] -> ${w.outcome} after ${w.steps} lines at ${at}`);
  }
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const boxArg = args.find((a) => a.startsWith('--box='))?.slice(6);
const box = boxArg ? boxArg.split(',').map(Number) : null;
if (box && (box.length !== 4 || box.some((v) => !Number.isFinite(v)))) throw new Error('--box=minLon,minLat,maxLon,maxLat');
const tag = box ? box.map((v) => v.toFixed(3)).join('_') : '';
const base = `${CACHE}/sources/${KEY}`;
const raw = box ? `${base}/raw/box-${tag}` : `${base}/raw`;
const outDir = box ? `${base}/box/${tag}` : base;
const refresh = args.includes('--refresh');
const log = (s: string) => console.log(s);
const started = performance.now();

const L = await fetchAll(raw, box, refresh, log);
log('Private laterals downstream of drains');
const privateFeats = await fetchPrivateChains(L, `${raw}/privateLaterals.geojson`, refresh, log);
log(`  privateLaterals: ${privateFeats.length} features`);
if (args.includes('--fetch-only')) process.exit(0);

const built = build(L, privateFeats);
const keyed = resolution(built.assets);
built.stats['line-end keys nothing else carries, dropped'] = clearDangling(built.assets);
const walked = walkDrains(built);
const counts = report(built, keyed, walked, log);
samples(walked.walks, log);

const meta: SourceMeta = {
  key: KEY,
  name: 'City of Seattle (Seattle Public Utilities)',
  county: 'King',
  credit: 'Storm drain data: City of Seattle, Seattle Public Utilities. No warranty.',
  fetchedAt: new Date().toISOString(),
  boundary: boundaryOf(L.city),
  counts,
  notes: [
    'Keys are SPU feature keys (unique across the SPU layers). Lines run in flow order from fromId to toId; SPU digitizes upstream to downstream.',
    "Each catch basin's or inlet's chain of laterals is one 'pipe' (the lead) from the drain to the wye, maintenance hole, catch basin, ditch or outfall it reaches. Mainlines are split at those wyes, and the pieces keep the mainline's id.",
    "endHint 'treatment' marks where street water first enters a combined sewer (system 'combined': on to a King County treatment plant, overflowing in big storms) or a sanitary sewer (system 'separated'). On combined ones, receivingHint is the water that CSO basin overflows into.",
    'Sanitary pipes are left out. Combined pipes are kept for the map; traces end where they are entered.',
    "Drains carry SPU's recorded receiving water (receivingHint, about two thirds filled) as a check. Outfalls carry the creek when SPU puts them in a creek watershed, else the receiving water body.",
    "A drain's system is the sewer its keyed path enters; if it reaches water or stops, its SPU sewer classification area (a combined area draining to water counts as partially separated).",
    "Phantom connectors (role 'virtual') join structure walls to structure centers; their blank keys come from the structure point at that end (within 0.5 m).",
    'Private catch basins and laterals are included as owner private, fetched by key downstream of drains. No addresses, owner or staff names were requested.',
    'SPU data reaches into neighbors (the Shoreline strip, King County and WSDOT pieces). Clip with the boundary (King County CITY_AREA_448, Seattle).',
  ],
};
mkdirSync(outDir, { recursive: true });
writeAssets(`${outDir}/assets.ndjson`, built.assets);
writeJSON(`${outDir}/meta.json`, meta);
log(`Wrote ${built.assets.length} assets to ${outDir} in ${Math.round((performance.now() - started) / 1000)} s`);
