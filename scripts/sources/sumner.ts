// City of Sumner storm drains -> <cache>/sources/sumner/{assets.ndjson,meta.json}.
// Geometry graph with no inverts, but most lines are tagged with the outfall they drain to.
// Each tagged line is turned to point toward its outfall along the lines that share the tag.
// node scripts/sources/sumner.ts [--refresh]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { GridIndex, localProjection, nearestOnPolyline, pointInPolygon, polylineLength, type XY } from '../../src/geo/geo.ts';
import { text, type Feature, type FeatureCollection, type Position } from '../../src/trace/geojson.ts';
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';

const KEY = 'sumner';
const DIR = `${process.env.TT_CACHE ?? '.cache'}/sources/${KEY}`;
const SVC = 'https://services5.arcgis.com/i22ctDcYlAxooCJX/arcgis/rest/services/Sumner_Utilities/FeatureServer';
const CITIES = 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Cities_in_Pierce_County/FeatureServer/0';
const CREDIT = 'Storm drain data: City of Sumner GIS, provided as is.';

// explicit allowlists: no comments, editor names or staff initials ('edit')
const LAYERS = {
  structures: { url: `${SVC}/14`, fields: ['OBJECTID', 'City_ID', 'Structure', 'Type', 'Ownership', 'Outfall'] },
  cleanouts: { url: `${SVC}/15`, fields: ['OBJECTID', 'City_ID', 'Structure', 'Owner', 'Outfall'] },
  outfalls: { url: `${SVC}/16`, fields: ['OBJECTID', 'City_ID', 'Outfall_ID', 'Owner', 'Outfa_Elev', 'Elev_Units'] },
  treatment: { url: `${SVC}/17`, fields: ['OBJECTID', 'City_ID', 'Structure', 'Ownership', 'Outfall'] },
  sites: { url: `${SVC}/18`, fields: ['OBJECTID', 'City_ID', 'Site_Type', 'Owner'] },
  lines: { url: `${SVC}/19`, fields: ['OBJECTID', 'City_ID', 'Owner', 'Pipe_Type', 'Pipe_Size', 'Outfall'] },
  city: { url: CITIES, fields: ['NAME'], where: "NAME = 'Sumner'" },
};

const SNAP = 1.5; // meters: ends and structures this close are one node
const ATTACH = 15; // meters: farthest an outfall point may sit from its tagged lines
const DRAWN_OK = 0.9; // share of tag-oriented lines already drawn downhill needed to trust drawn order elsewhere

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

// ---- helpers

const P = localProjection([-122.23, 47.21]); // Sumner center
const toXY = (p: [number, number]): XY => P.toXY(p);
const ll = (p: Position): [number, number] => [p[0], p[1]];
const gap = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 'DOU  e6-1 ' -> 'DOU E6-1'; anything else (blank, '?', 'N', 'NA') -> '' */
export function outfallTag(v: unknown): string {
  const t = text(v).toUpperCase().replace(/\s+/g, ' ');
  return /^DOU [A-Z]\d+-\d+$/.test(t) ? t : '';
}

function owner(v: unknown): SourceAsset['owner'] | undefined {
  const t = text(v).toLowerCase();
  return t === 'private' ? 'private' : t === 'public' ? 'public' : t === 'wsdot' ? 'other' : undefined;
}

function lineParts(f: Feature): [number, number][][] {
  const g = f.geometry;
  const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
  const out: [number, number][][] = [];
  for (const part of parts) {
    const pts = part.map(ll);
    const prev = out[out.length - 1];
    if (prev && gap(toXY(prev[prev.length - 1]), toXY(pts[0])) <= SNAP) prev.push(...pts.slice(1));
    else out.push(pts);
  }
  return out.filter((p) => p.length >= 2);
}

