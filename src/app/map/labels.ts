/// <reference types="vite/client" />
// Names over the map, from states down to streets, plus the tags pinned to a picked street's trip.
// Placed nearest the middle of the open map first, never over each other or the caption, card and buttons.
import './map.css';
import { pointInPolygon, simplify, type XY } from '../../geo/geo.ts';
import type { BaseTile } from './basemap.ts';
import { CAT, PICK, TRIP } from './palette.ts';
import { regionPt, worldPt, type Region } from './region.ts';
import { REGION_MPP, S, STREET_MPP, type Cam, type Renderer, type Tag } from './render.ts';
import { OPEN_VIEW } from './views.ts';
import type { World } from './world.ts';

export type Kind = 'street' | 'water' | 'town' | 'hood' | 'place' | 'region' | 'city' | 'peak' | 'sea' | 'tag' | 'nomap';
export type Box = [x0: number, y0: number, x1: number, y1: number];

/** public/data/labels.json (scripts/build-labels.ts). Optional: without it, city names come from region.json. */
export interface LabelFile {
  v: number;
  places: [name: string, kind: string, lon: number, lat: number][];
  lakes: [name: string, lon: number, lat: number, areaM2: number, w: number, s: number, e: number, n: number][];
  parks?: [name: string, lon: number, lat: number, areaM2: number][];
  schools?: [name: string, lon: number, lat: number][];
}

/** One fixed name and where it may go. */
export interface Cand {
  text: string;
  kind: Kind;
  /** shown for min < mpp <= max */
  min: number;
  max: number;
  /** anchors in world meters, best first; drawn: the same where the region map draws them */
  at: XY[];
  drawn: XY[];
  /** else a spot inside the part of this shape in view */
  fill?: { world: XY[][]; drawn: XY[][]; wbox: Box; dbox: Box };
  /** a smaller second line */
  sub?: string;
  /** css px from the anchor; with dx the label's left edge sits there */
  dx?: number;
  dy?: number;
  /** may sit on any side of its anchor */
  around?: boolean;
  fish?: boolean;
  /** a lake from labels.json: named only where water is drawn */
  wet?: boolean;
  /** across in m; unnamed while under MIN_ACROSS css px */
  across?: number;
  extra?: string;
  bb?: Box;
  /** fills in anchors or the outline the first time they're needed */
  make?: () => void;
  /** towns and neighborhoods: bigger kinds first */
  tier?: number;
  // placing state
  el?: HTMLDivElement;
  w?: number;
  h?: number;
  fv?: number;
  last?: XY | null;
  lastDrawn?: boolean;
  tf?: string;
}

export interface Names { early: Cand[]; towns: Cand[]; water: Cand[]; hoods: Cand[]; late: Cand[] }

/** A street name: every run of that name near each other (another town's street of the same name is its own). */
export interface Street {
  text: string;
  norm: string;
  len: number;
  /** where it was shown last time */
  last: XY | null;
  el?: HTMLDivElement;
  w?: number;
  h?: number;
  fv?: number;
  tf?: string;
}

export interface Streets {
  groups: Street[];
  /** anchors every 150 m: x, y and street */
  x: Float64Array;
  y: Float64Array;
  g: Int32Array;
  cells: Map<number, number[]>;
  /** street of each run, -1 for none */
  runG: Int32Array;
}

const TOWN_MIN = STREET_MPP, TOWN_MAX = 420, HOOD_MIN = 1.8, HOOD_MAX = 40, STREET_MAX = 12, WATER_MAX = 90;
const STEP = 150; // m between a street's anchors
const CELL = 400;
const MIN_ACROSS = 30;
const NOMAP = 'Pipe map not added yet';
const HERE = 'Where TireTrail works';
/** the UI a label must stay off; the coach bubble carries one of the last two */
export const UI_BLOCKS = '.caption, .sheet, .zoom, .coach-bubble, [data-label-block]';
// names from survey maps, not from people; the second kind only up close
const SURVEY = /unnamed|tributary/i, SURVEY_NEAR = /outflow|ditch/i;
const NOT_LAKE = /unnamed|pond|basin|detention|retention|lagoon|wastewater/i;
const TOWNS: Record<string, number> = { city: 4e7, town: 1.5e7, village: 3e6 };
const HOODS: Record<string, number> = { suburb: 4, quarter: 3, neighbourhood: 2, hamlet: 1 };

const TONE: Record<Tag['tone'], string> = {
  street: PICK.band, drain: '#d6ded5', pipe: TRIP.dot, pond: '#9cc4cf', creek: CAT.creek, soak: CAT.ground,
  other: CAT.elsewhere, treatment: CAT.treatment, gap: '#d6ded5', plain: '#d6ded5',
};
// placing order: where the water ends up, the street, its drain, a pond, the pipes
const TAG_ORDER: Record<Tag['tone'], number> = { creek: 0, other: 0, soak: 0, treatment: 0, gap: 0, street: 1, drain: 2, pond: 3, pipe: 4, plain: 5 };
const PHONE_WORDS: Record<string, string> = { 'storm drain': 'drain', 'pipes under the street': 'pipes', 'roadside ditch': 'ditch' };

// a 9x5 coho facing left: outline, eye, body, belly, tail
const FISH = (() => {
  const rows = ['..####.##', '.#eooo#o#', '#ooooooo#', '.#wwww#o#', '..####.##'];
  const col: Record<string, string> = { '#': '#1a1712', e: '#1a1712', o: CAT.creek, w: '#f4f1e6' };
  let px = '';
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (col[c]) px += `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[c]}"/>`; }));
  return `<svg class="ml-fish" viewBox="0 0 9 5" shape-rendering="crispEdges" aria-hidden="true">${px}</svg>`;
})();

// ---------- labels.json ----------

let file: LabelFile | null | undefined;
let asked: Promise<LabelFile | null> | null = null;

