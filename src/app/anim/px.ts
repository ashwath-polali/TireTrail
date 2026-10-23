// Pixel art as rows of letters, and frame sets that draw from code now or a sprite sheet later, with the same shape.

export type Pal = Record<string, string>;

/** [width, height] of a picture given as rows */
export const rowsSize = (rows: readonly string[]): [number, number] => [Math.max(0, ...rows.map((r) => r.length)), rows.length];

/** A set of frames, w x h art pixels each. Code-drawn (codeFrames) or a sprite sheet (sheetFrames). */
export interface Frames {
  w: number;
  h: number;
  n: number;
  fps: number;
  /** a detailed sheet, drawn 1 CSS px a pixel; code art is blown up to the scene's scale */
  hi?: boolean;
  /** a sheet's image is in (or failed) */
  ready?: Promise<void>;
  /** draws frame i (wraps) with its top left at x, y; flip faces it the other way */
  draw(ctx: CanvasRenderingContext2D, i: number, x: number, y: number, flip?: boolean): void;
}

/** Its size in CSS px in a scene of k CSS px per art pixel. */
export const sizePx = (f: Frames, k: number): [number, number] => (f.hi ? [f.w, f.h] : [f.w * k, f.h * k]);

/** Draws frame i centered on cx, cy (CSS px, on a canvas 1 CSS px a pixel). */
export function drawPx(ctx: CanvasRenderingContext2D, f: Frames, i: number, cx: number, cy: number, k: number, flip = false): void {
  const [w, hh] = sizePx(f, k), x = Math.round(cx - w / 2), y = Math.round(cy - hh / 2);
  if (f.hi) { f.draw(ctx, i, x, y, flip); return; }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  f.draw(ctx, i, 0, 0, flip);
  ctx.restore();
}

/** The frame to show t ms into a loop. */
export const frameAt = (f: Pick<Frames, 'n' | 'fps'>, t: number): number => Math.floor(Math.max(0, t) / (1000 / f.fps)) % f.n;

function bake(rows: readonly string[], pal: Pal, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  [c.width, c.height] = [w, h];
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

function put(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sx: number, sw: number, sh: number, x: number, y: number, flip: boolean): void {
  x = Math.round(x); y = Math.round(y);
  if (!flip) { ctx.drawImage(src, sx, 0, sw, sh, x, y, sw, sh); return; }
  ctx.save();
  ctx.translate(x + sw, y);
  ctx.scale(-1, 1);
  ctx.drawImage(src, sx, 0, sw, sh, 0, 0, sw, sh);
  ctx.restore();
}

/** Frames from rows of letters; baked to small canvases on first draw. */
export function codeFrames(frames: readonly (readonly string[])[], pal: Pal, fps: number): Frames {
  const [w, h] = rowsSize(frames[0]);
  let baked: HTMLCanvasElement[] | null = null;
  return {
    w, h, n: frames.length, fps,
    draw(ctx, i, x, y, flip = false) {
      baked ??= frames.map((f) => bake(f, pal, w, h));
      put(ctx, baked[((i % baked.length) + baked.length) % baked.length], 0, w, h, x, y, flip);
    },
  };
}

/** Frames from a sprite sheet laid out in one row (a PixelLab sheet: see its .json). left: drawn facing left. */
export function sheetFrames(src: string, w: number, h: number, n: number, fps: number, left = false): Frames {
  // asked for at once, so it's in by the time a reveal draws
  const img = typeof Image === 'undefined' ? null : Object.assign(new Image(), { src });
  const ready = img ? new Promise<void>((ok) => { img.onload = img.onerror = () => ok(); }) : Promise.resolve();
  return {
    w, h, n, fps, hi: true, ready,
    draw(ctx, i, x, y, flip = false) {
      if (!img?.complete || !img.naturalWidth) return;
      put(ctx, img, (((i % n) + n) % n) * w, w, h, x, y, flip !== left);
    },
  };
}

/** Every frame side by side, as a PNG data URL: a strip for CSS sprites. */
export function stripURL(f: Frames, flip = false): string {
  const c = document.createElement('canvas');
  [c.width, c.height] = [f.w * f.n, f.h];
  const ctx = c.getContext('2d')!;
  for (let i = 0; i < f.n; i++) f.draw(ctx, i, i * f.w, 0, flip);
  return c.toDataURL('image/png');
}

/** A small seeded random, so scenes look the same every time. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Eases out; t from 0 to 1. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** ms rounded down to a whole frame at fps, so motion steps like pixel art */
export const onFrame = (t: number, fps = 12): number => Math.floor(t / (1000 / fps)) * (1000 / fps);
