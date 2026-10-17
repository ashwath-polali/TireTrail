// OpenStreetMap land cover and roads through Overpass, cached per chunk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { LngLat } from '../../src/geo/geo.ts';

const CACHE = '.cache/basemap';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'TireTrail-student-project/0.1 (map basemap build)';
const STEP = 0.1; // degrees per chunk

export type Cover = 'forest' | 'park' | 'grass' | 'water';
export interface CoverPoly { cls: Cover; rings: LngLat[][] }
export interface Road { major: boolean; line: LngLat[] }

const query = (s: number, w: number, n: number, e: number) => `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
(
  nwr["landuse"~"^(forest|grass|meadow)$"];
  nwr["natural"~"^(wood|water)$"];
  nwr["leisure"="park"];
  nwr["waterway"="riverbank"];
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];
  way["highway"="service"]["service"!~"^(driveway|parking_aisle|drive-through)$"];
);
out geom;`;

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function fetchChunk(s: number, w: number): Promise<any> {
  const f = `${CACHE}/osm-${s.toFixed(2)}_${w.toFixed(2)}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const body = new URLSearchParams({ data: query(s, w, +(s + STEP).toFixed(2), +(w + STEP).toFixed(2)) });
  let delay = 5000;
  for (let attempt = 0; attempt < 24; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(240_000) });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const j = JSON.parse(text);
        // a timeout or memory error comes back as 200 with a remark and no data
        if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark);
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(f, text);
        return j;
      }
      console.log(`  ${s},${w}: ${url.split('/')[2]} HTTP ${res.status}`);
    } catch (e) {
      console.log(`  ${s},${w}: ${url.split('/')[2]} ${e instanceof Error ? e.message : e}`);
    }
    if (attempt % ENDPOINTS.length === ENDPOINTS.length - 1) {
      await wait(delay);
      delay = Math.min(90_000, delay * 2);
    }
  }
  throw new Error(`Overpass chunk ${s},${w} failed`);
}

function coverOf(t: Record<string, string>): Cover | null {
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (t.natural === 'water' || t.waterway === 'riverbank') return 'water';
  if (t.leisure === 'park') return 'park';
  if (t.landuse === 'grass' || t.landuse === 'meadow') return 'grass';
  return null;
}

const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;

// Joins member ways end to end into closed rings.
function joinRings(ways: LngLat[][]): LngLat[][] {
  const key = (p: LngLat) => `${p[0]},${p[1]}`;
  const open = ways.filter((w) => w.length > 1).map((w) => [...w]);
  const out: LngLat[][] = [];
  while (open.length) {
    const ring = open.pop()!;
    for (let guard = 0; key(ring[0]) !== key(ring[ring.length - 1]) && guard < 10000; guard++) {
      const end = key(ring[ring.length - 1]);
      const k = open.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (k < 0) break;
      const w = open.splice(k, 1)[0];
      ring.push(...(key(w[0]) === end ? w : w.reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) out.push(ring);
  }
  return out;
}

/** Land cover polygons and roads in the box [w, s, e, n], deduplicated across chunks; `keep` can skip chunks. */
export async function fetchOsm(box: number[], keep: (chunk: number[]) => boolean = () => true): Promise<{ cover: CoverPoly[]; roads: Road[]; chunks: number }> {
  const [W, S, E, N] = box;
  const seen = new Set<string>();
  const cover: CoverPoly[] = [];
  const roads: Road[] = [];
  let chunks = 0;
  for (let s = Math.floor(S / STEP) * STEP; s < N - 1e-9; s += STEP) {
    for (let w = Math.floor(W / STEP) * STEP; w < E - 1e-9; w += STEP) {
      if (!keep([w, s, w + STEP, s + STEP])) continue;
      const j = await fetchChunk(+s.toFixed(2), +w.toFixed(2));
      chunks++;
      for (const el of j.elements) {
        const id = `${el.type}${el.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const t = el.tags ?? {};
        const pts = (g: { lon: number; lat: number }[] | undefined): LngLat[] => (g ?? []).map((p) => [p.lon, p.lat]);
        if (el.type === 'way' && t.highway) {
          const line = pts(el.geometry);
          if (line.length > 1) roads.push({ major: MAJOR.test(t.highway), line });
          continue;
        }
        const cls = coverOf(t);
        if (!cls) continue;
        if (el.type === 'way') {
          const ring = pts(el.geometry);
          if (ring.length >= 4 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) cover.push({ cls, rings: [ring] });
        } else if (el.type === 'relation' && t.type === 'multipolygon') {
          const members = (el.members ?? []).filter((m: any) => m.type === 'way' && m.geometry);
          const outer = joinRings(members.filter((m: any) => m.role !== 'inner').map((m: any) => pts(m.geometry)));
          const inner = joinRings(members.filter((m: any) => m.role === 'inner').map((m: any) => pts(m.geometry)));
          // each hole goes with every outer; even-odd fill leaves it empty only inside its own outer
          for (const o of outer) cover.push({ cls, rings: [o, ...inner.filter((h) => h.some((p) => inRing(p, o)))] });
        }
      }
    }
  }
  return { cover, roads, chunks };
}

function inRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
