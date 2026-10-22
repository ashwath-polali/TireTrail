// City of Puyallup storm drains -> <cache>/sources/puyallup/{assets.ndjson,meta.json}.
// Geometry graph. Pipes, culverts and ditches carry an 8-point compass flow direction;
// each line is turned to agree with it. A line's discharge field names the creek it ends in.
// node scripts/sources/puyallup.ts [--refresh]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { GridIndex, localProjection, nearestOnPolyline, pointInPolygon, type XY } from '../../src/geo/geo.ts';
import { text, type Feature, type FeatureCollection, type Position } from '../../src/trace/geojson.ts';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';

const KEY = 'puyallup';
const DIR = `${process.env.TT_CACHE ?? '.cache'}/sources/${KEY}`;
const SVC = 'https://services8.arcgis.com/5K6vnOH0GkPyJs6A/ArcGIS/rest/services/Storm_Water/FeatureServer';
const CITIES = 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Cities_in_Pierce_County/FeatureServer/0';
const CREDIT = 'Storm drain data: City of Puyallup GIS, provided as is.';

// explicit allowlists: no addresses, streets, comments, descriptions or editor names
const LAYERS = {
  outfalls: { url: `${SVC}/1`, fields: ['OBJECTID', 'OUT_Puyallup_ID', 'OUT_INVERT_ELEVATION', 'OUT_ReceivingWaters', 'OUT_Ownership', 'OUT_Drainage'] },
  manholes: { url: `${SVC}/2`, fields: ['OBJECTID', 'MAN_PUYALLUP_ID', 'MAN_TYPE', 'MAN_OWNER'] },
  inlets: { url: `${SVC}/3`, fields: ['OBJECTID', 'IN_PUYALLUP_ID', 'IN_TYPE', 'IN_OWNER'] },
  controls: { url: `${SVC}/4`, fields: ['OBJECTID', 'CTRL_PUYALLUP_ID', 'CTRL_TYPE', 'CTRL_OWNERSHIP'] },
  pipes: { url: `${SVC}/5`, fields: ['OBJECTID', 'PUYALLUP_ID', 'PIPE_SIZE_WIDTH_IN', 'PIPE_TYPE', 'PIPE_MATERIAL', 'PIPE_FLOWDIR', 'PIPE_DISDEST', 'PIPE_SALMON', 'PIPE_OWNER', 'PIPE_DRAINAGE'] },
  culverts: { url: `${SVC}/6`, fields: ['OBJECTID', 'CUL_PUYALLUP_ID', 'CUL_SIZE_WIDTH_IN', 'CUL_MATERIAL', 'CUL_FLOW_DIR', 'CUL_DIS_DEST', 'CUL_SALMON', 'CUL_OWNER', 'CUL_DRAINBAS'] },
  channels: { url: `${SVC}/7`, fields: ['OBJECTID', 'CH_PUYALLUP_ID', 'CH_WIDTH_IN', 'CH_TYPE', 'CH_FLOWDIR', 'CH_DIS_DEST', 'CH_OWNER', 'CH_DRAINBAS'] },
  facilities: { url: `${SVC}/8`, fields: ['OBJECTID', 'FAC_Puyallup_ID', 'FAC_TYPE', 'FAC_TSUBTYPE_1', 'FAC_TOWNER_1'] },
  city: { url: CITIES, fields: ['NAME'], where: "NAME = 'Puyallup'" },
};

