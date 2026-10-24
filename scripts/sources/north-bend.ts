// City of North Bend storm drains -> <cache>/sources/north-bend/{assets.ndjson,meta.json}.
// No from/to IDs, inverts or types on the lines: lines join by geometry and are kept as drawn only where the
// ground (USGS 3DEP) shows they are drawn downhill often enough.
// node scripts/sources/north-bend.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  pointOf,
  rawDirFor,
  runCli,
  str,
  summarize,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type RunOptions,
} from './bellevue.ts';
import { settle, type DirLine } from './lib/direction.ts';
import { openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'north-bend';
const BASE = 'https://services9.arcgis.com/ybM2KDccCAJ5Rslp/arcgis/rest/services/NB_Utility_Data/FeatureServer';
const GEOID = '5349485';

const layers = {
  pipes: { name: 'drain-pipes', url: `${BASE}/18`, fields: ['OBJECTID', 'FACILITYID'] },
  ditches: { name: 'open-drains', url: `${BASE}/19`, fields: ['OBJECTID', 'FACILITYID'] },
  inlets: { name: 'inlets', url: `${BASE}/16`, fields: ['OBJECTID', 'FACILITYID', 'INLETTYPE'] },
  discharge: { name: 'discharge-points', url: `${BASE}/17`, fields: ['OBJECTID', 'FACILITYID'] },
  structures: { name: 'structures', url: `${BASE}/15`, fields: ['OBJECTID', 'FACILITYID', 'STRUCTTYPE'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

export async function buildNorthBend(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`north-bend ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, f: EsriFeature) => str(f.attributes.FACILITYID) || `${layers[layer].name}:${str(f.attributes.OBJECTID)}`;
  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    assets.push({ role, id: idOf(layer, f), src: KEY, coords: [at], trust: 'none', ...more });
    inc(`points.${role}`);
  };
  // inlets are the street drains; their types are mostly blank
  for (const f of L.inlets) point('inlets', f, 'drain');
  for (const f of L.structures) point('structures', f, 'junction');
  for (const f of L.discharge) point('discharge', f, 'outfall', { endHint: 'unknown' });

  const lines: DirLine[] = [];
  const gaps = { n: 0 };
  for (const [layer, role] of [['pipes', 'pipe'], ['ditches', 'ditch']] as const) {
    for (const f of L[layer]) {
      const coords = lineOf(f.geometry, gaps);
      if (!coords) {
        inc('skipped.noGeometry');
        continue;
      }
      const asset: SourceAsset = { role, id: idOf(layer, f), src: KEY, coords, trust: 'none' };
      assets.push(asset);
      lines.push({ asset, says: 0 });
    }
  }
  const ground = await openGround(boundaryBox(boundary));
  const dirNotes = settle(lines, ground, 'digitized', extra);
  extra['lines.pathGaps'] = gaps.n;

  const notes = [
    ...dirNotes,
    'Inlets are drains; network structures junctions; discharge points outlets (the walk goes on). Line, inlet and outlet types, owners and status are blank',
    'No license terms stated on the item. Dropped: comments and editor fields (never requested); parcels and the water and sewer layers not used',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of North Bend',
    county: 'King',
    credit: 'Storm drain data: City of North Bend GIS, provided as is.',
    disclaimer: 'City of North Bend GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildNorthBend);