function loadFile(): Promise<LabelFile | null> {
  asked ??= fetch('data/labels.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => (file = readFile(j)))
    .catch(() => (file = null));
  return asked;
}

/** labels.json checked row by row; null if it isn't one */
export function readFile(j: unknown): LabelFile | null {
  const f = j as Partial<LabelFile> | null;
  if (!f || typeof f !== 'object' || f.v !== 1 || !Array.isArray(f.places)) return null;
  const rows = <T extends unknown[]>(a: unknown, n: number, str: number[]): T[] => (Array.isArray(a) ? a : []).filter((r): r is T =>
    Array.isArray(r) && r.length >= n && r.slice(0, n).every((v, k) => (str.includes(k) ? typeof v === 'string' && v !== '' : Number.isFinite(v))));
  return {
    v: 1,
    places: rows(f.places, 4, [0, 1]),
    lakes: rows(f.lakes, 8, [0]),
    parks: rows(f.parks, 4, [0]),
    schools: rows(f.schools, 3, [0]),
  };
}

// ---------- names ----------

const WORDS: Record<string, string> = {
  street: 'St', avenue: 'Ave', road: 'Rd', drive: 'Dr', boulevard: 'Blvd', highway: 'Hwy', court: 'Ct', place: 'Pl',
  lane: 'Ln', parkway: 'Pkwy', terrace: 'Ter', circle: 'Cir',
};
const DIRS: Record<string, string> = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };

/** An OSM road name the way the county writes it: "41st Street Place Southeast" -> "41st St Pl SE". */
export function shortName(name: string): string {
  const w = name.trim().split(/\s+/);
  return w.map((s, i) => {
    const k = s.toLowerCase();
    if (i === w.length - 1 && i > 0 && DIRS[k]) return DIRS[k];
    return i > 0 && WORDS[k] ? WORDS[k] : s;
  }).join(' ');
}

/** For telling two spellings of one road apart from two roads. */
export function sameName(name: string): string {
  return name.toLowerCase().split(/\s+/).map((k) => (DIRS[k] ?? WORDS[k] ?? k).toLowerCase()).join(' ');
}

// ---------- geometry ----------

const hit = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function boxOf(pts: readonly XY[]): Box {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}

function ringArea(r: readonly XY[]): number {
  let a = 0;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) a += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
  return Math.abs(a / 2);
}

/** distance from p to a closed ring */
function edgeDist(p: XY, r: readonly XY[]): number {
  let best = Infinity;
  for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
    const ax = r[j][0], ay = r[j][1], dx = r[k][0] - ax, dy = r[k][1] - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)) : 0;
    const d = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Spots inside the rings and the view, farthest from both edges first: a grid of about n x n laid over
 * where they overlap. Grid steps snap to a fixed ladder of sizes, so spots stay put while the map pans.
 */
export function interior(rings: XY[][], rbox: Box, view: Box, n = 8): { at: XY; d: number }[] {
  const x0 = Math.max(rbox[0], view[0]), y0 = Math.max(rbox[1], view[1]), x1 = Math.min(rbox[2], view[2]), y1 = Math.min(rbox[3], view[3]);
  if (!(x0 < x1 && y0 < y1)) return [];
  const s = Math.pow(2, Math.ceil(Math.log2(Math.max(x1 - x0, y1 - y0) / n) * 2) / 2);
  const out: { at: XY; d: number }[] = [];
  for (let y = (Math.floor(y0 / s) + .5) * s; y < y1; y += s) {
    if (y <= y0) continue;
    for (let x = (Math.floor(x0 / s) + .5) * s; x < x1; x += s) {
      if (x <= x0) continue;
      const p: XY = [x, y];
      if (!pointInPolygon(p, rings)) continue;
      let d = Math.min(x - view[0], view[2] - x, y - view[1], view[3] - y);
      for (const r of rings) d = Math.min(d, edgeDist(p, r));
      out.push({ at: p, d });
    }
  }
  return out.sort((a, b) => b.d - a.d);
}

/** points every `step` m along lines, carrying the distance from one line to the next */
function along(lines: readonly (readonly XY[])[], step: number): XY[] {
  const out: XY[] = [];
  let acc = step / 2;
  for (const l of lines) for (let k = 1; k < l.length; k++) {
    const [ax, ay] = l[k - 1], [bx, by] = l[k], L = Math.hypot(bx - ax, by - ay);
    let t = 0;
    while (acc + L - t >= step) { t += step - acc; acc = 0; out.push([ax + ((bx - ax) * t) / L, ay + ((by - ay) * t) / L]); }
    acc += L - t;
  }
  if (!out.length && lines.length) { const l = lines[0]; out.push(l[l.length >> 1]); }
  return out;
}

// ---------- building the names ----------

/**
 * Every fixed name, in placing order: region names, the home town and cities without a pipe map, then labels.json
 * towns, water, labels.json neighborhoods (towns and neighborhoods nearest the middle first, a few at a time),
 * then the streets, then parks and schools.
 */
