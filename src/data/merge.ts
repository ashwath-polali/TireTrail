// Joins area bundles into one. It only appends, so drain and street indices already in use stay valid.
import type { Bundle } from './bundle.ts';

export function mergeBundles(base: Bundle, add: Bundle): Bundle {
  const A = base.assets.key.length, E = base.endings.length, D = base.drains.asset.length, P = base.streets.pieces.length;
  const explicit: Record<string, number[]> = { ...base.drains.explicitPaths };
  for (const [k, v] of Object.entries(add.drains.explicitPaths)) explicit[String(Number(k) + D)] = v.map((a) => a + A);
  const r = base.streets.runs, s = add.streets.runs;
  return {
    ...base,
    credits: [...new Set([...base.credits, ...add.credits])],
    sources: { ...base.sources, ...add.sources },
    assets: {
      key: base.assets.key.concat(add.assets.key),
      kind: base.assets.kind.concat(add.assets.kind),
      geom: base.assets.geom.concat(add.assets.geom),
    },
    pondShapes: base.pondShapes.concat(add.pondShapes.map(([a, ring]): [number, number[]] => [a + A, ring])),
    next: base.next.concat(add.next.map((n) => (n < 0 ? n : n + A))),
    endings: base.endings.concat(add.endings.map((e) => ({ ...e, terminal: e.terminal + A, exit: e.exit + A }))),
    drains: {
      asset: base.drains.asset.concat(add.drains.asset.map((a) => a + A)),
      ending: base.drains.ending.concat(add.drains.ending.map((e) => e + E)),
      explicitPaths: explicit,
    },
    streets: {
      pieces: base.streets.pieces.concat(add.streets.pieces),
      runs: {
        piece: r.piece.concat(s.piece.map((p) => p + P)),
        drain: r.drain.concat(s.drain.map((d) => (d < 0 ? d : d + D))),
        cls: r.cls.concat(s.cls),
        geom: r.geom.concat(s.geom),
      },
    },
    waters: base.waters.concat(add.waters),
    fixList: base.fixList.concat(add.fixList.map((f) => ({ ...f, exit: f.exit + A }))),
    // headline numbers stay those of the first area
    numbers: base.numbers,
  };
}

/** Keeps only the street runs that pass the test (e.g. drop county roads inside a city that has its own data). */
export function keepRuns(b: Bundle, keep: (run: number) => boolean): Bundle {
  const r = b.streets.runs, idx = r.piece.map((_, i) => i).filter(keep);
  return {
    ...b,
    streets: {
      pieces: b.streets.pieces,
      runs: { piece: idx.map((i) => r.piece[i]), drain: idx.map((i) => r.drain[i]), cls: idx.map((i) => r.cls[i]), geom: idx.map((i) => r.geom[i]) },
    },
  };
}
