// Home's second picture: the road toward Rainier at night in the rain, alive at 12 fps.
// A car drives off with its tail lights on and its tire dust washes down the gutter into the drain; stars twinkle.
import { h } from '../dom.ts';
import { animate } from './hero.ts';

const W = 512, H = 312, FPS = 12, LOOP = 12;
/** where the road meets the sky, and the right lane's offset at depth 1 */
const VX = 252, VY = 212, LANE = 54;
/** the gutter line, and where it meets the grate */
const gutterX = (y: number) => 271 + (y - 222) * 1.22;
const GRATE_Y = 281;
/** the car at night */
const DIM = 0.42;

type RGB = readonly [number, number, number];
const SPECK: RGB = [20, 20, 22], STAR_DARK: RGB = [10, 16, 34], HALO: RGB = [255, 80, 64], WET_RED: RGB = [255, 90, 70], FAR_RED: RGB = [255, 80, 66], FAR_DARK: RGB = [40, 44, 46];
const RAIN: RGB = [120, 140, 170], GLINT: RGB = [140, 160, 196], SHINE: RGB = [150, 170, 200];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

const img = (src: string) => new Promise<HTMLImageElement>((done, fail) => {
  const i = new Image();
  i.addEventListener('load', () => done(i));
  i.addEventListener('error', () => fail(new Error(src)));
  i.src = src;
});

