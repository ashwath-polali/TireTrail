// Watersheds (USGS Watershed Boundary Dataset, HUC-12) for taps where TireTrail has no pipe map: which one a spot is
// in, and the salmon WDFW records in the stream it's named for. public/data/state/watersheds.json, from
// scripts/build-watersheds.ts, in the region map's coordinates (region.ts); fetched on the first tap that needs it.
import { pointInPolygon, type XY } from '../../geo/geo.ts';

/** arcs: shared borders as [x, y, dx, dy, ...] in steps of q m; w: per watershed, its rings as arc numbers (~n runs arc n backward) */
export interface RawWatersheds {
  v: 1;
  q: number;
  source: string;
  built: string;
  arcs: number[][];
  w: [huc12: string, name: string, stream: string, sp: number, rings: number[][]][];
}

/** stream: the salmon stream it's named for ('' if none), sp: the species WDFW records there (src/salmon/species.ts) */
export interface Watershed { huc12: string; name: string; stream: string; sp: number; rings: XY[][]; box: [number, number, number, number] }

/** The file as watersheds; null unless it is one. */
export function readWatersheds(j: unknown): Watershed[] | null {
  const f = j as Partial<RawWatersheds> | null;
  if (!f || f.v !== 1 || !(Number(f.q) > 0) || !Array.isArray(f.arcs) || !Array.isArray(f.w)) return null;
  const q = f.q!;
  const arcs = f.arcs.map((d) => {
    const out: XY[] = [];
    let x = 0, y = 0;
    for (let k = 0; k + 1 < d.length; k += 2) out.push([(x += d[k]) * q, (y += d[k + 1]) * q]);
    return out;
  });
  return f.w.map(([huc12, name, stream, sp, rs]) => {
    const rings = rs.map((ids) => {
      const ring: XY[] = [];
      for (const i of ids) {
        const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
        ring.push(...(ring.length ? a.slice(1) : a));
      }
      return ring;
    });
    const box: Watershed['box'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of rings) for (const [x, y] of r) {
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
    }
    return { huc12, name, stream, sp, rings, box };
  });
}

/** The watershed a region map point is in, or null. */
export function watershedAt(list: readonly Watershed[], p: XY): Watershed | null {
  for (const w of list) if (p[0] >= w.box[0] && p[0] <= w.box[2] && p[1] >= w.box[1] && p[1] <= w.box[3] && pointInPolygon(p, w.rings)) return w;
  return null;
}

// a stream's name ends in one of these; a valley, lake, island or town doesn't
const STREAM = /\b(creek|river|slough|brook|fork)$/i;

/**
 * The stream a watershed is named for: "Issaquah Creek" for "Upper Issaquah Creek", "Bear Creek" for
 * "Bear Creek-Sammamish River", "Wenatchee River" for "Ollala Canyon-Wenatchee River", '' for "Lake Wenatchee".
 */
export function mainStream(name: string): string {
  for (const part of name.split('-')) {
    // "Upper", "Lower", "Middle" and "Headwaters" are parts of a stream, but "Middle Fork" is a stream's own name
    const s = part.trim().replace(/^((upper|lower|middle|headwaters)\s+(?!fork\b))+/i, '');
    if (STREAM.test(s) && s.split(/\s+/).length > 1) return s;
  }
  return '';
}

/** Loads the file once, on the first ask; a failed load is tried again on a later ask. */
export class WatershedData {
  private list: Watershed[] | null = null;
  private wait: Promise<Watershed[] | null> | null = null;
  private readonly url: string;
  private readonly get: (url: string) => Promise<unknown>;

  constructor(url = 'data/state/watersheds.json', get: (url: string) => Promise<unknown> = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))) {
    [this.url, this.get] = [url, get];
  }

  /** The watersheds, if loaded. */
  get ready(): Watershed[] | null {
    return this.list;
  }

  load(): Promise<Watershed[] | null> {
    if (this.list) return Promise.resolve(this.list);
    this.wait ??= this.get(this.url)
      .then((j) => (this.list = readWatersheds(j)))
      .catch(() => null)
      .finally(() => { this.wait = null; });
    return this.wait;
  }

  /** The watershed at a region map point; null when there's none or the file can't load. */
  async at(p: XY): Promise<Watershed | null> {
    const list = await this.load();
    return list ? watershedAt(list, p) : null;
  }
}
