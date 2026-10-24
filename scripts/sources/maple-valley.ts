// City of Maple Valley storm drains (Cityworks SWM service) -> <cache>/sources/maple-valley/{assets.ndjson,meta.json}.
// About a quarter of the pipes name their end structures (UpstreamFacilityID -> DownstreamFacilityID = flow order).
// The rest are kept as drawn when the keyed lines show the city draws pipes in flow order and the ground agrees.
// node scripts/sources/maple-valley.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  num,
  orientByKeys,
  outerRings,
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
  type RunOptions,
} from './bellevue.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'maple-valley';
const BASE = 'https://gis.maplevalleywa.gov/arcgis2/rest/services/Cityworks/SWM/MapServer';
const GEOID = '5343150';
const LIVE = "LifecycleStatus IS NULL OR LifecycleStatus = 'Active'";
const PT = ['OBJECTID', 'FacilityID', 'LifecycleStatus', 'AdministrativeArea'];
const LN = [...PT, 'SubtypeCD', 'Diameter', 'UpstreamFacilityID', 'UpstreamInvert', 'DownstreamFacilityID', 'DownstreamInvert'];
const POLY = ['OBJECTID', 'FacilityID', 'LifecycleStatus', 'AdministrativeArea'];

const layers = {
  pumps: { name: 'pumps', url: `${BASE}/0`, fields: PT, where: LIVE },
  drains: { name: 'drains', url: `${BASE}/1`, fields: [...PT, 'SubtypeCD', 'GrateType'], where: LIVE },
  wells: { name: 'wells', url: `${BASE}/2`, fields: [...PT, 'SubtypeCD'], where: LIVE },
  cleanouts: { name: 'cleanouts', url: `${BASE}/3`, fields: PT, where: LIVE },
  separators: { name: 'separators', url: `${BASE}/4`, fields: PT, where: LIVE },
  filters: { name: 'filters', url: `${BASE}/5`, fields: PT, where: LIVE },
  filterra: { name: 'filterra', url: `${BASE}/37`, fields: ['OBJECTID', 'FacilityID', 'Lifecycle'] },
  catchBasins: { name: 'catch-basins', url: `${BASE}/6`, fields: [...PT, 'SubtypeCD', 'GrateType'], where: LIVE },
  control: { name: 'control', url: `${BASE}/7`, fields: PT, where: LIVE },
  cds: { name: 'cds', url: `${BASE}/8`, fields: [...PT, 'GrateType'], where: LIVE },
  inlets: { name: 'inlets', url: `${BASE}/12`, fields: [...PT, 'SubtypeCD'], where: LIVE },
  outlets: { name: 'outlets', url: `${BASE}/13`, fields: [...PT, 'SubtypeCD'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/14`, fields: [...PT, 'SinkType'], where: LIVE },
  manholes: { name: 'manholes', url: `${BASE}/15`, fields: PT, where: LIVE },
  channels: { name: 'channels', url: `${BASE}/16`, fields: LN, where: LIVE },
  tanks: { name: 'tanks', url: `${BASE}/17`, fields: LN, where: LIVE },
  pipes: { name: 'pipes', url: `${BASE}/19`, fields: [...LN, 'WaterBody'], where: LIVE },
  modular: { name: 'modular-wetlands', url: `${BASE}/11`, fields: ['OBJECTID', 'FacilityID'] },
  detention: { name: 'detention-vaults', url: `${BASE}/21`, fields: POLY, where: LIVE },
  filtration: { name: 'filtration-vaults', url: `${BASE}/22`, fields: POLY, where: LIVE },
  infiltration: { name: 'infiltration-vaults', url: `${BASE}/23`, fields: POLY, where: LIVE },
  wet: { name: 'wet-vaults', url: `${BASE}/24`, fields: POLY, where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/25`, fields: [...POLY, 'Pond_Type'], where: LIVE },
  galleries: { name: 'galleries', url: `${BASE}/27`, fields: POLY, where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function mvOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s) return undefined;
  if (s === 'COMV' || s === 'City of Maple Valley') return 'public';
  if (s === 'PRVT' || s === 'PVT' || s === 'Private System') return 'private';
  return 'other';
}

const WATER_SINKS: Record<string, string> = { Stream: 'stream', Wetlands: 'wetland', Lake: 'lake' };

export async function buildMapleValley(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`maple-valley ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 2000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.04, 47.37]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.FacilityID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: mvOwner(f.attributes.AdministrativeArea), ...more });
  };
  const solid = (a: Attrs) => str(a.GrateType) === 'Solid';

  for (const f of L.catchBasins) {
    const a = f.attributes;
    // 4 = Stormceptor (a treatment unit)
    point('catchBasins', f, solid(a) || num(a.SubtypeCD) === 4 ? 'junction' : 'drain');
  }
  for (const f of L.drains) {
    const a = f.attributes;
    // 2 = roof drain: house water, not street water
    point('drains', f, solid(a) || num(a.SubtypeCD) === 2 ? 'junction' : 'drain');
  }
  for (const f of L.cds) point('cds', f, solid(f.attributes) ? 'junction' : 'drain');
  // 2 = curb inlet; 1 = headwall (a ditch or pond into a pipe)
  for (const f of L.inlets) point('inlets', f, num(f.attributes.SubtypeCD) === 2 ? 'drain' : 'junction');
  // 0 = dry well
  for (const f of L.wells) point('wells', f, 'junction', num(f.attributes.SubtypeCD) === 0 ? { openBottom: true } : {});
  for (const f of L.outfalls) {
    const sink = str(f.attributes.SinkType);
    const water = WATER_SINKS[sink];
    point('outfalls', f, 'outfall', water ? { endHint: 'water', receivingHint: water } : { endHint: 'unknown', receivingHint: sink ? sink.toLowerCase() : undefined });
  }
  // outlets and endwalls: a pipe's open end into a pond, ditch or swale
  for (const f of L.outlets) point('outlets', f, 'outfall', { endHint: 'unknown' });
  for (const layer of ['manholes', 'cleanouts', 'separators', 'filters', 'control', 'pumps'] as const) for (const f of L[layer]) point(layer, f, 'junction');
  for (const f of L.filterra) {
    const life = str(f.attributes.Lifecycle);
    if (life && life !== 'Active') continue;
    point('filterra', f, 'junction');
  }

  const facility = (layer: LayerName, role: Role) => {
    for (const f of L[layer]) {
      const rings = outerRings(f.geometry);
      if (!rings.length) {
        inc('skipped.noGeometry');
        continue;
      }
      const t = str(f.attributes.Pond_Type);
      const r: Role = layer === 'ponds' ? (t === 'Infiltration Pond' || t === 'Bioretention Pond' ? 'facility-infiltrate' : 'facility-hold') : role;
      for (const ring of rings) assets.push({ role: r, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none', owner: mvOwner(f.attributes.AdministrativeArea) });
    }
  };
  facility('detention', 'facility-hold');
  facility('filtration', 'facility-hold');
  facility('wet', 'facility-hold');
  facility('modular', 'facility-hold');
  facility('infiltration', 'facility-infiltrate');
  facility('galleries', 'facility-infiltrate');
  facility('ponds', 'facility-hold');

  // lines
  const gaps = { n: 0 };
  const loose: { layer: string; asset: SourceAsset }[] = [];
  const keyed: Record<string, { asDrawn: number; flipped: number }> = {};
  // keyed lines: is UpstreamInvert above DownstreamInvert?
  let invAgree = 0;
  let invDisagree = 0;
  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset>) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const up = num(a.UpstreamInvert);
    const down = num(a.DownstreamInvert);
    const base: SourceAsset = {
      role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: mvOwner(a.AdministrativeArea),
      upInv: toM(up, FT), downInv: toM(down, FT), ...more,
    };
    const upId = str(a.UpstreamFacilityID);
    const downId = str(a.DownstreamFacilityID);
    if (upId || downId) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, coords, upId, downId, ends);
      if (ends.resolved > before) {
        const k = (keyed[layer] ??= { asDrawn: 0, flipped: 0 });
        if (o.reversed) k.flipped++;
        else k.asDrawn++;
        if (up > 0 && down > 0 && up !== down) up > down ? invAgree++ : invDisagree++;
        assets.push({ ...base, coords: o.coords, fromId: o.fromId, toId: o.toId, trust: 'id' });
        return;
      }
      base.fromId = o.fromId;
      base.toId = o.toId;
    }
    assets.push(base);
    loose.push({ layer, asset: base });
  };

  const PIPE_ROLES: Record<number, Role> = { 2: 'culvert', 3: 'culvert' };
  for (const f of L.pipes) {
    const a = f.attributes;
    const st = num(a.SubtypeCD);
    const stream = !!str(a.WaterBody);
    line('pipes', f, stream ? 'stream-culvert' : (PIPE_ROLES[st] ?? 'pipe'), {
      width: toM(num(a.Diameter), IN), perforated: st === 5 || undefined, liveStream: stream || undefined,
      receivingHint: stream ? str(a.WaterBody) : undefined,
    });
  }
  // detention and infiltration tanks (2 = infiltration)
  for (const f of L.tanks) line('tanks', f, 'pipe', { width: toM(num(f.attributes.Diameter), IN), perforated: num(f.attributes.SubtypeCD) === 2 || undefined });
  for (const f of L.channels) {
    const st = num(f.attributes.SubtypeCD);
    // 3 = stream; 2 = infiltration channel
    line('channels', f, st === 3 ? 'stream' : 'ditch', { liveStream: st === 3 || undefined, perforated: st === 2 || undefined });
  }

  // lines no key orients: as drawn, if the keyed ones are mostly drawn in flow order
  const ground = await openGround(boundaryBox(boundary));
  const sign = (list: SourceAsset[]) => {
    let d = 0;
    let u = 0;
    for (const a of list) {
      const s = groundSign(ground, a.coords);
      if (s > 0) d++;
      else if (s < 0) u++;
    }
    return { d, u };
  };
  const notes: string[] = [];
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const allKeyed = Object.values(keyed).reduce((s, k) => ({ asDrawn: s.asDrawn + k.asDrawn, flipped: s.flipped + k.flipped }), { asDrawn: 0, flipped: 0 });
  const gk = sign(assets.filter((a) => a.trust === 'id'));
  notes.push(
    `Keyed lines (UpstreamFacilityID -> DownstreamFacilityID): ${allKeyed.asDrawn}/${allKeyed.asDrawn + allKeyed.flipped} (${pct(allKeyed.asDrawn, allKeyed.asDrawn + allKeyed.flipped)}) already drawn in flow order; ${Object.entries(keyed).map(([l, k]) => `${l} ${k.asDrawn}/${k.asDrawn + k.flipped}`).join(', ')}`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${gk.d}/${gk.d + gk.u} (${pct(gk.d, gk.d + gk.u)}) keyed lines as oriented`,
    `Keyed lines with two inverts: UpstreamInvert is above DownstreamInvert on ${invAgree} and below on ${invDisagree}`,
  );
  extra['keyed.asDrawn'] = allKeyed.asDrawn;
  extra['keyed.flipped'] = allKeyed.flipped;
  extra['ground.keyed.downhill'] = gk.d;
  extra['ground.keyed.uphill'] = gk.u;
  const drawnOk = allKeyed.asDrawn + allKeyed.flipped >= 20 && allKeyed.asDrawn / (allKeyed.asDrawn + allKeyed.flipped) >= DRAWN_OK;
  for (const layer of ['pipes', 'tanks', 'channels']) {
    const list = loose.filter((l) => l.layer === layer).map((l) => l.asset);
    const g = sign(list);
    // a layer is kept as drawn if keyed lines say so and its own lines run downhill about as often as keyed ones do
    const ok = drawnOk && (g.d + g.u < 20 || g.d / (g.d + g.u) >= 0.75);
    if (ok) for (const a of list) a.trust = 'digitized';
    extra[`ground.${layer}.unkeyed.downhill`] = g.d;
    extra[`ground.${layer}.unkeyed.uphill`] = g.u;
    extra[`lines.${layer}.unkeyed`] = list.length;
    notes.push(`${layer}: ${list.length} lines no key orients; the ground falls along ${g.d}/${g.d + g.u} (${pct(g.d, g.d + g.u)}) as drawn; ${ok ? "'digitized' (kept as drawn)" : "'none'"}`);
  }
  settleKeys(assets, nodes, extra);
  extra['lines.pathGaps'] = gaps.n;
  notes.push(
    'Catch basins, area/yard drains, CDS units and curb inlets are drains unless the grate is Solid; Stormceptors, roof drains and headwall inlets are junctions. Dry wells have an open bottom',
    "Outfalls: SinkType Stream, Wetlands, Lake -> 'water'; Detention Facility, Ditch and blank -> 'unknown'. Outlets and endwalls -> outfall 'unknown' (the walk goes on where the map does)",
    'Pipes: Collector, Detention, Unknown -> pipe; Culvert, Driveway Culvert -> culvert; Infiltration -> perforated; WaterBody set -> stream-culvert. Open channels: Stream -> stream, Infiltration -> perforated ditch, the rest -> ditch',
    'Ponds: Detention Pond -> facility-hold, Infiltration and Bioretention Pond -> facility-infiltrate; detention, filtration and wet vaults and modular wetlands -> hold; infiltration vaults and galleries -> infiltrate',
    'owner: public = COMV, private = PRVT, other = King County, Soos Creek Water District',
    'Only Active (or blank) features. Dropped: LocationDescription, Notes, FacilityName, FacilityAddress, PIN, as-built and project fields (never requested); downspout connections not used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Maple Valley',
    county: 'King',
    credit: 'Storm drain data: City of Maple Valley GIS, provided as is.',
    disclaimer: 'City of Maple Valley GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildMapleValley);
