// Street names to their runs, for search. The same name in two places is two entries.
import { polylineLength } from '../../geo/geo.ts';
import type { Run, World } from '../map/world.ts';

export interface StreetHit {
  key: string;
  name: string;
  place: string;
}

// one collator for every sort: localeCompare with options builds a new one per call
const ORDER = new Intl.Collator('en', { numeric: true });

// street words people type out in full, as the street data shortens them
const WORDS: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', highway: 'hwy', court: 'ct', place: 'pl', lane: 'ln',
  parkway: 'pkwy', circle: 'cir', terrace: 'ter', east: 'e', west: 'w', north: 'n', south: 's', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

/** Search words: lowercase, street words shortened, no "th" on numbers. "214th Avenue East" -> "214 ave e". */
export function norm(s: string): string {
  return shorten(s).split(' ').map((w) => w.replace(/^(\d+)(st|nd|rd|th)$/, '$1')).join(' ');
}

/** Street words shortened the way the street data writes them: "214th Avenue East" -> "214th ave e". */
export function shorten(s: string): string {
  return s.toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((w) => WORDS[w] ?? w).join(' ');
}

export class StreetIndex {
  private readonly byKey = new Map<string, { hit: StreetHit; runs: Run[] }>();
  private readonly hits: StreetHit[];
  /** each hit's name as search words */
  private readonly words: string[];
  /** name|place key per run index */
  private readonly keys: string[] = [];

  constructor(world: World, placeOf: (run: number) => string) {
    // every run of a piece comes from the same area file
    const places = new Map<number, string>();
    for (const r of world.runs) {
      const name = world.pieceNames[r.piece];
      if (!name) continue;
      let place = places.get(r.piece);
      if (place === undefined) places.set(r.piece, (place = placeOf(r.i)));
      const key = `${name}|${place}`;
      this.keys[r.i] = key;
      const e = this.byKey.get(key);
      if (e) e.runs.push(r);
      else this.byKey.set(key, { hit: { key, name, place }, runs: [r] });
    }
    this.hits = [...this.byKey.values()].map((e) => e.hit).sort((a, b) => ORDER.compare(a.name, b.name) || ORDER.compare(a.place, b.place));
    this.words = this.hits.map((x) => norm(x.name));
  }

  /** Names containing q (as typed, or with street words spelled out), the ones starting with it first. */
  search(q: string, max = 6): StreetHit[] {
    const s = q.trim().toLowerCase(), n = norm(q);
    if (!s) return [];
    const found: { hit: StreetHit; first: boolean }[] = [];
    this.hits.forEach((hit, i) => {
      const name = hit.name.toLowerCase(), w = this.words[i];
      if (name.includes(s) || (n && w.includes(n))) found.push({ hit, first: name.startsWith(s) || (!!n && w.startsWith(n)) });
    });
    return found.sort((a, b) => Number(!a.first) - Number(!b.first)).slice(0, max).map((f) => f.hit);
  }

  runs(key: string): Run[] {
    return this.byKey.get(key)?.runs ?? [];
  }

  /** The name|place key of a run's street, or '' if it has no name. */
  keyOf(run: Run): string {
    return this.keys[run.i] ?? '';
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
