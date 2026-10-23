// Small pixel animations: a creek with coho swimming upstream. Sprite sheets in public/art/anim (PixelLab),
// each with a code-drawn fallback that draws until the sheet loads (or if it never does).
import { calm } from '../ui/ui.ts';

/** Frames of one animation, drawn at art pixels (1 = one canvas pixel). */
export interface Sprite {
  w: number;
  h: number;
  /** frames */
  n: number;
  fps: number;
  draw(g: CanvasRenderingContext2D, frame: number, x: number, y: number): void;
}

const wrapFrame = (f: number, n: number) => ((Math.floor(f) % n) + n) % n;

/** A sprite from bitmaps: one string row per pixel row, colors by character. */
export function codeSprite(frames: readonly (readonly string[])[], colors: Record<string, string>, fps = 8): Sprite {
  const w = Math.max(...frames.flat().map((r) => r.length)), h = Math.max(...frames.map((f) => f.length));
  return {
    w, h, n: frames.length, fps,
    draw(g, frame, x, y) {
      const rows = frames[wrapFrame(frame, frames.length)];
      for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) {
        const c = colors[rows[j][i]];
        if (c) { g.fillStyle = c; g.fillRect(x + i, y + j, 1, 1); }
      }
    },
  };
}

/**
 * A sprite from a horizontal sheet (frames left to right). flip mirrors it left to right.
 * Until the sheet loads, the fallback draws, centered in the frame.
 */
export function sheetSprite(src: string, w: number, h: number, n: number, fps: number, fallback?: Sprite, flip = false): Sprite {
  const img = typeof Image === 'undefined' ? null : new Image();
  let ok = false;
  if (img) { img.onload = () => { ok = true; }; img.src = src; }
  return {
    w, h, n, fps,
    draw(g, frame, x, y) {
      if (!ok || !img) {
        fallback?.draw(g, frame, x + Math.round((w - fallback.w) / 2), y + Math.round((h - fallback.h) / 2));
        return;
      }
      const sx = wrapFrame(frame, n) * w;
      if (!flip) { g.drawImage(img, sx, 0, w, h, x, y, w, h); return; }
      g.save();
      g.translate(x + w, y);
      g.scale(-1, 1);
      g.drawImage(img, sx, 0, w, h, 0, 0, w, h);
      g.restore();
    },
  };
}

// the brand coho (glyphs.ts SALMON), facing right, with its tail flicking
const COHO_ROWS = [[
  '.......GGG......',
  'G....GGGGGGGG...',
  'GG..GRRRRRRGGGG.',
  '.GGGRRRRRRRRGEGG',
  'GG..RRRRRRRRWWW.',
  'G....WWWWWWWW...',
  '.......G..G.....',
], [
  '.......GGG......',
  '.G...GGGGGGGG...',
  '.GG.GRRRRRRGGGG.',
  '..GGRRRRRRRRGEGG',
  '.GG.RRRRRRRRWWW.',
  '.G...WWWWWWWW...',
  '.......G..G.....',
], [
  '.......GGG......',
  '.....GGGGGGGG...',
  'GG..GRRRRRRGGGG.',
  'GGGGRRRRRRRRGEGG',
  '....RRRRRRRRWWW.',
  'GG...WWWWWWWW...',
  '.......G..G.....',
]];
export const CODE_COHO = codeSprite([COHO_ROWS[0], COHO_ROWS[1], COHO_ROWS[0], COHO_ROWS[2]], { G: '#4f9ea3', R: '#e3503f', W: '#f1ece4', E: '#0b0f0d' }, 8);

/** The swimming coho, spawning colors, facing right (upstream). 64x32 frames, the fish about 48x18 in the middle. */
export const COHO: Sprite = sheetSprite('art/anim/salmon-swim.png', 64, 32, 8, 10, CODE_COHO, true);

// a tile of moving water, drawn in code: ripples that line up across tiles
const CODE_WATER: Sprite = {
  w: 128, h: 24, n: 4, fps: 6,
  draw(g, frame, x, y) {
    g.fillStyle = '#2c4a52';
    g.fillRect(x, y, 128, 24);
    g.fillStyle = '#36575f';
    g.fillRect(x, y + 6, 128, 12);
    for (let j = 0; j < 6; j++) {
      g.fillStyle = j === 2 ? '#c8e0e0' : '#5f858a';
      const yy = y + 3 + j * 3 + (j > 2 ? 1 : 0);
      for (let k = 0; k < 4; k++) g.fillRect(x + ((k * 32 + j * 13 + (frame % 4) * 2) % 128), yy, j === 2 ? 3 : 4, 1);
    }
  },
};
/** Creek water, tiling left to right; its frames shimmer in place. */
export const WATER: Sprite = sheetSprite('art/anim/creek-strip.png', 128, 24, 4, 6, CODE_WATER);

/** A little gold sparkle where a fish arrives; its middle pixel is at (7, 7). */
export const SPARKLE: Sprite = sheetSprite('art/anim/sparkle.png', 16, 16, 4, 6, codeSprite([
  ['................', '................', '................', '................', '................', '................', '................', '.......X........'],
  ['................', '................', '................', '................', '................', '................', '.......X........', '......XXX.......', '.......X........'],
  ['................', '................', '................', '................', '.......X........', '.......X........', '.......X........', '....XXXXXXX.....', '.......X........', '.......X........', '.......X........'],
], { X: '#ffd166' }, 12));

/** bank colors */
const BANK = { soil: '#1f2c25', grass: '#2f4a2c', grass2: '#4f7a3a', stone: '#44534a', stone2: '#6b766c' };

