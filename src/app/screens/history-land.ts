// My drives scenery: the sky by the Washington clock and the NWS forecast, Mount Rainier, the foothills and a fir hill
// with a few houses. Painted once in art pixels on small canvases; the road layers them with a little parallax.
import type { Light, Weather } from './history-week.ts';

export interface Pal {
  /** sky bands, top down */
  sky: string[];
  star: string | null;
  /** cloud light and shade */
  cloud: [string, string];
  /** the mountain: multiplied by this, then this much haze of the low sky */
  mtn: [string, number];
  /** foothills: far and nearer */
  far: [string, string];
  /** the fir hill: ground, then fir dark, mid and light */
  hill: string;
  fir: [string, string, string];
  /** house wall, roof, lit window (null: lights off) */
  house: [string, string, string | null];
  /** near ground: top, body, deep; grass lip */
  ground: [string, string, string];
  grass: string;
  /** road: asphalt, edge line, center dashes, rail */
  road: [string, string, string, string];
  /** the strip at the foot, under the day names */
  foot: string;
  sun: string | null;
  lamps: boolean;
}

const BASE: Record<Light, Pal> = {
  night: {
    sky: ['#060912', '#080c18', '#0a101e', '#0d1426', '#10192e', '#141f37'], star: '#c9d3f2',
    cloud: ['#1c2538', '#141b2a'], mtn: ['#4f5f86', 0.25], far: ['#121a2a', '#0f1722'],
    hill: '#0d1714', fir: ['#08110e', '#0d1a15', '#15281f'], house: ['#151c1d', '#0b0f10', '#ffcf6b'],
    ground: ['#18291f', '#132219', '#0e1912'], grass: '#24402d', road: ['#23292a', '#7c8681', '#b8923f', '#4a534e'], foot: '#070b09', sun: null, lamps: true,
  },
  dusk: {
    sky: ['#221c36', '#352643', '#55324f', '#7f445a', '#ad5b5e', '#d37d5f'], star: null,
    cloud: ['#d88c78', '#8a5568'], mtn: ['#e3a0a8', 0.2], far: ['#4b3650', '#382a40'],
    hill: '#231f2b', fir: ['#16141d', '#201d29', '#332c3c'], house: ['#2b2732', '#1a1720', '#ffcf6b'],
    ground: ['#232b26', '#1b221e', '#141a17'], grass: '#37463a', road: ['#2e3033', '#b9aaa4', '#c9a14a', '#5e5660'], foot: '#090b0a', sun: '#ffd08a', lamps: true,
  },
  morning: {
    sky: ['#2b456b', '#46628a', '#7383a3', '#a693a5', '#d6a79b', '#ecc39f'], star: null,
    cloud: ['#f2d6c6', '#a493aa'], mtn: ['#f4c6b4', 0.12], far: ['#566684', '#3f4f66'],
    hill: '#283840', fir: ['#18252a', '#223535', '#334c47'], house: ['#3a4448', '#252d31', null],
    ground: ['#283a2c', '#203024', '#18251c'], grass: '#46643f', road: ['#34393a', '#c9cdc6', '#c9a14a', '#646d68'], foot: '#0a0d0b', sun: '#ffe2a8', lamps: false,
  },
  day: {
    sky: ['#4f6878', '#5c7484', '#6a808e', '#798c98', '#8898a2', '#97a5ad'], star: null,
    cloud: ['#c3cbcf', '#8b989f'], mtn: ['#c9d3d8', 0.1], far: ['#566c78', '#435966'],
    hill: '#2c4038', fir: ['#1a2b23', '#253b2f', '#365441'], house: ['#4a5450', '#2e3633', null],
    ground: ['#2b4431', '#223828', '#1a2d20'], grass: '#4a6e4b', road: ['#373d3c', '#cfd5d0', '#c9a14a', '#6a736e'], foot: '#0a0d0b', sun: null, lamps: false,
  },
};

