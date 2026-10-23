// Pixel map renderer: overview, pixel town, underground pipes, and the story overlays.
import { pointInPolygon, type XY } from '../../geo/geo.ts';
import { Basemap, COVER_FOREST, COVER_GRASS, COVER_PARK, COVER_SEA, COVER_WATER, type BaseTile, type Road } from './basemap.ts';
import { BAYER, hash, vnoise } from './noise.ts';
import { CAT, HATCH, LINE, mix, PICK, ROAD, ROUTE, SALMON_QUIET, SALMON_WATER, TRIP, type LineCode } from './palette.ts';
import { regionPt, worldPt, type Region, type Shape } from './region.ts';
import type { SalmonData, SLine, Tile as SalmonTile } from '../../salmon/tiles.ts';
import { FAR_MPP, type Layer, type Part, type StateMap, type WorldLayer } from './state.ts';
import type { Sprites } from './sprites.ts';
import { CLS, DRAW, G_CREEK, G_GRASS, G_LAKE, G_ROAD, type Cls, type Overview, type Water, type World } from './world.ts';

export const S = 3; // CSS px per art pixel
export const STREET_MPP = 2.6; // at or below this, draw the pixel town
export const REGION_MPP = 24; // above this, draw the region outlines
export const BLOCK_MPP = 12; // above this, no buildings
/** with a drive's route or pins up, the street map holds out to here */
export const ROUTE_MPP = 40;
/** the region map draws streets below this */
export const OV_MPP = 120;
/** salmon streams come from the near tiles, with their names, below this */
export const SALMON_NEAR_MPP = 100;
/** art px per side of a cached street tile, and how many are kept */
const OV_TILE = 128, OV_TILES = 48;

export interface Cam { x: number; y: number; mpp: number }
export interface Pin { at: XY; n: number; active?: boolean; color?: string; hollow?: boolean; badge?: 'fish' | 'soak' | 'waves' | 'q' | 'plant'; /** a mark instead of the number: '!' for the one fix's hard brake */ mark?: 'bang' }
/** rest: the ending stays drawn, still */
export interface Ending { kind: 'salmon' | 'ripple' | 'soak' | 'stop'; at: XY; t: number; rest?: boolean }
/** A word pinned to a world point; the labels draw it. n numbers the end-of-story tags. */
export interface Tag { at: XY; text: string; tone: 'street' | 'drain' | 'pipe' | 'pond' | 'creek' | 'soak' | 'other' | 'treatment' | 'gap' | 'plain'; n?: number; fish?: boolean }
/** A tapped street's rain from its drain to the end, drawn whole. */
export interface Trip { path: XY[]; cls: Cls; end: 'salmon' | 'pond' | 'soak' | 'ripple' | 'plant' | 'gap'; water: XY | null; pond: XY | null }
export interface Scene {
  dissolve?: number;
  trail?: { path: XY[]; prog: number } | null;
  drop?: XY | null;
  rain?: number;
  rainT?: number;
  ending?: Ending | null;
  /** a street drawn in the picked band, steady */
  highlight?: XY[] | null;
  /** no longer used: the picked street never blinks */
  flash?: number;
  pins?: Pin[];
  route?: XY[] | null;
  pondAt?: XY | null;
  focusRuns?: Set<number> | null;
  drainMark?: XY | null;
  car?: XY | null;
  /** dotted hop from a pond to the water the city says it drains to */
  link?: { from: XY; to: XY } | null;
  trip?: Trip | null;
  /** the picked street's runs that share its answer */
  stretch?: XY[][] | null;
  /** where the last tap landed, and when */
  tapMark?: { at: XY; t0: number } | null;
  tags?: Tag[] | null;
  /** drive results: traced streets step back to plain roads */
  muted?: boolean;
  /** zoomed out past the blocks, only streets that drain to a salmon creek keep their color */
  salmonOnly?: boolean;
  /** from each hard stop to where its water goes */
  trails?: { path: XY[]; cls: Cls }[] | null;
  /** a drive's replay: the route in colored stretches, last on top; hi: the picked one; dot: shown as a dot when too short to see; gap: not recorded (dashed) */
  replay?: { path: XY[]; color: string; hi?: boolean; dot?: boolean; gap?: boolean }[] | null;
  /** the viewer's location, accuracy in m */
  me?: { at: XY; acc: number } | null;
  /** salmon streams drawn strong, by name: the creeks of the drive being shown; the rest stay quiet */
  creeks?: ReadonlySet<string> | null;
}

type View = { x0: number; y0: number; mpp: number };
type Band = 'town' | 'overview' | 'region';

// ABGR words for ImageData
const C = (h: string) => { const n = parseInt(h.slice(1), 16); return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0; };
const PAL = {
  grass: ['#5c7a4b', '#557245', '#638251'].map(C), tuft: C('#4b6740'), flower: C('#d9cf96'),
  ograss: ['#3c5334', '#394f32', '#405837'].map(C),
  lake: [C('#2f5361'), C('#356070')], shore: C('#5f8c97'), sparkle: C('#b6d8de'),
  creek: C('#3b6b7b'), bank: C('#2a4b56'),
  asphalt: ROAD.asphalt.map(C), edge: C(ROAD.edge),
  dirt: ['#5b4434', '#543f30', '#624a3a'].map(C), pebble: C('#7a6453'), ghost: C('#4a392d'),
  tube: C('#a9a397'), tubeHi: C('#d9d3c5'), tubeLo: C('#77716a'), tubeDim: C('#5a5048'), rim: C('#2a201a'), deep: C('#25343a'),
  forest: ['#3d5734', '#38502f', '#43603a'].map(C), crown: C('#4d6b41'), crownHi: C('#5f7f4e'), crownLo: C('#2c4027'),
  park: ['#67874f', '#60804a', '#6e8f55'].map(C),
  oforest: ['#2e4329', '#2b3f26', '#32482c'].map(C), ospeck: C('#3b5534'), opark: ['#46623a', '#425d37', '#4b683f'].map(C),
  block: C('#a29c92'), blockLo: C('#77716a'),
  road: C(ROAD.fill), roadFar: C(ROAD.fillFar), ocase: C(ROAD.casing), pick: C(PICK.band),
  stream: C('#5591a3'), streamCase: C('#22404a'), city: C('#93a48d'), sWater: C(SALMON_WATER), sQuiet: C(SALMON_QUIET),
};
// roofs: house tones 0-7, then big flat roofs 8-10; each with its shadow (south, east) and lit (north, west) edge
const ROOF = ['#7d6f62', '#6b5a4c', '#776a5f', '#6d7174', '#8a8070', '#626b63', '#75696f', '#5f5650', '#a5a49e', '#8f959a', '#b1ada3'];
const ROOF_MID = ROOF.map(C), ROOF_LO = ROOF.map((h) => C(shade(h, .72))), ROOF_HI = ROOF.map((h) => C(shade(h, 1.18)));
const num = (p: number, q: number) => p - q;

