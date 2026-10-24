// City of Medina storm drains -> <cache>/sources/medina/{assets.ndjson,meta.json}.
// No from/to IDs or inverts on the lines: lines join by geometry. Each catch basin records, per pipe, the compass
// way it leaves (IE_n_Dir) and whether water comes in or goes out (IE_n_Flow); a line end that leaves a basin
// that way says which way the line runs. The ground (USGS 3DEP) checks it.
// node scripts/sources/medina.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  IN,
  NodeIndex,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  isMain,
  lineOf,
  newEnds,
  num,
  pointOf,
  rawDirFor,
  runCli,
  str,
  summarize,
  toM,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type RunOptions,
} from './bellevue.ts';
import { endsSay, settle, type DirLine, type Port } from './lib/direction.ts';
import { openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'medina';
const BASE = 'https://services6.arcgis.com/SmwZXXgXPAlc2QrP/arcgis/rest/services/Medina_Storm_Water_Data/FeatureServer';
const GEOID = '5344725';

const IE = [1, 2, 3, 4, 5, 6].flatMap((n) => [`IE_${n}_Dir`, `IE_${n}_Flow`, `IE_${n}_Dia`]);
const layers = {
  lines: { name: 'lines', url: `${BASE}/22`, fields: ['OBJECTID', 'AssetID', 'Line_ID', 'Feat_Name', 'dia', 'material'] },
  catchBasins: { name: 'catch-basins', url: `${BASE}/19`, fields: ['OBJECTID', 'AssetID', 'Point_ID', 'Type', 'SD_Type', 'Outfall', ...IE] },
  vaults: { name: 'vaults', url: `${BASE}/21`, fields: ['OBJECTID', 'AssetID', 'Point_ID', 'Type', 'SD_Type', ...IE] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const COMPASS: Record<string, number> = { n: 0, north: 0, ne: 45, northeast: 45, e: 90, east: 90, se: 135, southeast: 135, s: 180, south: 180, sw: 225, southwest: 225, w: 270, west: 270, nw: 315, northwest: 315 };
/** recorded as one of 8 (mostly 4) compass points */
const TOL_DEG = 45;

export async function buildMedina(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`medina ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.23, 47.62]);
  const ports = new Map<string, Port[]>();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, f: EsriFeature) => str(f.attributes.AssetID) || `${layers[layer].name}:${str(f.attributes.OBJECTID)}`;
  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) {
      inc('skipped.noGeometry');
      return undefined;
    }
    const id = idOf(layer, f);
    assets.push({ role, id, src: KEY, coords: [at], trust: 'none', ...more });
    inc(`points.${role}`);
    const key = nodes.add(id, at);
    const list: Port[] = [];
    for (let n = 1; n <= 6; n++) {
      const az = COMPASS[str(f.attributes[`IE_${n}_Dir`]).toLowerCase()];
      const flow = str(f.attributes[`IE_${n}_Flow`]).toLowerCase();
      if (az !== undefined && (flow === 'in' || flow === 'out')) list.push({ az, out: flow === 'out' });
    }
    if (list.length) ports.set(key, list);
    inc(`ports.${list.length}`);
    return key;
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    const t = str(a.SD_Type);
    if (t === 'Cln' || t === 'Vault') point('catchBasins', f, 'junction');
    else point('catchBasins', f, 'drain');
    // a basin marked as an outfall lets water out where it sits
    if (str(a.Outfall).toLowerCase() === 'yes') point('catchBasins', f, 'outfall', { endHint: 'unknown' });
  }
  for (const f of L.vaults) point('vaults', f, 'facility-hold');

  const lines: DirLine[] = [];
  const gaps = { n: 0 };
  for (const f of L.lines) {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const name = str(a.Feat_Name).toLowerCase();
    const role: Role = name === 'swale' ? 'ditch' : /culvert/.test(name) ? 'culvert' : 'pipe';
    const dia = num(a.dia);
    const asset: SourceAsset = {
      role, id: idOf('lines', f), src: KEY, coords, trust: 'none', owner: /prvt/.test(name) ? 'private' : undefined,
      width: role !== 'ditch' && dia > 0 ? toM(dia, IN) : undefined, perforated: /perf/i.test(str(a.material)) || undefined,
    };
    assets.push(asset);
    lines.push({ asset, says: role === 'ditch' ? 0 : endsSay(coords, nodes, ports, TOL_DEG) });
  }
  const ground = await openGround(boundaryBox(boundary));
  const dirNotes = settle(lines, ground, 'compass', extra);
  extra['lines.pathGaps'] = gaps.n;

  const notes = [
    ...dirNotes,
    `Catch basin pipes: IE_1-6 compass way (N to NW) and flow (In, Out); a line end within 2 m of a basin that leaves it within ${TOL_DEG} degrees of one flow kind says its order`,
    "Catch basins are drains except cleanouts and vaults (junctions); the 2 basins marked as outfalls also let water out (the walk goes on); vault points hold",
    'Lines: swales are ditches, box culverts culverts, private storm lines owner private',
    'Copyright: City of Medina. No license terms stated on the item. Dropped: comments, maintenance, GPS, creator and editor fields; private control facilities and building permits (never requested)',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Medina',
    county: 'King',
    credit: 'Storm drain data: City of Medina GIS, provided as is.',
    disclaimer: 'City of Medina GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildMedina);
