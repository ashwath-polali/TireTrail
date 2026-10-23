// My drives art: the creek scene with a coho for each gentle crossing, a drive's route as a little map, and the spot's map.
import type { LngLat } from '../../geo/geo.ts';
import { speciesSVG } from '../../salmon/species.ts';
import { calm, glyph } from '../ui/ui.ts';
import { COHO, fishRoom, run, SPARKLE, WATER } from './pixel-anim.ts';

/** the PixelLab creek scene and where its water is, as parts of its height */
export const SCENE = { src: 'art/drives/creek-scene.png', w: 360, h: 200, water: [0.79, 0.96] as [number, number] };
/** the scene as art pixels tall; wider boxes show more of it */
const ART_H = SCENE.h;

function image(src: string): { img: HTMLImageElement | null; ok: () => boolean; ready: Promise<boolean> } {
  if (typeof Image === 'undefined') return { img: null, ok: () => false, ready: Promise.resolve(false) };
  const img = new Image();
  let ok = false;
  const ready = new Promise<boolean>((done) => {
    img.onload = () => { ok = true; done(true); };
    img.onerror = () => done(false);
  });
  img.src = src;
  return { img, ok: () => ok, ready };
}

let scene: ReturnType<typeof image> | null = null;
let fir: ReturnType<typeof image> | null = null;
const sceneImg = () => (scene ??= image(SCENE.src));
const firImg = () => (fir ??= image('art/anim/fir.png'));

/** The scene's picture is in (or failed). */
export const sceneReady = (): Promise<boolean> => sceneImg().ready;

/** Until the picture loads: a bank of firs, the creek, stones in front. */
function drawStandIn(g: CanvasRenderingContext2D, W: number, H: number, t: number): void {
  const [a, b] = SCENE.water, wy = Math.round(H * a) - 8, wb = Math.round(H * b);
  g.fillStyle = '#16211b';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1f2c25';
  g.fillRect(0, Math.round(H * 0.42), W, wy - Math.round(H * 0.42));
  const f = firImg();
  if (f.ok() && f.img) for (let x = -8, k = 0; x < W; x += 22, k++) g.drawImage(f.img, x, Math.round(H * 0.42) - 26 + ((k * 7) % 3) * 4 - (k % 2 ? 10 : 0));
  const drift = Math.floor(t / 166) % WATER.w, wf = Math.floor(t / (1000 / WATER.fps));
  for (let y = wy; y < wb; y += WATER.h) for (let x = -drift; x < W; x += WATER.w) WATER.draw(g, wf, x, y);
  g.fillStyle = '#26332b';
  g.fillRect(0, wb, W, H - wb);
  for (let x = 2; x < W; x += 9) {
    g.fillStyle = (x * 7) % 3 ? '#44534a' : '#6b766c';
    g.fillRect(x, wb + ((x * 5) % 6), 5, 3);
  }
}

export interface SceneOpts {
  /** coho to show (one per gentle crossing); more than fit show as many as fit */
  fish: number;
  /** the sample, signed out: the fish are faint */
  dim?: boolean;
}