/** clear days: a bluer sky and a sun */
const CLEAR_DAY: Partial<Pal> = {
  sky: ['#2c5e8c', '#376b98', '#4479a4', '#5487b0', '#6896bb', '#7fa6c6'], cloud: ['#e6ecef', '#a6b7c4'], mtn: ['#ffffff', 0.06], sun: '#fff1c4',
};
/** rain: a low gray lid, no stars or sun */
const RAIN_SKY: Record<Light, Partial<Pal>> = {
  night: { sky: ['#0b0f15', '#0d121a', '#10161f', '#131a24', '#161e29', '#1a222d'], cloud: ['#1f2731', '#161c24'], star: null },
  dusk: { sky: ['#272630', '#2e2c37', '#35323e', '#3d3945', '#46404b', '#4f4751'], cloud: ['#544b56', '#3b3540'], sun: null },
  morning: { sky: ['#323b46', '#39434e', '#414b56', '#49535d', '#525b64', '#5b636b'], cloud: ['#626a72', '#454d55'], sun: null },
  day: { sky: ['#3a454d', '#414c54', '#49545b', '#515c63', '#5a646a', '#636c72'], cloud: ['#69737a', '#4b555c'], sun: null },
};

export function palOf(light: Light, weather: Weather): Pal {
  const p = { ...BASE[light] };
  if (weather === 'clear' && light === 'day') Object.assign(p, CLEAR_DAY);
  if (weather === 'rain') Object.assign(p, RAIN_SKY[light]);
  if (weather !== 'clear' && light !== 'night') p.sun = null;
  if (weather === 'cloudy' && light === 'night') p.star = '#7d88a8';
  return p;
}

// ---------- small tools ----------

export function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** A repeatable random from a seed. */
export function rnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A smooth wobble for ridges: a few sines from a seed. */
function wobble(seed: number, amp: number, scale: number): (x: number) => number {
  const r = rnd(seed), ws = [0, 1, 2].map(() => [r() * 6.28, 0.6 + r() * 0.8] as const);
  return (x) => (Math.sin(x / scale + ws[0][0]) * ws[0][1] + Math.sin(x / (scale * 0.43) + ws[1][0]) * ws[1][1] * 0.5 + Math.sin(x / (scale * 0.17) + ws[2][0]) * ws[2][1] * 0.22) * amp;
}

const BAYER = [0, 2, 3, 1];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const hexRgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const px = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

/** A pixel fir: tiers that step back, lit on the left. */
export function fir(g: CanvasRenderingContext2D, x: number, base: number, h: number, c: readonly [string, string, string]): void {
  const rows = h - 1, maxHw = Math.max(1, Math.round(h * 0.27)), tier = h > 12 ? 4 : 3;
  for (let r = 0; r < rows; r++) {
    const grow = (r + 1) / rows, phase = (r % tier) / tier;
    const hw = Math.max(r < 1 ? 0 : 1, Math.round(maxHw * grow * (0.62 + 0.38 * phase)));
    const y = base - rows + r;
    px(g, x - hw, y, hw * 2 + 1, 1, c[1]);
    px(g, x + 1, y, hw, 1, c[0]);
    if (hw > 0) px(g, x - hw, y, Math.max(1, Math.round(hw * 0.5)), 1, c[2]);
  }
  px(g, x, base - 1, 1, 1, c[0]);
}

/** A small house, side on: wall, roof, a window lit at night. */
function house(g: CanvasRenderingContext2D, x: number, base: number, s: number, p: Pal): void {
  const w = 7 * s, h = 4 * s;
  px(g, x, base - h, w, h, p.house[0]);
  for (let r = 0; r < 3 * s; r++) px(g, x - s + r, base - h - 3 * s + r, w + 2 * s - 2 * r, 1, p.house[1]);
  if (p.house[2]) {
    px(g, x + s, base - h + s, s * 2, s * 2 - (s > 1 ? 1 : 0), p.house[2]);
    px(g, x + 4 * s, base - h + s, s * 2, s * 2 - (s > 1 ? 1 : 0), p.house[2]);
  }
}

