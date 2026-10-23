// My drives art: the PixelLab creek scene with a coho swimming upstream for each gentle crossing.
import { calm } from '../ui/ui.ts';
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
