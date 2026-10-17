// County area files: which exist, which are loaded, and fetching them on demand.
import type { Bundle } from '../data/bundle.ts';

export interface AreaInfo {
  id: string;
  name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  drains: number;
  byClass: Record<string, number>;
  bytes: number;
}

export type Box = [number, number, number, number];

/** "Tehaleh / SR 162 E" -> "Tehaleh" */
export const town = (name: string): string => name.split(' / ')[0].replace(/ \(\d+\)$/, '');

export class Areas {
  list: AreaInfo[] = [];
  readonly loaded = new Set<string>();
  private readonly pending = new Map<string, Promise<Bundle | null>>();

  async init(url = 'data/areas/index.json'): Promise<void> {
    try {
      const res = await fetch(url);
      if (res.ok) this.list = (await res.json()) as AreaInfo[];
    } catch { /* no county data; Bonney Lake still works */ }
  }

  get drains(): number {
    return this.list.reduce((n, a) => n + a.drains, 0);
  }

  /** Areas touching a lon/lat box that aren't loaded yet, nearest to its middle first. */
  missing(box: Box): AreaInfo[] {
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    return this.list
      .filter((a) => !this.loaded.has(a.id) && a.drains > 0 && a.bbox[0] <= box[2] && a.bbox[2] >= box[0] && a.bbox[1] <= box[3] && a.bbox[3] >= box[1])
      .sort((a, b) => dist2(a.bbox, cx, cy) - dist2(b.bbox, cx, cy));
  }

  private nameList: Promise<{ areas: string[]; names: (string | number)[][] } | null> | null = null;

  /** County street names matching q, in areas not loaded yet. */
  async findStreet(q: string, max = 6): Promise<{ name: string; place: string; area: AreaInfo }[]> {
    const s = q.trim().toLowerCase();
    if (!s || !this.list.length) return [];
    this.nameList ??= fetch('data/areas/names.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const nl = await this.nameList;
    if (!nl) return [];
    const byId = new Map(this.list.map((a) => [a.id, a]));
    const out: { name: string; place: string; area: AreaInfo }[] = [];
    const seen = new Set<string>();
    for (const [name, ...ks] of nl.names) {
      const n = String(name);
      if (!n.toLowerCase().includes(s)) continue;
      for (const k of ks) {
        const a = byId.get(nl.areas[Number(k)]);
        const place = a ? town(a.name) : '';
        if (!a || this.loaded.has(a.id) || seen.has(`${n}|${place}`)) continue;
        seen.add(`${n}|${place}`);
        out.push({ name: n, place, area: a });
      }
    }
    return out.sort((a, b) => Number(!a.name.toLowerCase().startsWith(s)) - Number(!b.name.toLowerCase().startsWith(s))).slice(0, max);
  }

  fetch(id: string): Promise<Bundle | null> {
    let p = this.pending.get(id);
    if (!p) {
      p = fetch(`data/areas/${id}.json`).then((r) => (r.ok ? (r.json() as Promise<Bundle>) : null)).catch(() => null);
      this.pending.set(id, p);
    }
    return p;
  }
}

function dist2(b: Box, x: number, y: number): number {
  const dx = (b[0] + b[2]) / 2 - x, dy = (b[1] + b[3]) / 2 - y;
  return dx * dx + dy * dy;
}