// ---------- the moon (night, its real phase) ----------

/** 0 new, 0.5 full, from the mean synodic month after the new moon of Jan 6 2000, 18:14 UTC. */
export const moonPhase = (now: number): number => (((now - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000 / 29.530588853) % 1 + 1) % 1;

function moon(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, phase: number, lit: string, dark: string): void {
  // the terminator: x/r against cos of the phase; waxing lights the right side
  const k = Math.cos(phase * 2 * Math.PI);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r + r * 0.6) continue;
      const half = Math.sqrt(Math.max(0, r * r - y * y)), t = half ? x / half : 0;
      const on = phase < 0.5 ? t > k : t < -k;
      px(g, cx + x, cy + y, 1, 1, on ? lit : dark);
    }
  }
}

// ---------- clouds ----------

export interface Cloud { img: HTMLCanvasElement; x: number; y: number; v: number }

function cloudImg(r: () => number, w: number, h: number, c: readonly [string, string]): HTMLCanvasElement {
  const cv = canvas(w, h), g = cv.getContext('2d')!;
  // wide, flat-bottomed puffs: a taller one in the middle, lower ones out to the ends
  const blobs: [number, number, number, number][] = [];
  const n = 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), tall = 1 - Math.abs(t - 0.45) * 1.3;
    const ry = Math.max(2, h * (0.35 + 0.55 * tall) * (0.8 + r() * 0.3)), rx = ry * (1.3 + r() * 0.5);
    blobs.push([w * (0.1 + 0.8 * t) + (r() - 0.5) * 3, h - 1, rx, ry]);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = blobs.some(([bx, by, rx, ry]) => ((x - bx) / rx) ** 2 + ((y - by) / ry) ** 2 <= 1);
    if (!inside) continue;
    // lit on top, shaded along the flat base
    px(g, x, y, 1, 1, y >= h - Math.max(2, Math.round(h * 0.28)) ? c[1] : c[0]);
  }
  return cv;
}

// ---------- the land ----------

export interface Land {
  sky: HTMLCanvasElement;
  /** the foothills and the fir hill, wider than the view by pad for the parallax */
  far: HTMLCanvasElement;
  mid: HTMLCanvasElement;
  clouds: Cloud[];
  /** stars that twinkle: x, y */
  twinkle: [number, number][];
  pad: number;
  pal: Pal;
}

export interface LandIn {
  w: number;
  h: number;
  /** where the fir hill meets the foothills, art px */
  horizon: number;
  light: Light;
  weather: Weather;
  now: number;
  /** the PixelLab mountain, or null while loading */
  mountain: HTMLImageElement | null;
  /** 1 on phones, 2 on a laptop: fir and house sizes */
  scale: number;
}

