// The home picture, alive: water pours from the pipe, the salmon swims, and a car brakes
// and its tire dust washes down the drain, out the pipe and toward the salmon.
import { h } from '../dom.ts';

const W = 384, H = 216, FPS = 12, LOOP = 12;

type RGB = readonly [number, number, number];
const rgb = (s: string): RGB => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => x * x * (3 - 2 * x);

// colors of open water and of the falling stream in hero.png
const OPEN = new Set(['667c7d', '6b8181', '3d5256', '41565a', '3a4e52', '36494d', '506567', 'a6bdbd', 'afcbd0', 'b9d4d8']);
// only the light falling water, so no pool color wraps up to the lip
const FALL = new Set(['7e9697', 'b9d4d8', 'afcbd0', '9aabab', 'a6bdbd']);
const TAIL_X = 224;
const RED: RGB = [255, 74, 58], SPECK: RGB = [18, 20, 21], FOAM: RGB = [207, 230, 234];

// tire dust: under the rear tire, along the gutter, into the grate, out the pipe, toward the salmon
const DUST = Array.from({ length: 7 }, (_, i) => ({
  x0: 85 + ((i * 5) % 11), y0: 87 + (i % 3), at: 0.3 + i * 0.12,
  gx: 184 + ((i * 7) % 28), px: 192 + ((i * 3) % 11),
  tx: 158 + ((i * 13) % 62), ty: 165 + ((i * 5) % 7),
}));

/** The home picture as a canvas, scaled to cover its box like a background photo. */
export function heroScene(): HTMLCanvasElement {
  const c = h('canvas.hero', { width: String(W), height: String(H), 'aria-hidden': 'true' }) as HTMLCanvasElement;
  load().then((p) => start(c, p), () => c.classList.add('missing'));
  return c;
}

interface Pic { img: HTMLImageElement; scene: Promise<Scene | null> }

/** The picture, and its moving parts once the page is idle. Worked out once: home redraws often. */
let pic: Promise<Pic> | null = null;
function load(): Promise<Pic> {
  pic ??= new Promise<Pic>((done, fail) => {
    const img = new Image();
    img.addEventListener('error', () => { pic = null; fail(new Error('no picture')); });
    img.addEventListener('load', () => done({ img, scene: idle(() => parts(img)) }));
    img.src = 'art/hero.png';
  });
  return pic;
}

const idle = <T>(fn: () => T): Promise<T> => new Promise((done) => {
  const go = () => done(fn());
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 500 });
  else setTimeout(go, 30);
});

function parts(img: HTMLImageElement): Scene | null {
  try {
    const g = (h('canvas', { width: String(W), height: String(H) }) as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, W, H);
    return new Scene(g.getImageData(0, 0, W, H).data);
  } catch { return null; } // can't read the pixels: keep it still
}

/** The still picture first, so home paints at once; then it comes alive. */
function start(c: HTMLCanvasElement, p: Pic): void {
  const g = c.getContext('2d');
  if (!g) return;
  g.drawImage(p.img, 0, 0, W, H);
  fit(c);
  void p.scene.then((s) => { if (s) play(c, g, s); });
}