export function buildNames(world: World, region: Region | null, f: LabelFile | null): Names {
  const W = (lon: number, lat: number) => world.toWorld([lon, lat]);
  // where the region map draws a world point
  const D = (p: XY): XY => (region ? regionPt(p) : p);
  const regionC: Cand[] = [], nomapC: Cand[] = [], townC: (Cand & { weight: number })[] = [], fileC: Cand[] = [], lakeC: Cand[] = [], creekC: Cand[] = [], hoodC: Cand[] = [], late: Cand[] = [];

  if (region) {
    const home = regionPt(world.center);
    const states: Cand[] = [];
    for (const s of region.states) {
      if (!s.west) continue;
      const c: Cand = { text: s.name.toUpperCase(), kind: 'region', min: 700, max: Infinity, at: [worldPt(s.at)], drawn: [s.at] };
      // the home state is always named: inside whatever part of it is in view, or beside it when it's small
      if (pointInPolygon(home, s.rings)) { Object.assign(c, { fill: { world: s.rings, drawn: s.rings, wbox: s.box, dbox: s.box }, around: true }); states.unshift(c); } else states.push(c);
    }
    regionC.push(...states.slice(0, 1));
    // next to the marker the region map draws
    regionC.push({ text: HERE, kind: 'region', extra: 'ml-here', min: 1500, max: Infinity, at: [world.center], drawn: [world.center], dx: 18, around: true });
    regionC.push(...states.slice(1));
    for (const co of [...region.counties].sort((a, b) => Number(b.home) - Number(a.home))) {
      if (co.home || region.covered(co)) regionC.push({ text: `${co.name.toUpperCase()} COUNTY`, kind: 'region', min: 110, max: 1500, at: [worldPt(co.at)], drawn: [co.at], dy: 22 });
    }
    for (const pt of region.points) {
      const at = [worldPt(pt.at)], drawn = [pt.at];
      if (pt.kind === 'city') regionC.push({ text: pt.name, kind: 'city', min: 90, max: 7000, at, drawn, dx: 8 });
      if (pt.kind === 'peak') regionC.push({ text: pt.name, kind: 'peak', min: 50, max: 2600, at, drawn, dy: 14 });
      if (pt.kind === 'water') regionC.push({ text: pt.name, kind: 'sea', min: pt.name === 'Puget Sound' ? 120 : 700, max: pt.name === 'Puget Sound' ? 1600 : Infinity, at, drawn });
    }
  }

  // towns: OSM points from labels.json; region.json's city outlines say which have no pipe map yet
  const fileTowns = (f?.places ?? []).filter((p) => TOWNS[p[1]]).map(([name, kind, lon, lat]) => ({ name, kind, at: W(lon, lat), used: false }));
  if (region) {
    const open = W(OPEN_VIEW.lngLat[0], OPEN_VIEW.lngLat[1]);
    const openPlace = region.placeAt(open);
    for (const pl of [...region.places].sort((a, b) => b.area - a.area)) {
      const ws = region.toWorld(pl);
      const twin = fileTowns.find((t) => !t.used && t.name.toLowerCase() === pl.name.toLowerCase() && pointInPolygon(t.at, ws.rings));
      if (twin) twin.used = true;
      // views.ts holds the town point of the place the map opens on
      const at = twin ? twin.at : pl === openPlace ? open : worldPt(pl.at);
      const drawn = twin || pl === openPlace ? D(at) : pl.at;
      if (!region.isMapped(pl)) {
        nomapC.push({ text: pl.name, sub: NOMAP, kind: 'nomap', around: true, min: TOWN_MIN, max: TOWN_MAX, at: [at], drawn: [drawn], fill: { world: ws.rings, drawn: pl.rings, wbox: ws.box, dbox: pl.box } });
      } else {
        // the town the map opens on goes first
        townC.push({ text: pl.name, kind: 'town', around: true, min: TOWN_MIN, max: TOWN_MAX, at: [at], drawn: [drawn], weight: pl === openPlace ? Infinity : pl.area });
      }
    }
  }
  for (const t of fileTowns) {
    if (t.used) continue;
    // a city the region map marks with a dot is named beside the dot from afar
    const dot = region?.points.some((p) => p.kind === 'city' && p.name === t.name && Math.hypot(worldPt(p.at)[0] - t.at[0], worldPt(p.at)[1] - t.at[1]) < 5000);
    fileC.push({ text: t.name, kind: 'town', around: true, min: TOWN_MIN, max: dot ? 90 : TOWN_MAX, at: [t.at], drawn: [D(t.at)], tier: TOWNS[t.kind] });
  }
  townC.sort((a, b) => b.weight - a.weight);
  const townNear = (name: string, p: XY) => [...townC, ...fileC, ...nomapC].some((c) => c.text === name && Math.hypot(c.at[0][0] - p[0], c.at[0][1] - p[1]) < 3000);
  for (const [name, kind, lon, lat] of [...(f?.places ?? [])].filter((p) => HOODS[p[1]]).sort((a, b) => HOODS[b[1]] - HOODS[a[1]])) {
    const at = W(lon, lat);
    if (!townNear(name, at)) hoodC.push({ text: name, kind: 'hood', min: HOOD_MIN, max: HOOD_MAX, at: [at], drawn: [D(at)], tier: HOODS[kind] });
  }

  // lakes: the map's own outlines (one per lake where area files repeat it), then labels.json points
  const rings: { name: string; ring: XY[]; box: Box; area: number }[] = [];
  for (const w of world.waters) {
    if (!w.ring || !w.name || NOT_LAKE.test(w.name)) continue;
    const box = boxOf(w.ring), area = ringArea(w.ring);
    const twin = rings.find((q) => q.name === w.name && hit(q.box, box));
    if (!twin) rings.push({ name: w.name, ring: w.ring, box, area });
    else if (area > twin.area) Object.assign(twin, { ring: w.ring, box, area });
  }
  for (const q of rings) {
    const c: Cand = { text: q.name, kind: 'water', min: 0, max: WATER_MAX, at: [], drawn: [], across: Math.sqrt(q.area), bb: q.box };
    // thinned the first time it's in view; the region map draws the town's water unconverted, so both frames match
    c.make = () => { const r = simplify(q.ring, Math.max(3, Math.sqrt(q.area) / 300)); c.fill = { world: [r], drawn: [r], wbox: q.box, dbox: q.box }; };
    lakeC.push(c);
  }
  for (const [name, lon, lat, area] of f?.lakes ?? []) {
    if (NOT_LAKE.test(name)) continue;
    const at = W(lon, lat);
    if (rings.some((q) => q.name === name && at[0] > q.box[0] - 2000 && at[0] < q.box[2] + 2000 && at[1] > q.box[1] - 2000 && at[1] < q.box[3] + 2000)) continue;
    lakeC.push({ text: name, kind: 'water', min: 0, max: WATER_MAX, at: [at], drawn: [at], across: Math.sqrt(area), wet: true });
  }
  lakeC.sort((a, b) => (b.across ?? 0) - (a.across ?? 0));

  // creeks, named along their length; coho streams first
  const lines = new Map<string, { pts: XY[][]; fish: boolean; len: number; box: Box }>();
  for (const w of world.waters) {
    if (!w.line || !w.name || SURVEY.test(w.name)) continue;
    const e = lines.get(w.name) ?? { pts: [], fish: false, len: 0, box: [Infinity, Infinity, -Infinity, -Infinity] };
    e.pts.push(w.line);
    e.fish ||= world.isCoho(w);
    const b = boxOf(w.line);
    e.box = [Math.min(e.box[0], b[0]), Math.min(e.box[1], b[1]), Math.max(e.box[2], b[2]), Math.max(e.box[3], b[3])];
    for (let k = 1; k < w.line.length; k++) e.len += Math.hypot(w.line[k][0] - w.line[k - 1][0], w.line[k][1] - w.line[k - 1][1]);
    lines.set(w.name, e);
  }
  for (const [name, e] of [...lines].sort((a, b) => Number(b[1].fish) - Number(a[1].fish) || b[1].len - a[1].len)) {
    const c: Cand = { text: name, kind: 'water', min: 0, max: SURVEY_NEAR.test(name) ? 3 : 16, at: [], drawn: [], fish: e.fish, bb: e.box };
    c.make = () => { c.at = c.drawn = along(e.pts, 250); };
    creekC.push(c);
  }

  for (const [name, lon, lat, area] of [...(f?.parks ?? [])].sort((a, b) => b[3] - a[3])) {
    const at = W(lon, lat);
    late.push({ text: name, kind: 'place', min: 0, max: 3.4, at: [at], drawn: [D(at)], across: Math.sqrt(area) });
  }
  for (const [name, lon, lat] of f?.schools ?? []) {
    const at = W(lon, lat);
    late.push({ text: name, kind: 'place', min: 0, max: 2.7, at: [at], drawn: [D(at)] });
  }
  const home = townC.filter((c) => c.weight === Infinity);
  return { early: [...regionC, ...home, ...nomapC, ...townC.filter((c) => c.weight !== Infinity)], towns: fileC, water: [...lakeC, ...creekC], hoods: hoodC, late };
}

