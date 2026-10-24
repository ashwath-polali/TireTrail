// City of SeaTac storm drains -> <cache>/sources/seatac/{assets.ndjson,meta.json}.
// An Esri stormwater utility network model: lines name their end points (UpAsset -> DownAsset is the flow order),
// and some carry up and down elevations (ElevUp/ElevDown). The ground (USGS 3DEP) is the independent check.
// node scripts/sources/seatac.ts [--refresh] [--box=w,s,e,n]
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
import { boundaryBox } from './mercer-island.ts';

const KEY = 'seatac';
const BASE = 'https://data.seatacwa.gov/arcgis/rest/services/StormwaterInfrastructure/FeatureServer';
const GEOID = '5362288';
const LIVE = "LifeStatus = 'In Service' OR LifeStatus IS NULL";

const layers = {
  inlets: { name: 'inlets', url: `${BASE}/0`, fields: ['OBJECTID', 'AssetID', 'StrucType', 'LidType', 'LifeStatus', 'OwnedBy'], where: LIVE },
  devices: { name: 'devices', url: `${BASE}/1`, fields: ['OBJECTID', 'AssetID', 'StrucType', 'DeviceType', 'LifeStatus', 'OwnedBy'], where: LIVE },
  sites: { name: 'sites', url: `${BASE}/2`, fields: ['OBJECTID', 'AssetID', 'StrucType', 'Infiltration', 'LifeStatus', 'OwnedBy'], where: LIVE },
  junctions: { name: 'junctions', url: `${BASE}/3`, fields: ['OBJECTID', 'AssetID', 'StrucType', 'LifeStatus', 'OwnedBy'], where: LIVE },
  lines: { name: 'lines', url: `${BASE}/4`, fields: ['OBJECTID', 'AssetID', 'UpAsset', 'DownAsset', 'Subtype', 'StrucType', 'LifeStatus', 'OwnedBy', 'Size', 'Perforated', 'ElevUp', 'ElevDown'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function seatacOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s || s === 'Unknown') return undefined;
  if (s === 'SeaTac') return 'public';
  if (s === 'Private') return 'private';
  return 'other';
}

const GRATES = new Set(['Beehive', 'Bisected', 'Bi Vanned', 'Bi Vaned Grate', 'Combination', 'Herring Bone', 'Slotted', 'Slotted Grate', 'Vanned', 'CMB Grate', 'Grated Other', 'Rolled']);
const INLETS = new Set(['CB Type 1', 'CB Type 1L', 'CB Type 2', 'CB Type 3', 'CB', 'Curb Inlet', 'Yard / Area Drain', 'Slot / Trench Drain', 'Scupper']);
const SOAK_SITES = new Set(['Dry Well', 'Permeable Pavement', 'Rain Garden']);

/** an inlet takes street water unless its lid is solid; manholes and unknowns only with a grate */
export function inletRole(type: string, lid: string): Role {
  if (INLETS.has(type)) return lid === 'Solid' ? 'junction' : 'drain';
  if (type === 'Downspout' || type === 'Open Pipe') return 'junction';
  return GRATES.has(lid) ? 'drain' : 'junction';
}

/** line types: Subtype 1 pipe, 2 culvert, 3 channel, 4 flowline */
export function lineRole(subtype: number, type: string): { role: Role; perforated?: boolean } | null {
  if (type === 'Natural Watercourse') return { role: 'stream' };
  if (type === 'Infiltration Trench') return { role: 'pipe', perforated: true };
  if (subtype === 2 || /Culvert/.test(type)) return { role: 'culvert' };
  if (subtype === 3) return { role: 'ditch' };
  // flowlines and inferred lines: the model's links where no pipe is mapped
  if (subtype === 4 || type === 'Inferred') return { role: 'virtual' };
  if (subtype === 1) return { role: 'pipe' };
  return null;
}

export async function buildSeatac(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`seatac ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.29, 47.44]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.AssetID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: seatacOwner(f.attributes.OwnedBy), ...more });
    inc(`points.${layer}.${role}`);
  };

  for (const f of L.inlets) point('inlets', f, inletRole(str(f.attributes.StrucType), str(f.attributes.LidType)));
  for (const f of L.junctions) point('junctions', f, 'junction');
  for (const f of L.devices) {
    const t = str(f.attributes.StrucType);
    if (t === 'Outfall') point('devices', f, 'outfall', { endHint: 'water' });
    else if (t === 'Discharge' && str(f.attributes.DeviceType) === 'Level Spreader') point('devices', f, 'discharge', { endHint: 'ground', receivingHint: 'dispersion onto the ground' });
    // outlets into ponds and swales, other discharge points: the walk goes on where the map does
    else if (t === 'Outlet' || t === 'Discharge') point('devices', f, 'outfall', { endHint: 'unknown' });
    else point('devices', f, 'junction');
  }
  for (const f of L.sites) {
    const a = f.attributes;
    const soaks = SOAK_SITES.has(str(a.StrucType)) || str(a.Infiltration) === 'Yes';
    point('sites', f, soaks ? 'facility-infiltrate' : 'facility-hold');
  }

  // lines, oriented by their end keys
  const gaps = { n: 0 };
  const keyless: SourceAsset[] = [];
  let asDrawn = 0;
  let flipped = 0;
  const inv = { agree: 0, disagree: 0 };
  for (const f of L.lines) {
    const a = f.attributes;
    const spec = lineRole(num(a.Subtype), str(a.StrucType));
    if (!spec) {
      inc(`skipped.lineType.${str(a.StrucType) || 'blank'}`);
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const r = spec.role;
    const up = num(a.ElevUp);
    const down = num(a.ElevDown);
    const base: SourceAsset = {
      role: r, id: idOf('lines', a), src: KEY, coords, trust: 'none', owner: seatacOwner(a.OwnedBy),
      width: r === 'pipe' || r === 'culvert' ? toM(num(a.Size), IN) : undefined, perforated: spec.perforated || str(a.Perforated) === 'Yes' || undefined,
      liveStream: r === 'stream' || undefined,
    };
    const upId = str(a.UpAsset);
    const downId = str(a.DownAsset);
    inc(`lines.${str(a.StrucType) || 'blank'}`);
    if (upId || downId) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, coords, upId, downId, ends);
      const asset = { ...base, coords: o.coords, fromId: o.fromId, toId: o.toId };
      if (ends.resolved > before) {
        if (o.reversed) flipped++;
        else asDrawn++;
        asset.trust = 'id';
        // the elevations are the independent check of the keys
        if (up > 0 && down > 0 && Math.abs(up - down) >= 0.01) {
          if (up > down) inv.agree++;
          else inv.disagree++;
          [asset.upInv, asset.downInv] = [toM(up, FT), toM(down, FT)];
        }
        assets.push(asset);
        continue;
      }
      assets.push(asset);
      keyless.push(asset);
      continue;
    }
    assets.push(base);
    keyless.push(base);
  }

  // lines no key orients: as drawn, if keyed lines are mostly drawn in flow order
  const ground = await openGround(boundaryBox(boundary));
  const g = { keyedDown: 0, keyedUp: 0, keylessDown: 0, keylessUp: 0 };
  for (const a of assets) {
    if (a.trust !== 'id' || a.role === 'virtual') continue;
    const s = groundSign(ground, a.coords);
    if (s > 0) g.keyedDown++;
    else if (s < 0) g.keyedUp++;
  }
  for (const a of keyless) {
    const s = groundSign(ground, a.coords);
    if (s > 0) g.keylessDown++;
    else if (s < 0) g.keylessUp++;
  }
  const drawnShare = asDrawn / Math.max(1, asDrawn + flipped);
  const ok = asDrawn + flipped >= 20 && drawnShare >= DRAWN_OK;
  if (ok) for (const a of keyless) a.trust = 'digitized';
  settleKeys(assets, nodes, extra);
  // an outfall a mapped line leaves (into a swale or channel): the walk goes on
  const leaving = new Set(assets.filter((a) => a.fromId && a.coords.length > 1).map((a) => a.fromId));
  for (const a of assets) {
    if (a.role === 'outfall' && a.endHint === 'water' && a.key && leaving.has(a.key)) {
      a.endHint = 'unknown';
      inc('outfalls.lineLeaves');
    }
  }
  Object.assign(extra, {
    'keyed.asDrawn': asDrawn, 'keyed.flipped': flipped, 'keyed.elevAgree': inv.agree, 'keyed.elevDisagree': inv.disagree,
    'ground.keyed.downhill': g.keyedDown, 'ground.keyed.uphill': g.keyedUp, 'ground.keyless.downhill': g.keylessDown, 'ground.keyless.uphill': g.keylessUp,
    'lines.keyless': keyless.length, 'lines.pathGaps': gaps.n,
  });
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');

  const notes = [
    `Keyed lines: UpAsset -> DownAsset is the flow order; ${asDrawn}/${asDrawn + flipped} (${pct(asDrawn, asDrawn + flipped)}) were already drawn that way`,
    `ElevUp/ElevDown (ft) fall from the up key to the down key on ${inv.agree}/${inv.agree + inv.disagree} (${pct(inv.agree, inv.agree + inv.disagree)}) keyed lines that carry both`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${g.keyedDown}/${g.keyedDown + g.keyedUp} (${pct(g.keyedDown, g.keyedDown + g.keyedUp)}) keyed lines as oriented, and along ${g.keylessDown}/${g.keylessDown + g.keylessUp} (${pct(g.keylessDown, g.keylessDown + g.keylessUp)}) of the ${keyless.length} lines no key orients, as drawn`,
    `The ${keyless.length} lines no key orients are ${ok ? "'digitized' (kept as drawn)" : "'none'"}`,
    'Lines: Gravity Main, Lateral and Force Main -> pipe; Infiltration Trench -> perforated pipe; culverts -> culvert; Bioswale and Artificial Watercourse -> ditch; Natural Watercourse -> stream; Flowline and Inferred -> virtual',
    'Inlets: catch basins, curb inlets, yard/area drains, slot drains and scuppers are drains unless the lid is solid; manholes, Other and Unknown only with a grate lid; downspouts and open pipes are junctions',
    `Devices: Outfall -> outfall 'water' (${extra['outfalls.lineLeaves'] ?? 0} that a mapped line leaves -> 'unknown', the walk goes on); Discharge with a level spreader -> discharge 'ground'; Outlet and other Discharge -> outfall 'unknown' (the walk goes on where the map does); BMP connections and pumps -> junctions`,
    'Structure sites (points): dry wells, permeable pavement, rain gardens and those marked Infiltration = Yes soak in; the rest hold water',
    'owner: public = SeaTac, private = Private, other = Port of Seattle, WSDOT, Joint, Other. The Port of Seattle airfield system is only partly in the map',
    'Only In Service features. Dropped: CreatedBy, EditedBy, dates and condition fields (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of SeaTac',
    county: 'King',
    credit: 'Storm drain data: City of SeaTac GIS, provided as is.',
    disclaimer: 'City of SeaTac GIS data is for information only and is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildSeatac);
