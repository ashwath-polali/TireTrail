// Street names to their runs, for search. The same name in two places is two entries.
import { polylineLength } from '../../geo/geo.ts';
import type { Run, World } from '../map/world.ts';

export interface StreetHit {
  key: string;
  name: string;
  place: string;
}

export class StreetIndex {
  private readonly byKey = new Map<string, { hit: StreetHit; runs: Run[] }>();
  private readonly hits: StreetHit[];

  constructor(world: World, placeOf: (run: number) => string) {
    for (const r of world.runs) {
      const name = world.pieceNames[r.piece];
      if (!name) continue;
      const place = placeOf(r.i), key = `${name}|${place}`;
      const e = this.byKey.get(key) ?? { hit: { key, name, place }, runs: [] };
      e.runs.push(r);
      this.byKey.set(key, e);
    }
    this.hits = [...this.byKey.values()].map((e) => e.hit).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || a.place.localeCompare(b.place));
  }

  /** Names containing q, the ones starting with it first. */
  search(q: string, max = 6): StreetHit[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return this.hits.filter((h) => h.name.toLowerCase().includes(s)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(s)) - Number(!b.name.toLowerCase().startsWith(s))).slice(0, max);
  }

  runs(key: string): Run[] {
    return this.byKey.get(key)?.runs ?? [];
  }

  /** The longest stretch of the street's most common answer. */
  main(key: string): Run | null {
    const runs = this.runs(key);
    const by = new Map<number, number>();
    for (const r of runs) if (r.drain !== null) by.set(r.k, (by.get(r.k) ?? 0) + polylineLength(r.line));
    const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const pool = top === undefined ? runs : runs.filter((r) => r.k === top && r.drain !== null);
    return pool.sort((a, b) => polylineLength(b.line) - polylineLength(a.line))[0] ?? null;
  }
}