function shade(h: string, f: number): string {
  const n = parseInt(h.slice(1), 16);
  const ch = (s: number) => Math.min(255, Math.round(((n >> s) & 255) * f)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// line codes per class index; streets with no answer are plain road
const PLAIN: LineCode = { w: 1, near: 1, dash: null };
const CODE: LineCode[] = CLS.map((c) => (c === 'unknown' || c === 'none' ? PLAIN : LINE[c]));
const FILL = CLS.map((c) => C(c === 'unknown' || c === 'none' ? ROAD.fill : CAT[c]));
const plain = (k: number) => CODE[k] === PLAIN;
// up close, a street still loading: its color half sunk into the asphalt
const FAINT = FILL.map((c) => mixW(c, PAL.asphalt[0], .55));

// region codes: 0 sea, 1 state, 2 coho state, 3 abroad, 4 city, 5 traced, 6 city without a pipe map,
// 7 coho state with its land drawn (state.ts), 8 its lakes; 4 to 7 take the terrain
const ABROAD = C('#1e251f');
const LAKE = 8;
const RP = {
  sea: C('#173039'), wave: C('#1f3f4b'), shore: C('#6f9aa0'),
  land: [0, C('#2b3829'), C('#3c5334'), ABROAD, C('#4b6842'), C('#3c5334'), C('#4b6842'), C('#3c5334'), C('#2f5361')],
  speck: [0, C('#283426'), C('#394f32'), ABROAD, C('#46623e'), C('#3c5334'), C('#46623e'), C('#394f32'), C('#2f5361')],
  border: [0, C('#3b4a38'), C('#5b7451'), ABROAD, C('#5b7451'), C('#5b7451'), C('#5b7451'), C('#5b7451'), C('#5b7451')],
  county: C('#4f6745'), city: C('#93a48d'), home: C('#f2d27a'), homeDim: C('#a8975e'), lake: C('#2f5361'), creek: C('#5591a3'),
  lakeRim: C('#4f7f8c'), river: C('#4b8597'),
  sCase: C('#22404a'), sWater: C(SALMON_WATER), sQuiet: C(SALMON_QUIET), sQuietFar: C(mix('#3c5334', SALMON_WATER, .38)),
  // by class: secondary, primary, trunk, motorway
  road: [0, 0, C('#5f6858'), C('#737a6b'), C('#9a9886'), C('#b9b39b')],
};
// the land by terrain cell (state.ts): its cover's color in six shades, darkest first, lit from the northwest
const TERRAIN = ['#3c5334', '#56614f', '#98a29c'];
const SHADE: ([string, number] | null)[] = [['#0f1c20', .42], ['#0f1c20', .28], ['#0f1c20', .14], null, ['#d6dc9e', .1], ['#d6dc9e', .2]];
function terrainLut(bases: string[], tint: number): Uint32Array {
  const lut = new Uint32Array(1 + SHADE.length * bases.length);
  bases.forEach((b, cv) => SHADE.forEach((sh, s) => {
    let c = C(b);
    if (sh) c = mixW(c, C(sh[0]), sh[1]);
    lut[1 + s + SHADE.length * cv] = tint ? mixW(c, RP.home, tint) : c;
  }));
  return lut;
}
const TERR = terrainLut(TERRAIN, 0);
// the traced area from afar: the same land under a light yellow
const TERR_TRACED = terrainLut(TERRAIN, .3), TRACED_FLAT = mixW(RP.land[2], RP.home, .3);
// close in, 200 m cells are too big to shade by: only towns and rock show, in the overview's grass tones
const TCLS = Uint8Array.from({ length: TERR.length }, (_, c) => (c ? Math.floor((c - 1) / SHADE.length) : 0));
const OCOVER = [PAL.ograss, ['#4f5948', '#4b5544', '#535d4c'].map(C), ['#87918c', '#828c87', '#8d9792'].map(C)];
const HATCH_W = { stripe: C(HATCH.stripe), wash: C(HATCH.wash), edge: C(HATCH.edge) };
// 3x5 digits for map pins
/** '!' in the same 3 by 5 cells */
const BANG = '010010010000010';
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

// small pixel pictures: k ink, c coral, b belly, a arrow, s soil, d dark soil, w white
const FISH = ['....kkkkk...', 'kk.kccccckk.', 'kckcccccceck', '.kccccccccck', 'kckbbbbbbbk.', 'kk.kbbbbbk..', '....kkkkk...'];
// soil with two arrows pointing down into it
const SOAK = ['kkkkkkkkk', 'kkakkkakk', 'kkakkkakk', 'kaaakaaak', 'kkakkkakk', 'ksssssssk', 'ksdsdsdsk', 'ksssssssk', 'kkkkkkkkk'];
const QMARK = ['wwwwwwwwwww', 'wwwwwwwwwww', 'wwwwkkkwwww', 'wwwkwwwkwww', 'wwwwwwwkwww', 'wwwwwwkwwww', 'wwwwwkwwwww', 'wwwwwwwwwww', 'wwwwwkwwwww', 'wwwwwwwwwww', 'wwwwwwwwwww'];
// a plant with a sawtooth roof and a stack
const PLANT = ['kkkkkkkkkkk', 'kkkkkkkwwkk', 'kkkkkkkwwkk', 'kwkkwkkwwkk', 'kwwkwwkwwkk', 'kwwwwwwwwwk', 'kwwkwwkwwwk', 'kwwwwwwwwwk', 'kwwwwwwwwwk', 'kkkkkkkkkkk'];
// 7x7 pin badges: a coho, water soaking in, waves, a question mark, a plant
const BADGE: Record<NonNullable<Pin['badge']>, string[]> = {
  fish: ['kkkkkkk', 'kkkcckk', 'kckccck', 'kkcccck', 'kckbbbk', 'kkkbbkk', 'kkkkkkk'],
  soak: ['kkkkkkk', 'kkkakkk', 'kkkakkk', 'kkaaakk', 'kkkakkk', 'ksssssk', 'kkkkkkk'],
  waves: ['kkkkkkk', 'kvkkkvk', 'vkvkvkv', 'kkkkkkk', 'kvkkkvk', 'vkvkvkv', 'kkkkkkk'],
  q: ['wwwwwww', 'wwkkkww', 'wkwwwkw', 'wwwwkww', 'wwwkwww', 'wwwwwww', 'wwwkwww'],
  plant: ['kkkkkkk', 'kkkkkwk', 'kwkwkwk', 'kwwwwwk', 'kwkwkwk', 'kwwwwwk', 'kkkkkkk'],
};
const INK: Record<string, string> = { k: '#1a1712', c: CAT.creek, b: '#f4f1e6', e: '#1a1712', a: CAT.ground, s: '#7a5a3e', d: '#4f3a28', w: '#f4f1e6', v: CAT.elsewhere };
const FISH_W: Record<string, number> = { k: C('#1a1712'), c: C(CAT.creek), b: C('#f4f1e6'), e: C('#1a1712') };

/** a color mixed t of the way to another (ABGR words) */
function mixW(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >>> s) & 255) + (((b >>> s) & 255) - ((a >>> s) & 255)) * t);
  return ((255 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
const HATCHED = new Map<number, number>();
/** A pixel of a city with no pipe map: every sixth diagonal darker, the rest a little. d = column + row in world pixels. */
function hatchPx(c: number, d: number): number {
  const s = ((d % 6) + 6) % 6 === 0 ? 1 : 0, key = (c & 0xffffff) * 2 + s;
  let out = HATCHED.get(key);
  if (out === undefined) HATCHED.set(key, (out = s ? mixW(c, HATCH_W.stripe, .45) : mixW(c, HATCH_W.wash, .18)));
  return out;
}

const dashLen = (d: readonly number[]) => d.reduce((s, v) => s + v, 0);
/** Is step s inside an "on" part of the dash? */
function dashOn(d: readonly number[], s: number): boolean {
  let t = s % dashLen(d);
  for (let q = 0; q < d.length; q++) {
    if (t < d[q]) return (q & 1) === 0;
    t -= d[q];
  }
  return false;
}

export class Renderer {
  AW = 0;
  AH = 0;
  private readonly ctx: CanvasRenderingContext2D;
  // sprites go on their own canvas; pixels are never read back from it
  private readonly surf = document.createElement('canvas');
  private readonly mask = document.createElement('canvas');
  private readonly tmp = document.createElement('canvas');
  private sctx!: CanvasRenderingContext2D;
  private mctx!: CanvasRenderingContext2D;
  private tctx!: CanvasRenderingContext2D;
  private imgS!: ImageData;
  private imgU!: ImageData;
  private imgM!: ImageData;
  private wS!: Uint32Array;
  private wU!: Uint32Array;
  private wM!: Uint32Array;
  private codes = new Uint8Array(0);
  private rows: number[][] = [];
  // per pixel, rebuilt each frame: land cover class, building id, and roads outside the city data
  private cover = new Uint8Array(0);
  private bid = new Int32Array(0);
  private croad = new Uint8Array(0);
  // the city's lakes, per pixel, in the overview
  private lake = new Uint8Array(0);
  // cities with no pipe map, per pixel, in the overview
  private hatch = new Uint8Array(0);
  // close in, per pixel: a basemap tile is there (1), and the statewide terrain cell where none is
  private based = new Uint8Array(0);
  private terr = new Uint8Array(0);
  // near the story's path, per pixel, underground
  private nearPath = new Uint8Array(0);
  private tones = new Uint8Array(1 << 16);
  private readonly xs = new Float64Array(64);
  // the region map's terrain cell column per pixel column, and one row of terrain tiles
  private cols = new Int32Array(0);
  private readonly tileRow: (Uint8Array | undefined)[] = [];
  private surfUsed = false;
  region: Region | null = null;
  /** real buildings, land cover and roads; null draws plain grass */
  basemap: Basemap | null = new Basemap();
  /** every traced street, simplified; drawn where its area isn't loaded */
  overview: Overview | null = null;
  /** the land statewide: terrain, lakes, rivers and big roads */
  state: StateMap | null = null;
  /** salmon streams statewide (src/salmon) */
  salmon: SalmonData | null = null;
  /** the scene from the last draw */
  lastScene: Scene = {};
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  /** The viewer asked for less motion (checked live). */
  get calm(): boolean {
    return !!this.motion?.matches;
  }

  readonly canvas: HTMLCanvasElement;
  readonly world: World;
  readonly sprites: Sprites;

  constructor(canvas: HTMLCanvasElement, world: World, sprites: Sprites) {
    [this.canvas, this.world, this.sprites] = [canvas, world, sprites];
    this.ctx = canvas.getContext('2d')!;
  }

  resize(cssW: number, cssH: number): void {
    this.AW = Math.max(40, Math.ceil(cssW / S));
    this.AH = Math.max(40, Math.ceil(cssH / S));
    for (const c of [this.canvas, this.surf, this.mask, this.tmp]) { c.width = this.AW; c.height = this.AH; }
    this.canvas.style.width = `${this.AW * S}px`;
    this.canvas.style.height = `${this.AH * S}px`;
    this.sctx = this.surf.getContext('2d')!;
    this.mctx = this.mask.getContext('2d')!;
    this.tctx = this.tmp.getContext('2d')!;
    this.imgS = this.sctx.createImageData(this.AW, this.AH);
    this.imgU = this.ctx.createImageData(this.AW, this.AH);
    this.imgM = this.mctx.createImageData(this.AW, this.AH);
    this.wS = new Uint32Array(this.imgS.data.buffer);
    this.wU = new Uint32Array(this.imgU.data.buffer);
    this.wM = new Uint32Array(this.imgM.data.buffer);
    const n = this.AW * this.AH;
    this.codes = new Uint8Array(n);
    this.cover = new Uint8Array(n);
    this.bid = new Int32Array(n);
    this.croad = new Uint8Array(n);
    this.lake = new Uint8Array(n);
    this.hatch = new Uint8Array(n);
    this.based = new Uint8Array(n);
    this.terr = new Uint8Array(n);
    this.nearPath = new Uint8Array(n);
    this.rows = Array.from({ length: this.AH }, () => []);
    this.cols = new Int32Array(this.AW);
  }

  private view(cam: Cam): View {
    const cx = Math.round(cam.x / cam.mpp) * cam.mpp, cy = Math.round(cam.y / cam.mpp) * cam.mpp;
    return { x0: cx - (this.AW / 2) * cam.mpp, y0: cy - (this.AH / 2) * cam.mpp, mpp: cam.mpp };
  }

  toWorld(cam: Cam, cssX: number, cssY: number): XY {
    const v = this.view(cam);
    return [v.x0 + (cssX / S) * v.mpp, v.y0 + (cssY / S) * v.mpp];
  }

  toScreen(cam: Cam, p: XY): XY {
    const v = this.view(cam);
    return [((p[0] - v.x0) / v.mpp) * S, ((p[1] - v.y0) / v.mpp) * S];
  }

  draw(cam: Cam, sc: Scene, now: number): void {
    this.lastScene = sc;
    const v = this.view(cam), m = v.mpp;
    const a = (p: XY): XY => [Math.round((p[0] - v.x0) / m), Math.round((p[1] - v.y0) / m)];
    // a drive's route and pins keep the street map out to ROUTE_MPP
    const drive = (sc.route?.length ?? 0) > 1 || (sc.pins?.length ?? 0) > 0 || (sc.replay?.length ?? 0) > 0;
    const town = m <= STREET_MPP, region = !town && m > (drive ? ROUTE_MPP : REGION_MPP) && !!this.region;
    // buildings are kept in the tile holding their middle, so look a little past the edges
    const pad = 120, tiles = region || !this.basemap ? [] : this.basemap.near(v.x0 - pad, v.y0 - pad, v.x0 + this.AW * m + pad, v.y0 + this.AH * m + pad, m <= BLOCK_MPP);
    this.surfUsed = false;
    if (town) this.drawTown(v, sc, now, a, tiles);
    else if (region) this.drawRegion(v, sc, now, a);
    else this.drawOverview(v, sc, tiles);
    const dis = town ? sc.dissolve ?? 0 : 0;
    const ctx = this.ctx;
    if (dis > 0) {
      // ordered-dither dissolve: each pixel flips to underground at its own threshold
      this.drawUnder(v, sc.trail?.path ?? sc.trip?.path ?? null);
      const thr = dis * 64, AW = this.AW;
      for (let j = 0; j < this.AH; j++) for (let i = 0; i < AW; i++) {
        const k = j * AW + i;
        const up = BAYER[(j & 7) * 8 + (i & 7)] >= thr;
        if (up) this.wU[k] = this.wS[k];
        this.wM[k] = up ? 0xff000000 : 0;
      }
      ctx.putImageData(this.imgU, 0, 0);
      for (const i of this.world.drainsNear([v.x0 + (AW * m) / 2, v.y0 + (this.AH * m) / 2], Math.max(AW, this.AH) * m)) {
        const [x, y] = a(this.world.drains[i]);
        if (x < 1 || y < 1 || x >= AW - 2 || y >= this.AH - 2 || BAYER[(y & 7) * 8 + (x & 7)] >= thr) continue;
        px(ctx, x - 2, y - 2, '#2a201a', 5, 5); px(ctx, x - 1, y - 1, '#8a8378', 3, 3); px(ctx, x, y, '#2a201a');
      }
      this.mctx.putImageData(this.imgM, 0, 0);
      const t = this.tctx;
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, AW, this.AH);
      t.drawImage(this.surf, 0, 0);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(this.mask, 0, 0);
      t.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.tmp, 0, 0);
    } else {
      ctx.putImageData(this.imgS, 0, 0);
      if (this.surfUsed) ctx.drawImage(this.surf, 0, 0);
    }
    this.drawOverlays(v, sc, now, a, town ? 'town' : region ? 'region' : 'overview');
  }

  // ---------- what's in view ----------

  /** Street runs or waters whose box meets the view: the fine grid up close, the coarse box grid far out. */
  private inView(v: View, what: 'runs' | 'waters'): number[] {
    const { AW, AH } = this, m = v.mpp, W = this.world, x1 = v.x0 + AW * m, y1 = v.y0 + AH * m;
    if (AW * m < 6000) {
      const mid: XY = [(v.x0 + x1) / 2, (v.y0 + y1) / 2], r = (Math.max(AW, AH) * m) / 2 + 40;
      // waters in a fixed order, so the fish stay put
      return what === 'runs' ? W.runsNear(mid, r) : W.watersNear(mid, r).sort(num);
    }
    return what === 'runs' ? W.runsIn(v.x0, v.y0, x1, y1) : W.watersIn(v.x0, v.y0, x1, y1);
  }

  private readonly ovBuf: number[] = [];

  /** Overview runs in view whose area isn't loaded yet. */
  private ovInView(v: View): number[] {
    const O = this.overview;
    if (!O) return [];
    const m = v.mpp;
    return O.missingIn(v.x0 - 2 * m, v.y0 - 2 * m, v.x0 + (this.AW + 2) * m, v.y0 + (this.AH + 2) * m, this.ovBuf);
  }

  /** plot() for one overview run. */
  private plotOv(k: number, v: View, col: number, w: number, dash: readonly number[] | null): void {
    const O = this.overview!, P = O.pts, m = v.mpp, e = O.start[k + 1];
    let step = 0;
    for (let o = O.start[k] + 1; o < e; o++) step = this.seg((P[2 * o - 2] - v.x0) / m, (P[2 * o - 1] - v.y0) / m, (P[2 * o] - v.x0) / m, (P[2 * o + 1] - v.y0) / m, col, w, dash, step, null);
  }

  /** stroke() for one overview run, one pixel wide; dashed skips every other pair. Far out most pieces are under a pixel, so it stays tight. */
  private strokeOv(k: number, v: View, col: number, dash: boolean): void {
    const O = this.overview!, P = O.pts, m = v.mpp, e = O.start[k + 1], { AW, AH } = this, w = this.wS;
    let n = 0, lx = Math.round((P[2 * O.start[k]] - v.x0) / m), ly = Math.round((P[2 * O.start[k] + 1] - v.y0) / m), px = -1, py = -1;
    for (let o = O.start[k] + 1; o < e; o++) {
      const x1 = Math.round((P[2 * o] - v.x0) / m), y1 = Math.round((P[2 * o + 1] - v.y0) / m);
      let x = lx, y = ly;
      const len = Math.max(Math.abs(x1 - x), Math.abs(y1 - y));
      if ((x < 0 && x1 < 0) || (y < 0 && y1 < 0) || (x >= AW && x1 >= AW) || (y >= AH && y1 >= AH)) { lx = px = x1; ly = py = y1; n += len; continue; }
      if (len > AW + AH) {
        // a very long piece: only the part in view
        const c = clipSeg(x, y, x1, y1, AW, AH), n0 = n;
        lx = px = x1; ly = py = y1;
        if (c) bres(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3]), (i, j) => { if (!(dash && (n++ & 3) > 1) && i >= 0 && j >= 0 && i < AW && j < AH) w[j * AW + i] = col; });
        n = n0 + len;
        continue;
      }
      const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        if (x !== px || y !== py) {
          [px, py] = [x, y];
          // dashes count every pixel, in view or not, so they stay put while panning
          if (!(dash && (n++ & 3) > 1) && x >= 0 && y >= 0 && x < AW && y < AH) w[y * AW + x] = col;
        }
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
      }
      lx = x1; ly = y1;
    }
  }

  /** Far out, every traced street from the overview, loaded or not: the same picture at a fraction of the points. */
  private strokeAllOv(v: View, muted: boolean, only = false): void {
    const by = this.ovByClass(v, false);
    for (const k of DRAW) {
      const flat = muted || plain(k) || (only && k !== 0);
      for (const q of by[k]) this.strokeOv(q, v, flat ? PAL.road : FILL[k], !flat && !!CODE[k].dash);
    }
  }

  private readonly ovCls: number[][] = CLS.map(() => []);
  // far out, the traced streets at one zoom, in world-fixed tiles
  private readonly ovTiles = new Map<string, Uint32Array>();
  private ovKey = '';
  private ovFor: Overview | null = null;
  private lastMpp = 0;

  /** Far out, the traced streets: while the zoom holds still, drawn once into tiles and copied in, so panning skips them. */
  private ovLayer(v: View, key: string, draw: (t: View) => void): void {
    const m = v.mpp, { AW, AH } = this, T = OV_TILE, still = m === this.lastMpp;
    this.lastMpp = m;
    if (!still) { draw(v); return; }
    // half a pixel off the grid when the canvas is an odd number of pixels across
    const fx = AW & 1 ? .5 : 0, fy = AH & 1 ? .5 : 0, k0 = `${m}|${fx}|${fy}|${key}`;
    if (k0 !== this.ovKey || this.ovFor !== this.overview) { this.ovTiles.clear(); [this.ovKey, this.ovFor] = [k0, this.overview]; }
    const ox = Math.round(v.x0 / m - fx), oy = Math.round(v.y0 / m - fy), w = this.wS;
    for (let ty = Math.floor(oy / T); ty * T < oy + AH; ty++) for (let tx = Math.floor(ox / T); tx * T < ox + AW; tx++) {
      const id = `${tx},${ty}`;
      let tile = this.ovTiles.get(id);
      if (tile) this.ovTiles.delete(id);
      else {
        tile = new Uint32Array(T * T);
        [this.wS, this.AW, this.AH] = [tile, T, T];
        try { draw({ x0: (tx * T + fx) * m, y0: (ty * T + fy) * m, mpp: m }); } finally { [this.wS, this.AW, this.AH] = [w, AW, AH]; }
        // the least recently used goes; a big screen keeps two views' worth
        if (this.ovTiles.size >= Math.max(OV_TILES, 2 * (Math.ceil(AW / T) + 1) * (Math.ceil(AH / T) + 1))) this.ovTiles.delete(this.ovTiles.keys().next().value!);
      }
      this.ovTiles.set(id, tile);
      const i0 = Math.max(0, tx * T - ox), i1 = Math.min(AW, (tx + 1) * T - ox), j1 = Math.min(AH, (ty + 1) * T - oy);
      for (let j = Math.max(0, ty * T - oy); j < j1; j++) {
        const src = (j + oy - ty * T) * T + ox - tx * T, dst = j * AW;
        for (let i = i0; i < i1; i++) { const c = tile[src + i]; if (c) w[dst + i] = c; }
      }
    }
  }

  /** Overview runs in view by class; missing: only those whose area isn't loaded. */
  private ovByClass(v: View, missing: boolean): number[][] {
    const O = this.overview!, m = v.mpp, by = this.ovCls, x0 = v.x0 - 2 * m, y0 = v.y0 - 2 * m, x1 = v.x0 + (this.AW + 2) * m, y1 = v.y0 + (this.AH + 2) * m;
    const ids = missing ? O.missingIn(x0, y0, x1, y1, this.ovBuf) : O.grid.query(x0, y0, x1, y1, this.ovBuf);
    for (const l of by) l.length = 0;
    for (const q of ids) by[O.cls[q]].push(q);
    return by;
  }

  /** A one pixel line through an overview run, straight into the buffer. */
  private lineOv(k: number, v: View, col: number): void {
    const O = this.overview!, P = O.pts, m = v.mpp, e = O.start[k + 1], { AW, AH } = this, w = this.wS;
    let x = Math.round((P[2 * O.start[k]] - v.x0) / m), y = Math.round((P[2 * O.start[k] + 1] - v.y0) / m);
    for (let o = O.start[k] + 1; o < e; o++) {
      const x1 = Math.round((P[2 * o] - v.x0) / m), y1 = Math.round((P[2 * o + 1] - v.y0) / m);
      if ((x < 0 && x1 < 0) || (y < 0 && y1 < 0) || (x >= AW && x1 >= AW) || (y >= AH && y1 >= AH) || Math.abs(x1 - x) + Math.abs(y1 - y) > 2 * (AW + AH)) {
        if (!((x < 0 && x1 < 0) || (y < 0 && y1 < 0) || (x >= AW && x1 >= AW) || (y >= AH && y1 >= AH))) this.seg(x, y, x1, y1, col, 1, null, 0, null);
        x = x1; y = y1;
        continue;
      }
      const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        if (x >= 0 && y >= 0 && x < AW && y < AH) w[y * AW + x] = col;
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
      }
    }
  }

  private readonly surveyed = new WeakMap<Water, boolean>();

  /** An unnamed stream line lying mostly (80%+) inside a lake: a survey line drawn across it, not drawn. */
  private survey(wt: Water): boolean {
    if (!wt.line || !/unnamed/i.test(wt.name)) return false;
    let s = this.surveyed.get(wt);
    if (s === undefined) {
      const W = this.world, L = wt.line;
      let n = 0, wet = 0;
      for (let q = 1; q < L.length; q++) {
        const p0 = L[q - 1], p1 = L[q], len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        for (let d = 0; d < len; d += 10) {
          const p: XY = [p0[0] + ((p1[0] - p0[0]) * d) / len, p0[1] + ((p1[1] - p0[1]) * d) / len];
          n++;
          if (W.watersNear(p, 1).some((i) => { const r = W.waters[i].ring; return !!r && pointInPolygon(p, [r]); })) wet++;
        }
      }
      s = n > 0 && wet >= 0.8 * n;
      this.surveyed.set(wt, s);
    }
    return s;
  }

  // ---------- overview ----------

  private drawOverview(v: View, sc: Scene, tiles: BaseTile[]): void {
    const { AW, AH } = this, m = v.mpp, w = this.wS, cover = this.cover, bid = this.bid, lake = this.lake, W = this.world;
    const close = m <= BLOCK_MPP;
    this.rasterBase(v, tiles, false);
    // where no basemap tile is, the land statewide
    const near = this.stateNear(v, false), terr = this.terr, tc = !!near && this.terrainClose(v);
    const waters = this.inView(v, 'waters');
    // the city's lakes and OSM water share one shoreline
    lake.fill(0);
    for (const i of waters) { const ring = W.waters[i].ring; if (ring) this.fill(lake, [ring], 1, v); }
    const hatched = this.hatchView(v), hatch = this.hatch;
    const wet = (k: number) => lake[k] > 0 || cover[k] === COVER_WATER;
    const gx = Math.round(v.x0 / m), gy = Math.round(v.y0 / m);
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      // vnoise(wx, wy, 140, 21) with its corner hashes kept while the cell stays the same
      const ny = wy / 140, ngy = Math.floor(ny), fy = ny - ngy, uy = fy * fy * (3 - 2 * fy);
      let ngx = NaN, na = 0, nb = 0, nc = 0, nd = 0;
      for (let i = 0; i < AW; i++) {
        const k = j * AW + i, cv = cover[k], id = bid[k];
        if (lake[k] || (!id && cv === COVER_WATER)) {
          const shore = (i > 0 && !wet(k - 1)) || (j > 0 && !wet(k - AW)) || (i + 1 < AW && !wet(k + 1)) || (j + 1 < AH && !wet(k + AW));
          w[k] = shore ? PAL.shore : PAL.lake[0];
          continue;
        }
        // buildings as light blocks, darker along the bottom once they are two pixels tall
        if (id) { w[k] = j > 0 && j + 1 < AH && bid[k - AW] === id && bid[k + AW] !== id ? PAL.blockLo : PAL.block; continue; }
        const nx = (v.x0 + (i + .5) * m) / 140, cx = Math.floor(nx), fx = nx - cx, ux = fx * fx * (3 - 2 * fx);
        if (cx !== ngx) [ngx, na, nb, nc, nd] = [cx, hash(cx, ngy, 21), hash(cx + 1, ngy, 21), hash(cx, ngy + 1, 21), hash(cx + 1, ngy + 1, 21)];
        const n = (na + (nb - na) * ux + (nc - na) * uy + (na - nb - nc + nd) * ux * uy) * 2.2 + (BAYER[(j & 7) * 8 + (i & 7)] / 64 - .5) * .9;
        const t = n < .75 ? 1 : n < 1.45 ? 0 : 2;
        let c = cv === COVER_FOREST ? (hash(gx + i, gy + j, 13) < .1 ? PAL.ospeck : PAL.oforest[t]) : (cv ? PAL.opark : tc && terr[k] ? OCOVER[TCLS[terr[k]]] : PAL.ograss)[t];
        // a city whose pipe map isn't in TireTrail yet: stripes on its land
        if (hatched && hatch[k]) c = hatchPx(c, gx + i + gy + j);
        w[k] = c;
      }
    }
    this.plotRoads(v, tiles);
    if (near) this.plotState(v, near, close);
    // streams, casing first; survey lines across lakes stay out
    const lines: Water[] = [];
    for (const i of waters) { const wt = W.waters[i]; if (wt.line && !this.survey(wt)) lines.push(wt); }
    for (const wt of lines) this.plot(wt.line!, v, PAL.streamCase, 3);
    for (const wt of lines) this.plot(wt.line!, v, PAL.stream, 1);
    const sal = this.salmonWorld(v, sc.creeks ?? null);
    // up close, coho on their streams, clear of a trip's own salmon; drive results leave the coral to the pins
    const end = sc.trip?.path.length ? sc.trip.water ?? sc.trip.path[sc.trip.path.length - 1] : null;
    if (!sc.muted && close) this.fish(v, lines, sal, end ? [Math.round((end[0] - v.x0) / m), Math.round((end[1] - v.y0) / m)] : null);
    // traced streets: every casing, then the fills with creek on top
    const muted = !!sc.muted, focus = sc.focusRuns ?? null, only = !!sc.salmonOnly && !close;
    const road = close ? PAL.road : PAL.roadFar;
    if (!close && !focus && this.overview) {
      // past block zoom the overview is the same picture with far fewer points, loaded or not
      this.ovLayer(v, `o${+muted}${+only}`, (t) => {
        const by = this.ovByClass(t, false);
        for (const k of DRAW) {
          const flat = muted || plain(k) || (only && k !== 0), wd = flat ? 1 : CODE[k].w, dash = flat ? null : CODE[k].dash, col = flat ? road : FILL[k];
          for (const q of by[k]) if (wd === 1 && !dash) this.lineOv(q, t, col); else this.plotOv(q, t, col, wd, dash);
        }
      });
    } else this.drawRuns(v, muted || only, focus, close, road, only);
    if (hatched) this.hatchEdges(v);
  }

  /** Traced streets in the overview band: casings up close, then fills with creek on top; overview runs stand in for areas not loaded. */
  private drawRuns(v: View, muted: boolean, focus: Set<number> | null, close: boolean, road: number, only = false): void {
    const W = this.world, runs = this.inView(v, 'runs');
    // streets of areas not loaded yet, from the overview, drawn the same way
    const ov = this.ovInView(v), O = this.overview;
    if (close) {
      for (const i of runs) {
        const r = W.runs[i];
        this.plot(r.line, v, PAL.ocase, (focus ? (focus.has(r.i) ? 2 : 1) : muted ? 1 : CODE[r.k].w) + 2);
      }
      for (const q of ov) this.plotOv(q, v, PAL.ocase, (focus || muted ? 1 : CODE[O!.cls[q]].w) + 2, null);
    }
    for (const k of DRAW) {
      const flat = (muted && !(only && k === 0)) || !!focus || plain(k);
      for (const i of runs) {
        const r = W.runs[i];
        if (r.k !== k || (focus && focus.has(r.i))) continue;
        if (flat) this.plot(r.line, v, road, 1);
        else this.plot(r.line, v, FILL[k], CODE[k].w, CODE[k].dash);
      }
      for (const q of ov) {
        if (O!.cls[q] !== k) continue;
        if (flat) this.plotOv(q, v, road, 1, null);
        else this.plotOv(q, v, FILL[k], CODE[k].w, CODE[k].dash);
      }
    }
    if (focus) for (const i of runs) if (focus.has(W.runs[i].i)) this.plot(W.runs[i].line, v, PAL.pick, 2);
  }

  /** Marks the land of cities with no pipe map in TireTrail; false if none is in view. */
  private hatchView(v: View): boolean {
    const R = this.region;
    if (!R) return false;
    const x1 = v.x0 + this.AW * v.mpp, y1 = v.y0 + this.AH * v.mpp;
    let any = false;
    for (const pl of R.places) {
      if (R.isMapped(pl)) continue;
      const sh = R.toWorld(pl);
      if (sh.box[2] < v.x0 || sh.box[0] > x1 || sh.box[3] < v.y0 || sh.box[1] > y1) continue;
      if (!any) this.hatch.fill(0);
      any = true;
      this.fill(this.hatch, sh.rings, 1, v);
    }
    return any;
  }

  /** Dashed limits of the cities with no pipe map. */
  private hatchEdges(v: View): void {
    const R = this.region!;
    for (const pl of R.places) if (!R.isMapped(pl)) for (const ring of R.toWorld(pl).rings) this.plot(ring, v, HATCH_W.edge, 1, [2, 2], true);
  }

  /** Coho salmon on their streams, then on the statewide salmon streams: one fish every 90 art px or more, at most 4 in view, none near `clear`. */
  private fish(v: View, lines: Water[], sal: readonly { pts: Float32Array }[], clear: XY | null): void {
    const m = v.mpp, gap = 90, step = gap * m, placed: XY[] = clear ? [clear] : [];
    let drawn = 0;
    // spots fixed along each line, so the fish stay put while panning; false once 4 are in
    const along = (n: number, at: (q: number) => XY): boolean => {
      let run = 0;
      for (let q = 1; q < n; q++) {
        const p0 = at(q - 1), p1 = at(q), len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (!len) continue;
        for (let d = Math.ceil((run - step / 2) / step) * step + step / 2; d <= run + len; d += step) {
          const t = (d - run) / len;
          const x = Math.round((p0[0] + (p1[0] - p0[0]) * t - v.x0) / m), y = Math.round((p0[1] + (p1[1] - p0[1]) * t - v.y0) / m);
          // not out in a lake the stream runs through
          if (x < 8 || y < 6 || x >= this.AW - 8 || y >= this.AH - 6 || this.lake[y * this.AW + x] || placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < gap)) continue;
          placed.push([x, y]);
          this.stamp(FISH, FISH_W, x - 6, y - 3, p1[0] < p0[0]);
          if (++drawn >= 4) return false;
        }
        run += len;
      }
      return true;
    };
    for (const wt of lines) if (this.world.isCoho(wt) && !along(wt.line!.length, (q) => wt.line![q])) return;
    for (const l of sal) if (!along(l.pts.length >> 1, (q) => [l.pts[2 * q], l.pts[2 * q + 1]])) return;
  }

  /** A small picture into the pixel buffer; flip mirrors it. */
  private stamp(rows: string[], ink: Record<string, number>, x0: number, y0: number, flip: boolean): void {
    const { AW, AH } = this, n = rows[0].length;
    for (let j = 0; j < rows.length; j++) for (let i = 0; i < n; i++) {
      const ch = rows[j][flip ? n - 1 - i : i], x = x0 + i, y = y0 + j;
      if (ch !== '.' && x >= 0 && y >= 0 && x < AW && y < AH) this.wS[y * AW + x] = ink[ch];
    }
  }

  /** Land cover, buildings and (in town) basemap roads for this view, into the per-pixel buffers. */
  private rasterBase(v: View, tiles: BaseTile[], town: boolean): void {
    const { AW, AH } = this, m = v.mpp, x1 = v.x0 + AW * m, y1 = v.y0 + AH * m, bid = this.bid;
    const seen = (b: ArrayLike<number>, o: number) => b[o + 2] >= v.x0 && b[o] <= x1 && b[o + 3] >= v.y0 && b[o + 1] <= y1;
    this.cover.fill(0);
    bid.fill(0);
    this.croad.fill(0);
    // the sea last, drawn as water
    for (const cls of [COVER_FOREST, COVER_GRASS, COVER_PARK, COVER_WATER, COVER_SEA]) for (const t of tiles) for (const c of t.cover) {
      if (c.cls === cls && seen(c.box, 0)) this.scan(this.cover, c.pts, c.ranges, cls === COVER_SEA ? COVER_WATER : cls, v);
    }
    if (town) for (const t of tiles) for (const r of t.roads) if (seen(r.box, 0) && this.shown(r)) this.thick(r.pts, r.major ? 7 : 5, r.major ? 2 : 1, v);
    if (m > BLOCK_MPP) return;
    let id = 0;
    const tiny = 1.5 * m;
    for (const t of tiles) for (let i = 0; i < t.tone.length; i++) {
      const bb = t.bb, o = 4 * i;
      if (!seen(bb, o)) continue;
      if (++id >= this.tones.length) { const g = new Uint8Array(this.tones.length * 2); g.set(this.tones); this.tones = g; }
      this.tones[id] = t.tone[i];
      if ((bb[o + 2] - bb[o] >= tiny || bb[o + 3] - bb[o + 1] >= tiny) && this.scanRing(t.bv, t.bs[i], t.bs[i + 1], id, v)) continue;
      // a pixel or less across: its middle pixel
      const x = Math.floor(((bb[o] + bb[o + 2]) / 2 - v.x0) / m), y = Math.floor(((bb[o + 1] + bb[o + 3]) / 2 - v.y0) / m);
      if (x >= 0 && y >= 0 && x < AW && y < AH) bid[y * AW + x] = id;
    }
  }

  /** Even-odd fill of a land cover polygon (world x, y pairs; [start, end) vertex ranges per ring) at pixel centers. */
  private scan(buf: Uint8Array, pts: Float32Array, ranges: ArrayLike<number>, val: number, v: View, skip: Uint8Array | null = null): void {
    const { AW, AH } = this, m = v.mpp, rows = this.rows;
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < ranges.length; r += 2) for (let k = ranges[r]; k < ranges[r + 1]; k++) {
      const y = pts[2 * k + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const j0 = Math.max(0, Math.ceil((lo - v.y0) / m - .5)), j1 = Math.min(AH - 1, Math.ceil((hi - v.y0) / m - .5) - 1);
    if (j0 > j1) return;
    for (let j = j0; j <= j1; j++) rows[j].length = 0;
    for (let r = 0; r < ranges.length; r += 2) {
      const s = ranges[r], e = ranges[r + 1];
      for (let k = s, p = e - 1; k < e; p = k++) {
        const ya = (pts[2 * p + 1] - v.y0) / m, yb = (pts[2 * k + 1] - v.y0) / m;
        if (ya === yb) continue;
        const xa = (pts[2 * p] - v.x0) / m, xb = (pts[2 * k] - v.x0) / m;
        const a = Math.max(j0, Math.ceil(Math.min(ya, yb) - .5)), b = Math.min(j1, Math.ceil(Math.max(ya, yb) - .5) - 1);
        for (let j = a; j <= b; j++) rows[j].push(xa + ((j + .5 - ya) * (xb - xa)) / (yb - ya));
      }
    }
    this.spans(buf, j0, j1, val, false, skip);
  }

  /** Even-odd fill of rings in world meters at pixel centers; `only` writes just where buf is already set. */
  private fill(buf: Uint8Array, rings: readonly (readonly XY[])[], val: number, v: View, only = false): void {
    const { AH } = this, m = v.mpp, rows = this.rows;
    let lo = Infinity, hi = -Infinity;
    for (const ring of rings) for (const p of ring) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    const j0 = Math.max(0, Math.ceil((lo - v.y0) / m - .5)), j1 = Math.min(AH - 1, Math.ceil((hi - v.y0) / m - .5) - 1);
    if (j0 > j1) return;
    for (let j = j0; j <= j1; j++) rows[j].length = 0;
    for (const ring of rings) for (let k = 0, p = ring.length - 1; k < ring.length; p = k++) {
      const ya = (ring[p][1] - v.y0) / m, yb = (ring[k][1] - v.y0) / m;
      if (ya === yb) continue;
      const xa = (ring[p][0] - v.x0) / m, xb = (ring[k][0] - v.x0) / m;
      const a = Math.max(j0, Math.ceil(Math.min(ya, yb) - .5)), b = Math.min(j1, Math.ceil(Math.max(ya, yb) - .5) - 1);
      for (let j = a; j <= b; j++) rows[j].push(xa + ((j + .5 - ya) * (xb - xa)) / (yb - ya));
    }
    this.spans(buf, j0, j1, val, only);
  }

  /** Fills between pairs of crossings on rows j0..j1. */
  private spans(buf: Uint8Array, j0: number, j1: number, val: number, only: boolean, skip: Uint8Array | null = null): void {
    const AW = this.AW, rows = this.rows;
    for (let j = j0; j <= j1; j++) {
      const xs = rows[j];
      if (xs.length < 2) continue;
      if (xs.length > 2) xs.sort(num);
      else if (xs[0] > xs[1]) { const q = xs[0]; xs[0] = xs[1]; xs[1] = q; }
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const o = j * AW, i0 = Math.max(0, Math.ceil(xs[q] - .5)), i1 = Math.min(AW - 1, Math.ceil(xs[q + 1] - .5) - 1);
        for (let i = i0; i <= i1; i++) if ((!only || buf[o + i]) && !skip?.[o + i]) buf[o + i] = val;
      }
    }
  }

  /** One small ring (a building, vertices s..e) into bid, row by row. True if any pixel was set. */
  private scanRing(pts: Float32Array, s: number, e: number, val: number, v: View): boolean {
    const { AW, AH } = this, m = v.mpp, xs = this.xs, buf = this.bid;
    let lo = Infinity, hi = -Infinity;
    for (let k = s; k < e; k++) {
      const y = pts[2 * k + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const j0 = Math.max(0, Math.ceil((lo - v.y0) / m - .5)), j1 = Math.min(AH - 1, Math.ceil((hi - v.y0) / m - .5) - 1);
    let any = false;
    for (let j = j0; j <= j1; j++) {
      // crossings with this row of pixel centers, in world meters
      const yc = v.y0 + (j + .5) * m;
      let n = 0;
      for (let k = s, p = e - 1; k < e; p = k++) {
        const ya = pts[2 * p + 1], yb = pts[2 * k + 1];
        if (ya > yc !== yb > yc && n < xs.length) xs[n++] = pts[2 * p] + ((yc - ya) * (pts[2 * k] - pts[2 * p])) / (yb - ya);
      }
      for (let q = 1; q < n; q++) {
        const x = xs[q];
        let r = q - 1;
        for (; r >= 0 && xs[r] > x; r--) xs[r + 1] = xs[r];
        xs[r + 1] = x;
      }
      for (let q = 0; q + 1 < n; q += 2) {
        const o = j * AW, i0 = Math.max(0, Math.ceil((xs[q] - v.x0) / m - .5)), i1 = Math.min(AW - 1, Math.ceil((xs[q + 1] - v.x0) / m - .5) - 1);
        for (let i = i0; i <= i1; i++) buf[o + i] = val;
        if (i0 <= i1) any = true;
      }
    }
    return any;
  }

  /** A road outside the city's street data, rM meters either side of its line, into croad. */
  private thick(pts: Float32Array, rM: number, val: number, v: View, skip: Uint8Array | null = null, buf = this.croad): void {
    const { AW, AH } = this, m = v.mpp, r = rM / m, r2 = r * r;
    for (let k = 2; k + 1 < pts.length; k += 2) {
      const ax0 = (pts[k - 2] - v.x0) / m, ay0 = (pts[k - 1] - v.y0) / m, bx0 = (pts[k] - v.x0) / m, by0 = (pts[k + 1] - v.y0) / m;
      if (Math.max(ax0, bx0) + r < 0 || Math.min(ax0, bx0) - r > AW || Math.max(ay0, by0) + r < 0 || Math.min(ay0, by0) - r > AH) continue;
      // short pieces keep the boxes tight on long diagonals
      const n = Math.max(1, Math.ceil(Math.hypot(bx0 - ax0, by0 - ay0) / 8));
      for (let q = 0; q < n; q++) {
        const ax = ax0 + ((bx0 - ax0) * q) / n, ay = ay0 + ((by0 - ay0) * q) / n;
        const bx = ax0 + ((bx0 - ax0) * (q + 1)) / n, by = ay0 + ((by0 - ay0) * (q + 1)) / n;
        const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), i1 = Math.min(AW - 1, Math.ceil(Math.max(ax, bx) + r));
        const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), j1 = Math.min(AH - 1, Math.ceil(Math.max(ay, by) + r));
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const t = Math.max(0, Math.min(1, ((i + .5 - ax) * dx + (j + .5 - ay) * dy) / L2));
          const ex = ax + t * dx - i - .5, ey = ay + t * dy - j - .5;
          if (ex * ex + ey * ey <= r2 && buf[j * AW + i] < val && !skip?.[j * AW + i]) buf[j * AW + i] = val;
        }
      }
    }
  }

  /** A basemap copy of a county street hides once the map draws that street. */
  private shown(rd: Road): boolean {
    if (!rd.near) return true;
    // streets only ever get added, so their count says when to look again
    const ver = this.world.runs.length;
    if (rd.ver !== ver) [rd.ver, rd.hide] = [ver, this.world.nearestRun(rd.mid, rd.near) !== null];
    return !rd.hide;
  }

  /** Basemap roads as plain gray lines under the city's streets (minor ones only up close), never over its lakes. */
  private plotRoads(v: View, tiles: BaseTile[]): void {
    const m = v.mpp, close = m <= BLOCK_MPP, x1 = v.x0 + this.AW * m, y1 = v.y0 + this.AH * m;
    const fill = close ? PAL.road : PAL.roadFar;
    for (const pass of close ? [0, 1] : [1]) {
      // a dark casing one pixel either side first, then the road down its middle
      for (const t of tiles) for (const rd of t.roads) {
        if ((!rd.major && !close) || rd.box[2] < v.x0 || rd.box[0] > x1 || rd.box[3] < v.y0 || rd.box[1] > y1 || !this.shown(rd)) continue;
        // major roads get two pixels close in; primary roads and up (when the tile says) out to BLOCK_MPP
        const wd = (rd.major && m <= 6) || rd.cls >= 4 ? 2 : 1;
        this.plotF(rd.pts, v, pass ? fill : PAL.ocase, pass ? wd : wd + 2, this.lake);
      }
    }
  }

  /** A polyline in world meters into the pixel buffer: w px blocks, dashed by `dash` (art px on, off, ...) from its start. */
  private plot(pts: readonly XY[], v: View, col: number, w: number, dash: readonly number[] | null = null, closed = false, mask: Uint8Array | null = null): void {
    const n = pts.length, m = v.mpp, last = closed ? n : n - 1;
    let step = 0;
    for (let k = 0; k < last; k++) {
      const p = pts[k], q = pts[(k + 1) % n];
      step = this.seg((p[0] - v.x0) / m, (p[1] - v.y0) / m, (q[0] - v.x0) / m, (q[1] - v.y0) / m, col, w, dash, step, mask);
    }
  }

  /** plot() for x, y pairs in a Float32Array. */
  private plotF(pts: Float32Array, v: View, col: number, w: number, mask: Uint8Array | null, dash: readonly number[] | null = null): void {
    const m = v.mpp;
    let step = 0;
    for (let k = 2; k + 1 < pts.length; k += 2) step = this.seg((pts[k - 2] - v.x0) / m, (pts[k - 1] - v.y0) / m, (pts[k] - v.x0) / m, (pts[k + 1] - v.y0) / m, col, w, dash, step, mask);
  }

  /** One segment in art px, Bresenham between its rounded ends. Returns the dash step after it, clipped or not. */
  private seg(ax: number, ay: number, bx: number, by: number, col: number, w: number, dash: readonly number[] | null, step: number, mask: Uint8Array | null): number {
    const { AW, AH } = this, buf = this.wS, o = w >> 1;
    let x = Math.round(ax), y = Math.round(ay), xe = Math.round(bx), ye = Math.round(by);
    const len = Math.max(Math.abs(xe - x), Math.abs(ye - y));
    if (Math.max(x, xe) + w < 0 || Math.min(x, xe) - w >= AW || Math.max(y, ye) + w < 0 || Math.min(y, ye) - w >= AH) return step + len;
    let s = step;
    if (len > 2 * (AW + AH)) {
      // a very long segment: only the part in view
      const c = clipSeg(ax + w, ay + w, bx + w, by + w, AW + 2 * w, AH + 2 * w);
      if (!c) return step + len;
      s += Math.round((Math.hypot(c[0] - w - ax, c[1] - w - ay) / (Math.hypot(bx - ax, by - ay) || 1)) * len);
      [x, y, xe, ye] = [Math.round(c[0] - w), Math.round(c[1] - w), Math.round(c[2] - w), Math.round(c[3] - w)];
    }
    const dx = Math.abs(xe - x), dy = -Math.abs(ye - y), sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1;
    // dashed lines cross the line one pixel deep, so their gaps stay open; solid ones use square blocks
    const across = dash ? (dx >= -dy ? 1 : 2) : 0;
    let e = dx + dy;
    for (let guard = 0; guard < 20000; guard++) {
      if (!dash || dashOn(dash, s)) {
        for (let j = Math.max(0, across === 2 ? y : y - o), j1 = Math.min(AH - 1, across === 2 ? y : y - o + w - 1); j <= j1; j++) {
          for (let i = Math.max(0, across === 1 ? x : x - o), i1 = Math.min(AW - 1, across === 1 ? x : x - o + w - 1); i <= i1; i++) {
            const k = j * AW + i;
            if (!mask || !mask[k]) buf[k] = col;
          }
        }
      }
      if (x === xe && y === ye) break;
      s++;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x += sx; }
      if (e2 <= dx) { e += dx; y += sy; }
    }
    return step + len;
  }

  // ---------- the land statewide, close in ----------

  /** The statewide near tiles (state.ts) for a close view, with `based` marking the pixels a basemap tile has; null if they all do. Lakes, and in town rivers and roads, go into the pixel buffers where no tile is. */
  private stateNear(v: View, town: boolean): WorldLayer[] | null {
    const St = this.state, B = this.basemap, { AW, AH } = this, m = v.mpp;
    if (!St?.ready) return null;
    const all = B ? B.covered(v.x0, v.y0, m, AW, AH, this.based) : false;
    // until the basemap's tile list is in, nothing: no flash of plain land over the town
    if (all !== false) return null;
    if (!B) this.based.fill(0);
    const near = St.near(v.x0, v.y0, v.x0 + AW * m, v.y0 + AH * m), x1 = v.x0 + AW * m, y1 = v.y0 + AH * m, skip = this.based;
    const seen = (b: Part['box'], r: number) => b[2] + r >= v.x0 && b[0] - r <= x1 && b[3] + r >= v.y0 && b[1] - r <= y1;
    for (const L of near) {
      for (const p of L.lakes) if (seen(p.box, 0)) this.scan(this.cover, p.pts, p.ranges, COVER_WATER, v, skip);
      if (!town) continue;
      for (const p of L.rivers) if (seen(p.box, 8)) this.thick(p.pts, 5, COVER_WATER, v, skip, this.cover);
      for (const p of L.roads) if (seen(p.box, 8)) this.thick(p.pts, p.cls >= 3 ? 7 : 5, p.cls >= 3 ? 2 : 1, v, skip);
    }
    return near;
  }

  /** Statewide rivers and roads as lines, where no basemap tile is (overview zoom). */
  private plotState(v: View, near: WorldLayer[], close: boolean): void {
    const m = v.mpp, x1 = v.x0 + this.AW * m, y1 = v.y0 + this.AH * m, skip = this.based;
    const seen = (b: Part['box']) => b[2] >= v.x0 && b[0] <= x1 && b[3] >= v.y0 && b[1] <= y1;
    for (const L of near) for (const p of L.rivers) if (seen(p.box)) this.plotF(p.pts, v, PAL.streamCase, 3, skip);
    for (const L of near) for (const p of L.rivers) if (seen(p.box)) this.plotF(p.pts, v, PAL.stream, 1, skip);
    // like the basemap's roads: casings, then the roads, wider for the big ones
    for (const pass of [0, 1]) for (const L of near) for (const p of L.roads) {
      if (!seen(p.box) || (!close && p.cls < 3)) continue;
      const wd = p.cls >= 4 || (p.cls >= 3 && m <= 6) ? 2 : 1;
      this.plotF(p.pts, v, pass ? (close ? PAL.road : PAL.roadFar) : PAL.ocase, pass ? wd : wd + 2, skip);
    }
  }

  /** The terrain cell under each pixel no basemap tile has, into `terr`; level 0 (or a coarser one while it loads), cell edges dithered. False if none is in. */
  private terrainClose(v: View): boolean {
    const St = this.state!, { AW, AH } = this, m = v.mpp, terr = this.terr, based = this.based;
    // world meters to the region map: straight enough across one close view
    const p = regionPt([v.x0, v.y0]), q = regionPt([v.x0 + AW * m, v.y0]), r = regionPt([v.x0, v.y0 + AH * m]);
    const ax = (q[0] - p[0]) / AW, ay = (q[1] - p[1]) / AW, bx = (r[0] - p[0]) / AH, by = (r[1] - p[1]) / AH;
    const L = St.pick(Math.min(p[0], r[0]), Math.min(p[1], q[1]), Math.max(q[0], q[0] + r[0] - p[0]), Math.max(r[1], r[1] + q[1] - p[1]), 0);
    if (L < 0) return false;
    const jit = St.size[L] / 64, gx = Math.round(v.x0 / m), gy = Math.round(v.y0 / m);
    for (let j = 0; j < AH; j++) for (let i = 0; i < AW; i++) {
      const k = j * AW + i;
      if (based[k]) { terr[k] = 0; continue; }
      const a = (gx + i) & 7, b = (gy + j) & 7, dx = (BAYER[b * 8 + a] - 31.5) * jit, dy = (BAYER[a * 8 + b] - 31.5) * jit;
      terr[k] = St.at(L, p[0] + ax * (i + .5) + bx * (j + .5) + dx, p[1] + ay * (i + .5) + by * (j + .5) + dy);
    }
    return true;
  }

  // ---------- salmon streams ----------

  /** Salmon lines for a region box: the near tiles up close once in, else the thinned tiers. */
  salmonLines(x0: number, y0: number, x1: number, y1: number, mpp: number): SLine[] {
    const Sd = this.salmon;
    if (!Sd?.ready) { Sd?.load(); return []; }
    if (mpp < SALMON_NEAR_MPP) {
      const tiles = Sd.near(x0, y0, x1, y1);
      if (Sd.loaded(x0, y0, x1, y1)) return tiles.flatMap((t) => t.lines);
    }
    return Sd.tier(mpp < FAR_MPP ? 'mid' : 'far') ?? (mpp < FAR_MPP ? Sd.tier('far') ?? [] : []);
  }

  private salmonRegion(v: View, creeks: ReadonlySet<string> | null): void {
    const m = v.mpp, x1 = v.x0 + this.AW * m, y1 = v.y0 + this.AH * m;
    const lines = this.salmonLines(v.x0, v.y0, x1, y1, m).filter((l) => l.box[2] >= v.x0 && l.box[0] <= x1 && l.box[3] >= v.y0 && l.box[1] <= y1);
    // thin quiet water, fainter far out; the drive's own creeks cased and bright
    const strong = (l: SLine) => !!creeks?.size && !!l.stream?.name && creeks.has(l.stream.name);
    const quiet = m >= FAR_MPP ? RP.sQuietFar : RP.sQuiet;
    for (const l of lines) if (!strong(l)) this.stroke(l.pts, v, quiet);
    if (!creeks?.size) return;
    for (const l of lines) if (strong(l)) this.stroke(l.pts, v, RP.sCase, 'wide');
    for (const l of lines) if (strong(l)) this.stroke(l.pts, v, RP.sWater);
  }

  private readonly salmonW = new WeakMap<SalmonTile, { pts: Float32Array; box: Part['box']; name: string }[]>();

  /** Salmon streams in the overview band: the near tiles in world meters, as thin quiet water; the drive's creeks strong. */
  private salmonWorld(v: View, creeks: ReadonlySet<string> | null): { pts: Float32Array; box: Part['box'] }[] {
    const Sd = this.salmon;
    if (!Sd?.ready) { Sd?.load(); return []; }
    const m = v.mpp, x1 = v.x0 + this.AW * m, y1 = v.y0 + this.AH * m;
    const a = regionPt([v.x0, v.y0]), b = regionPt([x1, v.y0]), c = regionPt([v.x0, y1]), d = regionPt([x1, y1]);
    const all: { pts: Float32Array; box: Part['box']; name: string }[] = [];
    for (const t of Sd.near(Math.min(a[0], c[0]), Math.min(a[1], b[1]), Math.max(b[0], d[0]), Math.max(c[1], d[1]))) {
      let w = this.salmonW.get(t);
      if (!w) this.salmonW.set(t, (w = t.lines.map((l) => ({ ...worldLine(l.pts), name: l.stream?.name ?? '' }))));
      for (const p of w) if (p.box[2] >= v.x0 && p.box[0] <= x1 && p.box[3] >= v.y0 && p.box[1] <= y1) all.push(p);
    }
    const strong = all.filter((p) => !!p.name && !!creeks?.has(p.name));
    for (const p of all) if (!strong.includes(p)) this.plotF(p.pts, v, PAL.sQuiet, 1, null);
    // the drive's creeks: cased and bright
    for (const p of strong) this.plotF(p.pts, v, PAL.streamCase, 3, null);
    for (const p of strong) this.plotF(p.pts, v, PAL.sWater, 1, null);
    return all;
  }

  // ---------- region ----------

  /** Fills a shape's rings (even-odd) into the code buffer; `land` leaves the sea alone. */
  private fillShape(sh: Shape, v: View, val: number, land = false): void {
    const { AW, AH } = this, m = v.mpp;
    if (sh.box[2] < v.x0 || sh.box[0] > v.x0 + AW * m || sh.box[3] < v.y0 || sh.box[1] > v.y0 + AH * m) return;
    this.fill(this.codes, sh.rings, val, v, land);
  }

  /** Plots a polyline into the pixel buffer; 'land' lines skip the coast. */
  private stroke(pts: XY[], v: View, col: number | ((c: number) => number), mode: 'all' | 'land' | 'dash' | 'wide' = 'all', closed = false): void {
    const { AW, AH } = this, m = v.mpp, w = this.wS, code = this.codes;
    let n = 0;
    const plot = (x: number, y: number) => {
      if (x < 1 || y < 1 || x >= AW - 1 || y >= AH - 1) return;
      const k = y * AW + x, c = code[k];
      if (mode === 'land' && (!c || !code[k - 1] || !code[k + 1] || !code[k - AW] || !code[k + AW])) return;
      if (mode === 'dash' && (n++ & 3) > 1) return;
      // a casing: the pixel and its four sides
      if (mode === 'wide') { const c0 = col as number; w[k] = w[k - 1] = w[k + 1] = w[k - AW] = w[k + AW] = c0; return; }
      w[k] = typeof col === 'number' ? col : col(c);
    };
    const last = closed ? pts.length : pts.length - 1;
    for (let k = 0; k < last; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const ax = (p[0] - v.x0) / m, ay = (p[1] - v.y0) / m, bx = (q[0] - v.x0) / m, by = (q[1] - v.y0) / m;
      // wholly off one side, or wholly inside: no clipping needed
      if ((ax < -1 && bx < -1) || (ay < -1 && by < -1) || (ax > AW && bx > AW) || (ay > AH && by > AH)) continue;
      if (ax >= -1 && ax <= AW && bx >= -1 && bx <= AW && ay >= -1 && ay <= AH && by >= -1 && by <= AH) { bres(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), plot); continue; }
      const c = clipSeg(ax, ay, bx, by, AW, AH);
      if (c) bres(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3]), plot);
    }
  }

  private drawRegion(v: View, sc: Scene, now: number, a: (p: XY) => XY): void {
    const { AW, AH } = this, m = v.mpp, R = this.region!, w = this.wS, code = this.codes, W = this.world;
    const fine = m < 400, cities = m < 1200, wa = m < 1600;
    const seen = (b: Shape['box']) => b[2] >= v.x0 && b[0] <= v.x0 + AW * m && b[3] >= v.y0 && b[1] <= v.y0 + AH * m;
    const St = this.state?.ready ? this.state : null, x1 = v.x0 + AW * m, y1 = v.y0 + AH * m;
    // the land statewide: the finest terrain level in, and the lakes, rivers and roads for this zoom
    const tl = St ? St.pick(v.x0, v.y0, x1, y1, St.levelFor(m)) : -1, layers: Layer[] = St ? St.lines(v.x0, v.y0, x1, y1, m) : [];
    code.fill(0);
    for (const sh of R.abroad) this.fillShape(sh, v, 3);
    for (const st of R.states) this.fillShape((fine && R.detail.get(st.id)) || st, v, st.west ? (St?.states.has(st.id) ? 7 : 2) : 1);
    if (cities) for (const pl of R.places) this.fillShape(pl, v, R.isMapped(pl) ? 4 : 6);
    // everywhere with traced drains, whichever city or county it's in
    const cover = m < 4000 ? R.coverage : null;
    if (cover) this.fillShape(cover, v, 5, true);
    for (const L of layers) for (const lk of L.lakes) if (seen(lk.box)) this.fill(code, lk.rings, LAKE, v, true);
    // plug one-pixel gaps where separately drawn outlines meet
    for (let j = 1; j < AH - 1; j++) for (let i = 1; i < AW - 1; i++) {
      const k = j * AW + i;
      if (code[k]) continue;
      const l = code[k - 1], r = code[k + 1], u = code[k - AW], d = code[k + AW];
      if ((l ? 1 : 0) + (r ? 1 : 0) + (u ? 1 : 0) + (d ? 1 : 0) >= 3) code[k] = l || r || u || d;
    }
    // colors, with a light coast line and specks that stay put while panning
    const gx = Math.round(v.x0 / m), gy = Math.round(v.y0 / m);
    // terrain cells three pixels or more across: each pixel reads the cell a little off its middle, so cell edges dither;
    // smaller ones are found by row and column
    const cs = tl >= 0 ? St!.size[tl] : 0, jit = cs >= 3 * m ? cs / 64 : 0, yellow = m > 120 || !this.overview, cols = this.cols;
    const grid = tl >= 0 && !jit, tx0 = grid ? Math.floor((v.x0 + m / 2) / cs) >> 8 : 0;
    if (grid) for (let i = 0; i < AW; i++) cols[i] = Math.floor((v.x0 + (i + .5) * m) / cs);
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m, cj = grid ? Math.floor(wy / cs) : 0, off = (cj & 255) << 8;
      const row = grid ? St!.row(tl, tx0, cols[AW - 1] >> 8, cj >> 8, this.tileRow) : null;
      for (let i = 0; i < AW; i++) {
        const k = j * AW + i, c = code[k], h = hash(gx + i, gy + j, 5);
        if (!c) { w[k] = h < .02 ? RP.wave : RP.sea; continue; }
        // Canada and Mexico: flat and quiet, no coast line
        if (c === 3) { w[k] = ABROAD; continue; }
        if (c === LAKE) {
          w[k] = m < FAR_MPP && ((i > 0 && code[k - 1] !== LAKE) || (i < AW - 1 && code[k + 1] !== LAKE) || (j > 0 && code[k - AW] !== LAKE) || (j < AH - 1 && code[k + AW] !== LAKE)) ? RP.lakeRim : RP.lake;
          continue;
        }
        if ((i > 0 && !code[k - 1]) || (i < AW - 1 && !code[k + 1]) || (j > 0 && !code[k - AW]) || (j < AH - 1 && !code[k + AW])) { w[k] = RP.shore; continue; }
        let t = 0;
        if (row && c >= 4) {
          const ci = cols[i], tile = row[(ci >> 8) - tx0];
          if (tile) t = tile[off | (ci & 255)];
        } else if (jit && c >= 4) {
          const a = (gx + i) & 7, b = (gy + j) & 7;
          t = St!.at(tl, v.x0 + (i + .5) * m + (BAYER[b * 8 + a] - 31.5) * jit, wy + (BAYER[a * 8 + b] - 31.5) * jit);
        }
        // traced places get a light yellow from afar, then just their outline once the streets show (and until they have come in)
        let col = t ? (c === 5 && yellow ? TERR_TRACED[t] : TERR[t]) : c === 5 ? (yellow ? TRACED_FLAT : RP.land[2]) : h < .07 ? RP.speck[c] : RP.land[c];
        if (c === 6) col = hatchPx(col, gx + i + gy + j);
        w[k] = col;
      }
    }
    // far out, the biggest roads only
    const minRoad = m >= 3000 ? 5 : m >= 1500 ? 4 : 0;
    for (const L of layers) for (const rv of L.rivers) if (seen(rv.box)) this.stroke(rv.pts, v, RP.river);
    this.salmonRegion(v, sc.creeks ?? null);
    for (const st of R.states) {
      const sh = (fine && R.detail.get(st.id)) || st;
      if (seen(sh.box)) for (const r of sh.rings) this.stroke(r, v, (c) => RP.border[c], 'land', true);
    }
    if (wa) {
      for (const co of R.counties) if (seen(co.box)) for (const r of co.rings) this.stroke(r, v, RP.county, 'land', true);
    }
    // big roads on top, the biggest last
    for (const L of layers) for (const rd of L.roads) if (rd.cls >= minRoad && seen(rd.box)) this.stroke(rd.pts, v, RP.road[rd.cls] || RP.road[2]);
    if (cities) for (const pl of R.places) {
      if (!seen(pl.box)) continue;
      // cities with no pipe map get a dashed edge, close enough to see it
      if (R.isMapped(pl)) for (const r of pl.rings) this.stroke(r, v, RP.city, 'all', true);
      else if (m <= 400) for (const r of pl.rings) this.stroke(r, v, HATCH_W.edge, 'dash', true);
    }
    // up close the streets show what's traced, so the edge steps back
    if (cover && seen(cover.box)) for (const r of cover.rings) this.stroke(r, v, m > 120 ? RP.home : RP.homeDim, m > 120 ? 'land' : 'dash', true);
    // the streets themselves, once they're more than a dot
    if (m < 90) for (const i of this.inView(v, 'waters')) {
      const wt = W.waters[i];
      if (wt.ring) this.stroke(wt.ring, v, RP.lake, 'all', true);
      else if (!this.survey(wt)) this.stroke(wt.line!, v, RP.creek);
    }
    if (m < OV_MPP && this.overview) this.ovLayer(v, `r${+!!sc.muted}${+!!sc.salmonOnly}`, (t) => this.strokeAllOv(t, !!sc.muted, !!sc.salmonOnly));
    else if (m < 90) {
      const runs = this.inView(v, 'runs');
      for (const k of DRAW) for (const i of runs) {
        const r = W.runs[i];
        if (r.k !== k) continue;
        if (sc.muted || plain(k) || (sc.salmonOnly && k !== 0)) this.stroke(r.line, v, PAL.road);
        else this.stroke(r.line, v, FILL[k], CODE[k].dash ? 'dash' : 'all');
      }
    }
    const s = this.sctx;
    s.clearRect(0, 0, AW, AH);
    this.surfUsed = true;
    for (const pt of R.points) {
      const [x, y] = a(pt.at);
      if (pt.kind === 'city' && m > 90 && m < 7000) { px(s, x - 1, y - 1, '#0e1311', 4, 4); px(s, x, y, '#eef2ec', 2, 2); }
      if (pt.kind === 'peak' && m > 50 && m < 2600) {
        // a small snowy peak
        px(s, x - 4, y + 1, '#0e1311', 9, 2); px(s, x - 3, y - 1, '#0e1311', 7, 2); px(s, x - 2, y - 3, '#0e1311', 5, 2); px(s, x - 1, y - 5, '#0e1311', 3, 2);
        px(s, x - 3, y + 1, '#7d8a86', 7, 1); px(s, x - 2, y - 1, '#9aa7a2', 5, 2); px(s, x - 1, y - 3, '#eef2ec', 3, 2); px(s, x, y - 4, '#ffffff');
      }
    }
    if (m > 1500) {
      // where TireTrail works, once the yellow areas are too small to see
      const [x, y] = a(R.middle ?? W.center), t = this.calm ? 0.25 : (now % 1400) / 1400;
      ring(s, x, y, this.calm ? 6 : 2 + Math.round(t * 9), '242,210,122', t);
      px(s, x - 2, y - 2, '#1a1712', 5, 5); px(s, x - 1, y - 1, '#f2d27a', 3, 3);
    }
  }

  // ---------- street zoom ----------

  private drawTown(v: View, sc: Scene, now: number, a: (p: XY) => XY, tiles: BaseTile[]): void {
    const { AW, AH } = this, m = v.mpp, W = this.world, w = this.wS, code = this.codes;
    const cover = this.cover, bid = this.bid, croad = this.croad, tones = this.tones;
    const calm = this.calm, tick = Math.floor(now / 170);
    // ground once per pixel; neighbors read it back, and off-screen ones ask the world
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      for (let i = 0; i < AW; i++) code[j * AW + i] = W.groundAt(v.x0 + (i + .5) * m, wy);
    }
    this.rasterBase(v, tiles, true);
    this.stateNear(v, true);
    // streets and lakes win over buildings
    for (let k = 0; k < AW * AH; k++) if (bid[k] && (code[k] !== G_GRASS || croad[k])) bid[k] = 0;
    const road = (k: number) => code[k] >= G_ROAD || croad[k] > 0;
    // a survey line drawn across a lake: lake on both sides of it
    const lakeBoth = (wx: number, wy: number) => (W.groundAt(wx - 4, wy) === G_LAKE && W.groundAt(wx + 4, wy) === G_LAKE) || (W.groundAt(wx, wy - 4) === G_LAKE && W.groundAt(wx, wy + 4) === G_LAKE);
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m, hy = Math.floor(wy / m);
      // vnoise(wx, wy, 22, 21) with its corner hashes kept while the cell stays the same
      const ny = wy / 22, ngy = Math.floor(ny), fy = ny - ngy, uy = fy * fy * (3 - 2 * fy);
      let ngx = NaN, na = 0, nb = 0, nc = 0, nd = 0;
      for (let i = 0; i < AW; i++) {
        const wx = v.x0 + (i + .5) * m, k = j * AW + i;
        const h = hash(Math.floor(wx / m), hy);
        const g = code[k];
        const gu = j > 0 ? code[k - AW] : W.groundAt(wx, wy - m), gl = i > 0 ? code[k - 1] : W.groundAt(wx - m, wy);
        let c: number;
        if (g === G_LAKE || (g === G_CREEK && lakeBoth(wx, wy))) {
          // no shoreline where OSM water carries on past the city's outline
          const edge = g === G_LAKE && ((gl !== G_LAKE && gl !== G_CREEK && !(i > 0 && cover[k - 1] === COVER_WATER)) || (gu !== G_LAKE && gu !== G_CREEK && !(j > 0 && cover[k - AW] === COVER_WATER)));
          c = edge ? PAL.shore : PAL.lake[h < .5 ? 0 : 1];
          if (!edge && !calm && ((h * 997 + tick) | 0) % 53 === 0) c = PAL.sparkle;
        } else if (g === G_CREEK) {
          c = gu === 0 || gl === 0 ? PAL.bank : PAL.creek;
        } else if (g >= G_ROAD) {
          const gd = j + 1 < AH ? code[k + AW] : W.groundAt(wx, wy + m), gr = i + 1 < AW ? code[k + 1] : W.groundAt(wx + m, wy);
          // a basemap road running into a city street doesn't count as its edge
          const edge = (gu < G_ROAD && !(j > 0 && croad[k - AW])) || (gl < G_ROAD && !(i > 0 && croad[k - 1]))
            || (gd < G_ROAD && !(j + 1 < AH && croad[k + AW])) || (gr < G_ROAD && !(i + 1 < AW && croad[k + 1]));
          c = edge ? PAL.edge : PAL.asphalt[h < .5 ? 0 : 1];
        } else if (croad[k]) {
          // outside the city's street data: the same plain asphalt
          const edge = (j > 0 && !road(k - AW)) || (i > 0 && !road(k - 1)) || (j + 1 < AH && !road(k + AW)) || (i + 1 < AW && !road(k + 1));
          c = edge ? PAL.edge : PAL.asphalt[h < .5 ? 0 : 1];
        } else if (bid[k]) {
          // flat roof, shadowed on the south and east sides, lit on the north and west
          const id = bid[k], t = tones[id];
          c = (i + 1 < AW && bid[k + 1] !== id) || (j + 1 < AH && bid[k + AW] !== id) ? ROOF_LO[t]
            : (i > 0 && bid[k - 1] !== id) || (j > 0 && bid[k - AW] !== id) ? ROOF_HI[t] : ROOF_MID[t];
        } else if (cover[k] === COVER_WATER) {
          const edge = (i > 0 && cover[k - 1] !== COVER_WATER && gl !== G_LAKE) || (j > 0 && cover[k - AW] !== COVER_WATER && gu !== G_LAKE);
          c = edge ? PAL.shore : PAL.lake[h < .5 ? 0 : 1];
          if (!edge && !calm && ((h * 997 + tick) | 0) % 53 === 0) c = PAL.sparkle;
        } else {
          const nx = wx / 22, gx = Math.floor(nx), fx = nx - gx, ux = fx * fx * (3 - 2 * fx);
          if (gx !== ngx) [ngx, na, nb, nc, nd] = [gx, hash(gx, ngy, 21), hash(gx + 1, ngy, 21), hash(gx, ngy + 1, 21), hash(gx + 1, ngy + 1, 21)];
          const nv = na + (nb - na) * ux + (nc - na) * uy + (na - nb - nc + nd) * ux * uy;
          const n = nv * 2.2 + (BAYER[(j & 7) * 8 + (i & 7)] / 64 - .5) * .9, t = n < .75 ? 1 : n < 1.45 ? 0 : 2;
          if (cover[k] === COVER_FOREST) c = PAL.forest[t];
          else if (cover[k]) c = PAL.park[t];
          else {
            c = PAL.grass[t];
            if (h > .996) c = PAL.flower; else if (h < .025) c = PAL.tuft;
          }
        }
        w[k] = c;
      }
    }
    // tree tops in real forest, at fixed spots in the world so they stay put while panning
    const open = (k: number) => cover[k] === COVER_FOREST && !bid[k] && !croad[k] && !code[k];
    const put = (k: number, col: number) => { if (open(k)) w[k] = col; };
    const T = 4.5, big = m <= 1.3;
    if (tiles.length) for (let gy = Math.floor(v.y0 / T); gy <= Math.floor((v.y0 + AH * m) / T); gy++) for (let gx = Math.floor(v.x0 / T); gx <= Math.floor((v.x0 + AW * m) / T); gx++) {
      if (hash(gx, gy, 23) > .55) continue;
      const i = Math.floor(((gx + hash(gx, gy, 24)) * T - v.x0) / m), j = Math.floor(((gy + hash(gx, gy, 25)) * T - v.y0) / m);
      if (i < 1 || j < 1 || i >= AW - 1 || j >= AH - 1) continue;
      const k = j * AW + i;
      if (!open(k)) continue;
      if (big) { put(k - AW, PAL.crownHi); put(k - 1, PAL.crown); put(k, PAL.crown); put(k + 1, PAL.crownLo); put(k + AW, PAL.crownLo); }
      else { put(k, PAL.crownHi); put(k + 1, PAL.crown); put(k + AW, PAL.crown); put(k + AW + 1, PAL.crownLo); }
    }
    // a stripe down each traced street in its answer's color and line code; plain asphalt for no answer
    const runs = this.inView(v, 'runs');
    // streets whose area is still loading: a faint overview line until the detail arrives
    const ov = sc.muted ? [] : this.ovInView(v), O = this.overview;
    if (!sc.muted) for (const k of DRAW) {
      if (plain(k)) continue;
      for (const q of ov) if (O!.cls[q] === k) this.plotOv(q, v, FAINT[k], 1, CODE[k].dash);
      for (const i of runs) {
        const r = W.runs[i];
        if (r.k === k) this.plot(r.line, v, FILL[k], big ? CODE[k].near : CODE[k].w, CODE[k].dash);
      }
    }
    const s = this.sctx;
    s.clearRect(0, 0, AW, AH);
    this.surfUsed = true;
    for (const i of W.drainsNear([v.x0 + (AW * m) / 2, v.y0 + (AH * m) / 2], (Math.max(AW, AH) * m) / 2 + 10)) {
      const [x, y] = a(W.drains[i]);
      if (x < -2 || y < -2 || x > AW + 2 || y > AH + 2 || !this.byRoad(i)) continue;
      // close in, a grate with bars; farther out, a small mark
      if (m <= 1.6) { px(s, x - 2, y - 2, '#0c100f', 5, 4); px(s, x - 1, y - 1, '#4a5157', 3, 2); px(s, x - 1, y - 1, '#c3cbd1', 1, 2); px(s, x + 1, y - 1, '#c3cbd1', 1, 2); }
      else { px(s, x - 1, y - 1, '#1f2326', 3, 2); px(s, x, y - 1, '#7c8389'); }
    }
    if (sc.pondAt && this.sprites.img.pond?.width) { const [x, y] = a(sc.pondAt); s.drawImage(this.sprites.img.pond, x - 24, y - 30); }
  }

  // per drain: 1 within 15 m of a traced street, 2 not, 0 not looked at yet
  private nearRuns = new WeakMap<World, Uint8Array>();

  /** A drain within 15 m of a street or road the map draws; the rest stay off the map. */
  private byRoad(i: number): boolean {
    const W = this.world, p = W.drains[i];
    let c = this.nearRuns.get(W);
    // new streets can make an old answer wrong, so start over when the world grows
    if (!c || c.length !== W.drains.length + W.runs.length) this.nearRuns.set(W, (c = new Uint8Array(W.drains.length + W.runs.length)));
    if (!c[i]) c[i] = W.nearestRun(p, 15) ? 1 : 2;
    return c[i] === 1 || !!this.basemap?.roadNear(p[0], p[1], 15);
  }

  private drawUnder(v: View, path: readonly XY[] | null): void {
    const { AW, AH } = this, m = v.mpp, W = this.world, w = this.wU, near = this.nearPath;
    // pipes more than 3 m from the story's path step back
    const dim = !!path && path.length > 0;
    if (dim) {
      near.fill(0);
      const r = 3 / m, r2 = r * r, R = Math.ceil(r), P = path!;
      let lx = NaN, ly = NaN;
      // every half pixel along the path, so long pipe runs count all the way
      for (let q = 0; q < P.length; q++) {
        const a = P[Math.max(0, q - 1)], b = P[q], n = Math.max(1, Math.ceil((Math.hypot(b[0] - a[0], b[1] - a[1]) / m) * 2));
        for (let s = q ? 1 : 0; s <= n; s++) {
          const cx = (a[0] + ((b[0] - a[0]) * s) / n - v.x0) / m - .5, cy = (a[1] + ((b[1] - a[1]) * s) / n - v.y0) / m - .5;
          const ix = Math.round(cx), iy = Math.round(cy);
          if ((ix === lx && iy === ly) || ix < -R || iy < -R || ix >= AW + R || iy >= AH + R) continue;
          [lx, ly] = [ix, iy];
          for (let j = Math.max(0, iy - R), j1 = Math.min(AH - 1, iy + R); j <= j1; j++) {
            for (let i = Math.max(0, ix - R), i1 = Math.min(AW - 1, ix + R); i <= i1; i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= r2) near[j * AW + i] = 1;
          }
        }
      }
    }
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      for (let i = 0; i < AW; i++) {
        const wx = v.x0 + (i + .5) * m, k = j * AW + i;
        const h = hash(Math.floor(wx / m), Math.floor(wy / m), 9);
        const n = vnoise(wx, wy, 12, 11) * 2.2 + (BAYER[(j & 7) * 8 + (i & 7)] / 64 - .5) * .9;
        const g = W.groundAt(wx, wy);
        let c = PAL.dirt[n < .75 ? 1 : n < 1.45 ? 0 : 2];
        if (h > .975 || vnoise(wx, wy, 5, 17) > .9) c = PAL.pebble;
        if (g >= G_ROAD) c = PAL.ghost;
        if (g === G_LAKE || g === G_CREEK) c = PAL.deep;
        const up = W.pipeAt(wx, wy - m), dn = W.pipeAt(wx, wy + m), lf = W.pipeAt(wx - m, wy), rt = W.pipeAt(wx + m, wy);
        if (W.pipeAt(wx, wy)) c = dim && !near[k] ? PAL.tubeDim : !up || !lf ? PAL.tubeHi : !dn || !rt ? PAL.tubeLo : PAL.tube;
        else if (up || dn || lf || rt) c = PAL.rim;
        w[k] = c;
      }
    }
  }

  // ---------- on top ----------

  private drawOverlays(v: View, sc: Scene, now: number, a: (p: XY) => XY, band: Band): void {
    const ctx = this.ctx, { AW, AH } = this, calm = this.calm, local = band !== 'region';
    if (sc.focusRuns && band !== 'overview') {
      // the overview tints these itself; at other zooms draw them on top
      for (const [col, wd] of [[PICK.casing, 4], [PICK.band, 2]] as const) {
        for (const i of sc.focusRuns) this.cline(this.world.runs[i].line, a, col, wd);
      }
    }
    // the picked street, steady
    const picked = [...(sc.stretch ?? []), ...(sc.highlight ? [sc.highlight] : [])];
    if (local && picked.length) this.picked(picked, v, a, sc);
    if (local && sc.trip && sc.trip.path.length) this.trip(sc.trip, v, a);
    if (local && sc.trails) for (const tr of sc.trails) this.cline(tr.path, a, CAT[tr.cls], 2, [2, 2]);
    if (sc.link) {
      const [x0, y0] = a(sc.link.from), [x1, y1] = a(sc.link.to);
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4)), sh = calm ? 0 : Math.floor(now / 160) % 2;
      for (let k = sh; k <= n; k += 2) {
        const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
        px(ctx, x - 1, y - 1, '#1d3b48', 3, 3); px(ctx, x, y, TRIP.hi);
      }
    }
    if (sc.trail) {
      const { path, prog } = sc.trail;
      const n = Math.max(1, Math.round(prog * (path.length - 1)));
      let last: XY | null = null, k = 0;
      for (let q = 0; q <= n; q += 2) {
        const p = a(path[q]);
        if (last && p[0] === last[0] && p[1] === last[1]) continue;
        last = p; k++;
        px(ctx, p[0], p[1], !calm && (k + Math.floor(now / 70)) % 7 < 2 ? TRIP.hi : TRIP.dot, 2, 2);
      }
    }
    if (sc.drainMark) { const [x, y] = a(sc.drainMark); grate(ctx, x, y); }
    if (sc.drop) { const [x, y] = a(sc.drop); drop(ctx, x, y); }
    // with motion turned down, endings hold still
    if (sc.ending) this.ending(calm ? { ...sc.ending, rest: true } : sc.ending, a);
    if (local && sc.replay?.length) this.replay(sc.replay, a);
    if (local && sc.route) {
      this.cline(sc.route, a, ROUTE.casing, 4);
      this.cline(sc.route, a, ROUTE.fill, 2);
    }
    if (sc.car) {
      // you-are-here dot, with a pulse unless motion is turned down
      const [x, y] = a(sc.car);
      if (!calm) ring(ctx, x, y, 3 + Math.floor((now % 1200) / 150), '242,210,122', (now % 1200) / 1200);
      px(ctx, x - 2, y - 3, '#1a1712', 5, 7); px(ctx, x - 3, y - 2, '#1a1712', 7, 5);
      px(ctx, x - 1, y - 2, '#f2d27a', 3, 5); px(ctx, x - 2, y - 1, '#f2d27a', 5, 3); px(ctx, x - 1, y - 1, '#fff6d8');
    }
    if (sc.me) {
      // where you are: a blue dot in a white ring, inside its accuracy circle
      const [x, y] = a(sc.me.at), r = Math.round(sc.me.acc / v.mpp);
      if (r > 4) disc(ctx, x, y, r, 'rgba(66,133,244,.16)');
      px(ctx, x - 2, y - 3, '#ffffff', 5, 7); px(ctx, x - 3, y - 2, '#ffffff', 7, 5); px(ctx, x - 1, y - 2, '#3d7fe6', 3, 5); px(ctx, x - 2, y - 1, '#3d7fe6', 5, 3);
    }
    for (const pin of sc.pins ?? []) this.pin(a(pin.at), pin, now, calm);
    // no rain when motion is turned down
    if (sc.rain !== undefined && sc.rain >= 0 && !calm) {
      const T = sc.rainT ?? now;
      for (let k = 0; k < Math.round(AW * AH / 520); k++) {
        const x = Math.floor(hash(k, 1) * AW + T * .004 * (k % 3)) % AW;
        const y = Math.floor((hash(k, 2) * AH + T * (.12 + (k % 4) * .03)) % AH);
        px(ctx, x, y, 'rgba(190,228,240,.6)', 1, 3);
      }
    }
    if (sc.tapMark) {
      // where the finger landed: a ring that opens up, or a still plus when motion is turned down
      const [x, y] = a(sc.tapMark.at), t = now - sc.tapMark.t0;
      if (calm) { if (t >= 0 && t < 600) { px(ctx, x - 3, y - 1, '#1a1712', 7, 3); px(ctx, x - 1, y - 3, '#1a1712', 3, 7); px(ctx, x - 2, y, '#f4f1e6', 5, 1); px(ctx, x, y - 2, '#f4f1e6', 1, 5); } }
      else if (t >= 0 && t < 400) ring(ctx, x, y, 3 + Math.round((t / 400) * 6), '244,241,230', t / 400, 1);
    }
  }

  /** The class drawn for one of the world's run lines, or -1. */
  private classOf(line: XY[]): number {
    const W = this.world, p = line[line.length >> 1];
    if (!p) return -1;
    for (const i of W.runsNear(p, 1)) if (W.runs[i].line === line) return W.runs[i].k;
    return -1;
  }

  /** The picked stretch: a light band with dark edges, its own line code down the middle. */
  private picked(lines: XY[][], v: View, a: (p: XY) => XY, sc: Scene): void {
    const town = v.mpp <= STREET_MPP, tripK = sc.trip ? CLS.indexOf(sc.trip.cls) : -1;
    const looks = lines.map((l) => {
      let k = sc.muted ? -1 : this.classOf(l);
      if (k < 0 && !sc.muted) k = tripK;
      const lit = k >= 0 && !plain(k);
      // up close the band stays two pixels wider than the stripe on each side, so it shows past it
      return { l, k, lit, w: town ? (lit ? (v.mpp <= 1.3 ? CODE[k].near : CODE[k].w) : 1) : 1 };
    });
    for (const s of looks) this.cline(s.l, a, PICK.casing, town ? s.w + 6 : 5);
    for (const s of looks) this.cline(s.l, a, PICK.band, town ? s.w + 4 : 3);
    for (const s of looks) {
      if (town) { if (s.lit) this.cline(s.l, a, CAT[CLS[s.k]], s.w, CODE[s.k].dash); }
      else this.cline(s.l, a, s.lit ? CAT[CLS[s.k]] : ROAD.fill, 1, s.lit ? CODE[s.k].dash : null);
    }
  }

  /** The rain's whole trip from the drain: blue dots on a dark casing, a yellow ring at the drain, and how it ends. */
  private trip(t: Trip, v: View, a: (p: XY) => XY): void {
    const c = this.ctx, path = t.path;
    this.cline(path, a, TRIP.casing, 4);
    this.cline(path, a, TRIP.dot, 2, [3, 2]);
    // small chevrons every 16 art px, pointing the way the water runs
    let next = 8;
    for (let k = 1, run = 0; k < path.length; k++) {
      const [x0, y0] = a(path[k - 1]), [x1, y1] = a(path[k]), len = Math.hypot(x1 - x0, y1 - y0);
      for (; len && next <= run + len; next += 16) {
        const t = (next - run) / len, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
        const dx = (x1 - x0) / len, dy = (y1 - y0) / len;
        // the arms go back from the tip, either side of the line, on a dark patch
        const arms: XY[] = [[0, 0]];
        for (const s of [1, -1]) {
          const bx = -dx - s * dy, by = -dy + s * dx, mm = Math.max(Math.abs(bx), Math.abs(by)), ux = Math.round(bx / mm), uy = Math.round(by / mm);
          arms.push([ux, uy], [2 * ux, 2 * uy]);
        }
        for (const [ax, ay] of arms) px(c, x + ax - 1, y + ay - 1, TRIP.casing, 3, 3);
        for (const [ax, ay] of arms) px(c, x + ax, y + ay, TRIP.hi);
      }
      run += len;
    }
    const [sx, sy] = a(path[0]);
    grate(c, sx, sy);
    circle(c, sx, sy, 6, ROUTE.fill);
    const end = path[path.length - 1], [ex, ey] = a(end);
    if (t.end === 'salmon') {
      const [x, y] = a(t.water ?? end);
      ring(c, x, y + 1, 9, '196,236,250', 0);
      glyph(c, FISH, x - 6, y - 3, false);
    } else if (t.end === 'ripple') {
      const [x, y] = a(t.water ?? end);
      ring(c, x, y, 6, '196,236,250', 0);
    } else if (t.end === 'soak') {
      glyph(c, SOAK, ex - 4, ey - 4, false);
    } else if (t.end === 'pond') {
      const [x, y] = a(t.pond ?? end);
      if (t.water) {
        // the dotted hop to the water the city says the pond drains to
        const [x1, y1] = a(t.water), n = Math.max(1, Math.round(Math.hypot(x1 - x, y1 - y) / 4));
        for (let k = 0; k <= n; k += 2) { const qx = Math.round(x + ((x1 - x) * k) / n), qy = Math.round(y + ((y1 - y) * k) / n); px(c, qx - 1, qy - 1, '#1d3b48', 3, 3); px(c, qx, qy, TRIP.hi); }
      }
      const pond = this.sprites.img.pond;
      if (v.mpp <= STREET_MPP && pond?.width) c.drawImage(pond, x - 24, y - 30);
      else { px(c, x - 3, y - 2, '#1a1712', 7, 5); px(c, x - 2, y - 1, '#5591a3', 5, 3); }
    } else if (t.end === 'plant') {
      glyph(c, PLANT, ex - 5, ey - 5, false);
    } else {
      glyph(c, QMARK, ex - 5, ey - 5, false);
      outline(c, ex - 6, ey - 6, 13, 13);
    }
  }

  /** A drive's colored stretches: one dark casing under all, a light band round the picked one, then each color. */
  private replay(rs: NonNullable<Scene['replay']>, a: (p: XY) => XY): void {
    const c = this.ctx;
    // not recorded: a thin dashed line across, under the rest
    for (const r of rs) if (r.gap && r.path.length > 1) { this.cline(r.path, a, ROUTE.casing, 3, [3, 3]); this.cline(r.path, a, r.color, 1, [3, 3]); }
    rs = rs.filter((r) => !r.gap);
    for (const r of rs) if (r.path.length > 1) this.cline(r.path, a, ROUTE.casing, r.hi ? 6 : 4);
    for (const r of rs) if (r.hi && r.path.length > 1) this.cline(r.path, a, PICK.band, 4);
    for (const r of rs) {
      if (r.path.length > 1) this.cline(r.path, a, r.color, 2);
      if (!r.dot && !r.hi) continue;
      // too short to see at this zoom: a block in its color
      const [x0, y0] = a(r.path[0]), [x1, y1] = a(r.path[r.path.length - 1]);
      if (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) >= 4) continue;
      const [x, y] = a(r.path[r.path.length >> 1]);
      if (r.hi) px(c, x - 4, y - 4, PICK.band, 9, 9);
      px(c, x - 3, y - 3, ROUTE.casing, 7, 7);
      px(c, x - 2, y - 2, r.color, 5, 5);
    }
  }

  /** A polyline on the overlay canvas: w px blocks along it, dashed by `dash` from its start, as plot() does. */
  private cline(pts: readonly XY[], a: (p: XY) => XY, col: string, w: number, dash: readonly number[] | null = null): void {
    const c = this.ctx, { AW, AH } = this, o = w >> 1;
    c.fillStyle = col;
    let step = 0;
    for (let k = 1; k < pts.length; k++) {
      let [x, y] = a(pts[k - 1]);
      const [xe, ye] = a(pts[k]);
      const len = Math.max(Math.abs(xe - x), Math.abs(ye - y));
      if (Math.max(x, xe) + w < 0 || Math.min(x, xe) - w >= AW || Math.max(y, ye) + w < 0 || Math.min(y, ye) - w >= AH) { step += len; continue; }
      const dx = Math.abs(xe - x), dy = -Math.abs(ye - y), sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1;
      // dashed: one pixel deep along the line, as in seg()
      const flat = dx >= -dy;
      let e = dx + dy, s = step;
      for (let guard = 0; guard < 20000; guard++) {
        if (!dash) c.fillRect(x - o, y - o, w, w);
        else if (dashOn(dash, s)) { if (flat) c.fillRect(x, y - o, 1, w); else c.fillRect(x - o, y, w, 1); }
        if (x === xe && y === ye) break;
        s++;
        const e2 = 2 * e;
        if (e2 >= dy) { e += dy; x += sx; }
        if (e2 <= dx) { e += dx; y += sy; }
      }
      step += len;
    }
  }

  private pin([x, y]: XY, p: Pin, now: number, calm: boolean): void {
    const c = this.ctx, active = !!p.active, hollow = p.hollow ?? p.color === CAT.none;
    const bob = active && !calm ? Math.floor(now / 250) % 2 : 0;
    const top = y - 13 - bob;
    // the picked pin keeps its color and gets a light ring
    if (active) px(c, x - 5, top - 2, '#fff6d8', 11, 12);
    px(c, x - 4, top - 1, '#1a1712', 9, 10);
    if (hollow) { px(c, x - 3, top, '#9aa39d', 7, 8); px(c, x - 2, top + 1, '#3a413c', 5, 6); }
    else px(c, x - 3, top, p.color ?? CAT.creek, 7, 8);
    px(c, x - 1, top + 9, '#1a1712', 3, 2); px(c, x, top + 11, '#1a1712', 1, 1);
    const d = p.mark === 'bang' ? BANG : DIGITS[p.n % 10], ink = hollow ? '#eef2ec' : '#1a1712';
    for (let k = 0; k < 15; k++) if (d[k] === '1') px(c, x - 1 + (k % 3), top + 1 + Math.floor(k / 3) + 1, ink);
    // what happens to the stop's water, as a small picture beside the flag
    if (p.badge) { outline(c, x + 6, top - 1, 9, 9); glyph(c, BADGE[p.badge], x + 7, top, false); }
  }

  private ending(e: Ending, a: (p: XY) => XY): void {
    const c = this.ctx, [x, y] = a(e.at);
    if (e.kind === 'salmon') {
      if (e.rest) {
        // a salmon resting in the water, with one still ring
        ring(c, x, y + 1, 9, '196,236,250', 0);
        glyph(c, FISH, x - 6, y - 3, false);
        return;
      }
      const fish = this.sprites.img.salmon2;
      const t = Math.min(1, e.t / .8);
      const st = Math.floor(t * 12) / 12;
      const jy = -Math.round(Math.sin(Math.PI * st) * 20), jx = Math.round((st - .5) * 18);
      if (t < 1 && fish?.width) c.drawImage(fish, x - (fish.width >> 1) + jx, y - fish.height + 6 + jy);
      if (e.t < .3) splash(c, x - 9, y, e.t / .3);
      if (e.t > .7 && e.t < 1.05) splash(c, x + 9, y, (e.t - .7) / .35);
      for (let q = 0; q < 3; q++) { const tt = e.t - .75 - q * .22; if (tt > 0 && tt < 1) ring(c, x + 9, y + 1, 3 + Math.round(tt * 10), '196,236,250', tt); }
    } else if (e.kind === 'ripple') {
      if (e.rest) { ring(c, x, y, 6, '196,236,250', 0); return; }
      for (let q = 0; q < 3; q++) { const tt = (e.t % 1.6) - q * .28; if (tt > 0 && tt < 1) ring(c, x, y, 2 + Math.round(tt * 11), '196,236,250', tt); }
    } else if (e.kind === 'soak') {
      // water spreading into the soil, thinning out as it goes; at rest, a wet patch
      const t = e.rest ? .45 : e.t, r = 2 + t * 10, keep = (1 - t) * 64;
      for (let j = -Math.ceil(r); j <= r; j++) for (let i = -Math.ceil(r); i <= r; i++) {
        const d = Math.hypot(i, j * 1.3);
        if (d <= r && BAYER[((y + j) & 7) * 8 + ((x + i) & 7)] < keep * (1 - d / (r + 1))) px(c, x + i, y + j, d < r * .5 ? '#5ec6ee' : '#3c8fae');
      }
    } else {
      // the map stops here
      outline(c, x - 6, y - 6, 13, 13);
      glyph(c, QMARK, x - 5, y - 5, false);
    }
  }
}