/** grid cell key, small enough to stay a fast integer */
const cellKey = (cx: number, cy: number) => (cx + 8192) * 16384 + cy + 8192;

/** Street names with anchors every 150 m along their runs, in a grid for finding the ones in view. */
export function streetGroups(world: World): Streets {
  const runs = world.runs, n = runs.length, G = 600, GROW = 150;
  const byName = new Map<string, number[]>();
  for (const r of runs) {
    const name = world.pieceNames[r.piece];
    if (!name) continue;
    const l = byName.get(name);
    if (l) l.push(r.i); else byName.set(name, [r.i]);
  }
  const groups: Street[] = [], gi = new Int32Array(n).fill(-1), up = new Int32Array(n);
  const find = (i: number) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  for (const [text, list] of byName) {
    if (/^unnamed/i.test(text)) continue;
    // runs of one name join when they come within about 600 m of each other
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of list) {
      up[i] = list[0];
      for (const p of runs[i].line) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    }
    // a short street is one street; a long name may be two streets far apart
    if (x1 - x0 > G || y1 - y0 > G) {
      const cell = new Map<number, number>();
      list.forEach((i) => {
        up[i] = i;
        const b = boxOf(runs[i].line);
        for (let cy = Math.floor((b[1] - GROW) / G); cy <= Math.floor((b[3] + GROW) / G); cy++) {
          for (let cx = Math.floor((b[0] - GROW) / G); cx <= Math.floor((b[2] + GROW) / G); cx++) {
            const key = cellKey(cx, cy), j = cell.get(key);
            if (j === undefined) cell.set(key, i);
            else up[find(i)] = find(j);
          }
        }
      });
    }
    const byRoot = new Map<number, number>(), norm = sameName(text);
    for (const i of list) {
      const root = find(i);
      let g = byRoot.get(root);
      if (g === undefined) { byRoot.set(root, (g = groups.length)); groups.push({ text, norm, len: 0, last: null }); }
      gi[i] = g;
    }
  }
  const acc = new Float64Array(groups.length).fill(STEP / 2), count = new Int32Array(groups.length), longest = new Int32Array(groups.length).fill(-1), longLen = new Float64Array(groups.length);
  const xs: number[] = [], ys: number[] = [], of: number[] = [];
  for (const r of runs) {
    const g = gi[r.i], l = r.line;
    if (g < 0) continue;
    let a = acc[g], runLen = 0;
    for (let k = 1; k < l.length; k++) {
      const ax = l[k - 1][0], ay = l[k - 1][1], dx = l[k][0] - ax, dy = l[k][1] - ay, L = Math.sqrt(dx * dx + dy * dy);
      let t = 0;
      while (a + L - t >= STEP) { t += STEP - a; a = 0; xs.push(ax + (dx * t) / L); ys.push(ay + (dy * t) / L); of.push(g); count[g]++; }
      a += L - t;
      runLen += L;
    }
    acc[g] = a;
    groups[g].len += runLen;
    if (runLen > longLen[g]) { longLen[g] = runLen; longest[g] = r.i; }
  }
  // short streets: one anchor in the middle of their longest run
  for (let g = 0; g < groups.length; g++) {
    if (count[g] || longest[g] < 0) continue;
    const l = runs[longest[g]].line, p = l.length > 2 ? l[l.length >> 1] : [(l[0][0] + l[l.length - 1][0]) / 2, (l[0][1] + l[l.length - 1][1]) / 2];
    xs.push(p[0]); ys.push(p[1]); of.push(g);
  }
  const cells = new Map<number, number[]>();
  for (let i = 0; i < xs.length; i++) {
    const key = cellKey(Math.floor(xs[i] / CELL), Math.floor(ys[i] / CELL)), c = cells.get(key);
    if (c) c.push(i); else cells.set(key, [i]);
  }
  return { groups, x: Float64Array.from(xs), y: Float64Array.from(ys), g: Int32Array.from(of), cells, runG: gi };
}

// ---------- sizes ----------

let fontVer = 0;
try { document.fonts.addEventListener('loadingdone', () => { fontVer++; }); } catch { /* no fonts here */ }
let mctx: CanvasRenderingContext2D | null | undefined;

/** text width in css px, or a guess where nothing can measure it */
function textW(text: string, font: string, px: number): number {
  if (mctx === undefined) {
    try { mctx = document.createElement('canvas').getContext('2d'); } catch { mctx = null; }
  }
  if (!mctx) return text.length * px * .58;
  mctx.font = font;
  return mctx.measureText(text).width;
}