// coded values from the service's domains
const OWNER: Record<number, SourceAsset['owner']> = { 1: 'private', 2: 'private', 3: 'public' }; // 1 Commercial
const BASIN: Record<number, string> = {
  1: "Clark's Creek", 2: 'Pothole', 3: 'Puyallup River, North', 4: 'Puyallup River, South', 5: 'Shaw Road',
  6: 'State Highway', 7: 'Wapato Creek', 8: 'SW Puyallup', 9: 'Deer Creek', 10: 'SE Puyallup',
};
/** discharge destinations that are open water */
const DEST_WATER: Record<number, string> = {
  10: 'Channel', 11: "Clark's Creek", 23: 'Deer Creek', 35: 'Intermittent Creek', 41: 'Meeker Creek', 42: 'Natural Pond',
  55: 'Perennial Stream', 80: 'Puyallup River', 82: 'Silver Creek', 94: 'Wapato Creek', 95: 'Wetland', 96: 'Woodland Creek',
};
/** discharge destinations that soak into the ground */
const DEST_GROUND: Record<number, string> = { 25: 'Drain Field', 30: 'Drywell', 54: 'Permeable Ballast', 65: 'Pothole' };
/** destinations that are a point feature at the line's lower end: 5 catch basin, 15 control structure, 30 drywell, 40 manhole */
const DEST_POINT: Record<number, string> = { 5: 'inlets', 15: 'controls', 30: 'inlets', 40: 'manholes' };
/** the other destinations, for the dead-end note */
const DEST_OTHER: Record<number, string> = { 15: 'Control Structure', 20: 'Culvert', 40: 'Manhole', 45: 'None', 50: 'Other', 5: 'Catch Basin', 60: 'Pipe', 70: 'Private Pond', 75: 'Public Pond', 83: 'System', 85: 'Unknown', 90: 'Vault' };
const PERFORATED = new Set([11, 16, 23, 27, 35]);
/** facility subtypes that soak in: infiltration, dispersion, rain garden, bioretention, permeable, compost soils */
const SOAK_SUBTYPES = new Set([9, 42, 47, 50, 52, 54, 58]);
const SOAK_TYPES = new Set([30, 50]); // LID, Permeable

const SNAP = 1.5; // meters: line ends this close are joined (as in the county graph)
const AMBIGUOUS = 22.5; // degrees around square to the compass where the field can't tell the ends apart

// ---- fetch (ArcGIS REST by object id chunks, cached raw)

type Spec = { url: string; fields: string[]; where?: string };

async function getJSON(url: string, body: URLSearchParams): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

async function download(spec: Spec): Promise<FeatureCollection> {
  const where = spec.where ?? '1=1';
  const ids: number[] = (await getJSON(`${spec.url}/query`, new URLSearchParams({ where, returnIdsOnly: 'true', f: 'json' }))).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 1000) chunks.push(ids.slice(i, i + 1000));
  const parts: Feature[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const body = new URLSearchParams({ objectIds: chunks[k].join(','), outFields: spec.fields.join(','), outSR: '4326', geometryPrecision: '7', f: 'geojson' });
      parts[k] = (await getJSON(`${spec.url}/query`, body)).features ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker)); // at most 4 per host
  const features = parts.flat();
  if (features.length !== ids.length) throw new Error(`${spec.url}: got ${features.length} of ${ids.length} features`);
  return { type: 'FeatureCollection', features };
}

async function layer(name: string, spec: Spec, refresh: boolean): Promise<FeatureCollection> {
  const file = `${DIR}/raw/${name}.geojson`;
  if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const fc = await download(spec);
  writeFileSync(`${file}.part`, JSON.stringify(fc));
  renameSync(`${file}.part`, file);
  console.log(`  ${name}: ${fc.features.length}`);
  return fc;
}

// ---- geometry helpers

const P = localProjection([-122.29, 47.18]); // Puyallup center
const toXY = (p: [number, number]): XY => P.toXY(p);
const ll = (p: Position): [number, number] => [p[0], p[1]];

/** Line parts of a feature; a MultiLineString is split where its parts don't touch. */
function lineParts(f: Feature): [number, number][][] {
  const g = f.geometry;
  const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
  const out: [number, number][][] = [];
  for (const part of parts) {
    const pts = part.map(ll);
    const prev = out[out.length - 1];
    if (prev && Math.hypot(...sub(toXY(prev[prev.length - 1]), toXY(pts[0]))) <= SNAP) prev.push(...pts.slice(1));
    else out.push(pts);
  }
  return out.filter((p) => p.length >= 2);
}

const sub = (a: XY, b: XY): [number, number] => [a[0] - b[0], a[1] - b[1]];

