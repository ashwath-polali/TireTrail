// Builds public/data/region.json: outlines for zooming from the whole US down to Bonney Lake.
// Sources: US Census Bureau boundaries (TIGERweb 2023, and us-atlas for the lower 48) and Natural Earth (world-atlas).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { localProjection, ORIGIN, pointInPolygon, simplify, type LngLat, type XY } from '../src/geo/geo.ts';

const CACHE = '.cache/region';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023';
const WEST = new Set(['WA', 'OR', 'CA']); // coho states shown on the map
const FIPS: Record<string, string> = { '53': 'WA', '41': 'OR', '06': 'CA' };
const NOT_48 = new Set(['02', '15', '60', '66', '69', '72', '78']);
const PIERCE_BOX = [-122.86, 46.72, -121.38, 47.42];

async function get(name: string, url: string): Promise<any> {
  const f = `${CACHE}/${name}.json`;
  if (!existsSync(f)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(f, await res.text());
  }
  return JSON.parse(readFileSync(f, 'utf8'));
}

const tiger = (path: string, params: Record<string, string>) =>
  `${TIGER}/${path}/query?${new URLSearchParams({ f: 'geojson', outSR: '4326', returnGeometry: 'true', outFields: '*', ...params })}`;

// Conformal conic touching the earth at the origin's latitude, scaled to match the town map there.
const P = localProjection();
const phi0 = (ORIGIN[1] * Math.PI) / 180, lam0 = (ORIGIN[0] * Math.PI) / 180;
const n = Math.sin(phi0);
const F = (Math.cos(phi0) * Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n)) / n;
const rho = (phi: number) => F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);
const kx = (P.metersPerDegLon * 180) / Math.PI / Math.cos(phi0), ky = (P.metersPerDegLat * 180) / Math.PI;
/** lon/lat to app coordinates (meters, y down) */
function project([lon, lat]: LngLat): XY {
  const r = rho((lat * Math.PI) / 180), th = n * ((lon * Math.PI) / 180 - lam0);
  return [r * Math.sin(th) * kx, -(rho0 - r * Math.cos(th)) * ky];
}

type Ring = LngLat[];
function polygons(geom: { type: string; coordinates: any }): Ring[][] {
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
}

/** projected, simplified, rounded, delta-encoded: [x0, y0, dx1, dy1, ...] */
function encode(ring: Ring, tol: number, minArea = 0): number[] | null {
  return encodeXY(simplify(ring.map(project), tol), minArea);
}

function encodeXY(pts: XY[], minArea = 0): number[] | null {
  if (pts.length < 4) return null;
  let a = 0;
  for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) a += (pts[j][0] - pts[k][0]) * (pts[j][1] + pts[k][1]);
  if (Math.abs(a / 2) < minArea) return null;
  const out: number[] = [];
  let px = 0, py = 0;
  for (const [x, y] of pts) {
    const rx = Math.round(x), ry = Math.round(y);
    out.push(rx - px, ry - py);
    [px, py] = [rx, ry];
  }
  return out;
}

const rings = (geom: { type: string; coordinates: any }, tol: number, minArea = 0) =>
  polygons(geom).flatMap((poly) => poly.map((r) => encode(r, tol, minArea))).filter((r): r is number[] => r !== null);

const at = (lon: number | string, lat: number | string) => project([Number(lon), Number(lat)]).map(Math.round);

// Sutherland-Hodgman against a lon/lat box, for Canada's arctic coast
function clip(ring: Ring, [x0, y0, x1, y1]: number[]): Ring {
  let out = ring;
  const edges: [(p: LngLat) => boolean, (a: LngLat, b: LngLat) => LngLat][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let k = 0; k < src.length; k++) {
      const a = src[(k + src.length - 1) % src.length], b = src[k];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

// TopoJSON arcs, decoded
function topoArcs(topo: any): LngLat[][] {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc: number[][]) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty] as LngLat; });
  });
}

function topoRings<T>(geom: any, arcs: T[][]): T[][][] {
  const ring = (ids: number[]) => ids.flatMap((i, k) => { const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i]; return k ? a.slice(1) : a; });
  return geom.type === 'Polygon' ? [geom.arcs.map(ring)] : geom.type === 'MultiPolygon' ? geom.arcs.map((p: number[][]) => p.map(ring)) : [];
}