class Union {
  private readonly p: Int32Array;
  constructor(n: number) {
    this.p = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  join(a: number, b: number): void {
    this.p[this.find(a)] = this.find(b);
  }
}

/** Shortest distances over edges whose line passes `ok`, spreading from the seeded nodes in d (in place). */
function spread(adj: Edge[][], d: Float64Array, seeds: number[], ok: (line: number) => boolean): void {
  const heap: [number, number][] = [];
  const push = (n: number, v: number) => {
    heap.push([v, n]);
    for (let i = heap.length - 1; i > 0; ) {
      const j = (i - 1) >> 1;
      if (heap[j][0] <= heap[i][0]) break;
      [heap[i], heap[j]] = [heap[j], heap[i]];
      i = j;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const s of seeds) push(s, d[s]);
  while (heap.length) {
    const [v, n] = pop();
    if (v > d[n]) continue;
    for (const e of adj[n]) {
      if (!ok(e.line)) continue;
      const w = v + e.w;
      if (w < d[e.to]) { d[e.to] = w; push(e.to, w); }
    }
  }
}

interface Edge { to: number; w: number; line: number }

// ---- build

export async function buildSumner(refresh = false): Promise<{ assets: SourceAsset[]; meta: SourceMeta }> {
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
  let noGeometry = 0;

  // points; every point is a graph node too
  const nodePts: XY[] = [];
  const outfallNode = new Map<string, number>();
  const drainPts: number[] = [];
  const pointSpecs: [string, (p: Record<string, unknown>) => Role, string][] = [
    ['structures', (p) => (text(p.Structure) === 'Storm Catch Basin' ? 'drain' : 'junction'), 'Ownership'],
    ['cleanouts', () => 'junction', 'Owner'],
    ['treatment', () => 'junction', 'Ownership'],
    ['outfalls', () => 'outfall', 'Owner'],
  ];
  for (const [name, role, ownerField] of pointSpecs) {
    for (const f of raw[name].features) {
      const p = f.properties ?? {};
      if (f.geometry?.type !== 'Point') { noGeometry++; continue; }
      const c = ll(f.geometry.coordinates);
      const id = uniqueId(text(p.City_ID) || text(p.Outfall_ID), name, p.OBJECTID);
      const a: SourceAsset = { role: role(p), id, src: KEY, coords: [c], trust: 'none' };
      const o = owner(p[ownerField]);
      if (o) a.owner = o;
      const tag = name === 'outfalls' ? outfallTag(p.Outfall_ID) : outfallTag(p.Outfall);
      if (tag) a.receivingHint = tag;
      if (name === 'outfalls') {
        a.endHint = 'water';
        const elev = Number(p.Outfa_Elev);
        if (elev > 0) a.downInv = /^m/i.test(text(p.Elev_Units)) ? elev : elev * 0.3048;
        if (tag) outfallNode.set(tag, nodePts.length);
      }
      assets.push(a);
      if (a.role === 'drain') drainPts.push(nodePts.length);
      nodePts.push(toXY(c));
      if (name === 'structures' && /dry\s*well/i.test(text(p.Type))) {
        const d: SourceAsset = { role: 'discharge', id, src: KEY, coords: [c], trust: 'none', endHint: 'ground', receivingHint: 'Drywell' };
        if (o) d.owner = o;
        assets.push(d);
      }
    }
  }

  // treatment sites
  for (const f of raw.sites.features) {
    const p = f.properties ?? {};
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    const rings = polys.map((r) => r[0]).filter((r) => r && r.length >= 4);
    if (!rings.length) { noGeometry++; continue; }
    const id = uniqueId(text(p.City_ID), 'sites', p.OBJECTID);
    const soak = /bio\s*cell/i.test(text(p.Site_Type));
    rings.forEach((ring, k) => {
      const a: SourceAsset = { role: soak ? 'facility-infiltrate' : 'facility-hold', id: k ? `${id}#p${k + 1}` : id, src: KEY, coords: ring.map(ll), trust: 'none' };
      const o = owner(p.Owner);
      if (o) a.owner = o;
      assets.push(a);
    });
  }

  // lines
  const lines: SourceAsset[] = [];
  const tags: string[] = [];
  for (const f of raw.lines.features) {
    const p = f.properties ?? {};
    const parts = lineParts(f);
    if (!parts.length) { noGeometry++; continue; }
    const id = uniqueId(text(p.City_ID), 'lines', p.OBJECTID);
    const type = text(p.Pipe_Type).toUpperCase();
    const role: Role = type === 'CULVERT' ? 'culvert' : type === 'OC' ? 'ditch' : 'pipe';
    const tag = outfallTag(p.Outfall);
    parts.forEach((coords, k) => {
      const a: SourceAsset = { role, id: k ? `${id}#p${k + 1}` : id, src: KEY, coords, trust: 'none' };
      const size = Number(p.Pipe_Size);
      if (size > 0) a.width = Math.round(size * 0.0254 * 1000) / 1000; // inches
      if (/PERF|UNDERDRAIN/.test(type)) a.perforated = true;
      const o = owner(p.Owner);
      if (o) a.owner = o;
      if (tag) a.receivingHint = tag;
      assets.push(a);
      lines.push(a);
      tags.push(tag);
    });
  }

  // nodes: line ends (2i, 2i+1) after the points; ends and points within SNAP are one node
  const base = nodePts.length;
  const lineXY = lines.map((a) => a.coords.map(toXY));
  for (const xy of lineXY) nodePts.push(xy[0], xy[xy.length - 1]);
  const u = new Union(nodePts.length);
  const grid = new GridIndex<number>(10);
  nodePts.forEach((q, i) => {
    for (const j of grid.near(q, SNAP)) if (gap(nodePts[j], q) <= SNAP) u.join(i, j);
    grid.insertPoint(i, q);
  });
  const node = (i: number) => u.find(i);
  const startNode = (li: number) => node(base + 2 * li);
  const endNode = (li: number) => node(base + 2 * li + 1);

  const adj: Edge[][] = Array.from({ length: nodePts.length }, () => []);
  const link = (a: number, b: number, w: number, line: number) => {
    adj[a].push({ to: b, w, line });
    adj[b].push({ to: a, w, line });
  };
  const lens = lineXY.map((xy) => polylineLength(xy));
  lineXY.forEach((_, i) => link(startNode(i), endNode(i), lens[i], i));
  // a line end on the middle of another line joins it there
  const lineGrid = new GridIndex<number>(25);
  lineXY.forEach((xy, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of xy) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    lineGrid.insert(i, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
  });
  let lineEnds = 0, joined = 0, midJoins = 0;
  const degree = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) for (const n of [startNode(i), endNode(i)]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const pointNodes = new Set<number>();
  for (let i = 0; i < base; i++) pointNodes.add(node(i));
  lineXY.forEach((xy, i) => {
    for (const [e, n] of [[xy[0], startNode(i)], [xy[xy.length - 1], endNode(i)]] as [XY, number][]) {
      lineEnds++;
      let touches = (degree.get(n) ?? 0) > 1 || pointNodes.has(n);
      for (const j of lineGrid.near(e, SNAP)) {
        if (j === i) continue;
        const on = nearestOnPolyline(e, lineXY[j]);
        if (on.d > SNAP) continue;
        touches = true;
        if (on.along <= SNAP || on.along >= lens[j] - SNAP) continue; // at its end: already one node
        link(n, startNode(j), on.along, j);
        link(n, endNode(j), lens[j] - on.along, j);
        midJoins++;
      }
      if (touches) joined++;
    }
  });

  // orient each tagged line toward its outfall, over lines with the same tag or none.
  // Gaps are not bridged: on lone catch-basin laterals, bridged pieces came out worse than their drawn order.
  const byTag = new Map<string, number[]>();
  tags.forEach((t, i) => { if (t) byTag.set(t, [...(byTag.get(t) ?? []), i]); });
  const stats = { tagged: 0, noOutfall: 0, oriented: 0, reversed: 0, unreached: 0, tie: 0, outfalls: 0, attachedFar: 0, unattached: 0, leaf: 0, leafReversed: 0 };
  const oriented = new Uint8Array(lines.length);
  for (const [tag, members] of byTag) {
    stats.tagged += members.length;
    const oi = outfallNode.get(tag);
    if (oi === undefined) { stats.noOutfall += members.length; continue; }
    stats.outfalls++;
    const ok = (li: number) => tags[li] === tag || tags[li] === '';
    // start at the outfall's node, or the nearest end of its tagged lines
    let start = node(oi);
    if (!adj[start].some((e) => ok(e.line))) {
      let best = Infinity;
      for (const li of members) for (const k of [0, 1]) {
        const d = gap(nodePts[oi], nodePts[base + 2 * li + k]);
        if (d < best) { best = d; start = k ? endNode(li) : startNode(li); }
      }
      if (best > ATTACH) { stats.unattached++; stats.unreached += members.length; continue; }
      stats.attachedFar++;
    }
    const d = new Float64Array(nodePts.length).fill(Infinity);
    d[start] = 0;
    spread(adj, d, [start], ok);
    for (const li of members) {
      const ds = d[startNode(li)], de = d[endNode(li)];
      if (!Number.isFinite(ds)) { stats.unreached++; continue; }
      if (ds === de) { stats.tie++; continue; }
      if (ds < de) { lines[li].coords.reverse(); stats.reversed++; }
      lines[li].trust = 'node-flags';
      oriented[li] = 1;
      stats.oriented++;
    }
  }

  // a catch basin with only one line is where water enters, so that line flows away from it
  const drainNodes = new Set(drainPts.map(node));
  const leafEnd = (li: number): 0 | 1 | undefined => {
    const s0 = startNode(li), e0 = endNode(li);
    const sLeaf = adj[s0].length === 1 && drainNodes.has(s0);
    const eLeaf = adj[e0].length === 1 && drainNodes.has(e0);
    return sLeaf === eLeaf ? undefined : sLeaf ? 0 : 1;
  };
  const check = { n: 0, tagOk: 0, drawnOk: 0 };
  lines.forEach((a, li) => {
    const leaf = leafEnd(li);
    if (leaf === undefined) return;
    if (oriented[li]) {
      check.n++;
      if (leaf === 0) check.drawnOk++;
      if ((gap(toXY(a.coords[0]), lineXY[li][0]) < 0.01) === (leaf === 0)) check.tagOk++;
      return;
    }
    if (leaf === 1) { a.coords.reverse(); stats.leafReversed++; }
    a.trust = 'node-flags';
    oriented[li] = 1;
    stats.leaf++;
  });
  const drawnAgrees = stats.oriented ? (stats.oriented - stats.reversed) / stats.oriented : 0;
  const fallback: Trust = drawnAgrees >= DRAWN_OK ? 'digitized' : 'none';
  lines.forEach((a, i) => { if (!oriented[i]) a.trust = fallback; });

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
  const trust: Partial<Record<Trust, number>> = {};
  for (const a of lines) trust[a.trust] = (trust[a.trust] ?? 0) + 1;
  for (const [k, v] of Object.entries(trust)) counts[`trust:${k}`] = v;
  counts.linesTagged = stats.tagged;
  counts.lineEnds = lineEnds;
  counts.lineEndsJoined = joined;
  counts.outsideCityLimits = outside;
  counts.noGeometry = noGeometry;

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  const notes = [
    `Lines tagged with an outfall: ${stats.tagged} of ${lines.length} (${pct(stats.tagged, lines.length)}), over ${byTag.size} tags; ${stats.outfalls} tags match an outfall point, ${stats.noOutfall} lines name an outfall that isn't mapped.`,
    `Oriented toward their tagged outfall along the network (trust node-flags): ${stats.oriented} (${pct(stats.oriented, lines.length)} of all lines); ${stats.unreached} tagged lines don't connect to their outfall (gaps over ${SNAP} m), ${stats.tie} were ties.`,
    `Drawn order already pointed toward the outfall on ${pct(stats.oriented - stats.reversed, stats.oriented)} of the oriented lines.`,
    `Check on lines with one end at a catch basin that nothing else joins (water enters there): tag orientation flows away from it on ${check.tagOk} of ${check.n}, drawn order on ${check.drawnOk}.`,
    `Lines not reached from their outfall but with such a lone catch basin at one end: ${stats.leaf} oriented away from it (trust node-flags; ${stats.leafReversed} reversed). The other ${lines.length - stats.oriented - stats.leaf} lines keep their drawn order (trust ${fallback}).`,
    `Outfalls more than ${SNAP} m from their lines (joined to the nearest tagged line end within ${ATTACH} m): ${stats.attachedFar}; too far to join: ${stats.unattached}.`,
    `Line ends within ${SNAP} m of another line or structure: ${joined} of ${lineEnds} (${pct(joined, lineEnds)}); ${midJoins} ends join the middle of another line.`,
    `receivingHint holds the outfall ID the source tags on each line, structure and outfall (Sumner records no receiving-water names). Owner WSDOT is 'other'.`,
    `${outside} assets lie outside city limits.`,
  ];
  const meta: SourceMeta = { key: KEY, name: 'City of Sumner', county: 'Pierce', credit: CREDIT, fetchedAt, boundary, counts, notes };
  return { assets, meta };
}

function writeSource(assets: SourceAsset[], meta: SourceMeta): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/assets.ndjson.part`, assets.map((a) => JSON.stringify(a)).join('\n') + '\n');
  renameSync(`${DIR}/assets.ndjson.part`, `${DIR}/assets.ndjson`);
  writeFileSync(`${DIR}/meta.json`, JSON.stringify(meta, null, 1));
}

if (import.meta.main) {
  const { assets, meta } = await buildSumner(process.argv.includes('--refresh'));
  writeSource(assets, meta);
  console.log(meta.counts);
  for (const n of meta.notes) console.log(`- ${n}`);
}
