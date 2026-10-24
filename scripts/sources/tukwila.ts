// City of Tukwila storm drains -> <cache>/sources/tukwila/{assets.ndjson,meta.json}.
// The city's public utility viewer, a May 2020 snapshot. Pipes and ditches name their end points by type and ID
// (From_Type/From_ID -> To_Type/To_ID: CB = catch basin, IE and FL = drain points); From_Elev/To_Elev and the
// ground (USGS 3DEP) are the independent checks of that order.
// node scripts/sources/tukwila.ts [--refresh] [--box=w,s,e,n]
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
  type Built,
  type EsriFeature,
  type LayerQuery,
  type RunOptions,
} from './bellevue.ts';
import { groundSign, openGround } from './lib/downhill.ts';
import { boundaryBox } from './mercer-island.ts';

const KEY = 'tukwila';
const BASE = 'https://services7.arcgis.com/ttErFEyWkCDr9b67/arcgis/rest/services/Tukwila_Utility_Viewer_2_WFL1/FeatureServer';
const GEOID = '5372625';
const LIVE = "Status = 'ACTIVE' OR Status IS NULL";

const layers = {
  catchBasins: { name: 'catch-basins', url: `${BASE}/6`, fields: ['OBJECTID', 'ID', 'Asset_ID', 'CB_Lid', 'CB_Type', 'Owner', 'Status'], where: LIVE },
  drainPoints: { name: 'drain-points', url: `${BASE}/7`, fields: ['OBJECTID', 'ID', 'Asset_ID', 'Sub_Type', 'Flow_Direction', 'Owner', 'Status'], where: LIVE },
  lines: { name: 'lines', url: `${BASE}/8`, fields: ['OBJECTID', 'ID', 'Asset_ID', 'From_ID', 'To_ID', 'From_Type', 'To_Type', 'From_Diam', 'From_Elev', 'To_Elev', 'Sub_Type', 'Owner', 'Status'], where: LIVE },
  facilities: { name: 'facilities', url: `${BASE}/12`, fields: ['OBJECTID', 'Asset_ID', 'Type', 'Function_', 'Owner', 'Status'], where: LIVE },
} satisfies Record<string, LayerQuery>;

function tukwilaOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s) return undefined;
  if (s === 'COT') return 'public';
  if (s === 'PRIVATE') return 'private';
  return 'other';
}

const SOLID = new Set(['SOLID RECT LID', 'SOLID MH LID']);
/** Sub_Type: 1 closed pipe, 2 culvert, 3 ditch, 4 trench drain */
const LINE_ROLES: Record<number, Role> = { 1: 'pipe', 2: 'culvert', 3: 'ditch', 4: 'pipe' };
const SOAKS = new Set(['INFILTRATION']);