const UIF = "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** the label's box in css px, halo and a small gap included */
function sizeOf(text: string, kind: Kind, phone: boolean, sub?: string, extra?: string, fish?: boolean): [number, number] {
  const m = (t: string, font: string, px: number, track = 0, upper = false) => textW(upper ? t.toUpperCase() : t, `${font} ${px}px ${UIF}`, px) + track * px * t.length;
  let w: number, h: number;
  switch (kind) {
    case 'street': { const px = phone ? 13 : 12.5; w = m(text, '600', px); h = px * 1.2; break; }
    case 'water': w = m(text, 'italic 600', 12.5) + (fish ? 22 : 0); h = 15; break;
    case 'town': w = m(text, '700', 16); h = 19.2; break;
    case 'hood': w = m(text, '700', 13, .06, true); h = 15.6; break;
    case 'place': w = m(text, '600', 12); h = 14.4; break;
    case 'region': if (extra) { w = m(text, '700', 13); h = 15.6; } else { w = textW(text, "400 16px Silkscreen, ui-monospace, monospace", 16) + 1.6 * text.length; h = 19.2; } break;
    case 'city': w = m(text, '600', 13); h = 15.6; break;
    case 'peak': w = m(text, '500', 12.5); h = 15; break;
    case 'sea': w = m(text, 'italic 600', 13, .12, true); h = 15.6; break;
    case 'nomap': w = Math.max(m(text, '700', 16), m(sub ?? '', '500', 12)); h = 19.2 + 14.4; break;
    default: w = m(text, '700', 12.5); h = 15;
  }
  return [Math.ceil(w) + 6, Math.ceil(h) + 4];
}

function label(kind: Kind, text: string, extra?: string, sub?: string, fish?: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `maplabel ml-${kind}${extra ? ` ${extra}` : ''}`;
  if (sub) {
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = text;
    b.className = 'ml-nomap-sub';
    b.textContent = sub;
    el.append(a, b);
  } else if (fish) {
    el.innerHTML = FISH;
    el.append(text);
  } else el.textContent = text;
  return el;
}

// ---------- placing ----------

interface Frame {
  m: number;
  x0: number;
  y0: number;
  W: number;
  H: number;
  phone: boolean;
  drawnFrame: boolean;
  /** middle of the open band, css px */
  cx: number;
  cy: number;
  ui: Box[];
  placed: Box[];
  /** tag boxes grown by 40 px: street names stay clear of them */
  tagsWide: Box[];
  world: World;
  r: Renderer;
}

const sideBox = (side: string, x: number, y: number, w: number, h: number, gap: number): Box =>
  side === 'r' ? [x + gap, y - h / 2, x + gap + w, y + h / 2]
    : side === 'l' ? [x - gap - w, y - h / 2, x - gap, y + h / 2]
      : side === 't' ? [x - w / 2, y - gap - h, x + w / 2, y - gap] : [x - w / 2, y + gap, x + w / 2, y + gap + h];
const sideTf = (side: string, x: number, y: number, gap: number): string =>
  side === 'r' ? `translate(${x + gap}px, ${y}px) translate(0, -50%)`
    : side === 'l' ? `translate(${x - gap}px, ${y}px) translate(-100%, -50%)`
      : side === 't' ? `translate(${x}px, ${y - gap}px) translate(-50%, -100%)` : `translate(${x}px, ${y + gap}px) translate(-50%, 0)`;

export class Labels {
  private readonly box: HTMLElement;
  private readonly world: World;
  private readonly region: Region | null;
  private names: Names = { early: [], towns: [], water: [], hoods: [], late: [] };
  private streets: Streets | null = null;
  /** street groups and OSM road names shown last time */
  private shownStreets = new Set<number>();
  private readonly roads = new Map<string, Street>();
  private shownRoads = new Set<string>();
  private readonly tagEls: { el: HTMLDivElement; key: string; tf: string; side: string }[] = [];
  private lastKey = '';
  private ver = 0;

  constructor(box: HTMLElement, world: World, region: Region | null, labelFile?: LabelFile | null) {
    this.box = box;
    this.world = world;
    this.region = region;
    // sorted once per data load
    this.streets = streetGroups(world);
    if (labelFile !== undefined) this.setFile(labelFile);
    else {
      this.setFile(file ?? null);
      if (file === undefined) void loadFile().then((f) => { if (f) this.setFile(f); });
    }
  }

  /** labels.json arrived (or not): rebuild the fixed names */
  private setFile(f: LabelFile | null): void {
    for (const list of Object.values(this.names)) for (const c of list) c.el?.remove();
    this.names = buildNames(this.world, this.region, f);
    this.ver++;
  }

  /** blocks: world points other things sit on, kept clear of labels */
  update(cam: Cam, r: Renderer, hide = false, blocks: XY[] = []): void {
    const m = cam.mpp, W = r.AW * S, H = r.AH * S;
    const phone = !!this.box.closest?.('.phone');
    const sc = r.lastScene ?? {};
    const tags = sc.tags ?? [];
    // the region map takes over past REGION_MPP, or past 40 while a drive is on the map
    const drawnFrame = !!this.region && m > (sc.route || sc.pins?.length ? 40 : REGION_MPP);
    const [x0, y0] = r.toWorld(cam, 0, 0);
    const { rects, band, key: uiKey } = this.readUI(W, H);
    const tiles: BaseTile[] = !hide && m <= STREET_MPP && r.basemap ? r.basemap.near(x0, y0, x0 + r.AW * m, y0 + r.AH * m) : [];
    const key = [Math.round(cam.x / m), Math.round(cam.y / m), m, r.AW, r.AH, +hide, +phone, +drawnFrame, uiKey, tiles.length, this.ver, fontVer,
      tags.map((t) => `${t.text}|${t.tone}|${t.n ?? ''}|${t.fish ? 1 : 0}|${Math.round(t.at[0])}|${Math.round(t.at[1])}`).join(';'),
      blocks.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(';')].join(' ');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const F: Frame = { m, x0, y0, W, H, phone, drawnFrame, cx: (band[0] + band[2]) / 2, cy: (band[1] + band[3]) / 2, ui: rects, placed: [], tagsWide: [], world: this.world, r };
    for (const p of blocks) {
      const [x, y] = this.screen(F, p);
      F.placed.push([x - 16, y - 16, x + 16, y + 16]);
    }
    this.placeTags(F, tags, band);
    const N = this.names, few = (lap: number, ph: number) => (hide ? 0 : phone ? ph : lap);
    for (const c of N.early) this.put(c, hide ? null : this.spot(F, c));
    this.placeFew(F, N.towns, m > REGION_MPP ? few(16, 7) : few(12, 6));
    for (const c of N.water) this.put(c, hide ? null : this.spot(F, c));
    this.placeFew(F, N.hoods, few(10, 5));
    this.placeStreets(F, hide, tiles);
    for (const c of N.late) this.put(c, hide ? null : this.spot(F, c));
  }

