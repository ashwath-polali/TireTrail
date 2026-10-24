// City of Mercer Island storm drains -> <cache>/sources/mercer-island/{assets.ndjson,meta.json}.
// Mains name their end nodes (UPSTREAMNODE -> DOWNSTREAMNODE is the flow order). The public GeoCortex service has
// catch basins and discharge points but not the inlet/outfall nodes (SD-IO-*), so those sit where the lines naming them meet.
// node scripts/sources/mercer-island.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
  approxM,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  num,
  orientByKeys,
  pointOf,
  rawDirFor,
  runCli,
  settleKeys,
  str,
  summarize,
  toM,
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';
import { groundSign, openGround } from './lib/downhill.ts';

const KEY = 'mercer-island';
const BASE = 'https://gis.mercerisland.gov/server/rest/services/GeoCortexExternal/gcexStormService/MapServer';
const GEOID = '5345005';
const ACTIVE = "FEATURESTATUS = 'Active' OR FEATURESTATUS IS NULL";

const layers = {
  structures: { name: 'structures', url: `${BASE}/1`, fields: ['OBJECTID', 'ASSETID', 'FEATURETYPE', 'FEATURESTATUS', 'LIDTYPE', 'BOTTOMPRESENT', 'OWNERSHIP'], where: ACTIVE },
  // layer 3 (private mains) is a subset of layer 2
  mains: { name: 'mains', url: `${BASE}/2`, fields: ['OBJECTID', 'ASSETID', 'FEATURETYPE', 'WATERCOURSETYPE', 'FEATURESTATUS', 'ENABLED', 'DIAMETER', 'OWNERSHIP', 'UPSTREAMINVERT_88', 'DOWNSTREAMINVERT_88', 'UPSTREAMNODE', 'DOWNSTREAMNODE'], where: ACTIVE },
  discharge: { name: 'discharge', url: `${BASE}/4`, fields: ['OBJECTID', 'ASSETID', 'FEATURETYPE', 'FEATURESTATUS', 'OWNERSHIP'], where: ACTIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const CITY_OWNERS = new Set(['Mercer Island', 'Mercer Island (by Easement)']);
function miOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s || s === 'Unknown') return undefined;
  if (CITY_OWNERS.has(s)) return 'public';
  if (s === 'Private') return 'private';
  return 'other';
}

const SOLID = new Set(['Solid Lid (Rectangular)', 'Solid Lid (Round)', 'Buried']);
const GRATE = new Set(['Vaned', 'Herringbone', 'Straight Slot', 'Grate', 'Bee Hive', 'Non-Standard']);
const INLETS = new Set(['Type 1', 'Type 1-L', 'Yard Drain', 'Inlet']);
/** ends this close are one node */
const MEET_M = 1.5;