/** Fish i of n at rest: spread along the strip, in up to three lanes between top and bottom. fw: the fish's frame width. */
export function fishSlot(i: number, n: number, w: number, top: number, bottom: number, fw = 64): { x: number; y: number } {
  const lanes = bottom - top >= 8 ? [0, 1, 0.5] : [0, 1];
  // frames have clear edges, so a fish may hang over the strip's ends by an eighth of its frame
  const edge = Math.round(fw / 8), x = Math.round((w * (i + 0.5)) / Math.max(n, 1) - fw / 2);
  return { x: Math.min(Math.max(x, -edge), w - fw + edge), y: Math.round(top + Math.max(0, bottom - top) * lanes[i % lanes.length]) };
}

/** How many fish fit side by side in w art pixels; the body is about 3/4 of the frame. */
export const fishRoom = (w: number, fw = 64): number => Math.max(1, Math.floor(w / Math.round(fw * 0.8)));

export interface CreekOpts {
  /** coho to show; more than `most` (or than fit) show as many as fit */
  fish: number;
  most?: number;
  /** CSS px per art pixel */
  scale?: number;
  /** art pixels tall, 26 or more */
  rows?: number;
  label?: string;
}

/**
 * A strip of creek with coho swimming upstream, one arriving after another (150 ms apart, all in by about 1.5 s).
 * Drawn at art pixels and scaled up, 12 frames a second; stops off screen. Calm: the fish rest in place.
 */
export function creekStrip(o: CreekOpts): HTMLCanvasElement {
  const S = o.scale ?? 2, H = Math.max(26, o.rows ?? 34);
  const c = document.createElement('canvas');
  c.className = 'px-creek';
  c.height = H;
  c.width = 160;
  c.style.height = `${H * S}px`;
  c.setAttribute('aria-hidden', 'true');
  if (o.label) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', o.label); c.removeAttribute('aria-hidden'); }
  let g: CanvasRenderingContext2D | null = null, t0 = 0;
  const paint = (now: number, still: boolean) => {
    g ??= c.getContext('2d');
    if (!g) return;
    const W = Math.max(64, Math.ceil(c.clientWidth / S));
    if (c.width !== W) c.width = W;
    g.imageSmoothingEnabled = false;
    const t = still ? 0 : now - t0, wy = Math.round((H - WATER.h) / 2);
    // banks above and below, then the water tiles, drifting downstream (left) a pixel every 2 frames
    g.fillStyle = BANK.soil;
    g.fillRect(0, 0, W, H);
    const wf = still ? 0 : Math.floor(t / (1000 / WATER.fps)), drift = still ? 0 : Math.floor(t / 166) % WATER.w;
    for (let x = -drift; x < W; x += WATER.w) WATER.draw(g, wf, x, wy);
    for (let x = 0; x < W; x += 3) {
      g.fillStyle = (x * 7) % 5 ? BANK.grass : BANK.grass2;
      g.fillRect(x, wy - 1, 2, (x * 13) % 4 ? 1 : 2);
    }
    for (let x = 1; x < W; x += 5) {
      g.fillStyle = (x * 3) % 4 ? BANK.stone : BANK.stone2;
      g.fillRect(x, wy + WATER.h - 1, (x * 11) % 3 ? 2 : 3, 1);
    }
    // the fish: each arrives 150 ms after the one before, then swims upstream slowly and wraps around
    const m = Math.min(o.fish, o.most ?? 8, fishRoom(W, COHO.w)), top = wy - 8, bottom = wy + WATER.h - 24;
    for (let i = 0; i < m; i++) {
      const slot = fishSlot(i, m, W, top, bottom, COHO.w), born = i * 150;
      if (!still && t < born) continue;
      const age = still ? 1e9 : t - born;
      const ease = Math.min(1, age / 600), from = -COHO.w;
      let x = still ? slot.x : from + (slot.x - from) * (1 - (1 - ease) ** 3) + Math.max(0, age - 600) * 0.006;
      const span = W + COHO.w;
      x = (((x + COHO.w) % span) + span) % span - COHO.w;
      const bob = still ? 0 : Math.floor(age / 700 + i) % 2;
      COHO.draw(g, still ? 0 : age / (1000 / COHO.fps) + i * 3, Math.round(x), slot.y + bob);
      if (!still && age < 500) SPARKLE.draw(g, age / 125, Math.round(x) + COHO.w - 18, slot.y + 6);
    }
  };
  if (calm()) {
    requestAnimationFrame(() => paint(0, true));
    onResize(c, () => paint(0, true));
    // the sheets may come after the first paint
    setTimeout(() => paint(0, true), 600);
    return c;
  }
  run(c, 12, (now) => { if (!t0) t0 = now; paint(now, false); });
  return c;
}

/** Redraws a still canvas when its box changes size. */
function onResize(el: HTMLElement, fn: () => void): void {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => { if (el.isConnected) fn(); }).observe(el);
}

/** Draws at fps while el is on the page and on screen; stops for good once it leaves the page. Works inside dialogs too. */
export function run(el: HTMLElement, fps: number, draw: (now: number) => void): void {
  let seen = true, timer = 0, born = false, tries = 0;
  const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => {
    seen = es[es.length - 1].isIntersecting;
    if (seen && !timer) tick();
  });
  const tick = () => {
    timer = 0;
    if (!el.isConnected) {
      // not on the page yet: wait a little; gone from it: stop
      if (!born && tries++ < 30) timer = window.setTimeout(tick, 100);
      else { io?.disconnect(); document.removeEventListener('visibilitychange', wake); }
      return;
    }
    if (!born) { born = true; io?.observe(el); }
    if (document.hidden || !seen) return;
    timer = -1;
    requestAnimationFrame((now) => { draw(now); timer = window.setTimeout(tick, 1000 / fps); });
  };
  const wake = () => { if (!document.hidden && !timer) tick(); };
  document.addEventListener('visibilitychange', wake);
  tick();
}
