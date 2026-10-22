// City of Auburn storm drains (King and Pierce parts) -> <cache>/sources/auburn/{assets.ndjson,meta.json}.
// Lines name their start and end structures (SSTRUCTURE/ESTRUCTURE = point STRUCTURE). Start/end is not
// always up/down, so each line is oriented by its own elevations, then the end structures' outlet elevations,
// then pumps and catch basin outlet directions, and last the start -> end order.
// node scripts/sources/auburn.ts [--refresh] [--box=w,s,e,n]
import type { Role, SourceAsset, SourceMeta, Trust } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  NodeIndex,
  fetchBoundary,
  fetchLayer,
  fetchedAt,
  invertSign,
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
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';

const KEY = 'auburn';
const A = 'https://gis.auburnwa.gov/hosting/rest/services/Storm/StormA/MapServer';
const B = 'https://gis.auburnwa.gov/hosting/rest/services/Storm/StormB/MapServer';
const GEOID = '5303180';
const LIVE = "(STATUS IS NULL OR STATUS IN ('EXISTING','COMPLETED')) AND RETIRED IS NULL";

const LINE = ['OBJECTID', 'ID', 'SSTRUCTURE', 'ESTRUCTURE', 'SELEVATION', 'SELEVATIONUNIT', 'EELEVATION', 'EELEVATIONUNIT', 'OWNER', 'STATUS', 'RETIRED'];
const layers = {
  pipes: { name: 'pipes', url: `${A}/8`, fields: [...LINE, 'PIPETYPE', 'PIPEMATERIAL', 'UNDERDRAIN', 'PIPESIZE', 'PIPESIZEUNIT'], where: LIVE },
  culverts: { name: 'culverts', url: `${A}/7`, fields: [...LINE, 'PIPESIZE', 'PIPESIZEUNIT'], where: LIVE },
  channels: { name: 'channels', url: `${A}/6`, fields: [...LINE, 'CHANNELTYPE'], where: LIVE },
  catchBasins: { name: 'catch-basins', url: `${A}/1`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'OUTELEVATION', 'OUTELEVATIONUNIT', 'DRYWELL', 'OUTDIRECTION', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  manholes: { name: 'manholes', url: `${A}/3`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'OUTELEVATION', 'OUTELEVATIONUNIT', 'DRYWELL', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${A}/4`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'OUTLOCATION', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  infalls: { name: 'infalls', url: `${A}/2`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  pumps: { name: 'pumps', url: `${A}/5`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'MAIN', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  aux: { name: 'aux', url: `${A}/0`, fields: ['OBJECTID', 'ID', 'STRUCTURE', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
  sites: { name: 'detention-sites', url: `${B}/2`, fields: ['OBJECTID', 'ID', 'SITETYPE', 'OWNER', 'STATUS', 'RETIRED'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const CITY_OWNERS = new Set(['COA', 'PUBLIC']);
function auburnOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v).toUpperCase();
  if (!s) return undefined;
  if (CITY_OWNERS.has(s)) return 'public';
  if (s === 'PRIVATE') return 'private';
  return 'other';
}

const WATER: Record<string, string> = {
  'GREEN RIVER': 'Green River',
  'WHITE RIVER': 'White River',
  'MILL CREEK': 'Mill Creek',
  'BOWMAN CREEK': 'Bowman Creek',
  STREAM: 'stream',
  WETLAND: 'wetland',
  TAILRACE: 'tailrace',
};
const GROUND = new Set(['GROUND', 'INFILTRATION']);
const INFILTRATING_SITES = new Set(['INFILTRATION', 'INFILTRATION POND', 'UIC', 'BIORETENTION', 'PERMEABLE PAVEMENT']);
const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Feet unless the unit field says meters. */
const elevM = (v: unknown, unit: unknown): number => {
  const x = num(v);
  if (!(x > 0)) return 0;
  return str(unit) === 'm' ? x : x * FT;
};
const SIZE_M: Record<string, number> = { in: 0.0254, ft: FT, mm: 0.001, cm: 0.01, m: 1 };

/** Compass bearing in degrees from a to b. */
function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}
const within = (a: number, b: number, tol: number) => Math.abs(((a - b + 540) % 360) - 180) <= tol;

type Evidence = 'lineInverts' | 'nodeInverts' | 'pump' | 'compass' | 'endRoles';

export async function buildAuburn(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`auburn ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 2000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.21, 47.3]);
  const ends = newEnds();
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  // per point key: outlet elevation (m), outlet compass bearing, role
  const outElev = new Map<string, number>();
  const outDir = new Map<string, number>();
  const roleOf = new Map<string, Role>();
  const pumpMain = new Map<string, string>();

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}): string | undefined => {
    const at = pointOf(f.geometry);
    if (!at) {
      inc('skipped.noGeometry');
      return undefined;
    }
    const a = f.attributes;
    const id = str(a.ID) || `${layers[layer].name}:${str(a.OBJECTID)}`;
    const key = nodes.add(str(a.STRUCTURE) || id, at);
    roleOf.set(key, role);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: auburnOwner(a.OWNER), ...more });
    return key;
  };

  for (const f of L.catchBasins) {
    const a = f.attributes;
    const dir = str(a.OUTDIRECTION);
    const soak = str(a.DRYWELL) === 'YES' || dir === 'GROUND';
    const key = point('catchBasins', f, 'drain', soak ? { openBottom: true } : {});
    if (!key) continue;
    const e = elevM(a.OUTELEVATION, a.OUTELEVATIONUNIT);
    if (e) outElev.set(key, e);
    if (dir in COMPASS) outDir.set(key, COMPASS[dir]);
  }
  for (const f of L.manholes) {
    const a = f.attributes;
    const key = point('manholes', f, 'junction', str(a.DRYWELL) === 'YES' ? { openBottom: true } : {});
    const e = elevM(a.OUTELEVATION, a.OUTELEVATIONUNIT);
    if (key && e) outElev.set(key, e);
  }
  for (const f of L.outfalls) {
    const loc = str(f.attributes.OUTLOCATION);
    if (WATER[loc]) point('outfalls', f, 'outfall', { endHint: 'water', receivingHint: WATER[loc] });
    else if (GROUND.has(loc)) point('outfalls', f, 'discharge', { endHint: 'ground', receivingHint: loc.toLowerCase() });
    else point('outfalls', f, 'outfall', { endHint: 'unknown', receivingHint: loc ? loc.toLowerCase() : undefined });
  }
  for (const f of L.infalls) point('infalls', f, 'junction');
  for (const f of L.pumps) {
    const key = point('pumps', f, 'junction');
    if (key && str(f.attributes.MAIN)) pumpMain.set(str(f.attributes.MAIN), key);
  }
  for (const f of L.aux) point('aux', f, 'junction');
  const infallKeys = new Set(L.infalls.map((f) => str(f.attributes.STRUCTURE)).filter(Boolean));
  for (const f of L.sites) {
    const a = f.attributes;
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const role: Role = INFILTRATING_SITES.has(str(a.SITETYPE)) ? 'facility-infiltrate' : 'facility-hold';
    const id = str(a.ID) || `detention-sites:${str(a.OBJECTID)}`;
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: auburnOwner(a.OWNER) });
  }

  const gaps = { n: 0 };
  const evidenceCount: Record<string, number> = {};
  // how each kind of evidence compares with the line's own elevations, where both exist
  const vsLine: Record<string, { agree: number; disagree: number }> = {};
  const pendingStartEnd: SourceAsset[] = [];
  const startEndSigns: number[] = [];
  let sAtFirst = 0;
  let sAtLast = 0;

  const line = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset>) => {
    const a = f.attributes;
    const drawn = lineOf(f.geometry, gaps);
    if (!drawn) return inc('skipped.noGeometry');
    const sId = str(a.SSTRUCTURE);
    const eId = str(a.ESTRUCTURE);
    // put the start structure first
    const o = orientByKeys(nodes, drawn, sId, eId, ends);
    if (o.reversed) sAtLast++;
    else if (o.fromId && nodes.keys.has(o.fromId)) sAtFirst++;
    const coords = o.coords;
    const sKey = o.fromId;
    const eKey = o.toId;
    const sEl = elevM(a.SELEVATION, a.SELEVATIONUNIT);
    const eEl = elevM(a.EELEVATION, a.EELEVATIONUNIT);

    // each test: true = flows start -> end, false = end -> start, undefined = no answer
    const tests: Partial<Record<Evidence, boolean>> = {};
    const lineSign = invertSign(sEl, eEl);
    if (lineSign) tests.lineInverts = lineSign > 0;
    const so = sKey ? outElev.get(sKey) : undefined;
    const eo = eKey ? outElev.get(eKey) : undefined;
    if (so && eo && Math.abs(so - eo) >= 0.01) tests.nodeInverts = so > eo;
    const pump = pumpMain.get(str(a.ID));
    if (pump && (pump === sKey || pump === eKey)) tests.pump = pump === sKey;
    const sDir = sKey ? outDir.get(sKey) : undefined;
    const eDir = eKey ? outDir.get(eKey) : undefined;
    const sOut = sDir !== undefined && within(sDir, bearing(coords[0], coords[1]), 45);
    const eOut = eDir !== undefined && within(eDir, bearing(coords[coords.length - 1], coords[coords.length - 2]), 45);
    if (sOut !== eOut) tests.compass = sOut;
    // an outfall or infall at one end: only reported, it agrees with the elevations on about 2 in 3
    const sRole = sKey ? roleOf.get(sKey) : undefined;
    const eRole = eKey ? roleOf.get(eKey) : undefined;
    const intoEnd = eRole === 'outfall' || eRole === 'discharge' || (!!sKey && infallKeys.has(sKey));
    const intoStart = sRole === 'outfall' || sRole === 'discharge' || (!!eKey && infallKeys.has(eKey));
    if (intoEnd !== intoStart) tests.endRoles = intoEnd;

    // each test against the line's own elevations, split by whether those say start -> end
    if (tests.lineInverts !== undefined) {
      const side = tests.lineInverts ? 'lineDown' : 'lineUp';
      for (const k of ['nodeInverts', 'pump', 'compass', 'endRoles'] as const) {
        if (tests[k] === undefined) continue;
        const v = (vsLine[`${k}.${side}`] ??= { agree: 0, disagree: 0 });
        if (tests[k] === tests.lineInverts) v.agree++;
        else v.disagree++;
      }
      startEndSigns.push(lineSign);
    }

    // Start -> end is the default. A catch basin outlet direction decides where there is one; otherwise
    // the order flips only when the line's and the end structures' elevations both say end -> start,
    // since a lone contrary elevation is more often wrong (see the lineUp counts). Force mains follow the pump.
    const forceMain = str(a.PIPETYPE) === 'FORCE MAIN';
    let sToE = true;
    let trust: Trust = 'none';
    let used = 'startEnd';
    if (forceMain) {
      if (tests.pump !== undefined) [sToE, trust, used] = [tests.pump, 'node-flags', 'pump'];
    } else if (tests.compass !== undefined) [sToE, trust, used] = [tests.compass, 'compass', 'compass'];
    else if (tests.lineInverts === false && tests.nodeInverts === false) [sToE, trust, used] = [false, 'inverts', 'bothInverts'];
    else if (tests.lineInverts === true) [trust, used] = ['inverts', 'lineInverts'];
    else if (tests.nodeInverts === true) [trust, used] = ['inverts', 'nodeInverts'];
    else if (tests.lineInverts === false || tests.nodeInverts === false) used = 'startEndOverOneInvert';
    evidenceCount[used] = (evidenceCount[used] ?? 0) + 1;
    const asset: SourceAsset = {
      role,
      id: str(a.ID) || `${layers[layer].name}:${str(a.OBJECTID)}`,
      src: KEY,
      coords: sToE ? coords : [...coords].reverse(),
      fromId: sToE ? sKey : eKey,
      toId: sToE ? eKey : sKey,
      trust,
      owner: auburnOwner(a.OWNER),
      upInv: (sToE ? sEl : eEl) || undefined,
      downInv: (sToE ? eEl : sEl) || undefined,
      ...more,
    };
    if (asset.upInv) asset.upInv = Math.round(asset.upInv * 1000) / 1000;
    if (asset.downInv) asset.downInv = Math.round(asset.downInv * 1000) / 1000;
    if (!sToE) inc('lines.flowsEndToStart');
    assets.push(asset);
    if (used.startsWith('startEnd') && !forceMain) pendingStartEnd.push(asset);
  };

  const sizeM = (a: Attrs) => {
    const s = num(a.PIPESIZE);
    const u = SIZE_M[str(a.PIPESIZEUNIT)] ?? 0.0254;
    return s > 0 ? Math.round(s * u * 1000) / 1000 : undefined;
  };
  for (const f of L.pipes) {
    const a = f.attributes;
    const perforated = str(a.PIPETYPE) === 'PERFORATED' || str(a.PIPEMATERIAL) === 'PERFORATED' || str(a.UNDERDRAIN) === 'YES';
    line('pipes', f, 'pipe', { width: sizeM(a), perforated: perforated || undefined });
  }
  for (const f of L.culverts) line('culverts', f, 'culvert', { width: sizeM(f.attributes) });
  for (const f of L.channels) {
    const stream = str(f.attributes.CHANNELTYPE) === 'STREAM';
    line('channels', f, stream ? 'stream' : 'ditch', { liveStream: stream || undefined });
  }

  // start -> end with no supporting evidence: trusted as drawn only if start -> end mostly runs downhill where elevations exist
  let down = 0;
  let up = 0;
  for (const s of startEndSigns) s > 0 ? down++ : up++;
  const share = down + up ? down / (down + up) : 0;
  const ok = down + up >= 20 && share >= DRAWN_OK;
  if (ok) for (const a of pendingStartEnd) a.trust = 'digitized';

  settleKeys(assets, nodes, extra);
  for (const [k, v] of Object.entries(evidenceCount)) extra[`orientedBy.${k}`] = v;
  for (const [k, v] of Object.entries(vsLine)) {
    extra[`vsLineInverts.${k}.agree`] = v.agree;
    extra[`vsLineInverts.${k}.disagree`] = v.disagree;
  }
  extra['startEnd.downhill'] = down;
  extra['startEnd.uphill'] = up;
  extra['startStructure.atFirstVertex'] = sAtFirst;
  extra['startStructure.atLastVertex'] = sAtLast;
  extra['lines.pathGaps'] = gaps.n;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  const vs = (k: string) => (vsLine[k] ? `${vsLine[k].agree}/${vsLine[k].agree + vsLine[k].disagree} (${pct(vsLine[k].agree, vsLine[k].agree + vsLine[k].disagree)})` : '-');
  const notes = [
    `Oriented by: ${Object.entries(evidenceCount)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    `Start -> end runs downhill on ${down}/${down + up} (${pct(down, down + up)}) lines with both elevations; the ${pendingStartEnd.length} with no other evidence are ${ok ? "'digitized'" : "'none'"}`,
    `Agreement with the line's own elevations where those say start -> end | end -> start: end-structure outlet elevations ${vs('nodeInverts.lineDown')} | ${vs('nodeInverts.lineUp')}, catch basin outlet direction ${vs('compass.lineDown')} | ${vs('compass.lineUp')}, outfall/infall at an end ${vs('endRoles.lineDown')} | ${vs('endRoles.lineUp')}`,
    `Start structure is at the first vertex on ${sAtFirst} lines and at the last on ${sAtLast}`,
    'Covers the King and Pierce (Lakeland Hills) parts; the boundary is the whole city. Includes a few pipes owned by Algona, Kent, Pierce County and WSDOT (owner other)',
    'owner: public = COA/PUBLIC, private = PRIVATE, other = other agencies and utilities',
    "Outfalls: rivers, creeks, streams, wetlands -> 'water'; GROUND/INFILTRATION -> discharge 'ground'; ditches, ponds, vaults, swales, separators -> 'unknown' with the recorded receiving type",
    'Dropped: SITENAME, STATIONNAME, NOTES, MICROFILM, CREATEDBY/EDITEDBY (never requested)',
  ];

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Auburn',
    county: 'King',
    credit: 'Storm drain data: City of Auburn GIS, provided as is.',
    disclaimer: 'City of Auburn GIS data is for general reference purposes only and is provided without warranties.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, ends, extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

if (isMain(import.meta.url)) await runCli(KEY, buildAuburn);
