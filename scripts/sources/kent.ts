// City of Kent storm drains -> <cache>/sources/kent/{assets.ndjson,meta.json}.
// The city publishes no storm data. This is its Cityworks storm map service, public with no login, hosted by its
// contractor Woolpert and labeled "City of Kent GIS": not an official open-data release, and no license or terms.
// No from/to IDs: lines join by geometry. Most lines carry InvertIn/InvertOut; the ground (USGS 3DEP) checks them.
// node scripts/sources/kent.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
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
  toM,
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type RunOptions,
} from './bellevue.ts';
import { settle, type DirLine } from './lib/direction.ts';
import { openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'kent';
const BASE = 'https://enterprise.woolpert.com/server/rest/services/StratCon/Stormwater/MapServer';
const GEOID = '5335415';
const LIVE = "LifecycleStatus = 'Active' OR LifecycleStatus IS NULL";

// no owner, maintainer, address, location, plan, note or editor fields
const pt = (name: string, id: number, more: string[] = []): LayerQuery => ({ name, url: `${BASE}/${id}`, fields: ['OBJECTID', 'AssetID', ...more, 'LifecycleStatus'], where: LIVE });
const layers = {
  catchBasins: pt('catch-basins', 133, ['CBType', 'CntrlAccessory']),
  pipeEnds: pt('pipe-ends', 78, ['FeatureType', 'Outfall']),
  access: pt('access', 101),
  cleanouts: pt('cleanouts', 77),
  valves: pt('valves', 88),
  decantStations: pt('decant-stations', 74),
  pipes: pt('pipes', 140, ['PipeType', 'Diameter', 'InvertIn', 'InvertOut']),
  culverts: pt('culverts', 139, ['CulvertShape', 'Diameter', 'InvertIn', 'InvertOut']),
  tanks: pt('tanks', 141, ['TankType', 'InvertIn', 'InvertOut']),
  trenches: pt('trench-drains', 85, ['TrenchType', 'InvertIn', 'InvertOut']),
  ponds: pt('ponds', 132, ['PondType']),
  vaults: pt('vaults', 98, ['VaultType']),
  wetlands: pt('wetlands', 99, ['WetlandType']),
  pavement: pt('permeable-pavement', 95, ['PvmtType', 'Underdrain']),
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

/** catch basins with flow-control or water-quality gear are control structures */
const CONTROL = new Set(['FC', 'WQ', 'WQ/FC']);
/** A pair pointing uphill by less than this (feet) says nothing: those lines run downhill on the ground as often as ones whose pair points downhill */
const INV_MIN_FT = 1;

export async function buildKent(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`kent ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.AssetID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: [at], trust: 'none', ...more });
    inc(`points.${role}`);
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    point('catchBasins', f, str(a.CBType) === 'MH' || CONTROL.has(str(a.CntrlAccessory)) ? 'junction' : 'drain');
  }
  for (const f of L.pipeEnds) {
    const a = f.attributes;
    // an input end takes ditch or pond water into a pipe; an output end lets it out (989 of 1003 outfalls are output ends)
    if (str(a.Outfall) === 'Yes') point('pipeEnds', f, 'outfall', { endHint: 'water' });
    else if (str(a.FeatureType) === 'Input') point('pipeEnds', f, 'junction');
    else point('pipeEnds', f, 'outfall', { endHint: 'unknown' });
  }
  for (const layer of ['access', 'cleanouts', 'valves', 'decantStations'] as const) for (const f of L[layer]) point(layer, f, 'junction');

  const polygon = (layer: LayerName, f: EsriFeature, role: Role) => {
    const rings = outerRings(f.geometry);
    if (!rings.length) return inc('skipped.noGeometry');
    for (const ring of rings) assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: ring, trust: 'none' });
    inc(`facilities.${role}`);
  };
  for (const f of L.ponds) polygon('ponds', f, str(f.attributes.PondType) === 'Infiltration' ? 'facility-infiltrate' : 'facility-hold');
  for (const f of L.vaults) polygon('vaults', f, str(f.attributes.VaultType) === 'Infiltration Vault' ? 'facility-infiltrate' : 'facility-hold');
  for (const f of L.wetlands) polygon('wetlands', f, 'facility-hold');
  for (const f of L.pavement) polygon('pavement', f, str(f.attributes.Underdrain) === 'Yes' ? 'facility-hold' : 'facility-infiltrate');

  const lines: DirLine[] = [];
  const gaps = { n: 0 };
  const m = (ft: number) => (ft > 0 ? Math.round(ft * FT * 1000) / 1000 : undefined);
  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const up = num(a.InvertIn);
    const down = num(a.InvertOut);
    const s = invertSign(up, down) < 0 && down - up < INV_MIN_FT ? 0 : invertSign(up, down);
    const asset: SourceAsset = { role, id: idOf(layer, a), src: KEY, coords, trust: 'none', ...more, ...(s ? { upInv: m(up), downInv: m(down) } : {}) };
    assets.push(asset);
    lines.push({ asset, says: s });
    inc(`lines.${layers[layer].name}`);
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    line('pipes', f, 'pipe', { width: toM(num(a.Diameter), IN), perforated: str(a.PipeType) === 'Perf' || undefined });
  }
  for (const f of L.culverts) line('culverts', f, 'culvert', { width: toM(num(f.attributes.Diameter), IN) });
  // detention tanks pass water on like pipes
  for (const f of L.tanks) line('tanks', f, 'pipe');
  // dispersion and infiltration trenches let the water soak in along them
  for (const f of L.trenches) line('trenches', f, 'pipe', { perforated: /Dispersion|Infiltration/.test(str(f.attributes.TrenchType)) || undefined });

  const ground = await openGround(boundaryBox(boundary));
  const dirNotes = settle(lines, ground, 'inverts', extra);
  extra['lines.pathGaps'] = gaps.n;

  const notes = [
    ...dirNotes,
    `InvertIn is taken as the first vertex's invert. Pairs pointing uphill by less than ${INV_MIN_FT} ft are read as level: along them the ground falls with the drawing as often as along pairs pointing downhill by as little`,
    'Catch basins (types 1 and 2, inlets and unknown) are drains; manholes and basins with flow-control or water-quality gear are junctions; access points, cleanouts, valves and decant stations are junctions',
    "Pipe ends: ends marked as outfalls -> 'water'; other output ends -> 'unknown' (the walk goes on where the map does); other input ends -> junctions",
    'Facilities: infiltration ponds and vaults and permeable pavement without an underdrain soak in; other ponds, vaults and stormwater wetlands hold',
    'Detention tanks are pipes; dispersion and infiltration trenches are perforated pipes. The ditch and channel layer is empty',
    "Source: the city's Cityworks storm service (\"City of Kent GIS\"), hosted by Woolpert; not an official open-data release, and no license or terms are stated. Public assets only",
    'Only Active features. Dropped: owner, maintainer, address, location, plan, cost, note and editor fields (never requested); hot spots and dams not used',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Kent',
    county: 'King',
    credit: 'Storm drain data: City of Kent GIS, from a public map service hosted by Woolpert (not an official open-data release), provided as is.',
    disclaimer: 'City of Kent GIS data from a public map service hosted by Woolpert, not an official open-data release. Provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildKent);