/** Paints the sky, the mountain in it, the foothills and the fir hill. */
export function paintLand(o: LandIn): Land {
  const { w, h, horizon, light, weather } = o, p = palOf(light, weather), pad = 16, r = rnd(4242);
  // the sky: bands with a dithered seam
  const sky = canvas(w, h), g = sky.getContext('2d')!;
  const top = Math.max(8, horizon + 6), bh = top / p.sky.length, rgb = p.sky.map(hexRgb);
  const img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const t = y / bh, b = Math.min(p.sky.length - 1, Math.floor(t)), f = t - b;
    // the lower half of each band dithers into the next, 4 by 4
    for (let x = 0; x < w; x++) {
      const next = b + 1 < p.sky.length && f > 0.5 && BAYER4[(x % 4) + (y % 4) * 4] < (f - 0.5) * 32;
      const c = rgb[next ? b + 1 : b], i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const twinkle: [number, number][] = [];
  if (p.star) {
    for (let i = 0, n = Math.round((w * horizon) / 260); i < n; i++) {
      const x = Math.floor(r() * w), y = Math.floor(r() * horizon * 0.85);
      px(g, x, y, 1, 1, r() > 0.75 ? p.star : p.sky[1]);
      if (r() > 0.8) twinkle.push([x, y]);
    }
  }
  if (light === 'night' && weather !== 'rain') moon(g, Math.round(w * 0.16), Math.round(horizon * 0.3), 5 + o.scale, moonPhase(o.now), '#e9e6d4', '#1a2133');
  if (p.sun) {
    const sx = light === 'dusk' ? Math.round(w * 0.2) : light === 'morning' ? Math.round(w * 0.14) : Math.round(w * 0.12);
    const sy = light === 'day' ? Math.round(horizon * 0.22) : horizon - 10;
    // a disc with a soft ring of light around it
    g.globalAlpha = 0.25;
    for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) if (x * x + y * y <= 60) px(g, sx + x, sy + y, 1, 1, p.sun);
    g.globalAlpha = 1;
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) if (x * x + y * y <= 22) px(g, sx + x, sy + y, 1, 1, p.sun);
  }
  // Mount Rainier, out unless it rains
  if (o.mountain && weather !== 'rain') {
    const m = o.mountain, mw = m.naturalWidth, mh = m.naturalHeight;
    const t = canvas(mw, mh), tg = t.getContext('2d')!;
    tg.drawImage(m, 0, 0);
    tg.globalCompositeOperation = 'multiply';
    px(tg, 0, 0, mw, mh, p.mtn[0]);
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(m, 0, 0);
    tg.globalCompositeOperation = 'source-atop';
    tg.globalAlpha = p.mtn[1] + (light === 'night' ? 0.3 : 0.12);
    px(tg, 0, 0, mw, mh, p.sky[p.sky.length - 1]);
    tg.globalAlpha = 1;
    // set down behind the hills, its summit clear of the top
    const mx = Math.round(w * 0.64 - mw / 2), my = Math.max(4, horizon + 10 - mh);
    g.drawImage(t, mx, my);
  }
  // the foothills: two hazy ridges with tiny firs
  const far = canvas(w + pad, h), fg = far.getContext('2d')!, rf = rnd(77);
  const ridges: [number, string, number][] = [[horizon - 12, p.far[0], 3], [horizon - 4, p.far[1], 5]];
  for (const [base, c, tall] of ridges) {
    const wb = wobble(base * 7, 5, 46);
    for (let x = 0; x < w + pad; x++) {
      const y = Math.round(base + wb(x));
      px(fg, x, y, 1, h - y, c);
      if (rf() > 0.55) {
        const th = 2 + Math.floor(rf() * tall);
        px(fg, x, y - th, 1, th, c);
        if (th > 3) px(fg, x - 1, y - th + 2, 3, th - 2, c);
      }
    }
  }
  // the fir hill, with houses whose windows light up after dark
  const mid = canvas(w + pad, h), mg = mid.getContext('2d')!, rm = rnd(913), wm = wobble(31, 6, 60);
  const ridgeY = (x: number) => Math.round(horizon + 6 + wm(x));
  for (let x = 0; x < w + pad; x++) px(mg, x, ridgeY(x), 1, h - ridgeY(x), p.hill);
  const s = o.scale, homes = [0.08, 0.47, 0.83].map((f) => Math.round((w + pad) * f + (rm() - 0.5) * 30));
  for (let x = -6; x < w + pad + 6; x += 2 + Math.floor(rm() * 4)) {
    if (homes.some((hx) => x > hx - 6 && x < hx + 16)) continue;
    const big = rm();
    const fh = Math.round((big > 0.85 ? 22 : big > 0.45 ? 16 : 11) * (0.8 + rm() * 0.35) * (s > 1 ? 0.85 : 1));
    fir(mg, x, ridgeY(x) + 3 + Math.floor(rm() * 3), fh, p.fir);
  }
  for (const hx of homes) house(mg, hx, ridgeY(hx + 4) + 2, 1, p);
  // clouds: a few on a dry day, a lid in the rain
  const clouds: Cloud[] = [], rc = rnd(5);
  const n = weather === 'rain' ? Math.round(w / 34) : weather === 'cloudy' ? Math.round(w / 70) : Math.round(w / 140);
  for (let i = 0; i < n; i++) {
    const big = weather === 'rain' ? 1.4 : 1, cw = Math.round((26 + rc() * 34) * big), ch = Math.round((8 + rc() * 7) * big);
    const y = weather === 'rain' ? Math.round(rc() * horizon * 0.35) - 3 : Math.round(6 + rc() * horizon * 0.5);
    clouds.push({ img: cloudImg(rc, cw, ch, p.cloud), x: Math.round(rc() * (w + 60)) - 30, y, v: 0.35 + rc() * 0.6 });
  }
  // cloudy: a band across the mountain's middle
  if (weather === 'cloudy' && o.mountain) {
    for (let i = 0; i < 3; i++) {
      clouds.push({ img: cloudImg(rc, 40 + Math.round(rc() * 24), 9, p.cloud), x: Math.round(w * (0.42 + i * 0.16)), y: horizon - 52 + Math.round(rc() * 10), v: 0.2 });
    }
  }
  return { sky, far, mid, clouds, twinkle, pad, pal: p };
}

