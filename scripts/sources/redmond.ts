// City of Redmond storm drains -> <cache>/sources/redmond/{assets.ndjson,meta.json}.
// From the city's Utility Viewer service. No from/to IDs: lines join by geometry. Mains and culverts carry
// upstream and downstream invert elevations; the drawn order is checked against them, against the chamber
// bottoms at the two ends, and against the ground (USGS 3DEP). There is no outfall layer: pipes end at streams.
// node scripts/sources/redmond.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
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

const KEY = 'redmond';
const BASE = 'https://gis.redmond.gov/arcgis/rest/services/UV/Utilities/MapServer';
const LIVE = "d_Status = 'ACT' OR d_Status IS NULL";

const CHAMBER = ['OBJECTID', 'AssetID', 'd_Status', 'd_Ownership', 'd_GrateType', 'BottomElevation', 'd_Infiltration', 'd_BottomCondition'];
const layers = {
  mains: { name: 'mains', url: `${BASE}/10`, fields: ['OBJECTID', 'AssetID', 'd_Status', 'd_Ownership', 'd_PipeSize', 'Width', 'UpstreamNodeIE', 'DownstreamNodeIE', 'd_Infiltration', 'd_StreamPipe'], where: LIVE },
  culverts: { name: 'culverts', url: `${BASE}/12`, fields: ['OBJECTID', 'AssetID', 'd_Status', 'd_Ownership', 'd_PipeSize', 'Width', 'UpstreamNodeIE', 'DownstreamNodeIE'], where: LIVE },
  chambers: { name: 'chambers', url: `${BASE}/3`, fields: CHAMBER, where: LIVE },
  otherChambers: { name: 'other-chambers', url: `${BASE}/5`, fields: CHAMBER, where: LIVE },
  streams: { name: 'streams', url: `${BASE}/15`, fields: ['OBJECTID', 'AssetID', 'd_Status', 'd_Type'], where: LIVE },
  ponds: { name: 'ponds', url: `${BASE}/19`, fields: ['OBJECTID', 'AssetID', 'd_Status', 'd_Ownership', 'd_PondType', 'd_Infiltration'], where: LIVE },
  vaults: { name: 'vaults', url: `${BASE}/17`, fields: ['OBJECTID', 'AssetID', 'd_Ownership', 'd_Infiltration'] },
  trenches: { name: 'infiltration-trenches', url: `${BASE}/20`, fields: ['OBJECTID', 'RedswInfiltrationTrenchID', 'd_Status', 'd_Ownership'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

function redmondOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (s === 'RED') return 'public';
  if (s === 'PVT') return 'private';
  return s && s !== 'UNK' ? 'other' : undefined;
}

/** d_PipeSize codes are inches ('12', '8', ...) */
const inches = (v: unknown) => {
  const n = parseFloat(str(v));
  return Number.isFinite(n) ? n : 0;
};
/** solid lid (SO); unknown or no grate: a manhole */
const GRATES = new Set(['BC', 'HB', 'OTH', 'PA', 'TC', 'TH', 'TP', 'TV', 'VA', 'BEE', 'ROL', 'PAM', 'PED', 'ATR', 'WLK']);
/** chamber at a line end: this close (m) */
const AT_END_M = 1;
const GROUND_OK = 0.75;

export async function buildRedmond(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`redmond ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const juris = readBoundaries().jurisdictions.find((j) => j.name === 'Redmond');
  if (!juris) throw new Error('no Redmond in the context boundaries');
  const boundary = juris.polygons as LonLat[][][];

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.AssetID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  // chambers: drains with a grate, junctions otherwise; their bottoms check the drawn order
  const chambers = new NodeIndex([-122.1, 47.67]);
  const bottomOf = new Map<string, number>();
  for (const layer of ['chambers', 'otherChambers'] as const) {
    for (const f of L[layer]) {
      const a = f.attributes;
      const at = pointOf(f.geometry);
      if (!at) {
        inc('skipped.noGeometry');
        continue;
      }
      const id = idOf(layer, a);
      const key = chambers.add(id, at);
      if (num(a.BottomElevation) > 0) bottomOf.set(key, num(a.BottomElevation));
      const grate = GRATES.has(str(a.d_GrateType));
      const soak = str(a.d_Infiltration) === 'YES' || str(a.d_BottomCondition) === 'OPN';
      assets.push({ role: grate ? 'drain' : 'junction', id, src: KEY, coords: [at], trust: 'none', owner: redmondOwner(a.d_Ownership), ...(soak ? { openBottom: true } : {}) });
      inc(`points.${layers[layer].name}.${grate ? 'drain' : 'junction'}`);
    }
  }

  const facility = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    const at = pointOf(f.geometry);
    if (!rings.length && !at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    for (const coords of rings.length ? rings : [[at!]]) assets.push({ role, id, src: KEY, coords, trust: 'none', owner: redmondOwner(f.attributes.d_Ownership) });
    inc(`facilities.${layers[layer].name}`);
  };
  for (const f of L.ponds) {
    const a = f.attributes;
    // natural ponds come from the water layers
    if (str(a.d_PondType) === 'NAT') continue;
    facility('ponds', f, str(a.d_Infiltration) === 'YES' ? 'facility-infiltrate' : 'facility-hold');
  }
  for (const f of L.vaults) facility('vaults', f, str(f.attributes.d_Infiltration) === 'YES' ? 'facility-infiltrate' : 'facility-hold');
  for (const f of L.trenches) facility('trenches', f, 'facility-infiltrate');

  // the city's streams, as waters the pipes reach
  const gaps = { n: 0 };
  for (const f of L.streams) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) continue;
    assets.push({ role: 'stream', id: idOf('streams', f.attributes), src: KEY, coords, trust: 'none', liveStream: true });
    inc('lines.streams');
  }

  // mains and culverts as drawn; inverts, chamber bottoms and the ground decide below
  type Group = 'invertsAgree' | 'invertsDisagree' | 'noInverts';
  type Line = { asset: SourceAsset; from: number; to: number; group: Group };
  const lines: Line[] = [];
  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const from = num(a.UpstreamNodeIE);
    const to = num(a.DownstreamNodeIE);
    const s = invertSign(from, to);
    const dia = inches(a.d_PipeSize) || num(a.Width);
    const asset: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', owner: redmondOwner(a.d_Ownership), width: toM(dia, IN), ...more };
    assets.push(asset);
    lines.push({ asset, from, to, group: s > 0 ? 'invertsAgree' : s < 0 ? 'invertsDisagree' : 'noInverts' });
  };
  for (const f of L.mains) {
    const a = f.attributes;
    const stream = str(a.d_StreamPipe) === 'YES';
    line('mains', f, stream ? 'stream-culvert' : 'pipe', { perforated: str(a.d_Infiltration) === 'YES' || undefined, liveStream: stream || undefined });
  }
  for (const f of L.culverts) line('culverts', f, 'culvert');

  // independent checks of the drawn order: chamber bottoms at both ends, and the ground
  const ground = await openGround(boundaryBox(boundary));
  const bottomAt = (p: LonLat) => {
    const n = chambers.nearest(p, AT_END_M);
    return n ? bottomOf.get(n.ref.key) : undefined;
  };
  const check: Record<string, { down: number; up: number }> = {};
  const tick = (k: string, down: boolean) => {
    const d = (check[k] ??= { down: 0, up: 0 });
    down ? d.down++ : d.up++;
  };
  const groundSays = new Map<SourceAsset, boolean>();
  for (const l of lines) {
    const c = l.asset.coords;
    const b0 = bottomAt(c[0]), b1 = bottomAt(c[c.length - 1]);
    if (b0 !== undefined && b1 !== undefined && Math.abs(b0 - b1) >= 0.01) tick(`bottoms.${l.group}`, b0 > b1);
    const s = groundSign(ground, c, 1);
    if (s) {
      groundSays.set(l.asset, s > 0);
      tick(`ground.${l.group}`, s > 0);
    }
  }
  const share = (k: string) => {
    const d = check[k] ?? { down: 0, up: 0 };
    return d.down + d.up ? d.down / (d.down + d.up) : 0;
  };

  // as in sammamish.ts: the ground runs downhill along most pipes but not all (q, from lines whose inverts
  // agree with the drawing); where they disagree, the drawing is right on (s - (1 - q)) / (2q - 1)
  const q = share('ground.invertsAgree');
  const drawnRight = Math.min(1, Math.max(0, (share('ground.invertsDisagree') - (1 - q)) / Math.max(0.01, 2 * q - 1)));
  const n = (g: Group) => lines.filter((l) => l.group === g).length;
  const drawnShare = n('invertsAgree') / Math.max(1, n('invertsAgree') + n('invertsDisagree'));
  const drawnOk = n('invertsAgree') + n('invertsDisagree') >= 20 && drawnShare >= DRAWN_OK;
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

  for (const g of ['invertsAgree', 'invertsDisagree', 'noInverts'] as Group[]) {
    extra[`lines.${g}`] = n(g);
    for (const k of ['bottoms', 'ground']) {
      extra[`${k}.${g}.down`] = check[`${k}.${g}`]?.down ?? 0;
      extra[`${k}.${g}.up`] = check[`${k}.${g}`]?.up ?? 0;
    }
  }
  extra['lines.pathGaps'] = gaps.n;
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const said = (k: string) => `${check[k]?.down ?? 0}/${(check[k]?.down ?? 0) + (check[k]?.up ?? 0)} (${pct(share(k))})`;
  const notes = [
    `Inverts: UpstreamNodeIE > DownstreamNodeIE (drawn downhill) on ${n('invertsAgree')} of ${n('invertsAgree') + n('invertsDisagree')} mains and culverts with both set (${pct(drawnShare)}); ${n('noInverts')} have none`,
    `Chamber bottoms at both ends (within ${AT_END_M} m) fall along the drawing on: agreeing inverts ${said('bottoms.invertsAgree')}, disagreeing ${said('bottoms.invertsDisagree')}, none ${said('bottoms.noInverts')}`,
    `Ground (3DEP, ends 1 m or more apart; share drawn downhill): agreeing inverts ${said('ground.invertsAgree')}, disagreeing ${said('ground.invertsDisagree')}, none ${said('ground.noInverts')}`,
    `Disagreeing inverts: the drawing is right on about ${pct(drawnRight)}; by the ground at the line ${extra['lines.keptByGround'] ?? 0} kept, ${extra['lines.reversedByGround'] ?? 0} reversed; elsewhere ${extra['lines.keptAsDrawn'] ?? 0} kept as drawn, ${extra['lines.reversedToInverts'] ?? 0} reversed to the inverts; no inverts: ${drawnOk ? "'digitized'" : "'none'"}`,
    'Chambers (Redmond and non-Redmond): a grate of any kind makes a drain, solid or unknown lids a junction; infiltrating or open-bottom chambers soak in',
    "Stream Pipe mains carry a stream (stream-culvert); the city's stream lines are waters (ownStreams). No outfall layer: where a pipe meets a stream or lake the tracer ends it there",
    'Facilities: stormwater ponds (not natural ones), vaults and infiltration trenches; infiltrating ones soak in. Side sewer pipes (private laterals), underdrains, cleanouts and connectors left out',
    'owner: public = City of Redmond, private = Private, other = WSDOT, King County, Bellevue, Kirkland, Sammamish',
    'Dropped: names, project and record drawing fields (never requested); the Utility Viewer parcel, taxpayer and address layers are never used',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Redmond',
    county: 'King',
    credit: 'Storm drain data: City of Redmond GIS, modified for use from its original source; the City makes no claims as to its completeness, timeliness, accuracy or content, and it is provided as is.',
    disclaimer: 'City of Redmond data is provided as is, without warranty of any kind (Redmond Data Terms of Use, https://www.redmond.gov/875/abc.html).',
    notice: 'The data made available here has been modified for use from its original source, which is the City of Redmond. The City of Redmond makes no claims as to the completeness, timeliness, accuracy or content of any data contained in this application; makes any representation of any kind, including, but not limited to, warranty of the accuracy or fitness for a particular use; nor are any such warranties to be implied or inferred with respect to the information or data furnished herein. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the web feed is being used at one\'s own risk.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
    ownStreams: true,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildRedmond);
