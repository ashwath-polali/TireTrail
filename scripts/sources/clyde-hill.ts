// City of Clyde Hill storm drains -> <cache>/sources/clyde-hill/{assets.ndjson,meta.json}.
// No from/to IDs or inverts: lines join by geometry. A field survey recorded at each catch basin the azimuth of
// its outlet pipe (POT) and inlet pipes (PIN1-4); a line end that leaves a basin along one of them says which way
// the line runs. The ground (USGS 3DEP) checks it. Water leaves the city into Bellevue's and Medina's systems.
// node scripts/sources/clyde-hill.ts [--refresh] [--box=w,s,e,n]
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

const KEY = 'clyde-hill';
const BASE = 'https://services.arcgis.com/oHNvOiOAe8DLsuZW/arcgis/rest/services';
const GEOID = '5313365';

const PORTS = ['POT', 'PIN1', 'PIN2', 'PIN3', 'PIN4', 'POT2'] as const;
const PORT_FIELDS: Record<(typeof PORTS)[number], [string, string]> = {
  POT: ['POT_Azimut', 'POT_Diamet'], PIN1: ['PIN1_Azimu', 'PIN1_Diame'], PIN2: ['PIN2_Azimu', 'PIN2_Diame'],
  PIN3: ['PIN3_Azimu', 'PIN3_Diame'], PIN4: ['PIN4_Azimu', 'PIN4_Diame'], POT2: ['POT2_Azimu', 'POT2_Diame'],
};
const layers = {
  pipes: { name: 'pipes', url: `${BASE}/SD_Pipes/FeatureServer/0`, fields: ['FID', 'GISIDTXT', 'DIA_CODE', 'MAT_CODE', 'IS_DETENT'] },
  privateLines: { name: 'private-lines', url: `${BASE}/SD_PVT_Lines/FeatureServer/0`, fields: ['FID', 'GISIDTXT', 'Type_Code', 'DIA_Code'] },
  catchBasins: { name: 'catch-basins', url: `${BASE}/SD_Structures_CB/FeatureServer/0`, fields: ['FID', 'GISIDTXT', 'Type', 'Grate', ...Object.values(PORT_FIELDS).flat()] },
  structures: { name: 'structures', url: `${BASE}/SD_Structures_DRN/FeatureServer/0`, fields: ['FID', 'GISIDTXT', 'Type', 'Sub_Type'] },
  privatePoints: { name: 'private-points', url: `${BASE}/SD_PVT_Points/FeatureServer/0`, fields: ['FID', 'GISIDTXT', 'Type_Code'] },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

/** port azimuths are field-measured to 10 degrees or so */
const TOL_DEG = 30;

export async function buildClydeHill(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`clyde-hill ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.21, 47.63]);
  const ports = new Map<string, Port[]>();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, f: EsriFeature) => str(f.attributes.GISIDTXT) || `${layers[layer].name}:${str(f.attributes.FID)}`;
  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) {
      inc('skipped.noGeometry');
      return undefined;
    }
    const id = idOf(layer, f);
    assets.push({ role, id, src: KEY, coords: [at], trust: 'none', ...more });
    inc(`points.${role}`);
    return nodes.add(id, at);
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    const t = str(a.Type);
    const grate = str(a.Grate);
    const solid = /solid/i.test(grate);
    let key: string | undefined;
    if (t === 'OUT') key = point('catchBasins', f, 'outfall', { endHint: 'unknown' });
    else if (t === 'TEE' || t === 'IN' || /Flow Restr|Poll Cntrl/.test(t)) key = point('catchBasins', f, 'junction');
    else if (t === 'PVT') key = point('catchBasins', f, grate && !solid ? 'drain' : 'junction', { owner: 'private' });
    else key = point('catchBasins', f, solid ? 'junction' : 'drain');
    if (!key) continue;
    const list: Port[] = [];
    for (const p of PORTS) {
      const [az, dia] = PORT_FIELDS[p];
      // a port is recorded when it has a size
      if (num(a[dia]) > 0) list.push({ az: num(a[az]) % 360, out: p.startsWith('POT') });
    }
    if (list.length) ports.set(key, list);
    inc(`ports.${list.length}`);
  }
  for (const f of L.structures) {
    const t = str(f.attributes.Type);
    if (/Detention|Pond|Vault/.test(t)) point('structures', f, 'facility-hold');
    else if (/^Pipe Out|End Ditch/.test(t)) point('structures', f, 'outfall', { endHint: 'unknown' });
    else point('structures', f, 'junction');
  }
  for (const f of L.privatePoints) {
    const t = str(f.attributes.Type_Code).toUpperCase();
    if (t === 'CB' || t === 'YD' || t === 'FD') point('privatePoints', f, 'drain', { owner: 'private' });
    else if (t === 'SB') point('privatePoints', f, 'discharge', { endHint: 'ground', receivingHint: 'splash block', owner: 'private' });
    else point('privatePoints', f, 'junction', { owner: 'private' });
  }

  const lines: DirLine[] = [];
  const gaps = { n: 0 };
  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset>, withPorts: boolean) => {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) return inc('skipped.noGeometry');
    const asset: SourceAsset = { role, id: idOf(layer, f), src: KEY, coords, trust: 'none', ...more };
    assets.push(asset);
    lines.push({ asset, says: withPorts ? endsSay(coords, nodes, ports, TOL_DEG) : 0 });
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    const dia = num(a.DIA_CODE);
    line('pipes', f, 'pipe', { width: dia > 0 && dia < 99 ? toM(dia, IN) : undefined, perforated: /PERF/i.test(str(a.MAT_CODE)) || undefined, owner: 'public' }, true);
  }
  for (const f of L.privateLines) {
    const t = str(f.attributes.Type_Code).toUpperCase();
    const dia = num(f.attributes.DIA_Code);
    line('privateLines', f, t === 'SW' ? 'ditch' : 'pipe', { width: dia > 0 && dia <= 72 ? toM(dia, IN) : undefined, perforated: t === 'PERF' || undefined, owner: 'private' }, true);
  }
  const ground = await openGround(boundaryBox(boundary));
  const dirNotes = settle(lines, ground, 'compass', extra);
  extra['lines.pathGaps'] = gaps.n;

  const notes = [
    ...dirNotes,
    `Catch basin ports: outlet (POT, POT2) and inlet (PIN1-4) azimuths where a size is recorded; a line end within 2 m of a basin that leaves it within ${TOL_DEG} degrees of one port kind says its order`,
    'Catch basins are drains unless the lid is solid; tees, pipe inlets, flow restrictors and pollution control basins are junctions; OUT structures are pipe outlets (the walk goes on)',
    'Drainage structures: pipe detention, ponds and vaults hold; pipe outlets and ditch ends are outlets; the rest are junctions. None is marked as an outfall',
    'Private lines and points (owner private): catch basins, yard and footing drains take water; splash blocks let it out onto the ground; swales are ditches',
    'The city sits between Bellevue and Medina: drains whose pipes leave the city end where its map does',
    'No license terms stated on the items. Dropped: staff, comments, condition and inspection fields; private parcels and city parcels (never requested)',
  ];
  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Clyde Hill',
    county: 'King',
    credit: 'Storm drain data: City of Clyde Hill GIS, provided as is.',
    disclaimer: 'City of Clyde Hill GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildClydeHill);