  /** Bigger kinds first, then nearest the middle of the open band, up to cap. */
  private placeFew(F: Frame, list: Cand[], cap: number): void {
    const m = F.m, near: { c: Cand; d: number }[] = [];
    for (const c of list) {
      const p = (F.drawnFrame ? c.drawn : c.at)[0];
      if (!cap || !(m > c.min && m <= c.max) || !p) { this.put(c, null); continue; }
      const [x, y] = this.screen(F, p);
      if (x < 0 || y < 0 || x > F.W || y > F.H) { this.put(c, null); continue; }
      // names already up keep their place a while
      near.push({ c, d: Math.hypot(x - F.cx, y - F.cy) - (c.last ? 150 : 0) });
    }
    near.sort((a, b) => (b.c.tier ?? 0) - (a.c.tier ?? 0) || a.d - b.d);
    let shown = 0;
    for (const { c } of near) {
      const tf = shown < cap ? this.spot(F, c) : null;
      if (tf) shown++;
      else c.last = null;
      this.put(c, tf);
    }
  }

  private screen(F: Frame, p: XY): XY {
    return [((p[0] - F.x0) / F.m) * S, ((p[1] - F.y0) / F.m) * S];
  }

  /** css px rects of the UI over the map, and the open band between the caption and the card */
  private readUI(W: number, H: number): { rects: Box[]; band: Box; key: string } {
    const band: Box = [0, 0, W, H], rects: Box[] = [];
    const stage = this.box.closest?.('.stage');
    if (!stage) return { rects, band, key: '' };
    const br = this.box.getBoundingClientRect();
    // the framed phone view is scaled; the canvas sits centered in the box
    const k = br.width / (this.box.offsetWidth || br.width || 1) || 1;
    const ox = (this.box.offsetWidth - W) / 2, oy = (this.box.offsetHeight - H) / 2;
    for (const el of stage.querySelectorAll<HTMLElement>(UI_BLOCKS)) {
      const q = el.getBoundingClientRect();
      if (q.width < 1 || q.height < 1) continue;
      const rc: Box = [(q.left - br.left) / k - ox - 4, (q.top - br.top) / k - oy - 4, (q.right - br.left) / k - ox + 4, (q.bottom - br.top) / k - oy + 4];
      rects.push(rc);
      if (el.classList.contains('caption')) band[1] = Math.max(band[1], rc[3] + 4);
      else if (el.classList.contains('sheet')) {
        // along the bottom on a phone, on the left on a laptop
        if (rc[2] - rc[0] > W * .7) band[3] = Math.min(band[3], rc[1] - 4);
        else band[0] = Math.max(band[0], rc[2] + 12);
      }
    }
    return { rects, band, key: rects.map((b) => b.map(Math.round).join(',')).join(';') };
  }

  private free(F: Frame, b: Box, street = false): boolean {
    if (b[0] < 6 || b[1] < 6 || b[2] > F.W - 6 || b[3] > F.H - 6) return false;
    for (const q of F.ui) if (hit(b, q)) return false;
    for (const q of F.placed) if (hit(b, q)) return false;
    if (street) for (const q of F.tagsWide) if (hit(b, q)) return false;
    return true;
  }

  private size(c: Cand | Street, F: Frame, kind: Kind, sub?: string, extra?: string, fish?: boolean): [number, number] {
    if (c.w === undefined || c.fv !== fontVer) [c.w, c.h, c.fv] = [...sizeOf(c.text, kind, F.phone, sub, extra, fish), fontVer];
    return [c.w, c.h!];
  }

  /** Where a fixed name goes this time: a css transform, or null. */
  private spot(F: Frame, c: Cand): string | null {
    const m = F.m;
    if (!(m > c.min && m <= c.max)) return null;
    if (c.across !== undefined && (c.across / m) * S < MIN_ACROSS) return null;
    if (c.wet && F.drawnFrame) return null;
    const [w, h] = this.size(c, F, c.kind, c.sub, c.extra, c.fish);
    // the view, less room for the label, in m
    const v: Box = [F.x0 + ((w / 2 + 8) * m) / S, F.y0 + ((h / 2 + 8) * m) / S, F.x0 + ((F.W - w / 2 - 8) * m) / S, F.y0 + ((F.H - h / 2 - 8) * m) / S];
    const inView = (p: XY) => p[0] > v[0] && p[0] < v[2] && p[1] > v[1] && p[1] < v[3];
    if (c.bb && (c.bb[2] < v[0] || c.bb[0] > v[2] || c.bb[3] < v[1] || c.bb[1] > v[3])) return null;
    if (c.make) { c.make(); c.make = undefined; }
    const pts = F.drawnFrame ? c.drawn : c.at;
    const tryAt = (p: XY): string | null => {
      if (c.wet && !this.wet(F, p)) return null;
      const [x, y] = this.screen(F, p), dy = c.dy ?? 0;
      if (c.dx === undefined) {
        const b: Box = [x - w / 2, y + dy - h / 2, x + w / 2, y + dy + h / 2];
        if (this.free(F, b)) return this.take(F, c, p, b, `translate(${Math.round(x)}px, ${Math.round(y + dy)}px) translate(-50%, -50%)`);
      } else if (!c.around) {
        const b: Box = [x + c.dx, y + dy - h / 2, x + c.dx + w, y + dy + h / 2];
        if (this.free(F, b)) return this.take(F, c, p, b, `translate(${Math.round(x + c.dx)}px, ${Math.round(y + dy)}px) translate(0, -50%)`);
      }
      // beside the point when something sits on it (the marker, a neighbor's name)
      if (c.around) {
        const gap = c.dx ?? 10;
        for (const side of ['r', 'l', 'b', 't']) {
          const b = sideBox(side, x, y, w, h, gap);
          if (this.free(F, b)) return this.take(F, c, p, b, sideTf(side, Math.round(x), Math.round(y), gap));
        }
      }
      return null;
    };
    // keep last time's spot while it still fits, so names don't hop as the map pans
    const fill = c.fill && (F.drawnFrame ? c.fill.drawn : c.fill.world);
    if (c.last && c.lastDrawn === F.drawnFrame && inView(c.last) && (!fill || pointInPolygon(c.last, fill))) {
      const tf = tryAt(c.last);
      if (tf) return tf;
    }
    const d = (p: XY) => { const [x, y] = this.screen(F, p); return (x - F.cx) ** 2 + (y - F.cy) ** 2; };
    for (const p of pts.length > 1 ? pts.filter(inView).sort((a, b) => d(a) - d(b)).slice(0, 3) : pts.filter(inView)) {
      const tf = tryAt(p);
      if (tf) return tf;
    }
    if (c.fill && fill) {
      // lakes need room around the name; the home state and cities just need to be in view
      const room = c.kind === 'water' ? (5 * m) / S : 0;
      for (const s of interior(fill, F.drawnFrame ? c.fill.dbox : c.fill.wbox, v).slice(0, 4)) {
        const tf = s.d >= room ? tryAt(s.at) : null;
        if (tf) return tf;
      }
    }
    c.last = null;
    return null;
  }

