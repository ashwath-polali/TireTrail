// Pixel map renderer: overview, pixel town, underground pipes, and the story overlays.
import type { XY } from '../../geo/geo.ts';
import { Basemap, COVER_FOREST, COVER_GRASS, COVER_PARK, COVER_WATER, type BaseTile, type Road } from './basemap.ts';
import { BAYER, hash, vnoise } from './noise.ts';
import type { Region, Shape } from './region.ts';
import type { Sprites } from './sprites.ts';
import { G_CREEK, G_GRASS, G_LAKE, G_ROAD, type World } from './world.ts';

export const S = 3; // CSS px per art pixel
export const STREET_MPP = 2.6; // at or below this, draw the pixel town
export const REGION_MPP = 24; // above this, draw the region outlines
export const BLOCK_MPP = 12; // above this, no buildings

export interface Cam { x: number; y: number; mpp: number }
export interface Pin { at: XY; n: number; active?: boolean; color?: string }
export interface Ending { kind: 'salmon' | 'ripple' | 'soak' | 'stop'; at: XY; t: number }
export interface Scene {
  dissolve?: number;
  trail?: { path: XY[]; prog: number } | null;
  drop?: XY | null;
  rain?: number;
  rainT?: number;
  ending?: Ending | null;
  highlight?: XY[] | null;
  flash?: number;
  pins?: Pin[];
  route?: XY[] | null;
  pondAt?: XY | null;
  focusRuns?: Set<number> | null;
  drainMark?: XY | null;
  car?: XY | null;
  /** dotted hop from a pond to the water the city says it drains to */
  link?: { from: XY; to: XY } | null;
}

// ABGR words for ImageData
const C = (h: string) => { const n = parseInt(h.slice(1), 16); return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0; };
const PAL = {
  grass: ['#5c7a4b', '#557245', '#638251'].map(C), tuft: C('#4b6740'), flower: C('#d9cf96'),
  ograss: ['#3c5334', '#394f32', '#405837'].map(C),
  lake: [C('#2f5361'), C('#356070')], shore: C('#5f8c97'), sparkle: C('#b6d8de'),
  creek: C('#3b6b7b'), bank: C('#2a4b56'),
  road: [['#7a4a42', '#744640'], ['#4b6552', '#475f4d'], ['#4d555e', '#495159'], ['#4b5056', '#464b51'], ['#4b5056', '#464b51']].map((p) => p.map(C)),
  edge: C('#2b2e31'),
  dirt: ['#5b4434', '#543f30', '#624a3a'].map(C), pebble: C('#7a6453'), ghost: C('#4a392d'),
  tube: C('#a9a397'), tubeHi: C('#d9d3c5'), tubeLo: C('#77716a'), rim: C('#2a201a'), deep: C('#25343a'),
  forest: ['#3d5734', '#38502f', '#43603a'].map(C), crown: C('#4d6b41'), crownHi: C('#5f7f4e'), crownLo: C('#2c4027'),
  park: ['#67874f', '#60804a', '#6e8f55'].map(C),
  oforest: ['#2e4329', '#2b3f26', '#32482c'].map(C), ospeck: C('#3b5534'), opark: ['#46623a', '#425d37', '#4b683f'].map(C),
  block: C('#a29c92'), blockLo: C('#77716a'), oroad: C('#4f5752'), ocase: C('#1e2721'),
};
// roofs: house tones 0-7, then big flat roofs 8-10; each with its shadow (south, east) and lit (north, west) edge
const ROOF = ['#7d6f62', '#6b5a4c', '#7f5a4d', '#6d7174', '#8a8070', '#626b63', '#75696f', '#5f5650', '#a5a49e', '#8f959a', '#b1ada3'];
const ROOF_MID = ROOF.map(C), ROOF_LO = ROOF.map((h) => C(shade(h, .72))), ROOF_HI = ROOF.map((h) => C(shade(h, 1.18)));
const num = (p: number, q: number) => p - q;

