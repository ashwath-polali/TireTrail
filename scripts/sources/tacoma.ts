// Tacoma Environmental Services storm network -> <cache>/sources/tacoma/assets.ndjson + meta.json.
// node scripts/sources/tacoma.ts [--refresh]. Raw layers are kept in raw/ and reused unless --refresh.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';
import { dist, localProjection, pointInPolygon, type XY } from '../../src/geo/geo.ts';
import { text, type Feature, type FeatureCollection, type Position, type Properties } from '../../src/trace/geojson.ts';

const KEY = 'tacoma';
const DIR = `${process.env.TT_CACHE ?? '.cache'}/sources/${KEY}`;
const RAW = `${DIR}/raw`;
const MS = 'https://staffmaps.tacoma.gov/serveres/rest/services/OpenData/Surfacewater_Network__Tacoma_/MapServer';
/** The City's AGOL copy of its facilities, read only for the INFILTRATED flag. */
const FACILITY_COPY = 'https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/swFacilities/FeatureServer/0';
/** The City's own limits. It keeps the waterways, so shoreline outfalls stay inside. */
const CITY = 'https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/Tacoma_City_Limits/FeatureServer/0';

const CREDIT = 'Storm drain data: City of Tacoma, Environmental Services GIS.';
// wording the City's open data terms require of apps (tacomaopendata-tacoma.hub.arcgis.com/pages/disclaimer)
const DISCLAIMER =
  'The information and data made available here has been modified for use from its original source, which is the City of Tacoma. ' +
  'The City of Tacoma makes no claims as to the completeness, accuracy, or timeliness of any information and data contained in this application; ' +
  'makes no representation of any kind, including, but not limited to, warranty of the accuracy or fitness for a particular use; ' +
  'nor are any such warranties to be implied or inferred with respect to the information or data furnished herein. ' +
  'The information and data is subject to change without notice. ' +
  'It is understood that the information and data contained in the web site is being used at user’s own risk.';

type Kind = 'main' | 'ditch' | 'virtual' | 'inlet' | 'manhole' | 'discharge' | 'facility' | 'outline' | 'node' | 'basin' | 'infiltration' | 'city';
type Group = 'public' | 'private';

interface Layer {
  name: string;
  url: string;
  kind: Kind;
  group?: Group;
  /** Explicit allowlist: no LOCDESC, COMMONNAME, LASTEDITOR or other free text. */
  fields: string[];
  where?: string;
  geometry?: boolean;
}

const MAIN = ['FACILITYID', 'ALTID', 'PIPETYPE', 'PIPEFUNCTION', 'MATERIAL', 'DIAMETER', 'FROMMH', 'TOMH', 'UPINVELEV', 'DNINVELEV', 'OWNEDBY', 'SUBBASIN'];
const DITCH = ['FACILITYID', 'ALTID', 'PIPEFUNCTION', 'TOPWIDTH', 'FROMMH', 'TOMH', 'UPINVELEV', 'DNINVELEV', 'OWNEDBY', 'SUBBASIN'];
const NODE = ['FACILITYID', 'ALTID', 'OWNEDBY', 'SUBBASIN'];
const ACTIVE = 'ACTIVEFLAG = 1';

const ms = (id: number, name: string, kind: Kind, group: Group | undefined, fields: string[], where = ACTIVE): Layer => ({
  name,
  url: `${MS}/${id}`,
  kind,
  group,
  fields,
  where,
});

