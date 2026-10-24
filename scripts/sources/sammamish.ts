// City of Sammamish storm drains -> <cache>/sources/sammamish/{assets.ndjson,meta.json}.
// No from/to IDs: lines join by geometry. Pipes and ditches carry From/To invert elevations; where both
// are set, the drawn order is checked against them. The ground (USGS 3DEP) is the independent check of
// which one is right where they disagree, and of the drawn order where no inverts exist.
// node scripts/sources/sammamish.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import { DEM_DIR } from '../terrain/config.ts';
import { Dem, tilesFor } from '../terrain/dem.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  invertSign,
  isMain,
  lineOf,
  newEnds,
  num,
  outerRings,
  pointOf,
  rawDirFor,
  runCli,
  str,
  summarize,
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';

const KEY = 'sammamish';
const BASE = 'https://maps.sammamishwa.gov/arcgis/rest/services/cityworks/cwStorm/MapServer';
const GEOID = '5361115';
const LIVE = "Status IS NULL OR Status <> 'Retired'";

const PIPE = ['OBJECTID', 'Pipe_ID', 'Status', 'PipeType', 'PipeDiameter', 'Width', 'PerfYN', 'FromInvertElev', 'ToInvertElev', 'OwnedBy'];
const VAULT = ['OBJECTID', 'Vault_ID', 'Status', 'VaultType', 'OwnedBy'];
// the Cityworks copy of the storm map: the public 'storm' service leaves out most lines' and all polygons' shapes
const layers = {
  pipes: { name: 'pipes', url: `${BASE}/30`, fields: PIPE, where: LIVE },
  ditches: { name: 'ditches', url: `${BASE}/12`, fields: ['OBJECTID', 'Channel_ID', 'Status', 'ChannelType', 'FromInvertElev', 'ToInvertElev', 'OwnedBy'], where: LIVE },
  structures: { name: 'structures', url: `${BASE}/21`, fields: ['OBJECTID', 'Structure_ID', 'Status', 'StructureType', 'GrateCoverType', 'MHLidType', 'OwnedBy'], where: LIVE },
  nodes: { name: 'nodes', url: `${BASE}/6`, fields: ['OBJECTID', 'StormNode_ID', 'Status', 'StormNodeType', 'WatSource', 'WatName', 'OwnedBy'], where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/14`, fields: ['OBJECTID', 'Pond_ID', 'Status', 'PondType', 'OwnedBy'], where: LIVE },
  vaults: { name: 'vaults', url: `${BASE}/35`, fields: VAULT, where: LIVE },
  filterVaults: { name: 'filter-vaults', url: `${BASE}/36`, fields: VAULT, where: LIVE },
  lid: { name: 'lid', url: `${BASE}/17`, fields: ['OBJECTID', 'LID_ID', 'Status', 'LID_Type', 'OwnedBy'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function sammamishOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (s === 'Sammamish' || s === 'Public') return 'public';
  if (s === 'Private') return 'private';
  if (s === 'King County') return 'other';
  return undefined;
}

const SOLID = new Set(['Solid', 'Solid Round', 'Solid Square', 'Solid Lid']);
const INLETS = /^(CB|I\b|I-|Inlet|Area Drain|Yard Drain|Nyloplast|Filterra|Drywell)/;
/** pipe ends that let water out onto the ground */
const SURFACE_OUT = new Set(['Pop-Up Emitter', 'Splash Block']);
const WATER = new Set(['Stream', 'Lake', 'Wetland', 'Piped stream', 'Other receiving water']);
/** LID types that soak water in */
const LID_SOAK = new Set(['Infiltration Trench', 'Dispersion Trench', 'Pervious Pavement', 'Drywell', 'Drywell for Roof', 'Rain Garden']);

/** ground elevation must change at least this much (m) along a line for the ground check */
const GROUND_MIN_M = 1;

export async function buildSammamish(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`sammamish ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs, field?: string) => (field && str(a[field])) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const ID: Partial<Record<LayerName, string>> = { ponds: 'Pond_ID', vaults: 'Vault_ID', filterVaults: 'Vault_ID', lid: 'LID_ID' };

  const point = (layer: LayerName, f: EsriFeature, field: string, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes, field), src: KEY, coords: [at], trust: 'none', owner: sammamishOwner(f.attributes.OwnedBy), ...more });
    inc(`points.${role}`);
  };

  for (const f of L.structures) {
    const a = f.attributes;
    const t = str(a.StructureType);
    const solid = SOLID.has(str(a.GrateCoverType)) || str(a.MHLidType) === 'Solid Locking Lid';
    if (SURFACE_OUT.has(t)) point('structures', f, 'Structure_ID', 'discharge', { endHint: 'ground', receivingHint: 'dispersion onto the ground' });
    else if (t === 'Drywell') point('structures', f, 'Structure_ID', solid ? 'junction' : 'drain', { openBottom: true });
    else if (INLETS.test(t)) point('structures', f, 'Structure_ID', solid ? 'junction' : 'drain');
    // type not recorded, but a grate is
    else if (!/^(MH|Manhole|Cleanout)/.test(t) && str(a.GrateCoverType) && !solid) point('structures', f, 'Structure_ID', 'drain');
    else point('structures', f, 'Structure_ID', 'junction');
  }
  for (const f of L.nodes) {
    const a = f.attributes;
    const t = str(a.StormNodeType);
    const src = str(a.WatSource);
    const name = str(a.WatName);
    const water = { endHint: 'water', receivingHint: name || src.toLowerCase() || undefined };
    if (t === 'Outfall' || t === 'Priv_Outfall') point('nodes', f, 'StormNode_ID', 'outfall', water);
    else if (t === 'Possible_Outfall' || t === 'End') {
      if (WATER.has(src)) point('nodes', f, 'StormNode_ID', 'outfall', water);
      else point('nodes', f, 'StormNode_ID', 'outfall', t === 'End' ? { endHint: 'end' } : { endHint: 'unknown' });
    }
    // into a pond, vault or other facility: the walk goes on where the map does
    else if (/DischargePoint|Possible_DP/.test(t)) point('nodes', f, 'StormNode_ID', 'discharge', { endHint: 'unknown', receivingHint: 'stormwater facility' });
    else if (t === 'Outlet' || /^Rock Pad/.test(t)) point('nodes', f, 'StormNode_ID', 'outfall', { endHint: 'unknown' });
    else point('nodes', f, 'StormNode_ID', 'junction');
  }

  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes, ID[layer]);
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: sammamishOwner(f.attributes.OwnedBy) });
    inc(`facilities.${role}`);
  };
  for (const f of L.ponds) polygon('ponds', f, str(f.attributes.PondType) === 'Infiltration' ? 'facility-infiltrate' : 'facility-hold');
  for (const f of L.vaults) polygon('vaults', f, 'facility-hold');
  for (const f of L.filterVaults) polygon('filterVaults', f, 'facility-hold');
  for (const f of L.lid) if (LID_SOAK.has(str(f.attributes.LID_Type))) polygon('lid', f, 'facility-infiltrate');

  // lines as drawn; inverts and the ground decide below
  type Line = { asset: SourceAsset; from: number; to: number; group: 'invertsAgree' | 'invertsDisagree' | 'noInverts' };
  const lines: Line[] = [];
  const gaps = { n: 0 };
  const line = (layer: LayerName, f: EsriFeature, field: string, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const from = num(a.FromInvertElev);
    const to = num(a.ToInvertElev);
    const s = invertSign(from, to);
    const asset: SourceAsset = { role, id: idOf(layer, a, field), src: KEY, coords, trust: 'none', owner: sammamishOwner(a.OwnedBy), ...more };
    assets.push(asset);
    lines.push({ asset, from, to, group: s > 0 ? 'invertsAgree' : s < 0 ? 'invertsDisagree' : 'noInverts' });
  };
  const width = (a: Attrs) => {
    const d = num(a.PipeDiameter) || num(a.Width);
    return d > 0 ? Math.round(d * IN * 1000) / 1000 : undefined;
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    const t = str(a.PipeType);
    const perforated = str(a.PerfYN) === 'Y' || /^PERF/i.test(t);
    line('pipes', f, 'Pipe_ID', t === 'Culvert' ? 'culvert' : 'pipe', { width: width(a), perforated: perforated || undefined });
  }
  for (const f of L.ditches) line('ditches', f, 'Channel_ID', 'ditch');

  // the ground at both ends of each line, where it changes enough to say which way is down
  const box = boundary.flat(2).reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const dem = await Dem.open(tilesFor([box[0] - 0.02, box[1] - 0.02, box[2] + 0.02, box[3] + 0.02]), DEM_DIR);
  const ground = async (p: LonLat) => (await dem.window(Dem.rowOf(p[1]), Dem.colOf(p[0]), 1, 1))[0];
  const check: Record<string, { down: number; up: number }> = {};
  const groundSays = new Map<SourceAsset, boolean>();
  for (const l of lines) {
    const c = l.asset.coords;
    const g0 = await ground(c[0]);
    const g1 = await ground(c[c.length - 1]);
    if (!Number.isFinite(g0) || !Number.isFinite(g1) || Math.abs(g0 - g1) < GROUND_MIN_M) continue;
    groundSays.set(l.asset, g0 > g1);
    const k = `${l.asset.role === 'ditch' ? 'ditch' : 'pipe'}.${l.group}`;
    const d = (check[k] ??= { down: 0, up: 0 });
    if (g0 > g1) d.down++;
    else d.up++;
  }
  await dem.close();
  const share = (k: string) => {
    const d = check[k] ?? { down: 0, up: 0 };
    return d.down + d.up ? d.down / (d.down + d.up) : 0;
  };

  // The ground runs downhill along most pipes but not all. Lines whose inverts agree with the drawing show how
  // often (q). Where the inverts disagree, the share drawn downhill on the ground (s) mixes lines drawn right
  // (downhill q of the time) and lines drawn wrong (1 - q): the drawing is right on (s - (1 - q)) / (2q - 1).
  const q = share('pipe.invertsAgree');
  const drawnRight = Math.min(1, Math.max(0, (share('pipe.invertsDisagree') - (1 - q)) / Math.max(0.01, 2 * q - 1)));

  // Inverts that agree with the drawing: 'inverts'. Inverts that disagree: the ground at the line decides
  // where it changes enough; elsewhere the side that is right more often (drawnRight). No inverts: drawn
  // order, 'digitized' when the lines with both inverts show the drawing runs downhill (DRAWN_OK).
  const drawn = { down: 0, up: 0 };
  for (const l of lines) l.group === 'invertsAgree' ? drawn.down++ : l.group === 'invertsDisagree' ? drawn.up++ : 0;
  const drawnShare = drawn.down / Math.max(1, drawn.down + drawn.up);
  const drawnOk = drawn.down + drawn.up >= 20 && drawnShare >= DRAWN_OK;
  const m = (ft: number) => Math.round(ft * FT * 1000) / 1000;
  for (const l of lines) {
    const a = l.asset;
    if (l.group === 'invertsAgree') {
      a.trust = 'inverts';
      [a.upInv, a.downInv] = [m(l.from), m(l.to)];
    } else if (l.group === 'invertsDisagree') {
      const g = groundSays.get(a);
      const keep = g ?? drawnRight >= 0.5;
      if (keep) {
        a.trust = g !== undefined || drawnRight >= DRAWN_OK ? 'digitized' : 'none';
        inc(g !== undefined ? 'lines.keptByGround' : 'lines.keptAsDrawn');
      } else {
        a.coords = [...a.coords].reverse();
        a.trust = 'inverts';
        [a.upInv, a.downInv] = [m(l.to), m(l.from)];
        inc(g !== undefined ? 'lines.reversedByGround' : 'lines.reversedToInverts');
      }
    } else if (drawnOk) a.trust = 'digitized';
  }

  for (const g of ['invertsAgree', 'invertsDisagree', 'noInverts']) {
    extra[`lines.${g}`] = lines.filter((l) => l.group === g).length;
    for (const kind of ['pipe', 'ditch']) {
      extra[`groundCheck.${kind}.${g}.down`] = check[`${kind}.${g}`]?.down ?? 0;
      extra[`groundCheck.${kind}.${g}.up`] = check[`${kind}.${g}`]?.up ?? 0;
    }
  }
  extra['lines.pathGaps'] = gaps.n;
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const said = (k: string) => `${check[k]?.down ?? 0}/${(check[k]?.down ?? 0) + (check[k]?.up ?? 0)} (${pct(share(k))})`;
  const notes = [
    `Inverts: From > To (drawn downhill) on ${drawn.down} of ${drawn.down + drawn.up} lines with both set (${pct(drawnShare)}); ${extra['lines.noInverts']} lines have none`,
    `Ground check (3DEP, ends ${GROUND_MIN_M} m or more apart; share drawn downhill): pipes with agreeing inverts ${said('pipe.invertsAgree')}, disagreeing ${said('pipe.invertsDisagree')}, none ${said('pipe.noInverts')}; ditches ${said('ditch.invertsAgree')}, ${said('ditch.invertsDisagree')}, ${said('ditch.noInverts')}`,
    `Disagreeing inverts: the drawing is right on about ${pct(drawnRight)}; by the ground at the line ${extra['lines.keptByGround'] ?? 0} kept, ${extra['lines.reversedByGround'] ?? 0} reversed; elsewhere ${extra['lines.keptAsDrawn'] ?? 0} kept as drawn, ${extra['lines.reversedToInverts'] ?? 0} reversed to the inverts; no inverts: ${drawnOk ? "'digitized'" : "'none'"}`,
    'Structures: catch basins, inlets, area and yard drains with a grate are drains; solid lids are junctions; drywells soak in; pop-up emitters and splash blocks let water out onto the ground',
    "Storm nodes: outfalls (city and private) -> 'water'; possible outfalls and ends -> 'water' where WatSource is a stream, lake or wetland; discharge points (into a stormwater facility) and outlets -> the walk goes on",
    'Facilities: ponds (infiltration ponds soak in), vaults, filter vaults; LID infiltration and dispersion trenches, pervious pavement, drywells and rain gardens soak in (swales, flow paths and other LID left out)',
    "Source: the city's Cityworks storm service (cityworks/cwStorm); the public stormwater/storm service returns no shapes for culverts, minor drains, ditches or facilities",
    'owner: public = Sammamish/Public, private = Private, other = King County',
    'Dropped: Notes, Location, names, Storm Facilities (addresses and owner contacts), editor fields (never requested); streams come from King County',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Sammamish',
    county: 'King',
    credit: 'Storm drain data: City of Sammamish GIS, provided as is.',
    disclaimer: 'City of Sammamish data, information and maps are provided as is, without warranty or any representation of accuracy, timeliness or completeness.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildSammamish);
