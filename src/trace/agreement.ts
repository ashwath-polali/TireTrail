// Agreement between our trace and the reference trace (the "answer key").
// High + Likely -> creek, Treated -> ground, Elsewhere -> elsewhere, Unknown -> unknown.
import { dist, type Projection, type XY } from '../geo/geo.ts';
import { describe, DRAIN_CLASSES, type DrainClass, type Trace } from './trace.ts';
import type { Network } from './network.ts';
import { text, type FeatureCollection } from './geojson.ts';

export type Color = 'creek' | 'ground' | 'grey';
export const COLORS: readonly Color[] = ['creek', 'ground', 'grey'];

export const colorOf = (c: DrainClass): Color => (c === 'creek' ? 'creek' : c === 'ground' ? 'ground' : 'grey');

const KEY_CLASS: Record<string, DrainClass> = {
  High: 'creek',
  Likely: 'creek',
  Treated: 'ground',
  Elsewhere: 'elsewhere',
  Unknown: 'unknown',
};

export interface Comparison {
  drain: number;
  id: string;
  ours: DrainClass;
  key: DrainClass;
  oursCode: string;
  keyCode: string;
  oursReason: string;
  keyFate: string;
  oursTerminal: string;
  keyTerminal: string;
  /** Where our trace continues past the key's ending, if it does. */
  pastKeyEnding: string;
}

export interface Agreement {
  compared: number;
  /** Drains missing from the key, or key entries missing a drain. */
  unmatched: number;
  colorAgreement: number;
  classAgreement: number;
  /** confusion3[ours][key] */
  confusion3: Record<Color, Record<Color, number>>;
  confusion4: Record<DrainClass, Record<DrainClass, number>>;
  rows: Comparison[];
}

function grid<K extends string>(keys: readonly K[]): Record<K, Record<K, number>> {
  return Object.fromEntries(keys.map((a) => [a, Object.fromEntries(keys.map((b) => [b, 0]))])) as Record<K, Record<K, number>>;
}

export function compareWithKey(net: Network, traces: readonly Trace[], key: FeatureCollection, projection: Projection): Agreement {
  // key by ID; a repeated ID matches the nearest copy
  const byId = new Map<string, { xy: XY; cls: DrainClass; code: string; fate: string; terminal: string; used: boolean }[]>();
  for (const f of key.features) {
    if (f.geometry?.type !== 'Point') continue;
    const p = f.properties;
    const entry = {
      xy: projection.toXY([f.geometry.coordinates[0], f.geometry.coordinates[1]]),
      cls: KEY_CLASS[text(p.conf)] ?? 'unknown',
      code: text(p.code),
      fate: text(p.fate),
      terminal: text(p.terminal),
      used: false,
    };
    const id = text(p.id);
    const list = byId.get(id);
    if (list) list.push(entry);
    else byId.set(id, [entry]);
  }

  const rows: Comparison[] = [];
  let unmatched = 0;
  for (const t of traces) {
    const a = net.assets[t.drain];
    const candidates = (byId.get(a.id) ?? []).filter((e) => !e.used);
    if (!candidates.length) {
      unmatched++;
      continue;
    }
    const k = candidates.reduce((best, e) => (dist(e.xy, a.anchor) < dist(best.xy, a.anchor) ? e : best));
    k.used = true;
    const at = t.path.findIndex((i) => net.assets[i].key === k.terminal);
    const via = at >= 0 && at < t.path.length - 1 ? net.out[t.path[at]].find((l) => l.to === t.path[at + 1]) : undefined;
    rows.push({
      drain: t.drain,
      id: a.id,
      ours: t.ending.cls,
      key: k.cls,
      oursCode: t.ending.code,
      keyCode: k.code,
      oursReason: t.ending.reason,
      keyFate: k.fate,
      oursTerminal: describe(net.assets[t.ending.terminal]),
      keyTerminal: k.terminal,
      pastKeyEnding: via ? `continues past ${k.terminal} through a ${via.how} link (${via.gapM} m) to ${describe(net.assets[via.to])}` : '',
    });
  }
  unmatched += [...byId.values()].flat().filter((e) => !e.used).length;

  const confusion3 = grid(COLORS);
  const confusion4 = grid(DRAIN_CLASSES);
  let sameColor = 0;
  let sameClass = 0;
  for (const r of rows) {
    confusion3[colorOf(r.ours)][colorOf(r.key)]++;
    confusion4[r.ours][r.key]++;
    if (colorOf(r.ours) === colorOf(r.key)) sameColor++;
    if (r.ours === r.key) sameClass++;
  }
  return {
    compared: rows.length,
    unmatched,
    colorAgreement: sameColor / rows.length,
    classAgreement: sameClass / rows.length,
    confusion3,
    confusion4,
    rows,
  };
}

/** Sample of disagreements, round-robin over (ours, key) pairs, biggest pair first. */
export function sampleDisagreements(rows: readonly Comparison[], n: number): Comparison[] {
  const groups = new Map<string, Comparison[]>();
  for (const r of rows) {
    if (colorOf(r.ours) === colorOf(r.key)) continue;
    const g = `${r.oursCode} | ${r.keyCode}`;
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  const out: Comparison[] = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const g of ordered) {
      if (round < g.length && out.length < n) {
        out.push(g[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