  private take(F: Frame, c: Cand, p: XY, b: Box, tf: string): string {
    F.placed.push([b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]);
    c.last = p;
    c.lastDrawn = F.drawnFrame;
    return tf;
  }

  /** water is drawn here: the town's lakes, or OSM water in a loaded tile */
  private wet(F: Frame, p: XY): boolean {
    return (F.world.waterAt(p, 0)?.d ?? 1) === 0 || !!F.r.basemap?.waterAt(p[0], p[1]);
  }

  private put(c: Cand, tf: string | null): void {
    if (!tf) { if (c.el && c.el.style.display !== 'none') c.el.style.display = 'none'; return; }
    if (!c.el) { c.el = label(c.kind, c.text, c.extra, c.sub, c.fish); this.box.append(c.el); }
    if (c.el.style.display) c.el.style.display = '';
    if (c.tf !== tf) { c.tf = tf; c.el.style.transform = tf; }
  }

  private putStreet(s: Street, tf: string | null): void {
    if (!tf) { if (s.el && s.el.style.display !== 'none') s.el.style.display = 'none'; return; }
    if (!s.el) { s.el = label('street', s.text); this.box.append(s.el); }
    if (s.el.style.display) s.el.style.display = '';
    if (s.tf !== tf) { s.tf = tf; s.el.style.transform = tf; }
  }