const pixels = (i: HTMLImageElement): Uint8ClampedArray | null => {
  try {
    const g = (h('canvas', { width: String(i.width), height: String(i.height) }) as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(i, 0, 0);
    return g.getImageData(0, 0, i.width, i.height).data;
  } catch { return null; }
};

/** The picture's parts, worked out once: home redraws often. */
let parts: Promise<Road | null> | null = null;
const load = () => (parts ??= Promise.all([
  img('art/home/plate-night.png'), img('art/home/car-back.png'),
  fetch('art/home/puddles.json').then((r) => r.json()).then((a: number[]) => Int16Array.from(a)).catch(() => new Int16Array(0)),
]).then(([plate, car, pud]) => {
  const base = pixels(plate), cp = pixels(car);
  return base && cp ? new Road(base, cp, car.width, pud) : null;
}).catch(() => { parts = null; return null; }));

/** Once the night picture is in (or failed), so the first screen can wait for it. */
export function nightLoaded(): Promise<void> {
  return load().then(() => {});
}

/** The night road as a canvas that covers its box, the bottom middle of the art kept in view. */
export function nightScene(): HTMLCanvasElement {
  const c = h('canvas.hero-night', { width: String(W), height: String(H), 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const g = c.getContext('2d');
  void load().then((road) => {
    if (!road || !g) { c.classList.add('missing'); return; }
    const draw = (t: number) => { road.frame(t); g.putImageData(road.out, 0, 0); };
    const at = document.documentElement.dataset.heroAt;
    if (at) return draw(Number(at) || 0);
    if (document.documentElement.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(4.2);
    const t0 = performance.now();
    animate(c, FPS, (now) => draw((now - t0) / 1000));
  });
  fit(c);
  return c;
}

class Road {
  readonly out: ImageData;
  private readonly stars: number[] = [];
  private readonly sizes = new Map<number, { w: number; h: number; a: Uint8ClampedArray }>();
  private readonly drops: { x: number; y: number; v: number; l: number }[];
  private readonly rings: { k: number; t0: number }[];
  /** lit tail light pixels this frame, x then y */
  private readonly halo = new Int16Array(2 * 27 * 28);
  private readonly base: Uint8ClampedArray;
  private readonly car: Uint8ClampedArray;
  private readonly carW: number;
  private readonly pud: Int16Array;

  constructor(base: Uint8ClampedArray, car: Uint8ClampedArray, carW: number, pud: Int16Array) {
    [this.base, this.car, this.carW, this.pud] = [base, car, carW, pud];
    this.out = new ImageData(W, H);
    // stars: lone bright pixels high in the sky
    for (let y = 2; y < 150; y++) for (let x = 2; x < W - 2; x++) {
      const k = (y * W + x) * 4, n = k - 4, l = lum(base[k], base[k + 1], base[k + 2]);
      if (l > 120 && l - lum(base[n], base[n + 1], base[n + 2]) > 50) this.stars.push(x, y, ((x * 7 + y * 13) % 17) / 17);
    }
    let seed = 9;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.drops = Array.from({ length: 110 }, () => ({ x: rnd() * (W + 40), y: rnd() * H, v: 7 + rnd() * 5, l: 3 + Math.floor(rnd() * 3) }));
    const np = pud.length / 2;
    this.rings = np ? Array.from({ length: 6 }, () => ({ k: Math.floor(rnd() * np), t0: rnd() * 2 })) : [];
    for (let w = 6; w <= 27; w++) this.carAt(w);
  }

  /** the car, scaled down by whole pixels, built once */
  private carAt(w: number) {
    let s = this.sizes.get(w);
    if (s) return s;
    const sw = 27, sh = 28, ht = Math.max(1, Math.round((w * sh) / sw)), a = new Uint8ClampedArray(w * ht * 4);
    for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
      const sx = 11 + Math.floor((x * sw) / w), sy = 7 + Math.floor((y * sh) / ht), q = (sy * this.carW + sx) * 4, t = (y * w + x) * 4;
      for (let i = 0; i < 4; i++) a[t + i] = this.car[q + i];
    }
    s = { w, h: ht, a };
    this.sizes.set(w, s);
    return s;
  }

  private blend(x: number, y: number, c: RGB, a: number): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
    const d = this.out.data, k = (y * W + x) * 4, m = Math.min(1, a);
    d[k] += (c[0] - d[k]) * m; d[k + 1] += (c[1] - d[k + 1]) * m; d[k + 2] += (c[2] - d[k + 2]) * m;
  }

  frame(t: number): void {
    const d = this.out.data, pud = this.pud, np = pud.length / 2;
    d.set(this.base);

    // puddles catch the light
    if (np) for (let i = 0; i < 26; i++) {
      const k = ((i * 977) % np) * 2, a = Math.max(0, Math.sin((t / (2.6 + (i % 5) * 0.5)) * Math.PI * 2 + i));
      for (let j = 0; j < 2 + (i % 3); j++) this.blend(pud[k] + j, pud[k + 1], SHINE, 0.55 * a * a);
    }

    // stars twinkle
    const st = this.stars;
    for (let i = 0; i < st.length; i += 3) this.blend(st[i], st[i + 1], STAR_DARK, 0.7 * Math.max(0, Math.sin(t * 1.3 + st[i + 2] * 9)));

    // the car: every 12 s it drives off up the road and eases off at the bend
    const u = (t % LOOP) - 1;
    if (u > 0 && u < 9) this.drawCar(u);

    // tire dust: specks off the right rear tire wash down the wet gutter into the grate
    for (let i = 0; i < 9; i++) {
      const ue = 0.35 + i * 0.08, s = u - ue;
      if (s < 0 || u > 11) continue;
      const dep = 0.82 + Math.pow(ue, 1.35) * 1.4, ey = VY + 92 / dep, ex = VX + LANE / dep + 9 + (i % 3);
      const gy = ey + (i % 2), gx = gutterX(gy);
      let x: number, y: number, a = 1;
      if (s < 0.8) { const p = s / 0.8; x = ex + (gx - ex) * p; y = ey - 1 + p; }
      else {
        y = Math.min(gy + (s - 0.8) * 9, GRATE_Y); x = gutterX(y);
        if (y >= GRATE_Y) { a = clamp(1 - (s - 0.8 - (GRATE_Y - gy) / 9) / 0.5); x += 3; }
      }
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.blend(x + dx, y + dy, SPECK, 0.95 * a);
      if (s >= 0.8) this.blend(x - 1, y - 1, GLINT, 0.35 * a);
    }
    // a thin trickle of runoff down the gutter
    for (let i = 0; i < 6; i++) {
      const y = 228 + ((t * 9 + i * 9.5) % 53), x = gutterX(y);
      this.blend(x, y, GLINT, 0.6);
      this.blend(x + 1, y + 1, GLINT, 0.4);
    }

    // rain, slanted a little, and rings on the puddles
    for (const r of this.drops) {
      const y = ((r.y + t * r.v * FPS) % (H + 10)) - 6, x = (r.x - y * 0.18) % (W + 40);
      for (let i = 0; i < r.l; i++) this.blend(x - i * 0.18, y - i, RAIN, 0.42 - i * 0.06);
    }
    for (const ri of this.rings) {
      const p = ((t + ri.t0) % 1.2) / 1.2, cx = pud[ri.k * 2], cy = pud[ri.k * 2 + 1], rr = 1 + p * 4;
      for (let q = 0; q < 16; q++) { const a = (q / 16) * Math.PI * 2; this.blend(cx + rr * Math.cos(a), cy + rr * 0.35 * Math.sin(a), RAIN, 0.5 * (1 - p)); }
    }
  }

  private drawCar(u: number): void {
    const d = this.out.data;
    const dep = 0.82 + Math.pow(u, 1.35) * 1.4, y = VY + 92 / dep, x = VX + LANE / dep, w = Math.round(27 * Math.min(1, 2 / dep));
    const brake = clamp((u - 4.6) / 0.25) * clamp((6.4 - u) / 0.4);
    if (w >= 6) {
      const s = this.carAt(w), x0 = Math.round(x - s.w / 2), y0 = Math.round(y - s.h), hl = this.halo;
      let n = 0;
      for (let yy = 0; yy < s.h; yy++) for (let xx = 0; xx < s.w; xx++) {
        const k = (yy * s.w + xx) * 4;
        if (s.a[k + 3] < 128) continue;
        let r = s.a[k], gg = s.a[k + 1], b = s.a[k + 2];
        // tail lights stay on at night
        const glow = r > 150 && gg < 110;
        if (glow) { r = 255; gg = 92; b = 80; } else { r *= DIM; gg *= DIM; b *= DIM; }
        const X = x0 + xx, Y = y0 + yy;
        if (X >= 0 && X < W && Y >= 0 && Y < H) { const q = (Y * W + X) * 4; d[q] = r; d[q + 1] = gg; d[q + 2] = b; }
        if (glow && n < hl.length) { hl[n++] = X; hl[n++] = Y; }
      }
      // a soft red halo round the tail lights
      for (let i = 0; i < n; i += 2) for (let gy = -2; gy <= 2; gy++) for (let gx = -2; gx <= 2; gx++) if (gx || gy) this.blend(hl[i] + gx, hl[i + 1] + gy, HALO, 0.07 * Math.max(brake, 0.8));
      // and their glow on the wet road
      const g = Math.max(brake, 0.55);
      for (let yy = 0; yy < Math.max(2, s.h / 3); yy++) for (let side = 0; side < 2; side++) {
        this.blend(x0 + s.w * (side ? 0.8 : 0.2) + (yy % 2), y0 + s.h + yy, WET_RED, 0.5 * g * (1 - yy / (s.h / 3 + 1)));
      }
    } else if (dep < 28) {
      // far away: two red points, then gone
      const a = clamp((28 - dep) / 6), half = Math.max(1, Math.round(w / 2)), X = Math.round(x), Y = Math.round(y) - 1;
      this.blend(X - half, Y, FAR_RED, a);
      this.blend(X + half - 1, Y, FAR_RED, a);
      if (w > 2) this.blend(X - half + 1, Y, FAR_DARK, a * 0.6);
    }
  }
}

/** Cover the box; the bottom middle of the art stays at the bottom middle of the box. */
function fit(c: HTMLCanvasElement): void {
  let ro: ResizeObserver | null = null, tries = 0;
  const place = () => {
    const box = c.parentElement;
    if (!c.isConnected || !box) { ro?.disconnect(); return; }
    const bw = box.clientWidth, bh = box.clientHeight, k = Math.max(bw / W, bh / H), w = W * k, ht = H * k;
    Object.assign(c.style, {
      width: `${w}px`, height: `${ht}px`,
      left: `${Math.min(0, Math.max(bw - w, bw / 2 - 256 * k))}px`, top: `${bh - ht}px`,
    });
  };
  // the canvas joins the page after this runs
  const wait = () => {
    if (c.parentElement && c.isConnected) { ro = new ResizeObserver(place); ro.observe(c.parentElement); place(); return; }
    if (tries++ < 50) requestAnimationFrame(wait);
  };
  wait();
}
