// City of Woodinville storm drains -> <cache>/sources/woodinville/{assets.ndjson,meta.json}.
// Pipes name their end structures by CartegraphID (manholes CB*, outlets IO*), but the labels are swapped:
// DownstreamInlet names the upstream end and UpstreamInlet the downstream end. The elevations are labeled
// right (UpstreamElevation is the high end). The adapter checks both against the drawing before trusting them.
// node scripts/sources/woodinville.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
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
import { readBoundaries } from './lib/boundaries.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'woodinville';
const BASE = 'https://services8.arcgis.com/OQPRCxZXJewOd2xW/arcgis/rest/services';

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/StormPipe_view/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID', 'UpstreamInlet', 'DownstreamInlet', 'UpstreamElevation', 'DownstreamElevation', 'Diameter', 'Culvert', 'Outfall', 'UseType', 'Owned_By', 'SWStatus'], where: "SWStatus IS NULL OR SWStatus <> 'Abandoned'" },
  manholes: { name: 'manholes', url: `${BASE}/StormManhole_View/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID', 'Type', 'UseType', 'CoverType'] },
  inlets: { name: 'inlets', url: `${BASE}/StormInletView/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID', 'InletType', 'GrateType'] },
  outlets: { name: 'outlets', url: `${BASE}/StormOutletView/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID', 'OutletType'] },
  channels: { name: 'channels', url: `${BASE}/StormChannelView/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID'] },
  facilities: { name: 'facilities', url: `${BASE}/StormFacility_View/FeatureServer/0`, fields: ['OBJECTID', 'CartegraphID', 'FacilityType'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function woodinvilleOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (s === 'CoW') return 'public';
  if (s === 'Private') return 'private';
  return s ? 'other' : undefined;
}

const SOLID = /^Solid/;
const GRATE = /Herringbone|Vane|Slot|Beehive|Birdcage|Grate|Directional|Trash Rack/i;
/** manhole types that are catch basins (1 and 2 are CB Type 1 and Type 2) */
const CB_TYPES = /^(1|2|CB|Type 1|Yard Drain|cb)/i;
/** facility points that soak water in */
const SOAK = new Set(['Infiltration', 'RainGarden']);
/** facility points left out: bioswales and conveyance are lines elsewhere, historical ones are gone */
const SKIP_FACILITY = new Set(['BioSwale', 'Conveyance', 'Historical', '', 'Unknown']);
/** ditches are kept as drawn when the ground falls along at least this share of the sloped ones */
const GROUND_OK = 0.75;

export async function buildWoodinville(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`woodinville ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const juris = readBoundaries().jurisdictions.find((j) => j.name === 'Woodinville');
  if (!juris) throw new Error('no Woodinville in the context boundaries');
  const boundary = juris.polygons as LonLat[][][];

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.15, 47.75]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.CartegraphID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    // inlets' CartegraphIDs are bare numbers no pipe names
    const id = layer === 'inlets' ? `inlet:${str(f.attributes.OBJECTID)}` : idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', ...more });
    inc(`points.${layers[layer].name}.${role}`);
  };

  for (const f of L.manholes) {
    const a = f.attributes;
    const cover = str(a.CoverType);
    const cb = CB_TYPES.test(str(a.Type)) || CB_TYPES.test(str(a.UseType));
    point('manholes', f, SOLID.test(cover) ? 'junction' : cb || GRATE.test(cover) ? 'drain' : 'junction');
  }
  // pipe inlets: where a ditch or swale enters a pipe
  for (const f of L.inlets) point('inlets', f, 'junction');
  for (const f of L.outlets) {
    const t = str(f.attributes.OutletType);
    if (t === 'Outfall' || t.startsWith('NPDES')) point('outlets', f, 'outfall', { endHint: 'water' });
    else point('outlets', f, 'outfall', { endHint: 'unknown' });
  }
  for (const f of L.facilities) {
    const t = str(f.attributes.FacilityType);
    if (SKIP_FACILITY.has(t)) continue;
    // a facility point becomes a vault node
    point('facilities', f, SOAK.has(t) ? 'facility-infiltrate' : 'facility-hold');
  }

  // pipes: keys swapped (see top); checked below against the drawing, the elevations and the ground
  const gaps = { n: 0 };
  const keyless: SourceAsset[] = [];
  let keyedAsDrawn = 0;
  let keyedFlipped = 0;
  const elev = { agree: 0, disagree: 0 };
  for (const f of L.pipes) {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const up = str(a.DownstreamInlet), down = str(a.UpstreamInlet);
    const hi = num(a.UpstreamElevation), lo = num(a.DownstreamElevation);
    const culvert = str(a.Culvert) === 'Y';
    const base: SourceAsset = {
      role: culvert ? 'culvert' : 'pipe', id: idOf('pipes', a), src: KEY, coords, trust: 'none', owner: woodinvilleOwner(a.Owned_By),
      width: toM(num(a.Diameter), IN), perforated: str(a.UseType) === 'Trench' || undefined,
    };
    if (hi > 0 && lo > 0 && Math.abs(hi - lo) >= 0.01) hi > lo ? elev.agree++ : elev.disagree++;
    const before = ends.resolved;
    const o = orientByKeys(nodes, coords, up, down, ends);
    if (ends.resolved > before) {
      o.reversed ? keyedFlipped++ : keyedAsDrawn++;
      const inv = hi > 0 && lo > 0 && hi > lo ? { upInv: toM(hi, FT), downInv: toM(lo, FT) } : {};
      assets.push({ ...base, ...inv, coords: o.coords, fromId: o.fromId, toId: o.toId, trust: 'id' });
      continue;
    }
    const asset = { ...base, fromId: o.fromId, toId: o.toId };
    assets.push(asset);
    keyless.push(asset);
  }
  const channels: SourceAsset[] = [];
  for (const f of L.channels) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const asset: SourceAsset = { role: 'ditch', id: idOf('channels', f.attributes), src: KEY, coords, trust: 'none' };
    assets.push(asset);
    channels.push(asset);
  }

  // the ground at line ends: keyed pipes as oriented, the rest as drawn
  const ground = await openGround(boundaryBox(boundary));
  const tally = (list: SourceAsset[]) => {
    let d = 0, u = 0;
    for (const a of list) {
      const s = groundSign(ground, a.coords);
      if (s > 0) d++;
      else if (s < 0) u++;
    }
    return { d, u };
  };
  const gK = tally(assets.filter((a) => a.trust === 'id'));
  const gN = tally(keyless);
  const gC = tally(channels);
  const drawnShare = keyedAsDrawn / Math.max(1, keyedAsDrawn + keyedFlipped);
  const ok = keyedAsDrawn + keyedFlipped >= 20 && drawnShare >= DRAWN_OK;
  if (ok) for (const a of keyless) a.trust = 'digitized';
  const chOk = gC.d + gC.u >= 20 && gC.d / (gC.d + gC.u) >= GROUND_OK;
  if (chOk) for (const a of channels) a.trust = 'digitized';
  settleKeys(assets, nodes, extra);
  Object.assign(extra, {
    'keyed.asDrawn': keyedAsDrawn, 'keyed.flipped': keyedFlipped, 'elevations.agree': elev.agree, 'elevations.disagree': elev.disagree,
    'ground.keyed.downhill': gK.d, 'ground.keyed.uphill': gK.u, 'ground.keyless.downhill': gN.d, 'ground.keyless.uphill': gN.u,
    'ground.channels.downhill': gC.d, 'ground.channels.uphill': gC.u, 'lines.keyless': keyless.length, 'lines.channels': channels.length, 'lines.pathGaps': gaps.n,
  });
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const notes = [
    `Keyed pipes: DownstreamInlet -> UpstreamInlet (the labels are swapped) is the flow order; ${keyedAsDrawn}/${keyedAsDrawn + keyedFlipped} (${pct(keyedAsDrawn, keyedAsDrawn + keyedFlipped)}) were already drawn that way`,
    `Elevations: UpstreamElevation > DownstreamElevation on ${elev.agree}/${elev.agree + elev.disagree} (${pct(elev.agree, elev.agree + elev.disagree)}) pipes with both set; kept as inverts on keyed pipes where they fall`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${gK.d}/${gK.d + gK.u} (${pct(gK.d, gK.d + gK.u)}) keyed pipes as oriented, ${gN.d}/${gN.d + gN.u} (${pct(gN.d, gN.d + gN.u)}) of the ${keyless.length} pipes no key orients ('${ok ? 'digitized' : 'none'}'), and ${gC.d}/${gC.d + gC.u} (${pct(gC.d, gC.d + gC.u)}) of the ${channels.length} channels as drawn ('${chOk ? 'digitized' : 'none'}')`,
    'Manholes: catch basin types (1, 2, CB-*) and any grate cover are drains, solid covers junctions; pipe inlets (ditch to pipe) are junctions',
    "Outlets: Outfall and NPDES outfalls -> 'water'; other outlets 'unknown' (the walk goes on where the map does)",
    'Facility points: infiltration and rain gardens soak in; tanks, vaults and oil/water separators hold; bioswales, conveyance and historical ones left out',
    "owner: public = CoW, private = Private, other = WSDOT, King County, Kirkland; blank stays unknown. Pipes marked Abandoned left out. Boundary: King County's Woodinville polygon (the map's pipes in Bothell, Kirkland and the counties are clipped off)",
    'Dropped: addresses, street and locator fields, plat and drawing links, notes, user, verifier, creator and editor fields (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Woodinville',
    county: 'King',
    credit: 'Storm drain data: City of Woodinville GIS, provided as is.',
    disclaimer: 'The City of Woodinville does not warrant the accuracy, currency, completeness or quality of its GIS data; use is at the user\'s sole risk.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildWoodinville);