// Proposed, abandoned and flow-arrow copies (26, 45, 97, 100) are left out. Order matters for repeated ids.
const LAYERS: Layer[] = [
  ms(22, 'public-inlet', 'inlet', 'public', [...NODE, 'INLETTYPE', 'CBTYPE']),
  ms(36, 'private-inlet', 'inlet', 'private', [...NODE, 'INLETTYPE', 'CBTYPE']),
  ms(20, 'public-manhole', 'manhole', 'public', [...NODE, 'MHTYPE']),
  ms(34, 'private-manhole', 'manhole', 'private', [...NODE, 'MHTYPE']),
  ms(21, 'public-discharge', 'discharge', 'public', [...NODE, 'DISCHRGTYPE']),
  ms(35, 'private-discharge', 'discharge', 'private', [...NODE, 'DISCHRGTYPE']),
  ms(17, 'local-facility', 'facility', 'public', [...NODE, 'FACILITYTYPE']),
  ms(18, 'regional-facility', 'facility', 'public', [...NODE, 'FACILITYTYPE']),
  ms(33, 'private-facility', 'facility', 'private', [...NODE, 'FACILITYTYPE']),
  ms(23, 'public-tap', 'node', 'public', NODE),
  ms(37, 'private-tap', 'node', 'private', NODE),
  ms(88, 'public-cleanout', 'node', 'public', NODE),
  ms(39, 'private-cleanout', 'node', 'private', NODE),
  ms(83, 'public-fitting', 'node', 'public', ['FACILITYID', 'ALTID', 'OWNEDBY']),
  ms(40, 'private-fitting', 'node', 'private', NODE),
  ms(85, 'public-valve', 'node', 'public', NODE),
  ms(42, 'private-valve', 'node', 'private', NODE),
  ms(87, 'public-weir', 'node', 'public', NODE),
  ms(43, 'private-weir', 'node', 'private', NODE),
  ms(84, 'public-pump', 'node', 'public', NODE),
  ms(41, 'private-pump', 'node', 'private', NODE),
  ms(70, 'local-facility-outline', 'outline', 'public', ['FACILITYID', 'ALTID_POINT', 'ALTID_OUTLINE', 'OWNEDBY']),
  ms(71, 'regional-facility-outline', 'outline', 'public', ['FACILITYID', 'ALTID_POINT', 'ALTID_OUTLINE', 'OWNEDBY']),
  ms(28, 'public-main', 'main', 'public', MAIN),
  ms(29, 'public-trunk', 'main', 'public', MAIN),
  ms(27, 'public-cb-lead', 'main', 'public', MAIN),
  ms(30, 'public-ditch', 'ditch', 'public', DITCH),
  ms(47, 'private-main', 'main', 'private', MAIN),
  ms(48, 'private-trunk', 'main', 'private', MAIN),
  ms(46, 'private-cb-lead', 'main', 'private', MAIN),
  ms(49, 'private-ditch', 'ditch', 'private', DITCH.filter((f) => f !== 'PIPEFUNCTION')),
  ms(68, 'virtual-drainline', 'virtual', undefined, ['ALTID', 'VDLTYPE', 'SUBBASIN']),
  ms(107, 'subbasin', 'basin', undefined, ['SUBBASIN', 'BASINNAME'], '1=1'),
  { name: 'facility-infiltration', url: FACILITY_COPY, kind: 'infiltration', fields: ['FACILITYID', 'INFILTRATED'], where: ACTIVE, geometry: false },
  { name: 'city-limits', url: CITY, kind: 'city', fields: ['areaname'], where: '1=1' },
];

// requested fields must never carry people, addresses or free text (OWNEDBY is a category code)
const PII = /owner|addr|phone|email|contact|parcel|grantor|taxpayer|user|editor|creator|inspector|staff|locdesc|comment|note|photo|link|commonname/i;
for (const l of LAYERS) for (const f of l.fields) if (PII.test(f)) throw new Error(`${l.name}: field ${f} is not allowed`);

// ---------- fetch ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, params: Record<string, string>): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 500);
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