function px(c: CanvasRenderingContext2D, x: number, y: number, col: string, w = 1, h = 1): void {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
}

/** A small picture on a canvas; flip mirrors it. */
function glyph(c: CanvasRenderingContext2D, rows: string[], x0: number, y0: number, flip: boolean): void {
  const n = rows[0].length;
  for (let j = 0; j < rows.length; j++) for (let i = 0; i < n; i++) {
    const ch = rows[j][flip ? n - 1 - i : i];
    if (ch !== '.') px(c, x0 + i, y0 + j, INK[ch]);
  }
}

/** A 1 px dark frame around a w x h box. */
function outline(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  px(c, x, y, '#1a1712', w, 1); px(c, x, y + h - 1, '#1a1712', w, 1); px(c, x, y, '#1a1712', 1, h); px(c, x + w - 1, y, '#1a1712', 1, h);
}

/** A storm drain grate, as the story draws it. */
function grate(c: CanvasRenderingContext2D, x: number, y: number): void {
  px(c, x - 3, y - 2, '#101315', 7, 5); px(c, x - 2, y - 1, '#4a5157', 5, 3);
  px(c, x - 1, y - 1, '#a3abb1', 1, 3); px(c, x + 1, y - 1, '#a3abb1', 1, 3);
}

/** A 1 px round outline. */
function circle(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string): void {
  c.fillStyle = col;
  let x = r, y = 0, e = 1 - r;
  while (x >= y) {
    for (const [p, q] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) c.fillRect(cx + p, cy + q, 1, 1);
    y++;
    if (e < 0) e += 2 * y + 1;
    else { x--; e += 2 * (y - x) + 1; }
  }
}

