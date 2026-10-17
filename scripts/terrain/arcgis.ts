// ArcGIS REST layer download by object id chunks, with an explicit field list (Node only).
// Like scripts/lib/county-fetch.ts, but for any box and with a browser user agent (Ecology blocks curl).
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tiretrail-terrain';

export interface LayerQuery {
  url: string;
  /** never '*' */
  fields: string[];
  where?: string;
  /** lon/lat box */
  box?: readonly [number, number, number, number];
  page?: number;
}

async function post(url: string, body: URLSearchParams, attempts = 5): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      last = e;
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw new Error(`${url}: ${String(last)}`);
}

function filter(q: LayerQuery): Record<string, string> {
  const p: Record<string, string> = { where: q.where ?? '1=1' };
  if (q.box) {
    Object.assign(p, { geometry: q.box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
  }
  return p;
}

/** Esri JSON feature as GeoJSON (lines and polygons; each polygon keeps all its rings). */
export function esriToGeoJSON(f: any): any {
  const g = f.geometry;
  let geometry: any = null;
  if (g?.paths) geometry = g.paths.length === 1 ? { type: 'LineString', coordinates: g.paths[0] } : { type: 'MultiLineString', coordinates: g.paths };
  else if (g?.rings) geometry = { type: 'Polygon', coordinates: g.rings };
  else if (g && 'x' in g) geometry = { type: 'Point', coordinates: [g.x, g.y] };
  return { type: 'Feature', properties: f.attributes ?? {}, geometry };
}

/** Writes the layer's features as GeoJSON lines (lon/lat) to file, at most 4 requests at a time. */
export async function downloadLayer(name: string, q: LayerQuery, file: string, log: (s: string) => void = console.log): Promise<number> {
  if (q.fields.includes('*')) throw new Error(`${name}: list the fields`);
  const ids: number[] = (await post(`${q.url}/query`, new URLSearchParams({ ...filter(q), returnIdsOnly: 'true', f: 'json' }))).objectIds ?? [];
  ids.sort((a, b) => a - b);
  const size = q.page ?? 1000;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  const out = createWriteStream(`${file}.part`);
  const params = (list: number[], f: string) => new URLSearchParams({ objectIds: list.join(','), outFields: q.fields.join(','), outSR: '4326', geometryPrecision: '6', f });
  const skipped: number[] = [];
  // a chunk the server keeps failing on is split until the bad feature is found; that one comes as Esri JSON
  const get = async (list: number[], attempts: number): Promise<unknown[]> => {
    try {
      return (await post(`${q.url}/query`, params(list, 'geojson'), attempts)).features ?? [];
    } catch (e) {
      if (list.length > 1) {
        const mid = list.length >> 1;
        return [...(await get(list.slice(0, mid), 2)), ...(await get(list.slice(mid), 2))];
      }
      try {
        return ((await post(`${q.url}/query`, params(list, 'json'), 2)).features ?? []).map(esriToGeoJSON);
      } catch {
        log(`  ${name}: skipped object ${list[0]} (${String(e)})`);
        skipped.push(list[0]);
        return [];
      }
    }
  };
  let next = 0;
  let done = 0;
  let count = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const k = next++;
      const feats = await get(chunks[k], 5);
      out.write(feats.map((f) => JSON.stringify(f)).join('\n') + (feats.length ? '\n' : ''));
      count += feats.length;
      done++;
      if (done % 10 === 0 || done === chunks.length) log(`  ${name}: ${done}/${chunks.length} pages`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
  await new Promise<void>((resolve) => out.end(() => resolve()));
  if (count + skipped.length !== ids.length) throw new Error(`${name}: got ${count} of ${ids.length} features`);
  renameSync(`${file}.part`, file);
  return count;
}

export async function ensureLayer(name: string, q: LayerQuery, file: string, log: (s: string) => void = console.log): Promise<void> {
  if (existsSync(file)) return;
  log(`Downloading ${name}`);
  const n = await downloadLayer(name, q, file, log);
  log(`  ${name}: ${n} features`);
}