function shade(h: string, f: number): string {
  const n = parseInt(h.slice(1), 16);
  const ch = (s: number) => Math.min(255, Math.round(((n >> s) & 255) * f)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
const OV_FILL = ['#ee7a63', '#8fd69a', '#7f93a6', '#5f6862', '#4f5752'];
// region codes: 0 sea, 1 state, 2 coho state, 3 abroad, 4 city, 5 Bonney Lake
const RP = {
  sea: C('#173039'), wave: C('#1f3f4b'), shore: C('#6f9aa0'),
  land: [0, C('#2b3829'), C('#3c5334'), C('#242d24'), C('#4b6842'), C('#3c5334')],
  speck: [0, C('#283426'), C('#394f32'), C('#222a22'), C('#46623e'), C('#3c5334')],
  border: [0, C('#3b4a38'), C('#5b7451'), C('#3b4a38'), C('#5b7451'), C('#5b7451')],
  county: C('#4f6745'), city: C('#93a48d'), home: C('#f2d27a'), lake: C('#2f5361'), creek: C('#5591a3'),
};
const RUN_FILL = OV_FILL.map(C);
const CENTER = ['#f08a72', '#a4e6ad'];
// 3x5 digits for map pins
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

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
  private tones = new Uint8Array(1 << 16);
  private readonly xs = new Float64Array(64);
  region: Region | null = null;
  /** real buildings, land cover and roads; null draws plain grass */
  basemap: Basemap | null = new Basemap();

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
    this.codes = new Uint8Array(this.AW * this.AH);
    this.cover = new Uint8Array(this.AW * this.AH);
    this.bid = new Int32Array(this.AW * this.AH);
    this.croad = new Uint8Array(this.AW * this.AH);
    this.lake = new Uint8Array(this.AW * this.AH);
    this.rows = Array.from({ length: this.AH }, () => []);
  }

  private view(cam: Cam) {
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
    const v = this.view(cam);
    const a = (p: XY): XY => [Math.round((p[0] - v.x0) / v.mpp), Math.round((p[1] - v.y0) / v.mpp)];
    const town = v.mpp <= STREET_MPP, region = !town && v.mpp > REGION_MPP && !!this.region;
    // buildings are kept in the tile holding their middle, so look a little past the edges
    const pad = 120, tiles = region || !this.basemap ? [] : this.basemap.near(v.x0 - pad, v.y0 - pad, v.x0 + this.AW * v.mpp + pad, v.y0 + this.AH * v.mpp + pad);
    if (town) this.drawTown(v, sc, now, a, tiles);
    else if (region) this.drawRegion(v, now, a);
    else this.drawOverview(v, sc, a, tiles);
    const dis = town ? sc.dissolve ?? 0 : 0;
    const ctx = this.ctx;
    if (dis > 0) {
      // ordered-dither dissolve: each pixel flips to underground at its own threshold
      this.drawUnder(v);
      const thr = dis * 64, AW = this.AW;
      for (let j = 0; j < this.AH; j++) for (let i = 0; i < AW; i++) {
        const k = j * AW + i;
        const up = BAYER[(j & 7) * 8 + (i & 7)] >= thr;
        if (up) this.wU[k] = this.wS[k];
        this.wM[k] = up ? 0xff000000 : 0;
      }
      ctx.putImageData(this.imgU, 0, 0);
      for (const i of this.world.drainsNear([v.x0 + (AW * v.mpp) / 2, v.y0 + (this.AH * v.mpp) / 2], Math.max(AW, this.AH) * v.mpp)) {
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
      ctx.drawImage(this.surf, 0, 0);
    }
    this.drawOverlays(v, sc, now, a, !town && !region);
  }

  private drawOverview(v: { x0: number; y0: number; mpp: number }, sc: Scene, a: (p: XY) => XY, tiles: BaseTile[]): void {
    const { AW, AH } = this, m = v.mpp, w = this.wS, cover = this.cover, bid = this.bid, lake = this.lake;
    this.rasterBase(v, tiles, false);
    // the city's lakes and OSM water share one shoreline
    lake.fill(0);
    for (const wt of this.world.waters) if (wt.ring) fillArt(lake, AW, AH, wt.ring.map(a), 1);
    const wet = (k: number) => lake[k] > 0 || cover[k] === COVER_WATER;
    const gx = Math.round(v.x0 / m), gy = Math.round(v.y0 / m);
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      for (let i = 0; i < AW; i++) {
        const k = j * AW + i, cv = cover[k], id = bid[k];
        if (lake[k] || (!id && cv === COVER_WATER)) {
          const shore = (i > 0 && !wet(k - 1)) || (j > 0 && !wet(k - AW)) || (i + 1 < AW && !wet(k + 1)) || (j + 1 < AH && !wet(k + AW));
          w[k] = shore ? PAL.shore : PAL.lake[0];
          continue;
        }
        // buildings as light blocks, darker along the bottom once they are two pixels tall
        if (id) { w[k] = j > 0 && j + 1 < AH && bid[k - AW] === id && bid[k + AW] !== id ? PAL.blockLo : PAL.block; continue; }
        const n = vnoise(v.x0 + (i + .5) * m, wy, 140, 21) * 2.2 + (BAYER[(j & 7) * 8 + (i & 7)] / 64 - .5) * .9;
        const t = n < .75 ? 1 : n < 1.45 ? 0 : 2;
        if (cv === COVER_FOREST) w[k] = hash(gx + i, gy + j, 13) < .1 ? PAL.ospeck : PAL.oforest[t];
        else w[k] = (cv ? PAL.opark : PAL.ograss)[t];
      }
    }
    this.plotRoads(v, tiles);
    const cx = v.x0 + (AW * m) / 2, cy = v.y0 + (AH * m) / 2;
    const span = Math.max(AW, AH) * m;
    const s = this.sctx;
    s.clearRect(0, 0, AW, AH);
    for (const wt of this.world.waters) if (wt.line) for (let k = 1; k < wt.line.length; k++) line(s, a(wt.line[k - 1]), a(wt.line[k]), '#22404a', 3);
    for (const wt of this.world.waters) if (wt.line) for (let k = 1; k < wt.line.length; k++) line(s, a(wt.line[k - 1]), a(wt.line[k]), '#5591a3', 1);
    const runs = this.world.runsNear([cx, cy], span);
    // dark casing only when the streets have room for it
    if (m <= 12) for (const i of runs) { const r = this.world.runs[i]; for (let k = 1; k < r.line.length; k++) line(s, a(r.line[k - 1]), a(r.line[k]), '#1e2721', 3); }
    const home = this.region?.places.find((p) => p.name === 'Bonney Lake');
    // city limits only from afar, and never in the route's yellow
    if (home && m > 16) for (const r of home.rings) poly(s, r.map(a), '#93a48d');
    for (const k of [4, 3, 2, 1, 0]) for (const i of runs) {
      const r = this.world.runs[i];
      if (r.k !== k) continue;
      const dim = sc.focusRuns && !sc.focusRuns.has(r.i);
      const col = sc.focusRuns ? (dim ? '#4f5752' : '#ffe08a') : OV_FILL[k];
      for (let q = 1; q < r.line.length; q++) line(s, a(r.line[q - 1]), a(r.line[q]), col, sc.focusRuns && !dim ? 2 : 1);
    }
  }

  /** Land cover, buildings and (in town) basemap roads for this view, into the per-pixel buffers. */
  private rasterBase(v: { x0: number; y0: number; mpp: number }, tiles: BaseTile[], town: boolean): void {
    const { AW, AH } = this, m = v.mpp, x1 = v.x0 + AW * m, y1 = v.y0 + AH * m, bid = this.bid;
    const seen = (b: ArrayLike<number>, o: number) => b[o + 2] >= v.x0 && b[o] <= x1 && b[o + 3] >= v.y0 && b[o + 1] <= y1;
    this.cover.fill(0);
    bid.fill(0);
    this.croad.fill(0);
    for (const cls of [COVER_FOREST, COVER_GRASS, COVER_PARK, COVER_WATER]) for (const t of tiles) for (const c of t.cover) {
      if (c.cls === cls && seen(c.box, 0)) this.scan(this.cover, c.pts, c.ranges, cls, v);
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
  private scan(buf: Uint8Array, pts: Float32Array, ranges: ArrayLike<number>, val: number, v: { x0: number; y0: number; mpp: number }): void {
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
    for (let j = j0; j <= j1; j++) {
      const xs = rows[j];
      if (xs.length < 2) continue;
      if (xs.length > 2) xs.sort(num);
      else if (xs[0] > xs[1]) { const q = xs[0]; xs[0] = xs[1]; xs[1] = q; }
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const o = j * AW, i0 = Math.max(0, Math.ceil(xs[q] - .5)), i1 = Math.min(AW - 1, Math.ceil(xs[q + 1] - .5) - 1);
        for (let i = i0; i <= i1; i++) buf[o + i] = val;
      }
    }
  }

  /** One small ring (a building, vertices s..e) into bid, row by row. True if any pixel was set. */
  private scanRing(pts: Float32Array, s: number, e: number, val: number, v: { x0: number; y0: number; mpp: number }): boolean {
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
  private thick(pts: Float32Array, rM: number, val: number, v: { x0: number; y0: number; mpp: number }): void {
    const { AW, AH } = this, m = v.mpp, r = rM / m, r2 = r * r, buf = this.croad;
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
          if (ex * ex + ey * ey <= r2 && buf[j * AW + i] < val) buf[j * AW + i] = val;
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

  /** Overview: basemap roads as thin lines under the city's streets (minor ones only up close), never over its lakes. */
  private plotRoads(v: { x0: number; y0: number; mpp: number }, tiles: BaseTile[]): void {
    const { AW, AH } = this, m = v.mpp, w = this.wS, lake = this.lake, x1 = v.x0 + AW * m, y1 = v.y0 + AH * m;
    for (const pass of m <= BLOCK_MPP ? [0, 1] : [1]) {
      // a dark casing three pixels wide first, then the road down its middle
      const col = pass ? PAL.oroad : PAL.ocase, r = pass ? 0 : 1;
      for (const t of tiles) for (const rd of t.roads) {
        if ((!rd.major && m > BLOCK_MPP) || rd.box[2] < v.x0 || rd.box[0] > x1 || rd.box[3] < v.y0 || rd.box[1] > y1 || !this.shown(rd)) continue;
        for (let k = 2; k + 1 < rd.pts.length; k += 2) {
          const c = clipSeg((rd.pts[k - 2] - v.x0) / m, (rd.pts[k - 1] - v.y0) / m, (rd.pts[k] - v.x0) / m, (rd.pts[k + 1] - v.y0) / m, AW, AH);
          if (!c) continue;
          let x = Math.round(c[0]), y = Math.round(c[1]);
          const xe = Math.round(c[2]), ye = Math.round(c[3]);
          const dx = Math.abs(xe - x), dy = -Math.abs(ye - y), sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1;
          let e = dx + dy;
          for (let guard = 0; guard < 6000; guard++) {
            for (let yy = Math.max(0, y - r), ye2 = Math.min(AH - 1, y + r); yy <= ye2; yy++) {
              for (let xx = Math.max(0, x - r), xe2 = Math.min(AW - 1, x + r); xx <= xe2; xx++) if (!lake[yy * AW + xx]) w[yy * AW + xx] = col;
            }
            if (x === xe && y === ye) break;
            const e2 = 2 * e;
            if (e2 >= dy) { e += dy; x += sx; }
            if (e2 <= dx) { e += dx; y += sy; }
          }
        }
      }
    }
  }

  /** Fills a shape's rings (even-odd) into the code buffer. */
  private fillShape(sh: Shape, v: { x0: number; y0: number; mpp: number }, val: number): void {
    const { AW, AH } = this, m = v.mpp, rows = this.rows;
    if (sh.box[2] < v.x0 || sh.box[0] > v.x0 + AW * m || sh.box[3] < v.y0 || sh.box[1] > v.y0 + AH * m) return;
    for (const r of rows) r.length = 0;
    for (const ring of sh.rings) {
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
        const px0 = (ring[j][0] - v.x0) / m, py0 = (ring[j][1] - v.y0) / m, px1 = (ring[k][0] - v.x0) / m, py1 = (ring[k][1] - v.y0) / m;
        if (py0 === py1) continue;
        const lo = Math.max(0, Math.ceil(Math.min(py0, py1) - .5)), hi = Math.min(AH - 1, Math.ceil(Math.max(py0, py1) - .5) - 1);
        for (let y = lo; y <= hi; y++) rows[y].push(px0 + ((y + .5 - py0) * (px1 - px0)) / (py1 - py0));
      }
    }
    const code = this.codes;
    for (let y = 0; y < AH; y++) {
      const xs = rows[y];
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - .5)), e = Math.min(AW - 1, Math.floor(xs[k + 1] - .5)); x <= e; x++) code[y * AW + x] = val;
      }
    }
  }

  /** Plots a polyline into the pixel buffer; 'land' lines skip the coast. */
  private stroke(pts: XY[], v: { x0: number; y0: number; mpp: number }, col: number | ((c: number) => number), mode: 'all' | 'land' | 'dash' = 'all', closed = false): void {
    const { AW, AH } = this, m = v.mpp, w = this.wS, code = this.codes;
    let n = 0;
    const plot = (x: number, y: number) => {
      if (x < 1 || y < 1 || x >= AW - 1 || y >= AH - 1) return;
      const k = y * AW + x, c = code[k];
      if (mode === 'land' && (!c || !code[k - 1] || !code[k + 1] || !code[k - AW] || !code[k + AW])) return;
      if (mode === 'dash' && (n++ & 3) > 1) return;
      w[k] = typeof col === 'number' ? col : col(c);
    };
    const last = closed ? pts.length : pts.length - 1;
    for (let k = 0; k < last; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const c = clipSeg((p[0] - v.x0) / m, (p[1] - v.y0) / m, (q[0] - v.x0) / m, (q[1] - v.y0) / m, AW, AH);
      if (c) bres(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3]), plot);
    }
  }

  private drawRegion(v: { x0: number; y0: number; mpp: number }, now: number, a: (p: XY) => XY): void {
    const { AW, AH } = this, m = v.mpp, R = this.region!, w = this.wS, code = this.codes;
    const fine = m < 400, cities = m < 1200, wa = m < 1600;
    const seen = (b: Shape['box']) => b[2] >= v.x0 && b[0] <= v.x0 + AW * m && b[3] >= v.y0 && b[1] <= v.y0 + AH * m;
    code.fill(0);
    for (const sh of R.abroad) this.fillShape(sh, v, 3);
    for (const st of R.states) this.fillShape((fine && R.detail.get(st.id)) || st, v, st.west ? 2 : 1);
    if (cities) for (const pl of R.places) this.fillShape(pl, v, pl.name === 'Bonney Lake' ? 5 : 4);
    // plug one-pixel gaps where separately drawn outlines meet
    for (let j = 1; j < AH - 1; j++) for (let i = 1; i < AW - 1; i++) {
      const k = j * AW + i;
      if (code[k]) continue;
      const l = code[k - 1], r = code[k + 1], u = code[k - AW], d = code[k + AW];
      if ((l ? 1 : 0) + (r ? 1 : 0) + (u ? 1 : 0) + (d ? 1 : 0) >= 3) code[k] = l || r || u || d;
    }
    // colors, with a light coast line and specks that stay put while panning
    const gx = Math.round(v.x0 / m), gy = Math.round(v.y0 / m);
    for (let j = 0; j < AH; j++) for (let i = 0; i < AW; i++) {
      const k = j * AW + i, c = code[k], h = hash(gx + i, gy + j, 5);
      if (!c) { w[k] = h < .025 ? RP.wave : RP.sea; continue; }
      const shore = (i > 0 && !code[k - 1]) || (i < AW - 1 && !code[k + 1]) || (j > 0 && !code[k - AW]) || (j < AH - 1 && !code[k + AW]);
      // Bonney Lake gets a yellow screen from afar, then just its outline once the streets show
      w[k] = shore ? RP.shore : c === 5 ? (m > 120 && ((i + j) & 1) ? RP.home : RP.land[2]) : h < .07 ? RP.speck[c] : RP.land[c];
    }
    for (const st of R.states) {
      const sh = (fine && R.detail.get(st.id)) || st;
      if (seen(sh.box)) for (const r of sh.rings) this.stroke(r, v, (c) => RP.border[c], 'land', true);
    }
    if (wa) {
      for (const co of R.counties) if (!co.home && seen(co.box)) for (const r of co.rings) this.stroke(r, v, RP.county, 'land', true);
      const home = R.home;
      if (home && seen(home.box)) for (const r of home.rings) this.stroke(r, v, RP.home, 'dash', true);
    }
    if (cities) for (const pl of R.places) if (seen(pl.box)) for (const r of pl.rings) this.stroke(r, v, pl.name === 'Bonney Lake' ? RP.home : RP.city, 'all', true);
    // the town itself, once it's more than a dot
    if (m < 90) {
      for (const wt of this.world.waters) {
        if (wt.ring) this.stroke(wt.ring, v, RP.lake, 'all', true);
        else this.stroke(wt.line!, v, RP.creek);
      }
      for (const k of [4, 3, 2, 1, 0]) for (const r of this.world.runs) if (r.k === k) this.stroke(r.line, v, RUN_FILL[k]);
    }
    const s = this.sctx;
    s.clearRect(0, 0, AW, AH);
    for (const pt of R.points) {
      const [x, y] = a(pt.at);
      if (pt.kind === 'city' && m > 90 && m < 7000) { px(s, x - 1, y - 1, '#0e1311', 4, 4); px(s, x, y, '#eef2ec', 2, 2); }
      if (pt.kind === 'peak' && m > 50 && m < 2600) {
        // a small snowy peak
        px(s, x - 4, y + 1, '#0e1311', 9, 2); px(s, x - 3, y - 1, '#0e1311', 7, 2); px(s, x - 2, y - 3, '#0e1311', 5, 2); px(s, x - 1, y - 5, '#0e1311', 3, 2);
        px(s, x - 3, y + 1, '#7d8a86', 7, 1); px(s, x - 2, y - 1, '#9aa7a2', 5, 2); px(s, x - 1, y - 3, '#eef2ec', 3, 2); px(s, x, y - 4, '#ffffff');
      }
    }
    if (m > 150) {
      // where TireTrail has data
      const [x, y] = a(this.world.center), t = (now % 1400) / 1400;
      ring(s, x, y, 2 + Math.round(t * 9), '242,210,122', t);
      px(s, x - 2, y - 2, '#1a1712', 5, 5); px(s, x - 1, y - 1, '#f2d27a', 3, 3);
    }
  }

  private drawTown(v: { x0: number; y0: number; mpp: number }, sc: Scene, now: number, a: (p: XY) => XY, tiles: BaseTile[]): void {
    const { AW, AH } = this, m = v.mpp, W = this.world, w = this.wS, code = this.codes;
    const cover = this.cover, bid = this.bid, croad = this.croad, tones = this.tones;
    // ground once per pixel; neighbors read it back, and off-screen ones ask the world
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      for (let i = 0; i < AW; i++) code[j * AW + i] = W.groundAt(v.x0 + (i + .5) * m, wy);
    }
    this.rasterBase(v, tiles, true);
    // streets and lakes win over buildings
    for (let k = 0; k < AW * AH; k++) if (bid[k] && (code[k] !== G_GRASS || croad[k])) bid[k] = 0;
    const road = (k: number) => code[k] >= G_ROAD || croad[k] > 0;
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
        if (g === G_LAKE) {
          // no shoreline where OSM water carries on past the city's outline
          const edge = (gl !== G_LAKE && !(i > 0 && cover[k - 1] === COVER_WATER)) || (gu !== G_LAKE && !(j > 0 && cover[k - AW] === COVER_WATER));
          c = edge ? PAL.shore : PAL.lake[h < .5 ? 0 : 1];
          if (!edge && ((h * 997 + Math.floor(now / 170)) | 0) % 53 === 0) c = PAL.sparkle;
        } else if (g === G_CREEK) {
          c = gu === 0 || gl === 0 ? PAL.bank : PAL.creek;
        } else if (g >= G_ROAD) {
          const gd = j + 1 < AH ? code[k + AW] : W.groundAt(wx, wy + m), gr = i + 1 < AW ? code[k + 1] : W.groundAt(wx + m, wy);
          // a basemap road running into a city street doesn't count as its edge
          const edge = (gu < G_ROAD && !(j > 0 && croad[k - AW])) || (gl < G_ROAD && !(i > 0 && croad[k - 1]))
            || (gd < G_ROAD && !(j + 1 < AH && croad[k + AW])) || (gr < G_ROAD && !(i + 1 < AW && croad[k + 1]));
          c = edge ? PAL.edge : PAL.road[g - G_ROAD][h < .5 ? 0 : 1];
        } else if (croad[k]) {
          // outside the city's street data: drawn like a street with no mapped drain
          const edge = (j > 0 && !road(k - AW)) || (i > 0 && !road(k - 1)) || (j + 1 < AH && !road(k + AW)) || (i + 1 < AW && !road(k + 1));
          c = edge ? PAL.edge : PAL.road[4][h < .5 ? 0 : 1];
        } else if (bid[k]) {
          // flat roof, shadowed on the south and east sides, lit on the north and west
          const id = bid[k], t = tones[id];
          c = (i + 1 < AW && bid[k + 1] !== id) || (j + 1 < AH && bid[k + AW] !== id) ? ROOF_LO[t]
            : (i > 0 && bid[k - 1] !== id) || (j > 0 && bid[k - AW] !== id) ? ROOF_HI[t] : ROOF_MID[t];
        } else if (cover[k] === COVER_WATER) {
          const edge = (i > 0 && cover[k - 1] !== COVER_WATER && gl !== G_LAKE) || (j > 0 && cover[k - AW] !== COVER_WATER && gu !== G_LAKE);
          c = edge ? PAL.shore : PAL.lake[h < .5 ? 0 : 1];
          if (!edge && ((h * 997 + Math.floor(now / 170)) | 0) % 53 === 0) c = PAL.sparkle;
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
    const C = 4.5, big = m <= 1.3;
    if (tiles.length) for (let gy = Math.floor(v.y0 / C); gy <= Math.floor((v.y0 + AH * m) / C); gy++) for (let gx = Math.floor(v.x0 / C); gx <= Math.floor((v.x0 + AW * m) / C); gx++) {
      if (hash(gx, gy, 23) > .55) continue;
      const i = Math.floor(((gx + hash(gx, gy, 24)) * C - v.x0) / m), j = Math.floor(((gy + hash(gx, gy, 25)) * C - v.y0) / m);
      if (i < 1 || j < 1 || i >= AW - 1 || j >= AH - 1) continue;
      const k = j * AW + i;
      if (!open(k)) continue;
      if (big) { put(k - AW, PAL.crownHi); put(k - 1, PAL.crown); put(k, PAL.crown); put(k + 1, PAL.crownLo); put(k + AW, PAL.crownLo); }
      else { put(k, PAL.crownHi); put(k + 1, PAL.crown); put(k + AW, PAL.crown); put(k + AW + 1, PAL.crownLo); }
    }
    const s = this.sctx;
    s.clearRect(0, 0, AW, AH);
    const cx = v.x0 + (AW * m) / 2, cy = v.y0 + (AH * m) / 2, span = Math.max(AW, AH) * m;
    // center lines: dashed on creek streets, dotted on soak-in streets
    for (const i of W.runsNear([cx, cy], span)) {
      const r = W.runs[i];
      if (r.k > 1) continue;
      let run = 0;
      for (let q = 1; q < r.line.length; q++) {
        const p0 = r.line[q - 1], p1 = r.line[q], len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        for (let d = 0; d < len; d += m) {
          run++;
          const [x, y] = a([p0[0] + ((p1[0] - p0[0]) * d) / len, p0[1] + ((p1[1] - p0[1]) * d) / len]);
          if (x < 0 || y < 0 || x >= AW || y >= AH) continue;
          if (r.k === 0 ? run % 7 < 4 : run % 3 === 0) px(s, x, y, CENTER[r.k]);
        }
      }
    }
    for (const i of W.drainsNear([cx, cy], span)) {
      const [x, y] = a(W.drains[i]);
      if (x < -2 || y < -2 || x > AW || y > AH) continue;
      px(s, x - 1, y - 1, '#1f2326', 3, 2); px(s, x, y - 1, '#7c8389');
    }
    if (sc.pondAt && this.sprites.img.pond?.width) { const [x, y] = a(sc.pondAt); s.drawImage(this.sprites.img.pond, x - 24, y - 30); }
  }

  private drawUnder(v: { x0: number; y0: number; mpp: number }): void {
    const { AW, AH } = this, m = v.mpp, W = this.world, w = this.wU;
    for (let j = 0; j < AH; j++) {
      const wy = v.y0 + (j + .5) * m;
      for (let i = 0; i < AW; i++) {
        const wx = v.x0 + (i + .5) * m;
        const h = hash(Math.floor(wx / m), Math.floor(wy / m), 9);
        const n = vnoise(wx, wy, 12, 11) * 2.2 + (BAYER[(j & 7) * 8 + (i & 7)] / 64 - .5) * .9;
        const g = W.groundAt(wx, wy);
        let c = PAL.dirt[n < .75 ? 1 : n < 1.45 ? 0 : 2];
        if (h > .975 || vnoise(wx, wy, 5, 17) > .9) c = PAL.pebble;
        if (g >= G_ROAD) c = PAL.ghost;
        if (g === G_LAKE || g === G_CREEK) c = PAL.deep;
        const up = W.pipeAt(wx, wy - m), dn = W.pipeAt(wx, wy + m), lf = W.pipeAt(wx - m, wy), rt = W.pipeAt(wx + m, wy);
        if (W.pipeAt(wx, wy)) c = !up || !lf ? PAL.tubeHi : !dn || !rt ? PAL.tubeLo : PAL.tube;
        else if (up || dn || lf || rt) c = PAL.rim;
        w[j * AW + i] = c;
      }
    }
  }

  private drawOverlays(v: { x0: number; y0: number; mpp: number }, sc: Scene, now: number, a: (p: XY) => XY, overview: boolean): void {
    const ctx = this.ctx, { AW, AH } = this;
    if (sc.focusRuns && !overview) {
      // the overview tints these itself; at other zooms draw them on top
      for (const [col, wd] of [['#1a1712', 4], ['#ffe08a', 2]] as const) {
        for (const i of sc.focusRuns) { const r = this.world.runs[i]; for (let k = 1; k < r.line.length; k++) line(ctx, a(r.line[k - 1]), a(r.line[k]), col, wd); }
      }
    }
    if (sc.route) {
      for (let k = 1; k < sc.route.length; k++) line(ctx, a(sc.route[k - 1]), a(sc.route[k]), '#1a1712', 4);
      for (let k = 1; k < sc.route.length; k++) line(ctx, a(sc.route[k - 1]), a(sc.route[k]), '#f2d27a', 2);
    }
    if (sc.highlight && Math.floor((sc.flash ?? 0) * 3) % 2 === 0) {
      // the tapped street, blinking three times a second
      for (let k = 1; k < sc.highlight.length; k++) line(ctx, a(sc.highlight[k - 1]), a(sc.highlight[k]), '#1a1712', 4);
      for (let k = 1; k < sc.highlight.length; k++) line(ctx, a(sc.highlight[k - 1]), a(sc.highlight[k]), '#ffe08a', 2);
    }
    if (sc.drainMark) {
      const [x, y] = a(sc.drainMark);
      px(ctx, x - 3, y - 2, '#101315', 7, 5); px(ctx, x - 2, y - 1, '#4a5157', 5, 3);
      px(ctx, x - 1, y - 1, '#a3abb1', 1, 3); px(ctx, x + 1, y - 1, '#a3abb1', 1, 3);
    }
    if (sc.rain !== undefined && sc.rain >= 0) {
      const T = sc.rainT ?? now;
      for (let k = 0; k < Math.round(AW * AH / 520); k++) {
        const x = Math.floor(hash(k, 1) * AW + T * .004 * (k % 3)) % AW;
        const y = Math.floor((hash(k, 2) * AH + T * (.12 + (k % 4) * .03)) % AH);
        px(ctx, x, y, 'rgba(190,228,240,.6)', 1, 3);
      }
    }
    if (sc.link) {
      const [x0, y0] = a(sc.link.from), [x1, y1] = a(sc.link.to);
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4)), sh = Math.floor(now / 160) % 2;
      for (let k = sh; k <= n; k += 2) {
        const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
        px(ctx, x - 1, y - 1, '#1d3b48', 3, 3); px(ctx, x, y, '#c4ecfa');
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
        px(ctx, p[0], p[1], (k + Math.floor(now / 70)) % 7 < 2 ? '#c4ecfa' : '#5ec6ee', 2, 2);
      }
    }
    if (sc.drop) { const [x, y] = a(sc.drop); drop(ctx, x, y); }
    if (sc.car) {
      // you-are-here dot with a pulse
      const [x, y] = a(sc.car);
      ring(ctx, x, y, 3 + Math.floor((now % 1200) / 150), '242,210,122', (now % 1200) / 1200);
      px(ctx, x - 2, y - 3, '#1a1712', 5, 7); px(ctx, x - 3, y - 2, '#1a1712', 7, 5);
      px(ctx, x - 1, y - 2, '#f2d27a', 3, 5); px(ctx, x - 2, y - 1, '#f2d27a', 5, 3); px(ctx, x - 1, y - 1, '#fff6d8');
    }
    for (const pin of sc.pins ?? []) this.pin(a(pin.at), pin.n, !!pin.active, now, pin.color);
    if (sc.ending) this.ending(sc.ending, a);
  }

  private pin([x, y]: XY, n: number, active: boolean, now: number, color = '#ee7a63'): void {
    const c = this.ctx;
    const bob = active ? (Math.floor(now / 250) % 2) : 0;
    const top = y - 13 - bob;
    px(c, x - 4, top - 1, '#1a1712', 9, 10); px(c, x - 3, top, active ? '#ffe08a' : color, 7, 8);
    px(c, x - 1, top + 9, '#1a1712', 3, 2); px(c, x, top + 11, '#1a1712', 1, 1);
    const d = DIGITS[n % 10];
    for (let k = 0; k < 15; k++) if (d[k] === '1') px(c, x - 1 + (k % 3), top + 1 + Math.floor(k / 3) + 1, '#1a1712');
  }

  private ending(e: Ending, a: (p: XY) => XY): void {
    const c = this.ctx, [x, y] = a(e.at);
    if (e.kind === 'salmon') {
      const fish = this.sprites.img.salmon2;
      const t = Math.min(1, e.t / .8);
      const st = Math.floor(t * 12) / 12;
      const jy = -Math.round(Math.sin(Math.PI * st) * 20), jx = Math.round((st - .5) * 18);
      if (t < 1 && fish?.width) c.drawImage(fish, x - (fish.width >> 1) + jx, y - fish.height + 6 + jy);
      if (e.t < .3) splash(c, x - 9, y, e.t / .3);
      if (e.t > .7 && e.t < 1.05) splash(c, x + 9, y, (e.t - .7) / .35);
      for (let q = 0; q < 3; q++) { const tt = e.t - .75 - q * .22; if (tt > 0 && tt < 1) ring(c, x + 9, y + 1, 3 + Math.round(tt * 10), '196,236,250', tt); }
    } else if (e.kind === 'ripple') {
      for (let q = 0; q < 3; q++) { const tt = (e.t % 1.6) - q * .28; if (tt > 0 && tt < 1) ring(c, x, y, 2 + Math.round(tt * 11), '196,236,250', tt); }
    } else if (e.kind === 'soak') {
      // water spreading into the soil, thinning out as it goes
      const r = 2 + e.t * 10, keep = (1 - e.t) * 64;
      for (let j = -Math.ceil(r); j <= r; j++) for (let i = -Math.ceil(r); i <= r; i++) {
        const d = Math.hypot(i, j * 1.3);
        if (d <= r && BAYER[((y + j) & 7) * 8 + ((x + i) & 7)] < keep * (1 - d / (r + 1))) px(c, x + i, y + j, d < r * .5 ? '#5ec6ee' : '#3c8fae');
      }
    } else {
      // the map stops: a broken-pipe marker
      px(c, x - 4, y - 4, '#1a1712', 9, 9);
      for (let k = -3; k <= 3; k++) { px(c, x + k, y + k, '#ee7a63'); px(c, x + k, y - k, '#ee7a63'); }
    }
  }
}

