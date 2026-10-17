// Headline numbers from our own trace.
import { pointInPolygon, type XY } from '../geo/geo.ts';
import type { FixItem } from './fixlist.ts';
import type { Network } from './network.ts';
import { STREET_CLASSES, type StreetClass, type StreetResult } from './streets.ts';
import { DRAIN_CLASSES, type DrainClass, type Trace } from './trace.ts';

export interface CreekShare {
  /** Drains with a known ending. */
  traceable: number;
  creek: number;
  share: number;
  /** "1 in N" traceable drains reach the creek. */
  oneIn: number;
}

export interface AppNumbers {
  drains: { total: number; byClass: Record<DrainClass, number> };
  creekShare: CreekShare;
  /** Same share inside the Fennel Creek basin. */
  creekShareFennelBasin: CreekShare & { drains: number };
  unmapped: { drains: number; share: number };
  streets: {
    pieces: number;
    lengthKm: number;
    piecesByClass: Record<StreetClass, number>;
    lengthKmByClass: Record<StreetClass, number>;
  };
  terrainVsPipes: {
    /** Street length where terrain and pipes both give an answer. */
    comparedKm: number;
    disagreeKm: number;
    disagreeShare: number;
    /** Share of all street length a terrain-only map sends to Fennel. */
    terrainCreekShare: number;
    /** Of street length with a known pipe ending, share reaching the creek. */
    pipesCreekShare: number;
    /** Terrain-only creek length, split by where pipes send it. */
    terrainCreekByPipes: Record<StreetClass, number>;
  };
  fixList: { rank: number; label: string; streetM: number; drains: number; inferredStreetM: number; bridges: string[] }[];
}

const km = (m: number) => Math.round(m / 10) / 100;
const share = (part: number, whole: number) => (whole ? part / whole : 0);
const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

function creekShare(traces: readonly Trace[]): CreekShare {
  const creek = traces.filter((t) => t.ending.cls === 'creek').length;
  const traceable = traces.filter((t) => t.ending.cls !== 'unknown').length;
  return { traceable, creek, share: share(creek, traceable), oneIn: creek ? Math.round(traceable / creek) : 0 };
}

export function computeNumbers(
  net: Pick<Network, 'assets'>,
  traces: readonly Trace[],
  streets: StreetResult,
  fixList: readonly FixItem[],
  fennelBasin: XY[][][],
): AppNumbers {
  const byClass = zero(DRAIN_CLASSES);
  for (const t of traces) byClass[t.ending.cls]++;
  const inBasin = traces.filter((t) => fennelBasin.some((rings) => pointInPolygon(net.assets[t.drain].anchor, rings)));

  const piecesByClass = zero(STREET_CLASSES);
  for (const p of streets.pieces) piecesByClass[p.cls]++;
  const lengthByClass = zero(STREET_CLASSES);
  const terrainCreekByPipes = zero(STREET_CLASSES);
  let total = 0;
  let compared = 0;
  let disagree = 0;
  let terrainCreek = 0;
  let pipesKnown = 0;
  let pipesCreek = 0;
  for (const r of streets.runs) {
    const terrain = streets.pieces[r.piece].terrain.cls;
    total += r.lengthM;
    lengthByClass[r.cls] += r.lengthM;
    if (terrain === 'creek') {
      terrainCreek += r.lengthM;
      terrainCreekByPipes[r.cls] += r.lengthM;
    }
    const pipesKnownHere = r.cls === 'creek' || r.cls === 'ground' || r.cls === 'elsewhere';
    if (pipesKnownHere) {
      pipesKnown += r.lengthM;
      if (r.cls === 'creek') pipesCreek += r.lengthM;
      if (terrain !== 'unknown') {
        compared += r.lengthM;
        if (terrain !== r.cls) disagree += r.lengthM;
      }
    }
  }

  return {
    drains: { total: traces.length, byClass },
    creekShare: creekShare(traces),
    creekShareFennelBasin: { drains: inBasin.length, ...creekShare(inBasin) },
    unmapped: { drains: byClass.unknown, share: share(byClass.unknown, traces.length) },
    streets: {
      pieces: streets.pieces.length,
      lengthKm: km(total),
      piecesByClass,
      lengthKmByClass: Object.fromEntries(STREET_CLASSES.map((c) => [c, km(lengthByClass[c])])) as Record<StreetClass, number>,
    },
    terrainVsPipes: {
      comparedKm: km(compared),
      disagreeKm: km(disagree),
      disagreeShare: share(disagree, compared),
      terrainCreekShare: share(terrainCreek, total),
      pipesCreekShare: share(pipesCreek, pipesKnown),
      terrainCreekByPipes: Object.fromEntries(STREET_CLASSES.map((c) => [c, km(terrainCreekByPipes[c])])) as Record<StreetClass, number>,
    },
    fixList: fixList.map((f) => ({
      rank: f.rank,
      label: f.label,
      streetM: f.streetM,
      drains: f.drains,
      inferredStreetM: f.inferredStreetM,
      bridges: f.bridges,
    })),
  };
}