function play(c: HTMLCanvasElement, g: CanvasRenderingContext2D, scene: Scene): void {
  const out = g.createImageData(W, H);
  const draw = (t: number) => { scene.frame(t, out.data); g.putImageData(out, 0, 0); };
  const at = document.documentElement.dataset.heroAt;
  if (at) return draw(Number(at));
  if (document.documentElement.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(11);
  const t0 = performance.now();
  animate(c, FPS, (now) => draw((now - t0) / 1000));
}

/**
 * Calls draw fps times a second while el is on screen. It rests while the tab is hidden,
 * el is scrolled away or a dialog covers it, and stops for good once el leaves the page.
 */
export function animate(el: HTMLElement, fps: number, draw: (now: number) => void): void {
  let seen = true, timer = 0, born = false, tries = 0;
  const stop = () => { clearTimeout(timer); timer = -1; io.disconnect(); document.removeEventListener('visibilitychange', wake); };
  const io = new IntersectionObserver((es) => {
    if (born && !el.isConnected) return stop();
    seen = es[es.length - 1].isIntersecting;
    if (seen) wake();
  });
  const later = (ms: number) => { timer = window.setTimeout(tick, ms); };
  function wake(): void { if (!timer) later(0); }
  function tick(): void {
    timer = 0;
    if (!el.isConnected) {
      // not on the page yet: wait a little; gone from it: stop
      if (!born && tries++ < 20) later(100); else stop();
      return;
    }
    if (!born) { born = true; io.observe(el); }
    // wake() starts it again
    if (document.hidden || !seen) return;
    if (el.closest('[inert]') || document.querySelector('[aria-modal="true"]')) return later(400);
    timer = -1;
    requestAnimationFrame((now) => {
      timer = 0;
      if (!el.isConnected) return stop();
      draw(now);
      later(1000 / fps);
    });
  }
  document.addEventListener('visibilitychange', wake);
  wake();
}

/** Cover the box. --cx and --cy (picture pixels) put that spot in the middle when they can; --fx and --fy (0 to 1) anchor it otherwise. */
function fit(c: HTMLCanvasElement): void {
  const box = c.parentElement;
  if (!box) return;
  const ro = new ResizeObserver(() => place());
  const num = (cs: CSSStyleDeclaration, k: string) => parseFloat(cs.getPropertyValue(k));
  let was = false;
  const place = () => {
    // the observer fires once it's on the page, and stops once it's gone
    if (!c.isConnected) { if (was) ro.disconnect(); return; }
    was = true;
    const bw = box.clientWidth, bh = box.clientHeight, cs = getComputedStyle(box);
    const k = Math.max(bw / W, bh / H), w = W * k, ht = H * k;
    const at = (size: number, full: number, mid: number, frac: number) => Number.isFinite(mid)
      ? Math.min(0, Math.max(size - full, size / 2 - mid * k))
      : (size - full) * (Number.isFinite(frac) ? frac : 0.5);
    Object.assign(c.style, {
      width: `${w}px`, height: `${ht}px`,
      left: `${at(bw, w, num(cs, '--cx'), num(cs, '--fx'))}px`, top: `${at(bh, ht, num(cs, '--cy'), num(cs, '--fy'))}px`,
    });
  };
  place();
  ro.observe(box);
}

class Scene {
  /** the picture with the salmon taken out */
  private readonly plate: Uint8ClampedArray;
  private readonly fish: { x: number; y: number; c: RGB }[] = [];
  private readonly fall: { x: number; y0: number; cols: RGB[] }[] = [];
  private readonly lights: number[] = [];
  private readonly open: Uint8Array;
  private readonly glints: { x: number; y: number; n: number; p: number; ph: number }[] = [];

  constructor(base: Uint8ClampedArray) {
    const px = (x: number, y: number): RGB => { const k = (y * W + x) * 4; return [base[k], base[k + 1], base[k + 2]]; };
    const key = (x: number, y: number) => { const k = (y * W + x) * 4; return ((base[k] << 16) | (base[k + 1] << 8) | base[k + 2]).toString(16).padStart(6, '0'); };
    this.plate = new Uint8ClampedArray(base);
    this.open = new Uint8Array(W * H);
    for (let y = 150; y < H; y++) for (let x = 0; x < W; x++) if (OPEN.has(key(x, y))) this.open[y * W + x] = 1;

    // the salmon: warm or green pixels, their dark outline, and tiny gaps between
    const inFish = (x: number, y: number) => x >= 128 && x <= 250 && y >= 164 && y <= 210;
    const warm = (c: RGB) => (c[0] > c[2] + 10 || c[1] > c[2] + 10) && lum(c) > 20;
    const mask = new Uint8Array(W * H);
    for (let y = 164; y <= 210; y++) for (let x = 128; x <= 250; x++) if (warm(px(x, y))) mask[y * W + x] = 1;
    const core = mask.slice();
    for (let y = 164; y <= 210; y++) for (let x = 128; x <= 250; x++) {
      if (core[y * W + x] || lum(px(x, y)) >= 40) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (inFish(x + dx, y + dy) && core[(y + dy) * W + x + dx]) { near = true; break; }
      if (near) mask[y * W + x] = 1;
    }
    for (let y = 164; y <= 210; y++) {
      let prev = -9;
      for (let x = 128; x <= 250; x++) {
        if (!mask[y * W + x]) continue;
        if (x - prev > 1 && x - prev <= 3) for (let q = prev + 1; q < x; q++) mask[y * W + q] = 1;
        prev = x;
      }
    }
    for (let y = 164; y <= 210; y++) {
      // fill behind the fish with the water just left of it
      let fill: RGB = rgb('667c7d');
      for (let x = 128; x <= 250; x++) {
        const k = y * W + x;
        if (!mask[k]) { if (OPEN.has(key(x, y))) fill = px(x, y); continue; }
        this.fish.push({ x, y, c: px(x, y) });
        this.open[k] = 0;
        this.plate.set(fill, k * 4);
      }
    }

    // the falling stream, column by column
    for (let x = 186; x <= 210; x++) {
      let best: number[] = [], run: number[] = [];
      for (let y = 144; y <= 157; y++) {
        if (FALL.has(key(x, y))) run.push(y);
        else run = [];
        if (run.length > best.length) best = run.slice();
      }
      if (best.length >= 4) this.fall.push({ x, y0: best[0], cols: best.map((y) => px(x, y)) });
    }

    // the car's tail light
    for (let y = 66; y <= 75; y++) for (let x = 76; x <= 86; x++) if (key(x, y) === 'a24238') this.lights.push(y * W + x);

    // glints: fixed spots on open water that come and go
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let tries = 0; this.glints.length < 16 && tries < 4000; tries++) {
      const x = 4 + Math.floor(rnd() * (W - 12)), y = 160 + Math.floor(rnd() * 52);
      if (this.open[y * W + x] && this.open[y * W + x + 3]) this.glints.push({ x, y, n: 2 + Math.floor(rnd() * 3), p: 3 + rnd() * 2.5, ph: rnd() });
    }
  }

  frame(time: number, out: Uint8ClampedArray): void {
    const t = time % LOOP;
    out.set(this.plate);
    const blend = (x: number, y: number, c: RGB, a: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
      const k = ((y | 0) * W + (x | 0)) * 4;
      for (let i = 0; i < 3; i++) out[k + i] += (c[i] - out[k + i]) * Math.min(1, a);
    };
    // a speck of dust with a soft edge
    const speck = (x: number, y: number, a: number) => {
      blend(x, y, SPECK, a);
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) blend(x + ex, y + ey, SPECK, a * 0.3);
    };

    // water pouring from the pipe
    const drop = Math.floor(time * 14);
    for (const f of this.fall) {
      const n = f.cols.length;
      for (let i = 0; i < n; i++) out.set(f.cols[(((i - drop) % n) + n) % n], ((f.y0 + i) * W + f.x) * 4);
    }

    // rings where it lands
    for (const off of [0, 1.2]) {
      const p = ((time + off) % 2.4) / 2.4, r = 3 + p * 20, ry = r * 0.28;
      for (let q = 0; q < 64; q++) {
        const a = (q / 64) * Math.PI * 2, x = Math.round(198 + r * Math.cos(a)), y = Math.round(159 + ry * Math.sin(a));
        if (y >= 150 && this.open[y * W + x]) blend(x, y, FOAM, 0.55 * (1 - p));
      }
    }

    // light catching the creek
    for (const gl of this.glints) {
      const a = Math.max(0, Math.sin(2 * Math.PI * (time / gl.p + gl.ph)));
      for (let i = 0; i < gl.n; i++) if (this.open[gl.y * W + gl.x + i]) blend(gl.x + i, gl.y, FOAM, 0.6 * a * a);
    }

    // tire dust in the creek, drifting toward the salmon
    for (const [i, d] of DUST.entries()) {
      const u = t - (6.2 + i * 0.14);
      if (u < 0 || u > 4) continue;
      let x: number, y: number, a = 0.9;
      if (u < 0.5) { x = d.px; y = 143 + (u / 0.5) * 14; }
      else {
        const v = ease(clamp((u - 0.5) / 3));
        x = d.px + (d.tx - d.px) * v + Math.sin(u * 2.3 + i) * 1.2;
        y = 157 + (d.ty - 157) * v;
        a *= clamp((4 - u) / 1.2);
      }
      speck(Math.round(x), Math.round(y), a);
    }

    // the salmon: a slow rise and fall, and a flick of the tail
    const body = Math.round(0.8 * Math.sin((2 * Math.PI * time) / 3.4));
    const tail = Math.round(Math.sin((2 * Math.PI * time) / 1.1));
    const dx = Math.round(1.2 * Math.sin((2 * Math.PI * time) / 7));
    for (const f of this.fish) {
      const dy = body + (f.x >= TAIL_X ? tail : f.x >= TAIL_X - 8 ? Math.round(tail * 0.5) : 0);
      const x = f.x + dx, y = f.y + dy;
      if (x >= 0 && x < W && y >= 0 && y < H) out.set(f.c, (y * W + x) * 4);
    }

    // brake lights, and their glow on the wet road
    const on = clamp(t / 0.12) * clamp((1.7 - t) / 0.25);
    if (on > 0) {
      for (const k of this.lights) {
        const x = k % W, y = (k / W) | 0;
        for (let gy = -2; gy <= 2; gy++) for (let gx = -2; gx <= 2; gx++) if (gx || gy) blend(x + gx, y + gy, RED, 0.12 * on);
      }
      for (const k of this.lights) blend(k % W, (k / W) | 0, RED, on);
      for (let y = 89; y <= 96; y++) for (let x = 74; x <= 86; x++) blend(x, y, RED, 0.3 * on * (1 - (y - 89) / 8) * (x % 2 ? 1 : 0.55));
    }

    // tire dust on the road: along the gutter and into the grate
    for (const d of DUST) {
      const u = t - d.at;
      if (u < 0) continue;
      const pts: [number, number][] = [[d.x0, d.y0], [d.x0 + 8, 98], [d.gx, 98], [d.gx, 104]];
      let left = u * 24, x = -1, y = -1, a = 0.9;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay);
        if (left <= len) { x = ax + ((bx - ax) * left) / len; y = ay + ((by - ay) * left) / len; break; }
        left -= len;
      }
      if (x < 0) continue;
      if (y > 100) a *= clamp((104 - y) / 4); // slipping into the grate
      speck(Math.round(x), Math.round(y + (y < 98 ? Math.sin(u * 3 + d.x0) * 0.4 : 0)), a);
    }
  }
}