/** Bearing from first to last vertex, degrees clockwise from north. */
export function bearing(coords: readonly [number, number][]): number {
  const [dx, dy] = sub(toXY(coords[coords.length - 1]), toXY(coords[0]));
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Angle between two bearings, 0..180. */
export function angleBetween(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** 'forward' when the drawn order agrees with the compass, 'reverse' when it opposes it, else 'unsure'. */
export function compassSays(coords: readonly [number, number][], compass: number): 'forward' | 'reverse' | 'unsure' {
  const d = angleBetween(bearing(coords), compass);
  return d < 90 - AMBIGUOUS ? 'forward' : d > 90 + AMBIGUOUS ? 'reverse' : 'unsure';
}

const num = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(v));

// ---- build

interface Line {
  asset: SourceAsset;
  compass?: number;
  dest?: number;
  basin?: number;
}

export async function buildPuyallup(refresh = false): Promise<{ assets: SourceAsset[]; meta: SourceMeta }> {
  mkdirSync(`${DIR}/raw`, { recursive: true });
  const raw: Record<string, FeatureCollection> = {};
  for (const [name, spec] of Object.entries(LAYERS)) raw[name] = await layer(name, spec, refresh);
  const fetchedAt = new Date().toISOString();

  const assets: SourceAsset[] = [];
  const seen = new Map<string, number>();
  const uniqueId = (id: string, layerName: string, oid: unknown): string => {
    const base = id || `${layerName}-${oid}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };
  const point = (f: Feature): [number, number] | undefined => (f.geometry?.type === 'Point' ? ll(f.geometry.coordinates) : undefined);
  let noGeometry = 0;

  // points
  const pointIndex: Record<string, GridIndex<XY>> = { inlets: new GridIndex(10), manholes: new GridIndex(10), controls: new GridIndex(10), basins: new GridIndex(10), all: new GridIndex(10) };
  const endings = new GridIndex<SourceAsset>(10);
  const pointSpecs: [string, string, string, (p: Record<string, unknown>) => Role][] = [
    ['inlets', 'IN_PUYALLUP_ID', 'IN_OWNER', () => 'drain'],
    ['manholes', 'MAN_PUYALLUP_ID', 'MAN_OWNER', () => 'junction'],
    ['controls', 'CTRL_PUYALLUP_ID', 'CTRL_OWNERSHIP', () => 'junction'],
    ['outfalls', 'OUT_Puyallup_ID', 'OUT_Ownership', () => 'outfall'],
  ];
  for (const [name, idField, ownerField, role] of pointSpecs) {
    for (const f of raw[name].features) {
      const p = f.properties ?? {};
      const c = point(f);
      if (!c) { noGeometry++; continue; }
      const a: SourceAsset = { role: role(p), id: uniqueId(text(p[idField]), name, p.OBJECTID), src: KEY, coords: [c], trust: 'none' };
      const owner = OWNER[Number(p[ownerField])];
      if (owner) a.owner = owner;
      if (name === 'outfalls') {
        a.endHint = 'water';
        const rw = DEST_WATER[Number(p.OUT_ReceivingWaters)];
        const basin = BASIN[Number(p.OUT_Drainage)];
        const hint = receiving(rw, basin);
        if (hint) a.receivingHint = hint;
        const inv = num(p.OUT_INVERT_ELEVATION);
        if (inv !== undefined && inv > 0) a.downInv = inv * 0.3048; // feet
        endings.insertPoint(a, toXY(c));
      }
      assets.push(a);
      pointIndex.all.insertPoint(toXY(c), toXY(c));
      if (pointIndex[name]) pointIndex[name].insertPoint(toXY(c), toXY(c));
      if (name === 'inlets' && Number(p.IN_TYPE) === 3) pointIndex.basins.insertPoint(toXY(c), toXY(c));
      // a dry well takes street water and soaks it into the ground at the same spot
      if (name === 'inlets' && Number(p.IN_TYPE) === 4) {
        const d: SourceAsset = { role: 'discharge', id: a.id, src: KEY, coords: [c], trust: 'none', endHint: 'ground', receivingHint: 'Drywell' };
        if (owner) d.owner = owner;
        assets.push(d);
        endings.insertPoint(d, toXY(c));
      }
    }
  }

  // facilities: one asset per polygon, outer ring
  for (const f of raw.facilities.features) {
    const p = f.properties ?? {};
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const rings = polys.map((r) => r[0]).filter((r) => r && r.length >= 4);
    if (!rings.length) { noGeometry++; continue; }
    const soak = SOAK_SUBTYPES.has(Number(p.FAC_TSUBTYPE_1)) || SOAK_TYPES.has(Number(p.FAC_TYPE));
    const id = uniqueId(text(p.FAC_Puyallup_ID), 'facilities', p.OBJECTID);
    rings.forEach((ring, k) => {
      const a: SourceAsset = { role: soak ? 'facility-infiltrate' : 'facility-hold', id: k ? `${id}#p${k + 1}` : id, src: KEY, coords: ring.map(ll), trust: 'none' };
      const owner = OWNER[Number(p.FAC_TOWNER_1)];
      if (owner) a.owner = owner;
      assets.push(a);
    });
  }

  // lines
  const lines: Line[] = [];
  const lineSpecs = [
    { name: 'pipes', id: 'PUYALLUP_ID', width: 'PIPE_SIZE_WIDTH_IN', material: 'PIPE_MATERIAL', dir: 'PIPE_FLOWDIR', dest: 'PIPE_DISDEST', salmon: 'PIPE_SALMON', owner: 'PIPE_OWNER', basin: 'PIPE_DRAINAGE' },
    { name: 'culverts', id: 'CUL_PUYALLUP_ID', width: 'CUL_SIZE_WIDTH_IN', material: 'CUL_MATERIAL', dir: 'CUL_FLOW_DIR', dest: 'CUL_DIS_DEST', salmon: 'CUL_SALMON', owner: 'CUL_OWNER', basin: 'CUL_DRAINBAS' },
    { name: 'channels', id: 'CH_PUYALLUP_ID', width: 'CH_WIDTH_IN', material: '', dir: 'CH_FLOWDIR', dest: 'CH_DIS_DEST', salmon: '', owner: 'CH_OWNER', basin: 'CH_DRAINBAS' },
  ];
  for (const s of lineSpecs) {
    for (const f of raw[s.name].features) {
      const p = f.properties ?? {};
      const parts = lineParts(f);
      if (!parts.length) { noGeometry++; continue; }
      const id = uniqueId(text(p[s.id]), s.name, p.OBJECTID);
      const salmon = s.salmon ? Number(p[s.salmon]) === 1 : false;
      const role: Role = salmon ? 'stream-culvert' : s.name === 'pipes' ? 'pipe' : s.name === 'culverts' ? 'culvert' : 'ditch';
      parts.forEach((coords, k) => {
        const a: SourceAsset = { role, id: k ? `${id}#p${k + 1}` : id, src: KEY, coords, trust: 'none' };
        const w = num(p[s.width]);
        if (w && w > 0) a.width = Math.round(w * 0.0254 * 1000) / 1000;
        if (s.material && PERFORATED.has(Number(p[s.material]))) a.perforated = true;
        if (s.name === 'pipes' && Number(p.PIPE_TYPE) === 9) a.perforated = true; // infiltration pipe
        if (salmon) a.liveStream = true;
        const owner = OWNER[Number(p[s.owner])];
        if (owner) a.owner = owner;
        assets.push(a);
        lines.push({ asset: a, compass: num(p[s.dir]), dest: num(p[s.dest]), basin: num(p[s.basin]) });
      });
    }
  }

  // line ends that no other line meets
  const lineIndex = new GridIndex<number>(25);
  const lineXY = lines.map((l) => l.asset.coords.map(toXY));
  lineXY.forEach((xy, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of xy) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    lineIndex.insert(i, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
  });
  const lone = (i: number, e: XY) => !lineIndex.near(e, SNAP).some((j) => j !== i && nearestOnPolyline(e, lineXY[j]).d <= SNAP);
  const hasPoint = (name: string, c: [number, number]) => pointIndex[name].near(toXY(c), SNAP).some((q) => Math.hypot(...sub(q, toXY(c))) <= SNAP);
  // a catch basin that only this line meets is where water enters, so the line flows away from it
  const leafSays = (i: number): 'forward' | 'reverse' | undefined => {
    const c = lines[i].asset.coords;
    const atStart = lone(i, toXY(c[0])) && hasPoint('basins', c[0]);
    const atEnd = lone(i, toXY(c[c.length - 1])) && hasPoint('basins', c[c.length - 1]);
    return atStart === atEnd ? undefined : atStart ? 'forward' : 'reverse';
  };
  let lineEnds = 0, joined = 0;
  lineXY.forEach((xy, i) => {
    for (const e of [xy[0], xy[xy.length - 1]]) {
      lineEnds++;
      if (!lone(i, e) || pointIndex.all.near(e, SNAP).some((q) => Math.hypot(...sub(q, e)) <= SNAP)) joined++;
    }
  });

  // orient lines by compass; the destination structure or a lone catch basin settles lines the compass can't
  const stats = { compass: 0, reversed: 0, unsure: 0, noCompass: 0, byDest: 0, byLeaf: 0, conflictDrawn: 0, conflictCompass: 0, destChecked: 0, destAgrees: 0, leafChecked: 0, leafAgrees: 0, leafDrawn: 0 };
  lines.forEach((l, i) => {
    const a = l.asset;
    const leaf = leafSays(i);
    const says = l.compass === undefined ? undefined : compassSays(a.coords, l.compass);
    // which end has the structure the line discharges into
    let destSays: 'forward' | 'reverse' | undefined;
    const destLayer = l.dest === undefined ? undefined : DEST_POINT[l.dest];
    if (destLayer) {
      const atStart = hasPoint(destLayer, a.coords[0]);
      const atEnd = hasPoint(destLayer, a.coords[a.coords.length - 1]);
      if (atStart !== atEnd) destSays = atEnd ? 'forward' : 'reverse';
    }
    const other = destSays ?? leaf;
    if (says === 'forward' || says === 'reverse') {
      stats.compass++;
      if (destSays) { stats.destChecked++; if (destSays === says) stats.destAgrees++; }
      if (leaf) { stats.leafChecked++; if (leaf === says) stats.leafAgrees++; if (leaf === 'forward') stats.leafDrawn++; }
      if (says === 'forward') { a.trust = 'compass'; return; }
      // compass against the drawn order: on checked lines this was wrong more often than right
      stats.reversed++;
      if (other) {
        if (other === 'reverse') a.coords.reverse();
        a.trust = 'node-flags';
        if (other === 'forward') stats.conflictDrawn++;
        else stats.conflictCompass++;
      }
      return;
    }
    if (says === 'unsure') stats.unsure++;
    else stats.noCompass++;
    if (other) {
      if (other === 'reverse') a.coords.reverse();
      a.trust = 'node-flags';
      if (destSays) stats.byDest++;
      else stats.byLeaf++;
      return;
    }
    a.trust = 'digitized'; // drawn order matches the compass on 99% of lines
  });

  // a line that ends in a creek or in the ground gets a discharge point at its lower end
  const dischargeStats = { water: 0, ground: 0, atOutfall: 0, unoriented: 0 };
  for (const l of lines) {
    const a = l.asset;
    if (l.dest === undefined) continue;
    const water = DEST_WATER[l.dest];
    const ground = DEST_GROUND[l.dest];
    if (!water && !ground) continue;
    if (l.dest === 10) continue; // 'Channel' is a ditch, still part of the network
    if (a.trust === 'none') { dischargeStats.unoriented++; continue; }
    const end = a.coords[a.coords.length - 1];
    const near = endings.near(toXY(end), 3).filter((e) => Math.hypot(...sub(toXY(e.coords[0]), toXY(end))) <= 3);
    if (near.length) {
      dischargeStats.atOutfall++;
      for (const e of near) if (!e.receivingHint && water) e.receivingHint = receiving(water, BASIN[l.basin ?? 0]);
      continue;
    }
    const d: SourceAsset = { role: 'discharge', id: `${a.id}:end`, src: KEY, coords: [end], trust: 'none', endHint: water ? 'water' : 'ground' };
    const hint = water ? receiving(water, BASIN[l.basin ?? 0]) : ground;
    if (hint) d.receivingHint = hint;
    if (a.owner) d.owner = a.owner;
    assets.push(d);
    endings.insertPoint(d, toXY(end));
    if (water) dischargeStats.water++;
    else dischargeStats.ground++;
  }

  // lower ends that meet nothing, by recorded destination (ponds and vaults are joined later by the graph)
  const deadEnds: Record<string, number> = {};
  lines.forEach((l, i) => {
    const c = l.asset.coords;
    if (l.asset.trust === 'none') return;
    const e = toXY(c[c.length - 1]);
    if (!lone(i, e) || pointIndex.all.near(e, SNAP).some((q) => Math.hypot(...sub(q, e)) <= SNAP)) return;
    if (endings.near(e, 3).some((x) => Math.hypot(...sub(toXY(x.coords[0]), e)) <= 3)) return;
    const k = (l.dest !== undefined && (DEST_WATER[l.dest] ?? DEST_GROUND[l.dest] ?? DEST_OTHER[l.dest])) || 'blank';
    deadEnds[k] = (deadEnds[k] ?? 0) + 1;
  });
  const deadTotal = Object.values(deadEnds).reduce((a, b) => a + b, 0);

  // city limits
  const boundary: [number, number][][][] = [];
  for (const f of raw.city.features) {
    const g = f.geometry;
    if (g?.type === 'Polygon') boundary.push(g.coordinates.map((r) => r.map(ll)));
    else if (g?.type === 'MultiPolygon') for (const poly of g.coordinates) boundary.push(poly.map((r) => r.map(ll)));
  }
  const boundaryXY = boundary.map((poly) => poly.map((r) => r.map(toXY)));
  const outside = assets.filter((a) => !boundaryXY.some((rings) => pointInPolygon(toXY(a.coords[0]), rings))).length;

  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.role] = (counts[a.role] ?? 0) + 1;
  const trust: Record<Trust, number> = { id: 0, inverts: 0, compass: 0, 'node-flags': 0, digitized: 0, none: 0 };
  for (const l of lines) trust[l.asset.trust]++;
  for (const [k, v] of Object.entries(trust)) if (v) counts[`trust:${k}`] = v;
  counts.lineEnds = lineEnds;
  counts.lineEndsJoined = joined;
  counts.outsideCityLimits = outside;
  counts.noGeometry = noGeometry;

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  const notes = [
    `Compass flow direction set on ${stats.compass + stats.unsure} of ${lines.length} lines; it is clear (not square to the line within ${AMBIGUOUS} degrees) on ${stats.compass}, and the drawn order agrees with it on ${stats.compass - stats.reversed} (${pct(stats.compass - stats.reversed, stats.compass)}, trust compass).`,
    `${stats.reversed} lines have a compass against their drawn order. Where the destination structure or a lone catch basin tells the ends apart, it sides with the drawn order on ${stats.conflictDrawn} and with the compass on ${stats.conflictCompass}; those follow it (trust node-flags), the other ${stats.reversed - stats.conflictDrawn - stats.conflictCompass} keep their drawn order with trust none.`,
    `No clear compass: ${stats.unsure} square to the line, ${stats.noCompass} blank; ${stats.byDest} oriented by the destination structure and ${stats.byLeaf} away from a lone catch basin (trust node-flags), the rest keep their drawn order (trust digitized).`,
    `Where the discharge-destination structure sits at exactly one end, the compass agrees on ${stats.destAgrees} of ${stats.destChecked} lines (${pct(stats.destAgrees, stats.destChecked)}).`,
    `Where one end is a catch basin no other line meets (water enters there), the compass flows away from it on ${stats.leafAgrees} of ${stats.leafChecked} lines (${pct(stats.leafAgrees, stats.leafChecked)}); drawn order on ${stats.leafDrawn}.`,
    `Discharge points added at line ends: ${dischargeStats.water} to water, ${dischargeStats.ground} to ground; ${dischargeStats.atOutfall} line ends already had an outfall or dry well; ${dischargeStats.unoriented} skipped (direction unknown).`,
    `Line ends within ${SNAP} m of another line or structure: ${joined} of ${lineEnds} (${pct(joined, lineEnds)}).`,
    `Dry wells are both a drain and a ground discharge at the same spot. City_Owned_UIC_Wells is not fetched: it repeats the dry wells in the inlets layer.`,
    `${outside} assets lie outside city limits (state highway, county and private pieces at the edges).`,
    `Oriented lines whose lower end meets no line, structure or ending within ${SNAP} m: ${deadTotal}; recorded destinations: ${Object.entries(deadEnds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ];
  const meta: SourceMeta = { key: KEY, name: 'City of Puyallup', county: 'Pierce', credit: CREDIT, fetchedAt, boundary, counts, notes };
  return { assets, meta };
}

function receiving(name: string | undefined, basin: string | undefined): string | undefined {
  if (!name) return basin ? `${basin} basin` : undefined;
  // generic names say little alone
  if ((name === 'Perennial Stream' || name === 'Intermittent Creek' || name === 'Wetland' || name === 'Channel' || name === 'Natural Pond') && basin) return `${name} (${basin} basin)`;
  return name;
}

function writeSource(dir: string, assets: SourceAsset[], meta: SourceMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/assets.ndjson.part`, assets.map((a) => JSON.stringify(a)).join('\n') + '\n');
  renameSync(`${dir}/assets.ndjson.part`, `${dir}/assets.ndjson`);
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 1));
}

if (import.meta.main) {
  const { assets, meta } = await buildPuyallup(process.argv.includes('--refresh'));
  writeSource(DIR, assets, meta);
  console.log(meta.counts);
  for (const n of meta.notes) console.log(`- ${n}`);
}