/** All features of a layer by object id chunks, at most 4 requests at a time. */
async function download(l: Layer, log: (s: string) => void): Promise<FeatureCollection> {
  const ids: number[] = (await post(`${l.url}/query`, { where: l.where ?? '1=1', returnIdsOnly: 'true', f: 'json' })).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 1000) chunks.push(ids.slice(i, i + 1000));
  const parts: FeatureCollection['features'][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const json = await post(`${l.url}/query`, {
        objectIds: chunks[k].join(','),
        outFields: l.fields.join(','),
        returnGeometry: l.geometry === false ? 'false' : 'true',
        outSR: '4326',
        geometryPrecision: '7',
        f: 'geojson',
      });
      parts[k] = json.features ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${l.name}: got ${features.length} of ${ids.length} features`);
  log(`  ${l.name}: ${features.length}`);
  return { type: 'FeatureCollection', features };
}

async function fetchRaw(refresh: boolean, log: (s: string) => void): Promise<Record<string, Feature[]>> {
  mkdirSync(RAW, { recursive: true });
  const out: Record<string, Feature[]> = {};
  for (const l of LAYERS) {
    const file = `${RAW}/${l.name}.geojson`;
    if (refresh || !existsSync(file)) {
      if (!Object.keys(out).length) log(`Downloading Tacoma layers into ${RAW}`);
      const fc = await download(l, log);
      writeFileSync(`${file}.part`, JSON.stringify(fc));
      renameSync(`${file}.part`, file);
    }
    out[l.name] = (JSON.parse(readFileSync(file, 'utf8')) as FeatureCollection).features;
  }
  return out;
}

/** Oldest raw file: when this snapshot was taken. */
function fetchedAt(): string {
  let t = Infinity;
  for (const l of LAYERS) t = Math.min(t, statSync(`${RAW}/${l.name}.geojson`).mtimeMs);
  return new Date(t).toISOString();
}

// ---------- mapping ----------

type LonLat = [number, number];
const proj = localProjection([-122.45, 47.25]);
const toXY = (p: LonLat): XY => proj.toXY(p);
const FT = 0.3048;
const INCH = 0.0254;
/** A key farther than this from its line end is a typo, not a joint. */
const FAR_M = 30;
const cm = (x: number) => Math.round(x * 100) / 100;

/** Positive number, else undefined (blank or 0 means not recorded). */
function pos(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number.parseFloat(text(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// OWNEDBY: 1 Tacoma ES, -2 other City of Tacoma, 2 Fife, 3 Fircrest, 4 Ruston, -1 private, -3 other government
const OWNER: Record<string, SourceAsset['owner']> = { '1': 'public', '-2': 'public', '2': 'public', '3': 'public', '4': 'public', '-1': 'private' };
const ownerOf = (v: unknown, group: Group | undefined): SourceAsset['owner'] => (text(v) ? (OWNER[text(v)] ?? 'other') : group);

/** Street inlets are drains; roof drains, yard drains and open pipe ends (often pond outlets) only join pipes. */
function inletRole(p: Properties): Role {
  const t = text(p.INLETTYPE);
  return t === 'Roof Drain' || t === 'Open Pipe' || text(p.CBTYPE) === 'YARDDRAIN' ? 'junction' : 'drain';
}

/** Outfalls reach water; Standard Outlets feed ponds, swales and ditches, so the map says where water goes next. */
function dischargeOf(type: string): Pick<SourceAsset, 'role' | 'endHint'> {
  if (type === 'Outfall') return { role: 'outfall', endHint: 'water' };
  if (type === 'Infiltration' || type === 'Energy Dispersion') return { role: 'discharge', endHint: 'ground' };
  return { role: 'discharge', endHint: 'unknown' };
}

/** FACILITYTYPE 3 pervious pavement and 8 trench soak in unless the City's flag says otherwise. */
function facilityRole(type: string, infiltrated: string | undefined): Role {
  if (infiltrated === 'Full' || infiltrated === 'Partial') return 'facility-infiltrate';
  if (infiltrated === 'None') return 'facility-hold';
  return type === '3' || type === '8' ? 'facility-infiltrate' : 'facility-hold';
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Polygons of a geometry, lon/lat. */
function polygonsOf(f: Feature): LonLat[][][] {
  const g = f.geometry;
  const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((rings) => rings.map((r) => r.map((p) => [p[0], p[1]] as LonLat)));
}

/** City basin of a subbasin code, or of the place when the code is blank. */
class Basins {
  private readonly names = new Map<string, string>();
  private readonly shapes: { name: string; rings: XY[][]; box: [number, number, number, number] }[] = [];

  constructor(features: Feature[]) {
    for (const f of features) {
      const name = titleCase(text(f.properties.BASINNAME));
      if (!name) continue;
      this.names.set(text(f.properties.SUBBASIN), name);
      for (const poly of polygonsOf(f)) {
        const rings = poly.map((r) => r.map(toXY));
        const xs = rings[0].map((p) => p[0]);
        const ys = rings[0].map((p) => p[1]);
        this.shapes.push({ name, rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
      }
    }
  }

  of(code: unknown, at: XY): string | undefined {
    const byCode = text(code) ? this.names.get(text(code)) : undefined;
    if (byCode) return byCode;
    for (const s of this.shapes) {
      const [x0, y0, x1, y1] = s.box;
      if (at[0] >= x0 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1 && pointInPolygon(at, s.rings)) return s.name;
    }
    return undefined;
  }
}

function pointOf(f: Feature): LonLat | null {
  const g = f.geometry;
  return g?.type === 'Point' && g.coordinates.length >= 2 ? [g.coordinates[0], g.coordinates[1]] : null;
}

/** Vertices in drawn order, parts joined, repeats dropped. */
function lineOf(f: Feature): LonLat[] | null {
  const g = f.geometry;
  const parts: Position[][] = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
  const out: LonLat[] = [];
  for (const part of parts) {
    for (const p of part) {
      const last = out.at(-1);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
    }
  }
  return out.length >= 2 ? out : null;
}

/** Layer and object id, for the rare feature with neither FACILITYID nor ALTID. */
const rowId = (l: Layer, f: Feature) => `${l.name}@${text((f as { id?: unknown }).id)}`;

/** Largest outer ring. */
function outerRing(f: Feature): LonLat[] | null {
  let best: LonLat[] | null = null;
  let bestArea = 0;
  for (const poly of polygonsOf(f)) {
    const r = poly[0];
    if (!r || r.length < 4) continue;
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    if (Math.abs(a) > bestArea) [best, bestArea] = [r, Math.abs(a)];
  }
  return best;
}

export interface TacomaStats {
  dropped: Record<string, number>;
  keyedEnds: number;
  resolvedEnds: number;
  blankEnds: number;
  /** Unresolved keys named by one line end only: left blank so the end snaps by geometry. */
  loneKeys: number;
  /** Unresolved keys shared by several line ends: kept, they join those lines. */
  sharedKeys: number;
  farKeys: number;
  selfKeys: number;
  reversedByKeys: number;
  reversedByInverts: number;
  /** id lines with both inverts: falling along the flow, flat, rising. */
  idInverts: { fall: number; flat: number; rise: number; riseOver1ft: number };
  repeatedIds: number;
}

export function buildTacoma(raw: Record<string, Feature[]>): { assets: SourceAsset[]; stats: TacomaStats } {
  const assets: SourceAsset[] = [];
  const xyOf: XY[] = []; // anchor of each asset, local meters
  const stats: TacomaStats = {
    dropped: {},
    keyedEnds: 0,
    resolvedEnds: 0,
    blankEnds: 0,
    loneKeys: 0,
    sharedKeys: 0,
    farKeys: 0,
    selfKeys: 0,
    reversedByKeys: 0,
    reversedByInverts: 0,
    idInverts: { fall: 0, flat: 0, rise: 0, riseOver1ft: 0 },
    repeatedIds: 0,
  };
  const drop = (why: string) => (stats.dropped[why] = (stats.dropped[why] ?? 0) + 1);
  const basins = new Basins(raw.subbasin);
  const infiltrated = new Map<string, string>();
  for (const f of raw['facility-infiltration']) if (text(f.properties.FACILITYID)) infiltrated.set(text(f.properties.FACILITYID), text(f.properties.INFILTRATED));

  const seenIds = new Map<string, number>();
  const uniqueId = (id: string): string => {
    const n = (seenIds.get(id) ?? 0) + 1;
    seenIds.set(id, n);
    if (n > 1) stats.repeatedIds++;
    return n === 1 ? id : `${id}#${n}`;
  };
  const add = (a: SourceAsset, at: XY) => {
    a.id = uniqueId(a.id);
    assets.push(a);
    xyOf.push(at);
  };

  // how many line ends name each key
  const named = new Map<string, number>();
  for (const l of LAYERS) {
    if (l.kind !== 'main' && l.kind !== 'ditch') continue;
    for (const f of raw[l.name]) for (const k of [text(f.properties.FROMMH), text(f.properties.TOMH)]) if (k) named.set(k, (named.get(k) ?? 0) + 1);
  }

  // points; keyed ones are the nodes lines name in FROMMH/TOMH (by FACILITYID, a few by ALTID)
  const nodes = new Map<string, number[]>();
  const altKey = new Map<string, string>();
  const facilityRoles = new Map<string, { role: Role; hint?: string }>();
  for (const l of LAYERS) {
    if (!['inlet', 'manhole', 'discharge', 'facility', 'node'].includes(l.kind)) continue;
    const copies = new Set<string>();
    for (const f of raw[l.name]) {
      const p = f.properties;
      const c = pointOf(f);
      if (!c) {
        drop('point without geometry');
        continue;
      }
      const facId = text(p.FACILITYID);
      const alt = text(p.ALTID);
      const id = facId || alt || rowId(l, f);
      // the valve and weir layers repeat each feature in place
      const copy = `${id}@${c[0]},${c[1]}`;
      if (copies.has(copy)) {
        drop(`repeated ${l.name}`);
        continue;
      }
      copies.add(copy);
      const at = toXY(c);
      const key = facId || (alt && named.has(alt) ? alt : '');
      if (facId && alt) altKey.set(alt, facId);
      const a: SourceAsset = { role: 'junction', id, src: KEY, coords: [c], trust: 'none', owner: ownerOf(p.OWNEDBY, l.group) };
      if (key) a.key = key;
      if (l.kind === 'inlet') a.role = inletRole(p);
      else if (l.kind === 'discharge') Object.assign(a, dischargeOf(text(p.DISCHRGTYPE)));
      else if (l.kind === 'facility') a.role = facilityRole(text(p.FACILITYTYPE), facId ? infiltrated.get(facId) : undefined);
      const hint = basins.of(p.SUBBASIN, at);
      if (hint) a.receivingHint = hint;
      if (l.kind === 'facility') facilityRoles.set(alt, { role: a.role, hint });
      if (key) nodes.set(key, [...(nodes.get(key) ?? []), assets.length]);
      add(a, at);
    }
  }

  // facility outlines, with their point's role; the point keeps the key
  for (const l of LAYERS.filter((x) => x.kind === 'outline')) {
    for (const f of raw[l.name]) {
      const p = f.properties;
      const ring = outerRing(f);
      if (!ring) {
        drop('outline without geometry');
        continue;
      }
      const fac = facilityRoles.get(text(p.ALTID_POINT));
      const id = text(p.ALTID_OUTLINE) || text(p.ALTID_POINT) || rowId(l, f);
      const a: SourceAsset = { role: fac?.role ?? 'facility-hold', id, src: KEY, coords: ring, trust: 'none', owner: ownerOf(p.OWNEDBY, l.group) };
      if (fac?.hint) a.receivingHint = fac.hint;
      add(a, toXY(ring[0]));
    }
  }

  // a key as the node carries it: an ALTID naming a node that has a FACILITYID becomes that FACILITYID
  const keyOf = (v: unknown): string => {
    const k = text(v);
    return k && !nodes.has(k) ? (altKey.get(k) ?? k) : k;
  };
  // nearest copy of a keyed node to a point
  const nodeNear = (k: string, at: XY): { i: number; d: number } | undefined => {
    let best: { i: number; d: number } | undefined;
    for (const i of nodes.get(k) ?? []) {
      const d = dist(xyOf[i], at);
      if (!best || d < best.d) best = { i, d };
    }
    return best;
  };

  for (const l of LAYERS) {
    if (l.kind !== 'main' && l.kind !== 'ditch' && l.kind !== 'virtual') continue;
    for (const f of raw[l.name]) {
      const p = f.properties;
      if (l.kind === 'virtual' && text(p.VDLTYPE) === 'Overflow path') {
        drop('emergency overflow path');
        continue;
      }
      const coords = lineOf(f);
      if (!coords) {
        drop('line without length');
        continue;
      }
      let xs = coords.map(toXY);
      let from = keyOf(p.FROMMH);
      let to = keyOf(p.TOMH);
      if (from) stats.keyedEnds++;
      else stats.blankEnds++;
      if (to) stats.keyedEnds++;
      else stats.blankEnds++;
      if (from && from === to) {
        // one node named at both ends: keep it where it is
        stats.selfKeys++;
        const n = nodeNear(from, xs[0]);
        if (n && dist(xyOf[n.i], xs.at(-1)!) < n.d) from = '';
        else to = '';
      }
      // up/down inverts (feet) belong to the FROMMH and TOMH ends
      let up = pos(p.UPINVELEV);
      let dn = pos(p.DNINVELEV);
      const flip = () => {
        coords.reverse();
        xs = xs.reverse();
      };
      // lines drawn against their keys run the way the keys say
      const A = xs[0];
      const B = xs.at(-1)!;
      const F = from ? nodeNear(from, A) : undefined;
      const T = to ? nodeNear(to, B) : undefined;
      if (F && T && F.i !== T.i) {
        const fb = dist(xyOf[F.i], B);
        const ta = dist(xyOf[T.i], A);
        if (fb + ta + 0.5 < F.d + T.d) {
          flip();
          stats.reversedByKeys++;
        }
      } else if (F && !T && F.d > 5 && dist(xyOf[F.i], B) <= 5) {
        flip();
        stats.reversedByKeys++;
      } else if (T && !F && T.d > 5 && dist(xyOf[T.i], A) <= 5) {
        flip();
        stats.reversedByKeys++;
      }
      // keep keys that sit at their end, or that join other lines
      const S = xs[0];
      const E = xs.at(-1)!;
      const settle = (k: string, at: XY): { k: string; ok: boolean } => {
        if (!k) return { k, ok: false };
        const n = nodeNear(k, at);
        if (n && n.d <= FAR_M) {
          stats.resolvedEnds++;
          return { k, ok: true };
        }
        if (n) {
          stats.farKeys++;
          return { k: '', ok: false };
        }
        if ((named.get(k) ?? 0) > 1) {
          stats.sharedKeys++;
          return { k, ok: false };
        }
        stats.loneKeys++;
        return { k: '', ok: false };
      };
      const fs = settle(from, S);
      const ts = settle(to, E);
      from = fs.k;
      to = ts.k;
      let trust: Trust;
      if (fs.ok && ts.ok) {
        trust = 'id';
        if (up !== undefined && dn !== undefined) {
          if (up > dn) stats.idInverts.fall++;
          else if (up === dn) stats.idInverts.flat++;
          else {
            stats.idInverts.rise++;
            if (dn - up > 1) stats.idInverts.riseOver1ft++;
          }
        }
      } else if (up !== undefined && dn !== undefined && up - dn >= 0.1) trust = 'inverts';
      else if (!fs.ok && !ts.ok && up !== undefined && dn !== undefined && dn - up > 0.5) {
        // no node to go by: the inverts say the water runs the other way, keys and all
        flip();
        [from, to] = [to, from];
        [up, dn] = [dn, up];
        stats.reversedByInverts++;
        trust = 'inverts';
      } else trust = 'digitized';

      const fn = text(p.PIPEFUNCTION);
      const role: Role = l.kind === 'virtual' ? 'virtual' : l.kind === 'ditch' ? 'ditch' : fn === 'Culvert' ? 'culvert' : 'pipe';
      const a: SourceAsset = { role, id: text(p.FACILITYID) || text(p.ALTID) || rowId(l, f), src: KEY, coords, trust };
      if (from) a.fromId = from;
      if (to) a.toId = to;
      const w = pos(l.kind === 'ditch' ? p.TOPWIDTH : p.DIAMETER);
      if (w !== undefined && l.kind !== 'virtual') a.width = cm(w * INCH);
      // PVC_P and URC_P: perforated pipe, mostly in facilities
      if (/_P$/.test(text(p.MATERIAL))) a.perforated = true;
      if (l.kind !== 'virtual') a.owner = ownerOf(p.OWNEDBY, l.group);
      const hint = basins.of(p.SUBBASIN, xs[Math.floor(xs.length / 2)]);
      if (hint) a.receivingHint = hint;
      if (up !== undefined) a.upInv = cm(up * FT);
      if (dn !== undefined) a.downInv = cm(dn * FT);
      add(a, xs[0]);
    }
  }
  return { assets, stats };
}

