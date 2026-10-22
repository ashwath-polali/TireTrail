// Endings of today's traced bundles: where each drain's trace stops, with its exit point (Node only).
import { readdirSync, readFileSync } from 'node:fs';
import { decodeCoords, type Bundle } from '../../src/data/bundle.ts';

export interface Exit {
  /** asset key of the exit (end point, culvert, pond...) */
  key: string;
  code: string;
  /** 0 creek, 1 ground, 2 elsewhere, 3 unknown (CLASSES in src/data/bundle.ts) */
  cls: number;
  receiving: string;
  /** where water leaves the mapped network: the point, or a line's last vertex (lines run in flow order) */
  at: [number, number];
  /** drain keys whose trace ends here */
  drains: string[];
  /** bundle it was first seen in */
  area: string;
}

/** Exits of the drains in some bundles; a drain shared by two bundles counts once (first seen). */
export function bundleExits(bundles: { name: string; bundle: Bundle }[]): Map<string, Exit> {
  const exits = new Map<string, Exit>();
  const seen = new Set<string>();
  for (const { name, bundle: b } of bundles) {
    b.drains.asset.forEach((a, i) => {
      const dk = b.assets.key[a];
      if (seen.has(dk)) return;
      seen.add(dk);
      const e = b.endings[b.drains.ending[i]];
      const key = b.assets.key[e.exit];
      let x = exits.get(key);
      if (!x) {
        const g = decodeCoords(b.assets.geom[e.exit]);
        const p = g[g.length - 1];
        x = { key, code: e.code, cls: e.cls, receiving: e.receiving, at: [p[0], p[1]], drains: [], area: name };
        exits.set(key, x);
      }
      x.drains.push(dk);
    });
  }
  return exits;
}

/** The county area bundles in a folder (index.json and names.json left out). */
export function readAreaBundles(dir: string): { name: string; bundle: Bundle }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'names.json')
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ''), bundle: JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Bundle }))
    .filter((x) => Array.isArray(x.bundle.endings));
}

/** Unknown endings where the map stops at an outfall or a discharge point. */
export const UNKNOWN_OUTLET_CODES = new Set(['outfall-unknown', 'discharge-unknown']);
/** Endings the tracer matched to mapped water (the calibration set). */
export const WATER_CODES = new Set(['outfall-creek', 'outfall-elsewhere', 'downstream-creek', 'stream-creek', 'stream-elsewhere', 'pond-to-creek', 'pond-to-elsewhere']);
/** Endings at the surface the tracer says soak in (a check on the low-spot rule). */
export const GROUND_CODES = new Set(['discharge-point', 'infiltration-pond']);