function px(c: CanvasRenderingContext2D, x: number, y: number, col: string, w = 1, h = 1): void {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
}

function line(c: CanvasRenderingContext2D, p: XY, q: XY, col: string, w = 1): void {
  let [x0, y0] = p;
  const [x1, y1] = q;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy, guard = 0;
  c.fillStyle = col;
  for (;;) {
    c.fillRect(x0 - (w >> 1), y0 - (w >> 1), w, w);
    if ((x0 === x1 && y0 === y1) || ++guard > 4000) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
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

function poly(c: CanvasRenderingContext2D, pts: XY[], col: string): void {
  for (let k = 0; k < pts.length; k++) line(c, pts[k], pts[(k + 1) % pts.length], col, 1);
}

function fillArt(w: Uint32Array | Uint8Array, AW: number, AH: number, ring: XY[], col: number): void {
  const ys = ring.map((p) => p[1]);
  for (let y = Math.max(0, Math.min(...ys)); y <= Math.min(AH - 1, Math.max(...ys)); y++) {
    const xs: number[] = [];
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
      const [x1, y1] = ring[k], [x2, y2] = ring[j];
      if ((y1 > y + .5) !== (y2 > y + .5)) xs.push(x1 + ((y + .5 - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - .5)); x <= Math.min(AW - 1, xs[k + 1] - .5); x++) w[y * AW + x] = col;
  }
}

// pixel ring, alpha stepped in quarters like hand-drawn frames
function ring(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: string, t: number): void {
  const al = Math.ceil((1 - t) * 4) / 4;
  if (al <= 0) return;
  c.fillStyle = `rgba(${rgb},${al})`;
  let x = r, y = 0, e = 1 - r;
  while (x >= y) {
    for (const [p, q] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) c.fillRect(cx + p, cy + Math.round(q * .7), 1, 1);
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