/** A filled pixel disc. */
function disc(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string): void {
  c.fillStyle = col;
  for (let j = -r; j <= r; j++) { const h = Math.floor(Math.sqrt(r * r - j * j)); c.fillRect(cx - h, cy + j, 2 * h + 1, 1); }
}

// Liang-Barsky: the part of a segment inside the view, or null
function clipSeg(x0: number, y0: number, x1: number, y1: number, W: number, H: number): [number, number, number, number] | null {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (const [pp, q] of [[-dx, x0 + 1], [dx, W - x0], [-dy, y0 + 1], [dy, H - y0]]) {
    if (pp === 0) { if (q < 0) return null; continue; }
    const r = q / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

function bres(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy, guard = 0;
  for (;;) {
    plot(x0, y0);
    if ((x0 === x1 && y0 === y1) || ++guard > 6000) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}

// pixel ring, alpha stepped in quarters like hand-drawn frames; squash < 1 lies it flat like a ripple
function ring(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: string, t: number, squash = .7): void {
  const al = Math.ceil((1 - t) * 4) / 4;
  if (al <= 0) return;
  c.fillStyle = `rgba(${rgb},${al})`;
  let x = r, y = 0, e = 1 - r;
  while (x >= y) {
    for (const [p, q] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) c.fillRect(cx + p, cy + Math.round(q * squash), 1, 1);
    y++;
    if (e < 0) e += 2 * y + 1;
    else { x--; e += 2 * (y - x) + 1; }
  }
}

export function drop(c: CanvasRenderingContext2D, x: number, y: number): void {
  const o = '#1d3b48', f = '#5ec6ee', h = '#e6f7fc';
  px(c, x, y - 3, o); px(c, x - 1, y - 2, o, 3, 1); px(c, x, y - 2, f);
  px(c, x - 2, y - 1, o, 5, 3); px(c, x - 1, y - 1, f, 3, 3); px(c, x - 1, y, h);
  px(c, x - 1, y + 2, o, 3, 1);
}

// three frames: burst, spray, settle
export function splash(c: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const f = t < .33 ? 0 : t < .66 ? 1 : 2;
  const W = '#ffffff', B = '#c4ecfa';
  if (f === 0) { px(c, x - 1, y - 2, B, 3, 1); px(c, x, y - 3, W); px(c, x - 3, y - 1, B); px(c, x + 3, y - 1, B); }
  if (f === 1) { px(c, x - 4, y - 4, W); px(c, x + 4, y - 4, W); px(c, x - 2, y - 5, B); px(c, x + 2, y - 5, B); px(c, x - 5, y - 1, B); px(c, x + 5, y - 1, B); }
  if (f === 2) { px(c, x - 6, y, B); px(c, x + 6, y, B); px(c, x - 3, y + 1, W); px(c, x + 3, y + 1, W); }
}

/** Region map points to world meters, packed, with their box. */
function worldLine(pts: readonly XY[]): { pts: Float32Array; box: Part['box'] } {
  const out = new Float32Array(2 * pts.length), box: Part['box'] = [Infinity, Infinity, -Infinity, -Infinity];
  pts.forEach((p, k) => {
    const [x, y] = worldPt(p);
    out[2 * k] = x; out[2 * k + 1] = y;
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
  });
  return { pts: out, box };
}