/**
 * The near ground under the road: grass at the lip, a slope of dithered bands with shrubs and stones, then a lower
 * ridge of firs in front, so the ground has depth. top(x): the ground's top.
 */
export function paintGround(g: CanvasRenderingContext2D, w: number, foot: number, top: (x: number) => number, p: Pal, seed: number, scale: number): void {
  const r = rnd(seed), front = wobble(seed * 3 + 1, 4, 38);
  const ridge = (x: number) => Math.max(top(x) + 10, Math.round(foot - 16 + front(x)));
  for (let x = 0; x < w; x++) {
    const y0 = top(x), span = foot - y0;
    if (span <= 0) continue;
    px(g, x, y0, 1, span, p.ground[0]);
    px(g, x, y0, 1, 2, p.grass);
    // bands down the slope, each darker, with a dithered seam
    for (const [f, c] of [[0.3, p.ground[1]], [0.62, p.ground[2]]] as const) {
      const seam = y0 + 2 + Math.round(span * f);
      for (let y = seam; y < foot; y++) if (y > seam + 3 || BAYER[(x % 2) + (y % 2) * 2] < y - seam) px(g, x, y, 1, 1, c);
    }
    const k = r();
    if (k > 0.93) px(g, x, y0 - 1, 1, 1 + Math.floor(r() * 2), p.grass);
    if (k < 0.035 && span > 14) { const sy = y0 + 5 + Math.floor(r() * (span - 10)); px(g, x, sy, 3, 1, p.grass); px(g, x - 1, sy + 1, 5, 1, p.fir[1]); px(g, x, sy + 2, 3, 1, p.fir[0]); }
    if (k > 0.5 && k < 0.52 && span > 8) { const sy = y0 + 4 + Math.floor(r() * (span - 6)); px(g, x, sy, 2, 1, p.road[3]); px(g, x, sy + 1, 2, 1, p.fir[0]); }
  }
  // the lower ridge in front: darker, with fir tops
  for (let x = 0; x < w; x++) { const y = ridge(x); if (y < foot) px(g, x, y, 1, foot - y, p.fir[0]); }
  for (let x = -4; x < w + 4; x += 5 + Math.floor(r() * 8)) {
    const y = ridge(Math.max(0, Math.min(w - 1, x)));
    if (y >= foot - 2) continue;
    const fh = Math.round((9 + r() * 9) * (scale > 1 ? 0.8 : 1));
    fir(g, x, y + 3, fh, [p.fir[0], p.fir[0], p.fir[1]]);
  }
}