/** City limits as polygons of rings, lon/lat. */
function boundaryOf(features: Feature[]): [number, number][][][] {
  return features.flatMap((f) => polygonsOf(f));
}

function countRoles(assets: SourceAsset[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.role] = (counts[a.role] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((x, y) => y[1] - x[1]));
}

const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'}%`;

async function main() {
  const log = (s: string) => console.log(s);
  const raw = await fetchRaw(process.argv.includes('--refresh'), log);
  const { assets, stats } = buildTacoma(raw);
  const counts = countRoles(assets);
  const boundary = boundaryOf(raw['city-limits']);
  const inside = (c: LonLat) => boundary.some((rings) => pointInPolygon(c, rings));
  const lines = assets.filter((a) => a.coords.length > 1 && !['facility-hold', 'facility-infiltrate'].includes(a.role));
  const trust: Record<string, number> = {};
  for (const a of lines) trust[a.trust] = (trust[a.trust] ?? 0) + 1;
  const drains = assets.filter((a) => a.role === 'drain');
  const outfalls = assets.filter((a) => a.role === 'outfall');
  const outsideDrains = drains.filter((a) => !inside(a.coords[0])).length;
  const outsideOutfalls = outfalls.filter((a) => !inside(a.coords[0])).length;
  const keyed = stats.keyedEnds;
  const ii = stats.idInverts;
  const iiAll = ii.fall + ii.flat + ii.rise;
  const notes = [
    'Layers: public and private storm mains, trunk mains, catch basin leads and ditches; virtual drainlines; inlets, manholes, discharge points, facilities, taps, cleanouts, fittings, valves, weirs, pumps; facility outlines. Only ACTIVEFLAG = In Service. Proposed, abandoned and flow-arrow layers left out; the wastewater network is a separate service and is not read.',
    `Line ends: ${keyed} of ${keyed + stats.blankEnds} carry a FROMMH/TOMH key; ${stats.resolvedEnds} (${pct(stats.resolvedEnds, keyed)}) resolve to a mapped node within ${FAR_M} m. ${stats.sharedKeys} unresolved keys shared by several lines are kept (they join those lines); ${stats.loneKeys} unresolved keys named once and ${stats.farKeys} keys whose node is over ${FAR_M} m away are left blank so those ends snap by geometry. Most private structures publish no FACILITYID, so private lines mostly join by geometry.`,
    `FROMMH sits at the first vertex on every line whose two keys resolve, so keys and drawing agree; ${stats.reversedByKeys} lines were reversed by a single key at the far end and ${stats.reversedByInverts} unkeyed lines by inverts that rise more than 0.5 ft along the drawing. Inverts on id lines fall along the flow on ${pct(ii.fall, iiAll)} (${ii.fall} of ${iiAll}), are flat on ${ii.flat} and rise on ${ii.rise} (${ii.riseOver1ft} by more than 1 ft); those keep the keyed direction.`,
    'trust: id = both keys resolve; inverts = no full key pair, inverts fall along the line (or reversed to); digitized = drawn order, the City draws lines downstream.',
    'Drains are catch basins, curb inlets and slot drains. Roof drains, yard drains and open pipe inlets (often pond or ditch outlets) are junctions.',
    'Discharge points: Outfall -> outfall, endHint water. Infiltration and Energy Dispersion -> discharge, ground. Standard Outlet (into a pond, swale or ditch), Overflow, Bubble Up CB, Other, Unknown and blank -> discharge, unknown.',
    'Facilities: INFILTRATED from the City AGOL facility copy (swFacilities, last edited Feb 2025; Full or Partial -> facility-infiltrate, None -> facility-hold); without it, pervious pavement and trenches soak in and the rest hold. Facility outline polygons (ids SWFO-...) carry their facility point role; the point carries the key, so treat a point inside its outline as the same facility.',
    'receivingHint is the City stormwater basin (SUBBASIN -> BASINNAME, e.g. Foss Waterway, Flett Creek, Lower Puyallup, Western Slopes), by subbasin polygon where SUBBASIN is blank. It names the basin, not the exact water.',
    'owner: OWNEDBY Tacoma or another city -> public, Private -> private, Other Government (schools, state, port and others) -> other.',
    'width from DIAMETER (inches) or ditch TOPWIDTH (read as inches); MATERIAL PVC_P and URC_P read as perforated; upInv/downInv from UPINVELEV/DNINVELEV (feet).',
    'Dropped: emergency overflow paths and virtual lines not In Service (most are flagged for deletion); repeated copies in the valve and weir layers.',
    `The network reaches past the city limits into Ruston, Fircrest, University Place, Fife, Lakewood and unincorporated Pierce; ${outsideDrains} drains and ${outsideOutfalls} outfalls lie outside the boundary.`,
    'Boundary: City of Tacoma "Tacoma City Limits" (AGOL, City IT). Terms: the City may require any use to stop; its disclaimer wording must be shown.',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Tacoma',
    county: 'Pierce',
    credit: CREDIT,
    disclaimer: DISCLAIMER,
    fetchedAt: fetchedAt(),
    boundary,
    counts,
    notes,
  };
  writeFileSync(`${DIR}/assets.ndjson.part`, assets.map((a) => JSON.stringify(a)).join('\n') + '\n');
  renameSync(`${DIR}/assets.ndjson.part`, `${DIR}/assets.ndjson`);
  writeFileSync(`${DIR}/meta.json`, JSON.stringify(meta, null, 1));

  log(`Tacoma: ${assets.length} assets -> ${DIR}/assets.ndjson`);
  log(`  roles: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`  line trust: ${Object.entries(trust).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`  keyed line ends resolved: ${stats.resolvedEnds} of ${keyed} (${pct(stats.resolvedEnds, keyed)}); blank ends ${stats.blankEnds}; shared unresolved kept ${stats.sharedKeys}; lone unresolved ${stats.loneKeys}; far ${stats.farKeys}; self ${stats.selfKeys}`);
  log(`  reversed: ${stats.reversedByKeys} by keys, ${stats.reversedByInverts} by inverts; id-line inverts fall ${ii.fall}, flat ${ii.flat}, rise ${ii.rise} (${ii.riseOver1ft} > 1 ft)`);
  log(`  drains ${drains.length} (public ${drains.filter((a) => a.owner === 'public').length}, private ${drains.filter((a) => a.owner === 'private').length}, other ${drains.filter((a) => a.owner === 'other').length}); outside the city ${outsideDrains}`);
  log(`  outfalls ${outfalls.length}, outside the city ${outsideOutfalls}; repeated ids ${stats.repeatedIds}`);
  log(`  dropped: ${Object.entries(stats.dropped).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const a of outfalls.filter((x) => x.owner === 'public').filter((_, i) => i % 19 === 0).slice(0, 8)) log(`  outfall ${a.id} -> ${a.receivingHint ?? '?'} at ${a.coords[0].join(',')}`);
}

if (import.meta.main) await main();