  /** Traced street names nearest the middle first, up to a cap per zoom; then OSM road names up close. */
  private placeStreets(F: Frame, hide: boolean, tiles: BaseTile[]): void {
    const st = this.streets, m = F.m, now = new Set<number>(), roadsNow = new Set<string>();
    const done: { norm: string; x: number; y: number }[] = [];
    let shown = 0;
    if (st && !hide && m <= STREET_MAX) {
      const cap = m <= STREET_MPP ? (F.phone ? 12 : 22) : m <= 5 ? (F.phone ? 8 : 14) : (F.phone ? 5 : 8);
      const minLen = m > 5 ? 900 : m > STREET_MPP ? 300 : 0;
      // room for a label in from each edge, in m; the middle of the open band
      const v: Box = [F.x0 + (50 * m) / S, F.y0 + (16 * m) / S, F.x0 + ((F.W - 50) * m) / S, F.y0 + ((F.H - 16) * m) / S];
      const inV = (p: XY) => p[0] >= v[0] && p[0] <= v[2] && p[1] >= v[1] && p[1] <= v[3];
      const cwx = F.x0 + (F.cx * m) / S, cwy = F.y0 + (F.cy * m) / S;
      const near = new Map<number, XY[]>();
      const add = (g: number, p: XY) => { const l = near.get(g); if (l) l.push(p); else near.set(g, [p]); };
      if (m <= STREET_MPP) {
        // up close every street in view gets a chance: points a few px apart along its runs
        const step = (12 * m) / S, W = this.world;
        for (const i of W.runsNear([(v[0] + v[2]) / 2, (v[1] + v[3]) / 2], Math.hypot(v[2] - v[0], v[3] - v[1]) / 2)) {
          const g = st.runG[i], l = W.runs[i].line;
          if (g < 0) continue;
          for (let k = 1; k < l.length; k++) {
            const [ax, ay] = l[k - 1], [bx, by] = l[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
            for (let q = k === 1 ? 0 : 1; q <= n; q++) { const p: XY = [ax + ((bx - ax) * q) / n, ay + ((by - ay) * q) / n]; if (inV(p)) add(g, p); }
          }
        }
      } else {
        for (let cy = Math.floor(v[1] / CELL); cy <= Math.floor(v[3] / CELL); cy++) {
          for (let cx = Math.floor(v[0] / CELL); cx <= Math.floor(v[2] / CELL); cx++) {
            for (const i of st.cells.get(cellKey(cx, cy)) ?? []) {
              const p: XY = [st.x[i], st.y[i]];
              if (inV(p) && st.groups[st.g[i]].len >= minLen) add(st.g[i], p);
            }
          }
        }
      }
      const d2 = (p: XY) => (p[0] - cwx) ** 2 + (p[1] - cwy) ** 2;
      const order: { g: number; pts: XY[]; d: number }[] = [];
      for (const g of this.shownStreets) {
        const last = st.groups[g].last;
        if (last && !near.has(g) && inV(last) && st.groups[g].len >= minLen) near.set(g, []);
      }
      for (const [g, pts] of near) {
        pts.sort((a, b) => d2(a) - d2(b));
        // a name already up keeps its spot while it fits, and its place in line a while
        const last = st.groups[g].last, keep = !!last && inV(last);
        if (keep) pts.unshift(last!);
        order.push({ g, pts, d: (Math.sqrt(d2(pts[0])) / m) * S - (keep ? 120 : 0) });
      }
      order.sort((a, b) => a.d - b.d);
      for (const { g, pts } of order) {
        if (shown >= cap) break;
        const s = st.groups[g], [w, h] = this.size(s, F, 'street');
        for (const p of pts.slice(0, 3)) {
          const [x, y] = this.screen(F, p), b: Box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
          // two streets of one name (courts off the same road) aren't both named close together
          if (!this.free(F, b, true) || done.some((q) => q.norm === s.norm && Math.hypot(q.x - x, q.y - y) < 250)) continue;
          F.placed.push([b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]);
          s.last = p;
          now.add(g);
          done.push({ norm: s.norm, x, y });
          this.putStreet(s, `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`);
          shown++;
          break;
        }
      }
      // OSM roads have names but no pipe data (Sumner, Puyallup); a traced label of the same name close by wins
      if (m <= STREET_MPP && shown < cap) {
        const best = new Map<string, { text: string; p: XY; d: number }>();
        const look = (norm: string, text: string, p: XY) => {
          if (!inV(p)) return;
          const d = d2(p), e = best.get(norm);
          if (!e || d < e.d) best.set(norm, { text, p, d });
        };
        for (const t of tiles) for (const rd of t.roads) {
          if (!rd.name || rd.hide || rd.box[2] < v[0] || rd.box[0] > v[2] || rd.box[3] < v[1] || rd.box[1] > v[3]) continue;
          const norm = sameName(rd.name), p = rd.pts;
          // the road's point nearest the middle, and the ends and middle of each piece
          for (let k = 2; k + 1 < p.length; k += 2) {
            const ax = p[k - 2], ay = p[k - 1], dx = p[k] - ax, dy = p[k + 1] - ay, L2 = dx * dx + dy * dy;
            const t = L2 ? Math.max(0, Math.min(1, ((cwx - ax) * dx + (cwy - ay) * dy) / L2)) : 0;
            look(norm, rd.name, [ax + t * dx, ay + t * dy]);
            look(norm, rd.name, [ax + dx / 2, ay + dy / 2]);
            look(norm, rd.name, [ax, ay]);
          }
        }
        for (const [norm, e] of [...best].sort((a, b) => a[1].d - b[1].d)) {
          if (shown >= cap) break;
          let s = this.roads.get(norm);
          if (!s) this.roads.set(norm, (s = { text: shortName(e.text), norm, len: 0, last: null }));
          const [w, h] = this.size(s, F, 'street');
          for (const p of s.last && this.shownRoads.has(norm) && inV(s.last) ? [s.last, e.p] : [e.p]) {
            const [x, y] = this.screen(F, p), b: Box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
            if (done.some((q) => q.norm === norm && Math.hypot(q.x - x, q.y - y) < 300) || !this.free(F, b, true)) continue;
            F.placed.push([b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2]);
            s.last = p;
            roadsNow.add(norm);
            done.push({ norm, x, y });
            this.putStreet(s, `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`);
            shown++;
            break;
          }
        }
      }
    }
    if (st) for (const g of this.shownStreets) if (!now.has(g)) { st.groups[g].last = null; this.putStreet(st.groups[g], null); }
    for (const n of this.shownRoads) if (!roadsNow.has(n)) this.putStreet(this.roads.get(n)!, null);
    this.shownStreets = now;
    this.shownRoads = roadsNow;
  }

  /** The picked street's tags: placed first, kept inside the open band, shown even while names are hidden. */
  private placeTags(F: Frame, tags: Tag[], band: Box): void {
    const order = tags.map((t, i) => ({ t, i })).sort((a, b) => TAG_ORDER[a.t.tone] - TAG_ORDER[b.t.tone] || (a.t.n ?? 0) - (b.t.n ?? 0) || a.i - b.i);
    // numbered end-of-story tags all show; others up to 5 on a laptop, 3 on a phone
    const cap = order.some((o) => o.t.n !== undefined) ? 5 : F.phone ? 3 : 5;
    const inBand = (b: Box) => b[0] >= band[0] + 4 && b[1] >= band[1] + 4 && b[2] <= Math.min(band[2], F.W) - 6 && b[3] <= Math.min(band[3], F.H) - 6;
    let used = 0;
    for (const { t } of order) {
      if (used >= cap) break;
      const [x, y] = this.screen(F, t.at);
      if (x < 0 || y < 0 || x > F.W || y > F.H) continue;
      const text = (F.phone && PHONE_WORDS[t.text]) || t.text;
      const w = Math.ceil(textW(text, `700 12.5px ${UIF}`, 12.5)) + 18 + (t.n !== undefined ? Math.ceil(textW(String(t.n), `700 12.5px ${UIF}`, 12.5)) + 6 : 0) + (t.fish ? 22 : 0) + 4, h = 27;
      // the destination and the street always get a tag
      const must = TAG_ORDER[t.tone] <= 1;
      let side = '', box: Box | null = null;
      for (const sd of ['r', 'l', 't', 'b']) {
        const b = sideBox(sd, x, y, w, h, 9);
        if (inBand(b) && !F.ui.some((q) => hit(b, q)) && !F.placed.some((q) => hit(b, q))) { side = sd; box = b; break; }
      }
      if (!box && must) {
        for (const sd of ['r', 'l', 't', 'b']) {
          const b = sideBox(sd, x, y, w, h, 9);
          if (inBand(b) && !F.ui.some((q) => hit(b, q))) { side = sd; box = b; break; }
        }
      }
      if (!box) continue;
      F.placed.push([box[0] - 3, box[1] - 3, box[2] + 3, box[3] + 3]);
      F.tagsWide.push([box[0] - 40, box[1] - 40, box[2] + 40, box[3] + 40]);
      let slot = this.tagEls[used];
      if (!slot) {
        const el = document.createElement('div');
        el.className = 'maplabel ml-tag';
        this.box.append(el);
        this.tagEls.push((slot = { el, key: '', tf: '', side: '' }));
      }
      const key = `${t.tone}|${t.n ?? ''}|${t.fish ? 1 : 0}|${text}`;
      if (slot.key !== key) {
        slot.key = key;
        slot.el.innerHTML = `${t.n !== undefined ? `<b class="ml-tag-n">${t.n}</b>` : ''}${t.fish ? FISH : ''}`;
        slot.el.append(text);
        slot.el.style.setProperty('--ml-tone', TONE[t.tone]);
      }
      if (slot.side !== side) { slot.side = side; slot.el.dataset.side = side; }
      const tf = sideTf(side, Math.round(x), Math.round(y), 9);
      if (slot.tf !== tf) { slot.tf = tf; slot.el.style.transform = tf; }
      if (slot.el.style.display) slot.el.style.display = '';
      used++;
    }
    for (let k = used; k < this.tagEls.length; k++) if (this.tagEls[k].el.style.display !== 'none') this.tagEls[k].el.style.display = 'none';
  }
}