const topoPolygons = (topo: any, geom: any): Ring[][] => topoRings(geom, topoArcs(topo));

async function main(): Promise<void> {
  const us = await get('states-20m', tiger('State_County/MapServer/9', { where: "STUSAB NOT IN ('AK','HI','PR')" }));
  const atlas = await get('us-states-10m', 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json');
  const detail = await get('states-500k', tiger('State_County/MapServer/7', { where: "STUSAB IN ('WA','OR')" }));
  const counties = await get('wa-counties-500k', tiger('State_County/MapServer/11', { where: "STATE='53'" }));
  const places = await get('pierce-places-500k', tiger('Places_CouSub_ConCity_SubMCD/MapServer/10', {
    where: "STATE='53'", geometry: PIERCE_BOX.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
  }));
  const world = await get('countries-50m', 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json');

  const pierce = counties.features.find((f: any) => f.properties.BASENAME === 'Pierce');
  const inPierce = (lon: number, lat: number) => polygons(pierce.geometry).some((poly) => pointInPolygon([lon, lat], poly));

  const abroad: number[][] = [];
  for (const g of world.objects.countries.geometries) {
    if (g.id !== '124' && g.id !== '484') continue; // Canada, Mexico
    for (const poly of topoPolygons(world, g)) {
      const r = clip(poly[0], [-136, 14, -52, 58]);
      const e = r.length > 3 ? encode(r, 2500, 4e7) : null;
      if (e) abroad.push(e);
    }
  }

  // simplify shared borders once, so neighbors still meet exactly
  const arcs = topoArcs(atlas).map((a) => simplify(a.map(project), 2500));
  const label = new Map<string, XY>(us.features.map((f: any) => [f.properties.NAME, at(f.properties.INTPTLON, f.properties.INTPTLAT)]));
  const out = {
    source: 'US Census Bureau 2023 generalized boundaries; Natural Earth',
    states: atlas.objects.states.geometries.filter((g: any) => !NOT_48.has(g.id)).map((g: any) => ({
      id: FIPS[g.id] ?? g.id, name: g.properties.name, west: WEST.has(FIPS[g.id] ?? ''), at: label.get(g.properties.name) ?? [0, 0],
      rings: topoRings(g, arcs).flatMap((poly) => poly.map((r) => encodeXY(r, 4e7))).filter((r): r is number[] => r !== null),
    })),
    detail: detail.features.map((f: any) => ({ id: f.properties.STUSAB, rings: rings(f.geometry, 100, 2e5) })),
    abroad,
    counties: counties.features.map((f: any) => ({
      name: f.properties.BASENAME, home: f.properties.BASENAME === 'Pierce',
      at: at(f.properties.INTPTLON, f.properties.INTPTLAT), rings: rings(f.geometry, 100, 2e5),
    })),
    places: places.features
      .filter((f: any) => inPierce(Number(f.properties.INTPTLON), Number(f.properties.INTPTLAT)))
      .map((f: any) => ({ name: f.properties.BASENAME, at: at(f.properties.INTPTLON, f.properties.INTPTLAT), rings: rings(f.geometry, 20, 1e4) }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    points: [
      { name: 'Seattle', at: at(-122.335, 47.608), kind: 'city' },
      { name: 'Olympia', at: at(-122.9, 47.038), kind: 'city' },
      { name: 'Portland', at: at(-122.676, 45.523), kind: 'city' },
      { name: 'San Francisco', at: at(-122.419, 37.775), kind: 'city' },
      { name: 'Los Angeles', at: at(-118.244, 34.052), kind: 'city' },
      { name: 'Mount Rainier', at: at(-121.76, 46.853), kind: 'peak' },
      { name: 'Puget Sound', at: at(-122.47, 47.6), kind: 'water' },
      { name: 'Pacific Ocean', at: at(-127.2, 42.5), kind: 'water' },
    ],
  };
  writeFileSync('public/data/region.json', JSON.stringify(out));
  const kb = (JSON.stringify(out).length / 1024).toFixed(0);
  console.log(`region.json ${kb} KB: ${out.states.length} states, ${out.detail.length} detailed, ${out.counties.length} counties, ${out.places.length} Pierce County places`);
  console.log(out.places.map((p: any) => p.name).join(', '));
}

await main();