export async function buildTukwila(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<keyof typeof layers, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [keyof typeof layers, LayerQuery][]) {
    opts.log(`tukwila ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.26, 47.47]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);

  // node keys: cb:<ID> for catch basins, dp:<ID> for drain points
  const point = (prefix: string, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const a = f.attributes;
    const id = str(a.Asset_ID) || `${prefix}-oid:${str(a.OBJECTID)}`;
    const key = str(a.ID) ? nodes.add(`${prefix}:${str(a.ID)}`, at) : undefined;
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: tukwilaOwner(a.Owner), ...more });
    inc(`points.${prefix}.${role}`);
  };
  for (const f of L.catchBasins) {
    const a = f.attributes;
    const soak = str(a.CB_Type) === 'CB 2 INFILTRATE';
    point('cb', f, SOLID.has(str(a.CB_Lid)) ? 'junction' : 'drain', soak ? { openBottom: true } : {});
  }
  for (const f of L.drainPoints) {
    // OUT: a pipe end where water leaves into a ditch, stream or river; the walk goes on where the map does
    if (str(f.attributes.Flow_Direction) === 'OUT') point('dp', f, 'outfall', { endHint: 'unknown' });
    else point('dp', f, 'junction');
  }
  for (const f of L.facilities) {
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const a = f.attributes;
    const role: Role = SOAKS.has(str(a.Function_)) ? 'facility-infiltrate' : 'facility-hold';
    const id = str(a.Asset_ID) || `facilities:${str(a.OBJECTID)}`;
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: tukwilaOwner(a.Owner) });
  }

  const keyOf = (type: string, id: string): string => {
    if (!id) return '';
    if (type === 'CB') return `cb:${id}`;
    if (type === 'IE' || type === 'FL') return `dp:${id}`;
    // not assessed: whichever layer has that ID
    if (type === 'UNK' || !type) return nodes.byId.has(`cb:${id}`) ? `cb:${id}` : nodes.byId.has(`dp:${id}`) ? `dp:${id}` : '';
    return `${type.toLowerCase()}:${id}`;
  };

  const gaps = { n: 0 };
  const keyless: SourceAsset[] = [];
  let asDrawn = 0;
  let flipped = 0;
  const inv = { agree: 0, disagree: 0 };
  for (const f of L.lines) {
    const a = f.attributes;
    const role = LINE_ROLES[num(a.Sub_Type)];
    if (!role) {
      inc(`skipped.lineType${str(a.Sub_Type) || 'Blank'}`);
      continue;
    }
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const fromElev = num(a.From_Elev);
    const toElev = num(a.To_Elev);
    const base: SourceAsset = {
      role, id: str(a.Asset_ID) || `lines:${str(a.OBJECTID)}`, src: KEY, coords, trust: 'none', owner: tukwilaOwner(a.Owner),
      width: role === 'pipe' || role === 'culvert' ? toM(num(a.From_Diam), IN) : undefined,
    };
    const up = keyOf(str(a.From_Type), str(a.From_ID));
    const down = keyOf(str(a.To_Type), str(a.To_ID));
    if (up || down) {
      const before = ends.resolved;
      const o = orientByKeys(nodes, coords, up, down, ends);
      const asset = { ...base, coords: o.coords, fromId: o.fromId, toId: o.toId };
      if (ends.resolved > before) {
        if (o.reversed) flipped++;
        else asDrawn++;
        asset.trust = 'id';
        if (fromElev > 0 && toElev > 0 && Math.abs(fromElev - toElev) >= 0.01) {
          if (fromElev > toElev) inv.agree++;
          else inv.disagree++;
          [asset.upInv, asset.downInv] = [toM(fromElev, FT), toM(toElev, FT)];
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

  const ground = await openGround(boundaryBox(boundary));
  const g = { keyedDown: 0, keyedUp: 0, keylessDown: 0, keylessUp: 0 };
  for (const a of assets) {
    if (a.trust !== 'id') continue;
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
  Object.assign(extra, {
    'keyed.asDrawn': asDrawn, 'keyed.flipped': flipped, 'keyed.elevAgree': inv.agree, 'keyed.elevDisagree': inv.disagree,
    'ground.keyed.downhill': g.keyedDown, 'ground.keyed.uphill': g.keyedUp, 'ground.keyless.downhill': g.keylessDown, 'ground.keyless.uphill': g.keylessUp,
    'lines.keyless': keyless.length, 'lines.pathGaps': gaps.n,
  });
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');

  const notes = [
    'Source: the city\'s public Tukwila Utility Viewer feature service, a May 2020 snapshot (newer pipes are not in it)',
    `Keyed lines: From -> To is the flow order; ${asDrawn}/${asDrawn + flipped} (${pct(asDrawn, asDrawn + flipped)}) were already drawn that way`,
    `From_Elev/To_Elev (ft) fall from the From end to the To end on ${inv.agree}/${inv.agree + inv.disagree} (${pct(inv.agree, inv.agree + inv.disagree)}) keyed lines that carry both`,
    `Ground (USGS 3DEP, ends at least 0.5 m apart) falls along ${g.keyedDown}/${g.keyedDown + g.keyedUp} (${pct(g.keyedDown, g.keyedDown + g.keyedUp)}) keyed lines as oriented, and along ${g.keylessDown}/${g.keylessDown + g.keylessUp} (${pct(g.keylessDown, g.keylessDown + g.keylessUp)}) of the ${keyless.length} lines no key orients, as drawn`,
    `The ${keyless.length} lines no key orients are ${ok ? "'digitized' (kept as drawn)" : "'none'"}`,
    'Catch basins are drains unless the lid is solid; infiltrating Type 2 basins have open bottoms',
    "Drain points: Flow_Direction OUT -> outfall 'unknown' (the walk goes on where the map does); IN, ditch flow points and connections -> junctions",
    'Lines: closed pipes and trench drains -> pipe, culverts -> culvert, ditches -> ditch. Detention and water quality outlines hold water; infiltration ones soak in',
    'owner: public = Tukwila (COT), private = Private, other = King County, WSDOT and others',
    'Only active features. Dropped: Near_Road, Comments, Record_Link, survey and data-source fields (never requested); the staff-only iMap service is not used',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Tukwila',
    county: 'King',
    credit: 'Storm drain data: City of Tukwila GIS (May 2020 snapshot), provided as is.',
    disclaimer: 'City of Tukwila GIS data (May 2020 snapshot) is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildTukwila);
