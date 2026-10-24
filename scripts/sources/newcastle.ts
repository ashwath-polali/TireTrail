// City of Newcastle storm drains -> <cache>/sources/newcastle/{assets.ndjson,meta.json}.
// A 2020 snapshot on the city's ArcGIS Online. No from/to IDs: lines join by geometry. Most pipes carry
// up and down invert elevations (UPELEV, DOWNELEV); the ground (USGS 3DEP) checks them.
// node scripts/sources/newcastle.ts [--refresh] [--box=w,s,e,n]
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

const KEY = 'newcastle';
const BASE = 'https://services6.arcgis.com/kvG4x0h4KLP0c8nr/arcgis/rest/services';
const GEOID = '5348645';
const LIVE = 'ACTIVEFLAG IS NULL OR ACTIVEFLAG <> 0';

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/swGravityMain_20200320/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'PIPETYPE', 'DIAMETER', 'UPELEV', 'DOWNELEV', 'DISCHARGE', 'OWNEDBY', 'ACTIVEFLAG'], where: LIVE },
  ditches: { name: 'open-drains', url: `${BASE}/Open_Drains_20200320/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'DISCHARGE', 'ACTIVEFLAG'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${BASE}/Catch_Basins_20200320/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'INLETTYPE', 'CBLIDTYPE', 'OWNEDBY', 'ACTIVEFLAG'], where: LIVE },
  manholes: { name: 'manholes', url: `${BASE}/Manholes_20200320/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'MHTYPE', 'ACTIVEFLAG'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/Outfalls_20200320/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'TYPE', 'DISCHARGE', 'ACTIVEFLAG'], where: LIVE },
  facilities: { name: 'wq-detention', url: `${BASE}/WQ_Detention_20200331/FeatureServer/0`, fields: ['OBJECTID', 'FACILITYID', 'TYPE', 'SUBTYPE', 'OWNEDBY', 'ACTIVEFLAG'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const owner = (v: unknown): SourceAsset['owner'] => {
  const s = str(v);
  if (s === 'City of Newcastle' || s === 'Public') return 'public';
  if (s === 'Private') return 'private';
  return s === 'Other' ? 'other' : undefined;
};
const SOLID = /solid|manhole|cleanout|control|restrictor|separat|stormfilter|spill/i;
/** a receiving water name, not a plat, parcel, road or pond */
export const WATER_NAME = /creek|lake|lk |stream|tributary|wetland|river/i;

export async function buildNewcastle(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`newcastle ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.FACILITYID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f.attributes), src: KEY, coords: [at], trust: 'none', owner: owner(f.attributes.OWNEDBY), ...more });
    inc(`points.${role}`);
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    const lid = str(a.CBLIDTYPE);
    const t = str(a.INLETTYPE);
    if (/dry ?well/i.test(t)) point('catchBasins', f, 'drain', { openBottom: true });
    else if (/oil water/i.test(t) || SOLID.test(lid)) point('catchBasins', f, 'junction');
    else point('catchBasins', f, 'drain');
  }
  for (const f of L.manholes) point('manholes', f, 'junction');
  for (const f of L.outfalls) {
    const to = str(f.attributes.DISCHARGE);
    if (WATER_NAME.test(to)) point('outfalls', f, 'outfall', { endHint: 'water', receivingHint: to });
    else point('outfalls', f, 'outfall', { endHint: str(f.attributes.TYPE) === 'Outfall' ? 'water' : 'unknown', receivingHint: to || undefined });
  }
  for (const f of L.facilities) {
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const soak = /infiltration|retention/i.test(str(f.attributes.SUBTYPE)) || str(f.attributes.TYPE) === 'Trench';
    for (const ring of rings) assets.push({ role: soak ? 'facility-infiltrate' : 'facility-hold', id: idOf('facilities', f.attributes), src: KEY, coords: ring, trust: 'none', owner: owner(f.attributes.OWNEDBY) });
    inc(`facilities.${soak ? 'infiltrate' : 'hold'}`);
  }

  const lines: DirLine[] = [];
  const gaps = { n: 0 };
  for (const f of L.pipes) {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const t = str(a.PIPETYPE);
    const up = num(a.UPELEV);
    const down = num(a.DOWNELEV);
    const s = invertSign(up, down);
    const m = (ft: number) => (ft > 0 ? Math.round(ft * FT * 1000) / 1000 : undefined);
    const asset: SourceAsset = {
      role: /culvert/i.test(t) ? 'culvert' : 'pipe', id: idOf('pipes', a), src: KEY, coords, trust: 'none', owner: owner(a.OWNEDBY),
      width: toM(num(a.DIAMETER), IN), perforated: /perf/i.test(t) || undefined, ...(s ? { upInv: m(up), downInv: m(down) } : {}),
    };
    assets.push(asset);
    lines.push({ asset, says: s });
  }
  for (const f of L.ditches) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const asset: SourceAsset = { role: 'ditch', id: idOf('ditches', f.attributes), src: KEY, coords, trust: 'none' };
    assets.push(asset);
    lines.push({ asset, says: 0 });
  }
  const ground = await openGround(boundaryBox(boundary));
  const dirNotes = settle(lines, ground, 'inverts', extra);
  extra['lines.pathGaps'] = gaps.n;

  const notes = [
    ...dirNotes,
    'Catch basins are drains unless the lid is solid or the basin is a control, filter or oil-water structure (junctions); dry wells soak in; manholes are junctions',
    "Outfalls and outlets whose DISCHARGE names a creek, lake, stream, tributary or wetland -> 'water'; other outfalls -> 'water', other outlets -> 'unknown' (the walk goes on)",
    'WQ and detention facilities: infiltration and retention ones (and trenches) soak in; ponds, vaults and tanks hold',
    'owner: public = City of Newcastle/Public, private = Private',
    'A 2020 snapshot (services dated 2020-03-20 and 2020-03-31). No license terms stated on the items.',
    'Only ACTIVEFLAG not 0. Dropped: owner names, addresses, locations, notes, links, development names and editor fields (never requested); GSI layer not used',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Newcastle',
    county: 'King',
    credit: 'Storm drain data: City of Newcastle GIS (2020), provided as is.',
    disclaimer: 'City of Newcastle GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildNewcastle);
