// Street names to their runs, for search.
import { polylineLength } from '../../geo/geo.ts';
import type { Run, World } from '../map/world.ts';

export class StreetIndex {
  private readonly byName = new Map<string, Run[]>();
  private readonly names: string[];

  constructor(world: World) {
    for (const r of world.runs) {
      const name = world.pieceNames[r.piece];
      if (!name) continue;
      this.byName.set(name, [...(this.byName.get(name) ?? []), r]);
    }
    this.names = [...this.byName.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  /** Names containing q, the ones starting with it first. */
  search(q: string, max = 6): string[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return this.names.filter((n) => n.toLowerCase().includes(s)).sort((a, b) => Number(!a.toLowerCase().startsWith(s)) - Number(!b.toLowerCase().startsWith(s))).slice(0, max);
  }

  runs(name: string): Run[] {
    return this.byName.get(name) ?? [];
  }

  /** The longest stretch of the street's most common answer. */
  main(name: string): Run | null {
    const runs = this.runs(name);
    const by = new Map<number, number>();
    for (const r of runs) if (r.drain !== null) by.set(r.k, (by.get(r.k) ?? 0) + polylineLength(r.line));
    const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const pool = top === undefined ? runs : runs.filter((r) => r.k === top && r.drain !== null);
    return pool.sort((a, b) => polylineLength(b.line) - polylineLength(a.line))[0] ?? null;
  }
}