/** Draws the scene at art pixels: the picture, cut to fit W x H from its middle, and the coho swimming upstream. t: ms since it began; still: the fish at rest. */
export function drawScene(g: CanvasRenderingContext2D, W: number, H: number, o: SceneOpts, t: number, still: boolean): void {
  g.imageSmoothingEnabled = false;
  const s = sceneImg();
  if (s.ok() && s.img) {
    // cover: as wide as the box, the bottom kept (the water)
    const k = Math.max(W / SCENE.w, H / SCENE.h), dw = Math.round(SCENE.w * k), dh = Math.round(SCENE.h * k);
    g.drawImage(s.img, Math.round((W - dw) / 2), H - dh, dw, dh);
  } else drawStandIn(g, W, H, still ? 0 : t);
  const [a, b] = SCENE.water, top = Math.round(H * a) - 6, bottom = Math.round(H * b) - 26;
  const lanes = 3, per = fishRoom(W, COHO.w), n = Math.min(o.fish, 12, per * lanes);
  if (o.dim) g.globalAlpha = 0.5;
  for (let i = 0; i < n; i++) {
    // spread evenly, stepping through three rows so neighbors never line up; each fish its own speed
    const lane = [1, 0, 2][i % lanes], y = Math.round(top + ((bottom - top) * lane) / (lanes - 1));
    const home = ((i + 0.5) / n) * W - COHO.w / 2, born = i * 140;
    if (!still && t < born) continue;
    const age = still ? 1e9 : t - born, ease = still ? 1 : Math.min(1, age / 700);
    let x = still ? home : -COHO.w + (home + COHO.w) * (1 - (1 - ease) ** 3) + Math.max(0, age - 700) * (0.004 + (i % 3) * 0.0015);
    const span = W + COHO.w;
    x = (((x + COHO.w) % span) + span) % span - COHO.w;
    const bob = still ? 0 : Math.floor(age / 650 + i) % 2;
    COHO.draw(g, still ? 0 : age / (1000 / COHO.fps) + i * 3, Math.round(x), y + bob);
    if (!still && age < 520) SPARKLE.draw(g, age / 130, Math.round(x) + COHO.w - 18, y + 6);
  }
  g.globalAlpha = 1;
}

/** The hero: the scene filling its box, drawn at 12 frames a second while on screen. Calm: everything still. */
export function creekScene(o: SceneOpts, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'my-scene';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label);
  c.width = SCENE.w;
  c.height = ART_H;
  let t0 = 0;
  const paint = (now: number, still: boolean) => {
    const g = c.getContext('2d');
    if (!g || !c.clientHeight) return;
    // art pixels: the height stays the picture's, the width follows the box
    const W = Math.max(160, Math.round((c.clientWidth / c.clientHeight) * ART_H));
    if (c.width !== W) c.width = W;
    if (c.height !== ART_H) c.height = ART_H;
    drawScene(g, W, ART_H, o, now - t0, still);
  };
  if (calm()) {
    const still = () => paint(0, true);
    requestAnimationFrame(still);
    void sceneImg().ready.then(still);
    void firImg().ready.then(still);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (c.isConnected) still(); }).observe(c);
    return c;
  }
  run(c, 12, (now) => { if (!t0) t0 = now; paint(now, false); });
  return c;
}

// ---------- species ----------

/** PixelLab portraits by species bit; the code fish stands in until one loads */
const PORTRAIT: Record<number, string> = { 1: 'coho', 2: 'chinook', 4: 'chum', 8: 'pink', 16: 'sockeye', 32: 'steelhead' };

/** A species' portrait: the PixelLab fish, over the small code fish until it loads. */
export function portrait(bit: number, cls = 'my-fish'): HTMLElement {
  const box = document.createElement('span');
  box.className = cls;
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = speciesSVG(bit, 3);
  const name = PORTRAIT[bit];
  if (name && typeof Image !== 'undefined') {
    const img = new Image();
    img.alt = '';
    img.width = 96;
    img.height = 48;
    img.draggable = false;
    img.onload = () => box.replaceChildren(img);
    img.src = `art/drives/fish-${name}.png`;
  }
  return box;
}

// ---------- little maps ----------

const K = Math.PI / 180;