export async function buildMercerIsland(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`mercer-island ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.23, 47.56]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.ASSETID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: miOwner(f.attributes.OWNERSHIP), ...more });
  };

  for (const f of L.structures) {
    const a = f.attributes;
    const t = str(a.FEATURETYPE);
    const lid = str(a.LIDTYPE);
    // street inlets take water unless the lid is solid; manholes and unknowns only with a grate
    const grate = INLETS.has(t) ? !SOLID.has(lid) : GRATE.has(lid);
    const bottomless = num(a.BOTTOMPRESENT) === 0 && a.BOTTOMPRESENT !== null && a.BOTTOMPRESENT !== undefined;
    point('structures', f, grate ? 'drain' : 'junction', bottomless ? { openBottom: true } : {});
    if (bottomless) inc('structures.noBottom');
  }
  for (const f of L.discharge) {
    const t = str(f.attributes.FEATURETYPE);
    if (t === 'Outfall') point('discharge', f, 'outfall', { endHint: 'water' });
    else if (t === 'Dry Well') point('discharge', f, 'discharge', { endHint: 'ground' });
    else point('discharge', f, 'outfall', { endHint: 'unknown' });
  }

  // lines, with their node keys
  const gaps = { n: 0 };
  interface Pending { f: EsriFeature; coords: LonLat[]; up: string; down: string }
  const pend: Pending[] = [];
  for (const f of L.mains) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    if (num(f.attributes.ENABLED) === 0 && f.attributes.ENABLED !== null) inc('mains.disabled');
    pend.push({ f, coords, up: str(f.attributes.UPSTREAMNODE), down: str(f.attributes.DOWNSTREAMNODE) });
  }

  // node keys with no point (SD-IO-*): the line end most lines naming the key share
  const ofKey = new Map<string, LonLat[]>();
  for (const p of pend) {
    for (const k of [p.up, p.down]) {
      if (!k || nodes.byId.has(k)) continue;
      const list = ofKey.get(k) ?? [];
      list.push(p.coords[0], p.coords[p.coords.length - 1]);
      ofKey.set(k, list);
    }
  }
  for (const [k, pts] of ofKey) {
    if (pts.length < 4) continue;
    let best: LonLat | undefined;
    let bestN = 0;
    for (const p of pts) {
      const n = pts.filter((q) => approxM(p, q) <= MEET_M).length;
      if (n > bestN) [best, bestN] = [p, n];
    }
    if (best && bestN >= 2) {
      nodes.add(k, best);
      inc('keys.placedWhereLinesMeet');
    } else inc('keys.linesNeverMeet');
  }

  const role = (t: string): Role => (t === 'Ditch' || t === 'Flume' ? 'ditch' : t === 'Piped Watercourse' ? 'stream-culvert' : t === 'Open Watercourse' ? 'stream' : 'pipe');
  const keyless: SourceAsset[] = [];
  let keyedAsDrawn = 0;
  let keyedFlipped = 0;
  for (const p of pend) {
    const a = p.f.attributes;
    const t = str(a.FEATURETYPE);
    const r = role(t);
    const live = r === 'stream-culvert' || r === 'stream';
    const dia = num(a.DIAMETER);
    const base: SourceAsset = {
      role: r, id: idOf('mains', a), src: KEY, coords: p.coords, trust: 'none', owner: miOwner(a.OWNERSHIP),
      width: r === 'pipe' || r === 'stream-culvert' ? toM(dia, IN) : undefined, liveStream: live || undefined,
      receivingHint: live && str(a.WATERCOURSETYPE) ? `stream type ${str(a.WATERCOURSETYPE).replace(/^Type /, '').trim()}` : undefined,
      upInv: toM(num(a.UPSTREAMINVERT_88), FT), downInv: toM(num(a.DOWNSTREAMINVERT_88), FT),
    };
    if (p.up || p.down) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, p.coords, p.up, p.down, ends);
      if (ends.resolved > before) {
        if (o.reversed) keyedFlipped++;
        else keyedAsDrawn++;
        assets.push({ ...base, coords: o.coords, fromId: o.fromId, toId: o.toId, trust: 'id' });
        continue;
      }
      // keys that place nowhere still join lines naming the same node
      const asset = { ...base, fromId: o.fromId, toId: o.toId };
      assets.push(asset);
      keyless.push(asset);
      continue;
    }
    assets.push(base);
    keyless.push(base);
  }

  // lines no key can orient: as drawn, if keyed lines are mostly drawn in flow order and the ground agrees
  const box = boundaryBox(boundary);
  const ground = await openGround(box);
  let gDown = 0;
  let gUp = 0;
  for (const a of assets) {
    if (a.trust !== 'id') continue;
    const s = groundSign(ground, a.coords);
    if (s > 0) gDown++;
    else if (s < 0) gUp++;
  }
  let kDown = 0;
  let kUp = 0;
  for (const a of keyless) {
    const s = groundSign(ground, a.coords);
    if (s > 0) kDown++;
    else if (s < 0) kUp++;
  }
  const drawnShare = keyedAsDrawn / Math.max(1, keyedAsDrawn + keyedFlipped);
  const ok = keyedAsDrawn + keyedFlipped >= 20 && drawnShare >= DRAWN_OK;
  if (ok) for (const a of keyless) a.trust = 'digitized';
  settleKeys(assets, nodes, extra);
  extra['keyed.asDrawn'] = keyedAsDrawn;
  extra['keyed.flipped'] = keyedFlipped;
  extra['ground.keyed.downhill'] = gDown;
  extra['ground.keyed.uphill'] = gUp;
  extra['ground.keyless.downhill'] = kDown;
  extra['ground.keyless.uphill'] = kUp;
  extra['lines.keyless'] = keyless.length;
  extra['lines.pathGaps'] = gaps.n;
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');

  const notes = [
    `Keyed mains: UPSTREAMNODE -> DOWNSTREAMNODE is the flow order; ${keyedAsDrawn}/${keyedAsDrawn + keyedFlipped} (${pct(keyedAsDrawn, keyedAsDrawn + keyedFlipped)}) were already drawn that way`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${gDown}/${gDown + gUp} (${pct(gDown, gDown + gUp)}) keyed lines as oriented, and along ${kDown}/${kDown + kUp} (${pct(kDown, kDown + kUp)}) of the ${keyless.length} lines no key orients, as drawn`,
    `The ${keyless.length} lines no key orients are ${ok ? "'digitized' (kept as drawn)" : "'none'"}`,
    `SD-IO inlet/outfall nodes are not in the public service: ${extra['keys.placedWhereLinesMeet'] ?? 0} placed where the lines naming them meet, ${extra['keys.linesNeverMeet'] ?? 0} where they never meet`,
    "Mains: Pipe and High Flow Bypass -> pipe, Ditch and Flume -> ditch, Piped Watercourse -> stream-culvert, Open Watercourse -> stream (WATERCOURSETYPE kept as 'stream type ...')",
    "Catch basins: Type 1, Type 1-L, Yard Drain and Inlet are drains unless the lid is solid or buried; Type 2/MH, Unknown and Other only with a grate lid. BOTTOMPRESENT = false -> open bottom",
    "Discharge points: Outfall -> outfall 'water', Dry Well -> discharge 'ground', Unknown -> outfall 'unknown'",
    'owner: public = Mercer Island (incl. by easement), private = Private, other = WSDOT, MI School District, Shorewood, King County',
    'Dropped: ADDRESS, LOCATION, COMMENTS, UPDATEBY, DOCFETCH and condition fields (never requested); layer 3 (private mains) repeats layer 2',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Mercer Island',
    county: 'King',
    credit: 'Storm drain data: City of Mercer Island GIS, provided as is.',
    disclaimer: 'City of Mercer Island GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
    // the island's Np and Ns creeks are in the City's map, not the County's or NHD
    ownStreams: true,
  };
  return { assets, meta };
}

/** lon/lat box of the city outline, padded about 300 m */
export function boundaryBox(b: LonLat[][][]): [number, number, number, number] {
  const pts = b.flat(2);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - 0.004, Math.min(...ys) - 0.003, Math.max(...xs) + 0.004, Math.max(...ys) + 0.003];
}

if (isMain(import.meta.url)) await runCli(KEY, buildMercerIsland);
