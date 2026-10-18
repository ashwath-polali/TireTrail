// OpenStreetMap from Geofabrik's free GeoPackage: land cover, water, roads and buildings, read-only, one row at a time.
import { DatabaseSync } from 'node:sqlite';
import { pointInPolygon, type LngLat } from '../../src/geo/geo.ts';
import { roadClass, type Building, type Cover, type CoverPoly, type Road } from './osm.ts';

export const GPKG_URL = 'https://download.geofabrik.de/north-america/us/washington-latest-free.gpkg.zip';

// layer classes drawn as each land cover; one feature with two (a wooded park) is drawn as the first in COVER_ORDER
const COVER: Record<string, Record<string, Cover>> = {
  gis_osm_landuse_a_free: { forest: 'forest', park: 'park', grass: 'grass', meadow: 'grass' },
  gis_osm_water_a_free: { water: 'water', reservoir: 'water', riverbank: 'water', dock: 'water' },
};
const COVER_ORDER: Cover[] = ['forest', 'water', 'park', 'grass'];
const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
const PARKING = ['parking', 'parking_multistorey', 'parking_underground'];
const ENVELOPE = [0, 32, 48, 48, 64];

interface Row { osm_id: string; fclass: string; name: string | null; ref?: string | null; tunnel?: string | null; geom: Uint8Array }

/** Parking lots, to find the aisles in them. */
class Lots {
  private readonly cells = new Map<string, LngLat[][][]>();
  private readonly cell = 0.002; // degrees

  add(rings: LngLat[][]): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const C = this.cell;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(y0 / C); j <= Math.floor(y1 / C); j++) {
      const k = `${i},${j}`, list = this.cells.get(k);
      if (list) list.push(rings); else this.cells.set(k, [rings]);
    }
  }

  private inside(p: LngLat): boolean {
    return (this.cells.get(`${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`) ?? []).some((rings) => pointInPolygon(p, rings));
  }

  /** Are most of the line's points and segment middles inside a lot? */
  holds(line: readonly LngLat[]): boolean {
    let hit = this.inside(line[0]) ? 1 : 0;
    for (let k = 1; k < line.length; k++) {
      if (this.inside(line[k])) hit++;
      if (this.inside([(line[k - 1][0] + line[k][0]) / 2, (line[k - 1][1] + line[k][1]) / 2])) hit++;
    }
    return 2 * hit >= 2 * line.length - 1;
  }
}

/** Lines and polygons ([outer, ...holes]) of a GeoPackage geometry: a small header, then standard WKB. */
export function readGeom(b: Uint8Array): { lines: LngLat[][]; polygons: LngLat[][][] } {
  if (b[0] !== 0x47 || b[1] !== 0x50) throw new Error('not a GeoPackage geometry');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8 + ENVELOPE[(b[3] >> 1) & 7];
  const lines: LngLat[][] = [], polygons: LngLat[][][] = [];
  const geom = (): void => {
    const le = b[p] === 1, t = dv.getUint32(p + 1, le);
    p += 5;
    // ISO codes: 1000s add z, 2000s m, 3000s both
    const type = t % 1000, dims = 2 + (t >= 3000 ? 2 : t >= 1000 ? 1 : 0);
    const u32 = () => { const v = dv.getUint32(p, le); p += 4; return v; };
    const pts = (): LngLat[] => {
      const n = u32(), out: LngLat[] = new Array(n);
      for (let i = 0; i < n; i++, p += 8 * dims) out[i] = [dv.getFloat64(p, le), dv.getFloat64(p + 8, le)];
      return out;
    };
    if (type === 1) p += 8 * dims;
    else if (type === 2) lines.push(pts());
    else if (type === 3) { const n = u32(), rings: LngLat[][] = []; for (let i = 0; i < n; i++) rings.push(pts()); polygons.push(rings); }
    else if (type >= 4 && type <= 7) { const n = u32(); for (let i = 0; i < n; i++) geom(); }
    else throw new Error(`WKB type ${t}`);
  };
  if (!(b[3] & 16)) geom();
  return { lines, polygons };
}

/** [w, e, s, n] from the header, or null for a point (which has none). */
function envelope(b: Uint8Array): [number, number, number, number] | null {
  if (!((b[3] >> 1) & 7)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), le = (b[3] & 1) === 1;
  return [dv.getFloat64(8, le), dv.getFloat64(16, le), dv.getFloat64(24, le), dv.getFloat64(32, le)];
}

export class GeoPackage {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
  }

  /** Rows of a layer in these classes whose outline meets the box [w, s, e, n], in file order. */
  *rows(table: string, classes: readonly string[], [W, S, E, N]: number[], cols = 'osm_id, fclass, name'): Generator<Row> {
    const st = this.db.prepare(`SELECT ${cols}, geom FROM ${table} WHERE fclass IN (${classes.map(() => '?').join(', ')})`);
    for (const r of st.iterate(...classes) as Iterable<Row>) {
      const e = r.geom && envelope(r.geom);
      if (e && (e[1] < W || e[0] > E || e[3] < S || e[2] > N)) continue;
      yield r;
    }
  }

  /** Forest, parks, grass and water, each feature once. */
  *cover(box: number[]): Generator<CoverPoly> {
    // first pass: which class each feature is drawn as (the same feature has the same OSM id and outline)
    const same = (r: Row) => `${r.osm_id} ${envelope(r.geom)?.join(' ')}`;
    const best = new Map<string, number>();
    for (const [table, map] of Object.entries(COVER)) for (const r of this.rows(table, Object.keys(map), box, 'osm_id, fclass')) {
      const k = same(r), c = COVER_ORDER.indexOf(map[r.fclass]);
      if (!best.has(k) || c < best.get(k)!) best.set(k, c);
    }
    for (const [table, map] of Object.entries(COVER)) for (const r of this.rows(table, Object.keys(map), box)) {
      const cls = map[r.fclass];
      if (COVER_ORDER.indexOf(cls) !== best.get(same(r))) continue;
      for (const rings of readGeom(r.geom).polygons) if (rings[0]?.length >= 4) yield { cls, rings, name: r.name ?? '' };
    }
  }

  /**
   * Streets and highways; no paths, tracks or footways. This layer can't tell a driveway or a parking aisle from an alley,
   * so unnamed service roads mostly inside a parking lot are left out, and driveways come along.
   */
  *roads(box: number[]): Generator<Road> {
    const lots = new Lots();
    for (const r of this.rows('gis_osm_traffic_a_free', PARKING, box, 'osm_id, fclass')) for (const rings of readGeom(r.geom).polygons) lots.add(rings);
    for (const r of this.rows('gis_osm_roads_free', ROADS, box, 'osm_id, fclass, name, ref, tunnel')) {
      const cls = roadClass(r.fclass);
      for (const line of readGeom(r.geom).lines) {
        if (line.length < 2 || (r.fclass === 'service' && !r.name && lots.holds(line))) continue;
        yield { cls, major: cls >= 3, name: r.name ?? '', ref: r.ref ?? '', tunnel: r.tunnel === 'T', line };
      }
    }
  }

  /** Building outlines (the outer ring of each part). */
  *buildings(box: number[]): Generator<Building> {
    for (const r of this.rows('gis_osm_buildings_a_free', ['building'], box, 'osm_id, fclass')) {
      for (const rings of readGeom(r.geom).polygons) if (rings[0]?.length >= 4) yield { id: Number(r.osm_id), ring: rings[0] };
    }
  }

  close(): void {
    this.db.close();
  }
}