/** Points to SVG px: north up, the same scale both ways, centered with pad. */
function fit(groups: readonly (readonly LngLat[])[], w: number, h: number, pad: number, around?: { at: LngLat; m: number }): ((p: LngLat) => [number, number]) | null {
  const all = groups.flat();
  if (!all.length && !around) return null;
  const lat0 = (around?.at ?? all[0])[1], kx = Math.cos(lat0 * K) * 111_320, ky = 110_540;
  const xy = (p: LngLat): [number, number] => [p[0] * kx, -p[1] * ky];
  let x0: number, x1: number, y0: number, y1: number;
  if (around) {
    const [cx, cy] = xy(around.at);
    [x0, x1, y0, y1] = [cx - around.m, cx + around.m, cy - around.m * (h / w), cy + around.m * (h / w)];
  } else {
    const ps = all.map(xy), xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  }
  const s = Math.min((w - 2 * pad) / Math.max(x1 - x0, 60), (h - 2 * pad) / Math.max(y1 - y0, 60)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // whole pixels, on a 2 px grid, so lines stay crisp
  return (p) => { const [x, y] = xy(p); return [Math.round((w / 2 + (x - cx) * s) / 2) * 2, Math.round((h / 2 + (y - cy) * s) / 2) * 2]; };
}

let ids = 0;
/** the dot grid under a little map, with an id of its own */
const dots = (w: number, h: number) => { const id = `my-dots-${++ids}`; return `<defs><pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#18231d"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`; };

const poly = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');

/** Fewer points: drops ones closer than 3 px to the last kept. */
function thin(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 3) out.push(p); }
  return out;
}

/** A drive's route as a small pixel map: the road in amber, where it began, and a square at each creek (green gentle, amber not). */
export function routeThumb(path: readonly LngLat[], creeks: readonly { ll: LngLat; gentle: boolean }[], w = 120, h = 80): string {
  const to = fit([path], w, h, 10);
  if (!to || path.length < 2) return `<svg class="my-thumb" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${dots(w, h)}</svg>`;
  const line = thin(path.map(to)), [sx, sy] = line[0];
  const marks = creeks.map((c) => { const [x, y] = to(c.ll); return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="${c.gentle ? '#8fe38a' : '#ffb547'}" stroke="#0b0f0d" stroke-width="2"/>`; }).join('');
  return `<svg class="my-thumb" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" shape-rendering="crispEdges">${dots(w, h)}`
    + `<path d="${poly(line)}" fill="none" stroke="#0b0f0d" stroke-width="8" stroke-linejoin="miter" stroke-linecap="square"/>`
    + `<path d="${poly(line)}" fill="none" stroke="#ffd166" stroke-width="4" stroke-linejoin="miter" stroke-linecap="square"/>`
    + `<rect x="${sx - 3}" y="${sy - 3}" width="6" height="6" fill="#eef3ef"/>${marks}</svg>`;
}

/** The spot's little map: your drives through it in gray, creeks near it, and its bell in the middle. */
export function spotThumb(at: LngLat, paths: readonly (readonly LngLat[])[], creeks: readonly { ll: LngLat; gentle: boolean }[], w = 120, h = 88): string {
  const m = 420, to = fit([], w, h, 0, { at, m })!;
  const inBox = (p: [number, number]) => p[0] > -20 && p[0] < w + 20 && p[1] > -20 && p[1] < h + 20;
  const roads = paths.map((p) => thin(p.map(to))).filter((l) => l.some(inBox));
  const near = creeks.map((c) => to(c.ll)).filter((p) => p[0] > 4 && p[0] < w - 4 && p[1] > 4 && p[1] < h - 4);
  const [cx, cy] = to(at);
  return `<svg class="my-thumb" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" shape-rendering="crispEdges">`
    + dots(w, h)
    + roads.map((l) => `<path d="${poly(l)}" fill="none" stroke="#44534a" stroke-width="4" stroke-linejoin="miter" stroke-linecap="square"/>`).join('')
    + near.map(([x, y]) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#7fd8c0" stroke="#0b0f0d" stroke-width="2"/>`).join('')
    + `<rect x="${cx - 13}" y="${cy - 13}" width="26" height="26" fill="#ffb547" stroke="#0b0f0d" stroke-width="2"/>`
    + `<g transform="translate(${cx - 9} ${cy - 9})" color="#1c1504">${glyph('bell', 2).replace('<svg', '<svg x="0" y="0"')}</g></svg>`;
}
