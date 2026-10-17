// Packs the analyzed city into the bundle (build time).
import { simplify, type XY } from '../geo/geo.ts';
import type { CityResult } from '../trace/city.ts';
import { exitPoint } from '../trace/fixlist.ts';
import { streetTitle } from '../trace/fixlist.ts';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  CLASSES,
  CONFIDENCES,
  COORD_SCALE,
  CREDITS,
  decodePath,
  DISCLAIMER,
  encodeCoords,
  KINDS,
  type Bundle,
  type BundleEnding,
} from './bundle.ts';

// simplify tolerance for creeks, lakes, ponds (not pipes)
const DISPLAY_TOL_M = 1;

export function encodeBundle(city: CityResult, sources: Record<string, string>): Bundle {
  const { net, traces, projection } = city;
  const ll = (pts: readonly XY[]) => encodeCoords(pts.map((p) => projection.toLngLat(p)));

  const assets: Bundle['assets'] = { key: [], kind: [], geom: [] };
  const pondShapes: Bundle['pondShapes'] = [];
  for (const a of net.assets) {
    assets.key.push(a.key);
    assets.kind.push(KINDS.indexOf(a.kind));
    assets.geom.push(ll(a.line ?? [a.anchor]));
    for (const rings of a.polygons ?? []) pondShapes.push([a.index, ll(simplify(rings[0], DISPLAY_TOL_M))]);
  }

  // dedupe endings
  const endings: BundleEnding[] = [];
  const endingIndex = new Map<string, number>();
  const drains: Bundle['drains'] = { asset: [], ending: [], explicitPaths: {} };
  for (const t of traces) {
    const e: BundleEnding = {
      code: t.ending.code,
      cls: CLASSES.indexOf(t.ending.cls),
      confidence: CONFIDENCES.indexOf(t.confidence),
      terminal: t.ending.terminal,
      exit: t.ending.exit,
      receiving: t.ending.receiving,
      reason: t.ending.reason,
    };
    const k = JSON.stringify(e);
    if (!endingIndex.has(k)) {
      endingIndex.set(k, endings.length);
      endings.push(e);
    }
    drains.asset.push(t.drain);
    drains.ending.push(endingIndex.get(k)!);
  }

  // First walk through an asset sets next[]. Walks that chose differently keep an explicit path.
  const next = new Array<number>(net.assets.length).fill(-1);
  for (const t of traces) {
    for (let i = 0; i + 1 < t.path.length; i++) if (next[t.path[i]] === -1) next[t.path[i]] = t.path[i + 1];
  }
  const partial = { next, endings, drains };
  traces.forEach((t, i) => {
    let ok: boolean;
    try {
      ok = JSON.stringify(decodePath(partial, i)) === JSON.stringify(t.path);
    } catch {
      ok = false;
    }
    if (!ok) drains.explicitPaths[String(i)] = t.path;
  });
  traces.forEach((t, i) => {
    if (JSON.stringify(decodePath(partial, i)) !== JSON.stringify(t.path)) throw new Error(`path of drain ${i} does not round-trip`);
  });

  const streets: Bundle['streets'] = {
    pieces: city.streets.pieces.map((p) => ({
      id: p.id,
      name: streetTitle(p.name),
      lengthM: Math.round(p.lengthM * 10) / 10,
      cls: CLASSES.indexOf(p.cls),
      terrainCls: CLASSES.indexOf(p.terrain.cls),
      terrainName: p.terrain.name,
    })),
    runs: { piece: [], drain: [], cls: [], geom: [] },
  };
  for (const r of city.streets.runs) {
    streets.runs.piece.push(r.piece);
    streets.runs.drain.push(r.drain);
    streets.runs.cls.push(CLASSES.indexOf(r.cls));
    streets.runs.geom.push(ll(r.line));
  }

  // NHD lines only back the trace, not the map
  const waters: Bundle['waters'] = city.waters.all
    .filter((w) => w.kind !== 'nhd')
    .map((w) => ({
      name: w.name,
      kind: w.kind,
      fennel: w.fennel,
      lines: (w.lines ?? []).map((l) => ll(simplify(l, DISPLAY_TOL_M))),
      rings: (w.polygons ?? []).map((rings) => ll(simplify(rings[0], DISPLAY_TOL_M))),
    }));

  const fixList = city.fixList.map((f) => {
    const [lon, lat] = projection.toLngLat(exitPoint(net.assets[f.exit]));
    return {
      rank: f.rank,
      label: f.label,
      exit: f.exit,
      receiving: f.receiving,
      streetM: f.streetM,
      inferredStreetM: f.inferredStreetM,
      drains: f.drains,
      streets: f.streets,
      bridges: f.bridges,
      at: [Math.round(lon * COORD_SCALE), Math.round(lat * COORD_SCALE)] as [number, number],
    };
  });

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    credits: CREDITS,
    disclaimer: DISCLAIMER,
    sources,
    assets,
    pondShapes,
    next,
    endings,
    drains,
    streets,
    waters,
    fixList,
    numbers: city.numbers,
  };
}
