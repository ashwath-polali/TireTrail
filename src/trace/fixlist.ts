// Fix list: creek-bound endings carrying runoff from the most street length.
import { GridIndex, nearestOnPolyline, type XY } from '../geo/geo.ts';
import type { Asset } from './assets.ts';
import type { Network } from './network.ts';
import type { StreetResult } from './streets.ts';
import { describe, type EndingCode, type OutfallInfo, type Trace } from './trace.ts';

export interface FixItem {
  rank: number;
  /** Asset index. */
  exit: number;
  exitId: string;
  /** Asset type + ID, receiving water, nearest street. No business names. */
  label: string;
  code: EndingCode;
  receiving: string;
  /** Street meters whose runoff reaches the creek here. */
  streetM: number;
  /** Creek-bound drains ending here. */
  drains: number;
  /** Top contributing streets, longest first. */
  streets: string[];
  nearStreet: string;
  /** Part of streetM whose path crosses a bridged gap. */
  inferredStreetM: number;
  /** Bridged links on those paths, e.g. "ditch CH-M8-915 -> pipe ML-M8-19997 (4.81 m gap)". */
  bridges: string[];
  /** Exit point, local meters. */
  point: XY;
}

/** Where water leaves an asset: line end, else anchor. */
export function exitPoint(a: Asset): XY {
  return a.line ? a.line[a.line.length - 1] : a.anchor;
}

/** "214TH AVE E" -> "214th Ave E"; route prefixes and compass directions stay upper. */
export function streetTitle(name: string): string {
  const keep = new Set(['SR', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
  return name
    .trim()
    .split(/\s+/)
    .map((w) => {
      const u = w.toUpperCase();
      if (keep.has(u)) return u;
      if (/^\d+(ST|ND|RD|TH)$/.test(u)) return u.toLowerCase();
      if (/^MC[A-Z]{2,}$/.test(u)) return `Mc${u.charAt(2)}${u.slice(3).toLowerCase()}`;
      return u.charAt(0) + u.slice(1).toLowerCase();
    })
    .join(' ');
}

export function buildFixList(
  net: Network,
  traces: readonly Trace[],
  streets: StreetResult,
  outfalls: ReadonlyMap<string, OutfallInfo>,
  count = 5,
): FixItem[] {
  // bridged links each drain's path crosses
  const bridgesOf = (t: Trace): string[] => {
    const out: string[] = [];
    for (let i = 1; i < t.path.length; i++) {
      const l = net.out[t.path[i - 1]].find((x) => x.to === t.path[i])!;
      if (l.how.startsWith('bridge')) out.push(`${describe(net.assets[l.from])} → ${describe(net.assets[l.to])} (${l.gapM} m gap)`);
    }
    return out;
  };

  const byExit = new Map<number, { streetM: number; inferredM: number; bridges: Set<string>; byStreet: Map<string, number> }>();
  for (const run of streets.runs) {
    if (run.cls !== 'creek') continue;
    const trace = traces[run.drain];
    const exit = trace.ending.exit;
    const entry = byExit.get(exit) ?? { streetM: 0, inferredM: 0, bridges: new Set<string>(), byStreet: new Map() };
    entry.streetM += run.lengthM;
    const bridges = bridgesOf(trace);
    if (bridges.length) {
      entry.inferredM += run.lengthM;
      for (const b of bridges) entry.bridges.add(b);
    }
    const name = streetTitle(streets.pieces[run.piece].name || 'unnamed street');
    entry.byStreet.set(name, (entry.byStreet.get(name) ?? 0) + run.lengthM);
    byExit.set(exit, entry);
  }

  // nearest named street, for a readable label
  const streetIndex = new GridIndex<number>(100);
  streets.runs.forEach((r, i) => {
    for (const p of r.line) streetIndex.insertPoint(i, p);
  });
  const nearestStreet = (p: XY): string => {
    for (const radius of [100, 300, 1000]) {
      let best = '';
      let bestD = Infinity;
      for (const i of streetIndex.near(p, radius)) {
        const r = streets.runs[i];
        const name = streets.pieces[r.piece].name;
        const d = nearestOnPolyline(p, r.line).d;
        if (name && d <= radius && (d < bestD || (d === bestD && name < best))) [best, bestD] = [name, d];
      }
      if (best) return streetTitle(best);
    }
    return '';
  };

  const ranked = [...byExit.entries()]
    .map(([exit, v]) => ({ exit, ...v }))
    // stable: most street first, then key
    .sort((a, b) => b.streetM - a.streetM || (net.assets[a.exit].key < net.assets[b.exit].key ? -1 : 1))
    .slice(0, count);

  return ranked.map((r, i) => {
    const a = net.assets[r.exit];
    const ending = traces.find((t) => t.ending.exit === r.exit && t.ending.cls === 'creek')!.ending;
    const point = exitPoint(a);
    const near = nearestStreet(point);
    let what: string;
    if (ending.code === 'outfall-creek') what = `Outfall ${outfalls.get(a.id)!.outfallId} (${describe(a)}) into ${ending.receiving}`;
    else if (ending.code === 'stream-creek') what = `${capitalize(describe(a))} where it meets ${ending.receiving}`;
    else what = `${capitalize(describe(a))}, listed as draining to Fennel Creek`;
    const drains = traces.filter((t) => t.ending.exit === r.exit && t.ending.cls === 'creek').length;
    return {
      rank: i + 1,
      exit: r.exit,
      exitId: a.id,
      label: near ? `${what}, near ${near}` : what,
      code: ending.code,
      receiving: ending.receiving,
      streetM: Math.round(r.streetM),
      drains,
      streets: [...r.byStreet.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3).map(([n]) => n),
      nearStreet: near,
      inferredStreetM: Math.round(r.inferredM),
      bridges: [...r.bridges].sort(),
      point,
    };
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
