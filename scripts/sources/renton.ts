// City of Renton storm drains -> <cache>/sources/renton/{assets.ndjson,meta.json}.
// No from/to IDs: lines join by geometry. The drawn order is checked against each pipe's recorded outfall
// and kept where that check passes; trust is 'inverts' where the inverts agree with it.
// Circuit (the outfall or outfalls a pipe drains to) is kept in receivingHint as 'circuit:OUT-0123|OUT-0124' for checking traces.
// node scripts/sources/renton.ts [--refresh] [--box=w,s,e,n]
import { GridIndex, dist, localProjection, type XY } from '../../src/geo/geo.ts';
import type { Role, SourceAsset, SourceMeta } from '../../src/county/source.ts';
import {
  DRAWN_OK,
  FT,
  IN,
  NodeIndex,
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
  type Attrs,
  type Built,
  type EsriFeature,
  type LayerQuery,
  type LonLat,
  type RunOptions,
} from './bellevue.ts';

const KEY = 'renton';
const BASE = 'https://gismaps.rentonwa.gov/as03/rest/services/Operational/SurfaceWaterSystem/MapServer';
const GEOID = '5357745';
const LIVE = "LifeCycleStatus IN ('Active','Bond') OR LifeCycleStatus IS NULL";

const layers = {
  pipes: { name: 'pipes', url: `${BASE}/108`, fields: ['OBJECTID', 'ASSETID', 'PipeFunction', 'Diameter', 'Width', 'UpperInvertElev', 'LowerInvertElev', 'Perforated', 'OwnedBy', 'Circuit', 'Name', 'LifeCycleStatus'], where: LIVE },
  virtual: { name: 'virtual', url: `${BASE}/111`, fields: ['OBJECTID'] },
  openDrains: { name: 'open-drains', url: `${BASE}/126`, fields: ['OBJECTID', 'ASSETID', 'OpenDrainType', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
  structures: { name: 'structures', url: `${BASE}/101`, fields: ['OBJECTID', 'ASSETID', 'STRUCTTYPE', 'LidType', 'OwnedBy', 'Circuit', 'LifeCycleStatus'], where: LIVE },
  outfalls: { name: 'outfalls', url: `${BASE}/104`, fields: ['OBJECTID', 'ASSETID', 'OutfallTo', 'OutfallType', 'InvertElev', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
  fittings: { name: 'fittings', url: `${BASE}/105`, fields: ['OBJECTID', 'ASSETID', 'FITTINGTYP', 'LifeCycleStatus'], where: LIVE },
  wq: { name: 'wq-facilities', url: `${BASE}/106`, fields: ['OBJECTID', 'ASSETID', 'STRUCTURETYPE', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
  detention: { name: 'detention', url: `${BASE}/107`, fields: ['OBJECTID', 'ASSETID', 'DETENTIONTYPE', 'Infiltration', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
  pumps: { name: 'pumps', url: `${BASE}/103`, fields: ['OBJECTID', 'ASSETID', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
  outlines: { name: 'outlines', url: `${BASE}/112`, fields: ['OBJECTID', 'AssocFacilityID', 'STRUCTURETYPE', 'OwnedBy', 'LifeCycleStatus'], where: LIVE },
} satisfies Record<string, LayerQuery>;
type LayerName = keyof typeof layers;

const CITY_OWNERS = new Set(['Renton', 'PARKS', 'AIRPORT', 'Renton Facilities Department', 'Renton Other Utility']);
function rentonOwner(v: unknown): SourceAsset['owner'] {
  const s = str(v);
  if (!s || s === 'Unknown') return undefined;
  if (CITY_OWNERS.has(s)) return 'public';
  if (s.startsWith('Private')) return 'private';
  return 'other';
}

/** OUT-677 and OUT-0677 are the same outfall */
export function circuitId(v: unknown): string {
  const s = str(v).toUpperCase();
  const m = /^OUT-?0*(\d+)$/.exec(s);
  return m ? `OUT-${m[1].padStart(4, '0')}` : s;
}

/** Circuit can list several outfalls: "OUT-0285 & OUT-0463", "OUT-0004, OUT-0006, & OUT-0474" */
export function circuitIds(v: unknown): string[] {
  return str(v)
    .split(/,|&|\band\b/i)
    .map((t) => circuitId(t))
    .filter(Boolean);
}

const SOLID = new Set(['Solid', 'Solid Locking']);
const INFILTRATING = new Set(['Permeable Pavement', 'Rain Garden', 'Infiltration Trench', 'Drywell', 'Dispersion Trench', 'Bioretention']);
const HOLDING = new Set(['Vault', 'Pond', 'Tank', 'Chambers', 'Stormtech Chamber', 'Natural Wetland', 'Stormwater Wetland', 'Wet Pond', 'Wet Vault']);
const WATER_OUTFALLS: Record<string, string> = {
  Stream: 'stream',
  'Wetland or natural area': 'wetland',
  Wetland: 'wetland',
  River: 'river',
  'Cedar River': 'Cedar River',
  'Lake Washington': 'Lake Washington',
};

export async function buildRenton(opts: RunOptions): Promise<Built> {
  const raw = rawDirFor(KEY, opts);
  const L = {} as Record<LayerName, EsriFeature[]>;
  for (const [name, q] of Object.entries(layers) as [LayerName, LayerQuery][]) {
    opts.log(`renton ${q.name}`);
    L[name] = await fetchLayer({ ...q, page: 1000 }, raw, opts);
  }
  const boundary = await fetchBoundary(GEOID, raw, opts);

  const assets: SourceAsset[] = [];
  const nodes = new NodeIndex([-122.2, 47.48]);
  const extra: Record<string, number> = {};
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const idOf = (layer: LayerName, a: Attrs) => str(a.ASSETID) || `${layers[layer].name}:${str(a.OBJECTID)}`;

  const point = (layer: LayerName, f: EsriFeature, role: Role, more: Partial<SourceAsset> = {}) => {
    const at = pointOf(f.geometry);
    if (!at) return inc('skipped.noGeometry');
    const id = idOf(layer, f.attributes);
    const key = nodes.add(id, at);
    assets.push({ role, id, src: KEY, key, coords: [at], trust: 'none', owner: rentonOwner(f.attributes.OwnedBy), ...more });
  };
  // circuit ids written as the outfalls' own ASSETIDs where one exists
  const outfallId = new Map(L.outfalls.map((f) => [circuitId(f.attributes.ASSETID), str(f.attributes.ASSETID)]));
  const circuitHint = (a: Attrs) => {
    const ids = circuitIds(a.Circuit).map((c) => outfallId.get(c) ?? c);
    return ids.length ? { receivingHint: `circuit:${ids.join('|')}` } : {};
  };
  const oneCircuit = (a: Attrs) => {
    const ids = circuitIds(a.Circuit);
    return ids.length === 1 ? ids[0] : undefined;
  };

  for (const f of L.structures) {
    const a = f.attributes;
    const t = str(a.STRUCTTYPE);
    const grate = !SOLID.has(str(a.LidType));
    if (t.startsWith('CB') || t === 'Inlet' || t === 'Yard Drain') point('structures', f, grate ? 'drain' : 'junction', circuitHint(a));
    else if (t === 'Drywell') point('structures', f, grate ? 'drain' : 'junction', { openBottom: true, ...circuitHint(a) });
    else if (t === 'Vault') point('structures', f, 'facility-hold', circuitHint(a));
    else point('structures', f, 'junction', circuitHint(a));
  }
  for (const f of L.outfalls) {
    const a = f.attributes;
    const water = WATER_OUTFALLS[str(a.OutfallTo)];
    point('outfalls', f, 'outfall', water ? { endHint: 'water', receivingHint: water } : { endHint: 'unknown' });
  }
  for (const f of L.fittings) point('fittings', f, 'junction');
  for (const f of L.pumps) point('pumps', f, 'junction');
  for (const f of L.wq) {
    const t = str(f.attributes.STRUCTURETYPE);
    point('wq', f, INFILTRATING.has(t) ? 'facility-infiltrate' : HOLDING.has(t) ? 'facility-hold' : 'junction');
  }
  for (const f of L.detention) {
    const a = f.attributes;
    const t = str(a.DETENTIONTYPE);
    point('detention', f, num(a.Infiltration) === 1 || INFILTRATING.has(t) ? 'facility-infiltrate' : 'facility-hold');
  }
  for (const f of L.outlines) {
    const a = f.attributes;
    const rings = outerRings(f.geometry);
    if (!rings.length) {
      inc('skipped.noGeometry');
      continue;
    }
    const t = str(a.STRUCTURETYPE);
    const role: Role = INFILTRATING.has(t) ? 'facility-infiltrate' : 'facility-hold';
    const id = str(a.AssocFacilityID) || `outlines:${str(a.OBJECTID)}`;
    for (const ring of rings) assets.push({ role, id, src: KEY, coords: ring, trust: 'none', owner: rentonOwner(a.OwnedBy) });
  }

  // lines stay as drawn here; the circuit check below says how far the drawn order can be trusted
  const gaps = { n: 0 };
  const lines: CheckLine[] = [];
  const inverts = new Map<SourceAsset, [number, number]>();

  for (const f of L.pipes) {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) {
      inc('skipped.noGeometry');
      continue;
    }
    const fn = str(a.PipeFunction);
    const name = str(a.Name);
    const stream = !!name && name !== 'Wetland';
    const role: Role = stream ? 'stream-culvert' : fn === 'Culvert' ? 'culvert' : 'pipe';
    let dia = num(a.Diameter);
    if (dia === 168) dia = 198;
    if (dia <= 0) dia = num(a.Width);
    // Upper/Lower taken as the inverts at the first/last vertex
    const up = num(a.UpperInvertElev);
    const down = num(a.LowerInvertElev);
    const s = invertSign(up, down);
    const asset: SourceAsset = {
      role,
      id: idOf('pipes', a),
      src: KEY,
      coords,
      trust: 'none',
      owner: rentonOwner(a.OwnedBy),
      width: dia > 0 ? Math.round(dia * IN * 1000) / 1000 : undefined,
      perforated: num(a.Perforated) === 1 || fn === 'Underdrain' || fn === 'Infiltration' || undefined,
      liveStream: stream || undefined,
      ...circuitHint(a),
      upInv: up > 0 ? m(up) : undefined,
      downInv: down > 0 ? m(down) : undefined,
    };
    assets.push(asset);
    inverts.set(asset, [up, down]);
    lines.push({ asset, group: s > 0 ? 'invertsAgree' : s < 0 ? 'invertsDisagree' : 'noInverts', circuit: oneCircuit(a) });
  }
  for (const f of L.virtual) {
    const coords = lineOf(f.geometry, gaps);
    if (!coords) continue;
    const asset: SourceAsset = { role: 'virtual', id: idOf('virtual', f.attributes), src: KEY, coords, trust: 'none' };
    assets.push(asset);
    lines.push({ asset, group: 'virtual' });
  }
  for (const f of L.openDrains) {
    const a = f.attributes;
    const coords = lineOf(f.geometry, gaps);
    if (!coords) continue;
    const asset: SourceAsset = { role: 'ditch', id: idOf('openDrains', a), src: KEY, coords, trust: 'none', owner: rentonOwner(a.OwnedBy) };
    assets.push(asset);
    lines.push({ asset, group: 'openDrains' });
  }

  const outfallAt = new Map<string, LonLat>();
  for (const f of L.outfalls) {
    const at = pointOf(f.geometry);
    if (at) outfallAt.set(circuitId(f.attributes.ASSETID), at);
  }
  const check = circuitCheck(lines, outfallAt);
  const ok = (g: string) => {
    const d = check[g] ?? { toward: 0, away: 0 };
    return d.toward + d.away >= 20 && d.toward / (d.toward + d.away) >= DRAWN_OK;
  };
  for (const l of lines) {
    const a = l.asset;
    if (l.group === 'invertsAgree') a.trust = 'inverts';
    else if (l.group === 'invertsDisagree') {
      if (ok('invertsDisagree')) a.trust = 'digitized';
      else {
        // inverts win: reverse
        const [up, down] = inverts.get(a)!;
        a.coords = [...a.coords].reverse();
        a.trust = 'inverts';
        a.upInv = m(Math.max(up, down));
        a.downInv = m(Math.min(up, down));
        inc('lines.reversedToInverts');
      }
    } else if (ok(l.group)) a.trust = 'digitized';
  }

  const notes: string[] = [];
  const groups = ['invertsAgree', 'invertsDisagree', 'noInverts', 'virtual', 'openDrains'];
  for (const g of groups) {
    const d = check[g] ?? { toward: 0, away: 0 };
    extra[`circuitCheck.${g}.toward`] = d.toward;
    extra[`circuitCheck.${g}.away`] = d.away;
    extra[`lines.${g}`] = lines.filter((l) => l.group === g).length;
  }
  const share = (g: string) => {
    const d = check[g] ?? { toward: 0, away: 0 };
    return `${d.toward}/${d.toward + d.away} (${d.toward + d.away ? ((100 * d.toward) / (d.toward + d.away)).toFixed(1) : '-'}%)`;
  };
  notes.push(
    `Circuit check (network distance to the pipe's recorded outfall, drawn last end nearer = drawn toward it): inverts agree with drawing ${share('invertsAgree')}, inverts disagree ${share('invertsDisagree')}, no inverts ${share('noInverts')}, virtual ${share('virtual')}, open drains ${share('openDrains')}`,
    `Pipes with inverts that agree with the drawing (${extra['lines.invertsAgree']}): 'inverts'. Inverts that disagree (${extra['lines.invertsDisagree']}): ${ok('invertsDisagree') ? "kept as drawn, 'digitized' (the circuit check says the drawing is right)" : "reversed, 'inverts'"}`,
    `No inverts (${extra['lines.noInverts']}): ${ok('noInverts') ? "'digitized'" : "'none'"}; virtual (${extra['lines.virtual']}): ${ok('virtual') ? "'digitized'" : "'none'"}; open drains (${extra['lines.openDrains']}): ${ok('openDrains') ? "'digitized'" : "'none'"}`,
  );
  extra['lines.pathGaps'] = gaps.n;
  notes.push(
    "Circuit (recorded outfall per pipe and structure) is in receivingHint as 'circuit:<ids>' joined by '|', written as the outfalls' own ASSETIDs (OUT-0123 or OUT-677); a few name a detention facility instead",
    'owner: public = City of Renton (incl. Parks, Airport, Facilities), private = Private and HOA, other = WSDOT, King County, other agencies',
    'Dropped: LOCDESC, ProjectName, Filecode, drawings, Notes, AttUpdateBy/GeoUpdateBy (never requested); layer 77 complaints and inactive layers not used',
  );

  const meta: SourceMeta = {
    key: KEY,
    name: 'City of Renton',
    county: 'King',
    credit: 'Storm drain data: City of Renton GIS, provided as is.',
    disclaimer: 'City of Renton GIS data is provided as is, without warranty of any kind.',
    fetchedAt: fetchedAt(raw),
    boundary,
    counts: summarize(assets, boundary, newEnds(), extra),
    notes: opts.box ? [`box ${opts.box.join(',')} only`, ...notes] : notes,
  };
  return { assets, meta };
}

const m = (ft: number) => Math.round(ft * FT * 1000) / 1000;

export interface CheckLine {
  asset: SourceAsset;
  group: string;
  circuit?: string;
}

/**
 * For lines tagged with an outfall (virtual lines and ditches take the tag of a pipe they touch):
 * network distance from each end to that outfall, over the lines of the same tag. Drawn toward
 * the outfall when the last vertex is nearer. Counts per group.
 */
export function circuitCheck(lines: CheckLine[], outfallAt: Map<string, LonLat>): Record<string, { toward: number; away: number }> {
  // ends within 1.5 m are one node
  const proj = localProjection([-122.2, 47.48]);
  const grid = new GridIndex<number>(3);
  const nodeXY: XY[] = [];
  const nodeOf = (p: LonLat): number => {
    const q = proj.toXY(p);
    for (const n of grid.near(q, 1.5)) if (Math.hypot(nodeXY[n][0] - q[0], nodeXY[n][1] - q[1]) <= 1.5) return n;
    nodeXY.push(q);
    grid.insertPoint(nodeXY.length - 1, q);
    return nodeXY.length - 1;
  };
  const E = lines.map((l) => {
    const c = l.asset.coords;
    let len = 0;
    for (let i = 1; i < c.length; i++) len += dist(proj.toXY(c[i - 1]), proj.toXY(c[i]));
    return { u: nodeOf(c[0]), v: nodeOf(c[c.length - 1]), len, tag: l.circuit };
  });
  const nodeTag = new Map<number, string>();
  for (const e of E) if (e.tag) nodeTag.set(e.u, e.tag).set(e.v, e.tag);
  for (const [i, e] of E.entries()) if (!e.tag && !lines[i].circuit) e.tag = nodeTag.get(e.u) ?? nodeTag.get(e.v);
  const byTag = new Map<string, number[]>();
  E.forEach((e, i) => {
    if (!e.tag) return;
    const list = byTag.get(e.tag);
    if (list) list.push(i);
    else byTag.set(e.tag, [i]);
  });
  const out: Record<string, { toward: number; away: number }> = {};
  for (const [tag, list] of byTag) {
    const o = outfallAt.get(tag);
    if (!o) continue;
    const oq = proj.toXY(o);
    const adj = new Map<number, { to: number; w: number }[]>();
    const link = (a: number, b: number, w: number) => {
      const l = adj.get(a);
      if (l) l.push({ to: b, w });
      else adj.set(a, [{ to: b, w }]);
    };
    for (const i of list) {
      link(E[i].u, E[i].v, E[i].len);
      link(E[i].v, E[i].u, E[i].len);
    }
    // Dijkstra from the nodes within 30 m of the outfall
    const d = new Map<number, number>();
    const heap: [number, number][] = [];
    const push = (n: number, v: number) => {
      if ((d.get(n) ?? Infinity) <= v) return;
      d.set(n, v);
      heapPush(heap, [v, n]);
    };
    for (const n of adj.keys()) {
      const d0 = dist(nodeXY[n], oq);
      if (d0 < 30) push(n, d0);
    }
    while (heap.length) {
      const [v, n] = heapPop(heap);
      if (v > (d.get(n) ?? Infinity)) continue;
      for (const e of adj.get(n) ?? []) push(e.to, v + e.w);
    }
    for (const i of list) {
      const du = d.get(E[i].u);
      const dv = d.get(E[i].v);
      if (du === undefined || dv === undefined || Math.abs(du - dv) < 0.5) continue;
      const g = (out[lines[i].group] ??= { toward: 0, away: 0 });
      if (du > dv) g.toward++;
      else g.away++;
    }
  }
  return out;
}

function heapPush(h: [number, number][], x: [number, number]): void {
  h.push(x);
  for (let i = h.length - 1; i > 0; ) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h: [number, number][]): [number, number] {
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

if (isMain(import.meta.url)) await runCli(KEY, buildRenton);
