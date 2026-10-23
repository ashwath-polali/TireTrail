// The creek scene: water runs downstream, and a coho swims in for each salmon stream the drive crossed, named.
// A gentle crossing gets a sparkle; a hard brake near one puffs tire dust into the water.
import { h } from '../dom.ts';
import { drawPx, easeOut, frameAt, onFrame, seeded } from './px.ts';
import { SPRITES } from './sprites.ts';

/** art pixels: 3 CSS px each; the scene is H tall with a bank above and below the water */
export const CREEK = { scale: 3, H: 34, bank: 6, max: 4 } as const;

export interface CreekFish {
  /** '' when the stream has no name */
  name: string;
  gentle: boolean;
  /** a hard brake near this crossing */
  hard: boolean;
}

export interface FishSpot extends CreekFish {
  x: number;
  y: number;
  from: number;
  at: number;
  /** its name sits on the top bank, else the bottom one */
  top: boolean;
}

const LANES = [11, 18, 14, 20];
const FISH_W = 16;

/** Where each coho swims to, W art px wide, and when. More than `max` streams: the rest are counted. Pure. */
export function creekLayout(W: number, fish: readonly CreekFish[], times: readonly { from: number; at: number }[], max: number = CREEK.max): { spots: FishSpot[]; more: number } {
  const shown = fish.slice(0, max), n = shown.length, slot = (W - 4) / Math.max(1, n);
  const spots = shown.map((f, i) => ({
    ...f,
    x: Math.round((n === 1 ? W / 2 : 2 + slot * (i + 0.5)) - FISH_W / 2),
    y: LANES[i % LANES.length],
    from: times[i]?.from ?? 0,
    at: times[i]?.at ?? 0,
    top: i % 2 === 0,
  }));
  return { spots, more: Math.max(0, fish.length - max) };
}

/** a ripple on the water */
interface Ripple { x: number; y: number; len: number; c: string }

const C = {
  grass: '#3c5334', grass2: '#46603c', tuft: '#557245', edge: '#2a3b25', soil: '#4a4232',
  deep: '#22404a', mid: '#2f6273', water: '#3b7688', lite: '#8fc3d2', white: '#d4ecf3', stone: '#335f6e',
  dust: '#8a7f6a', dust2: '#6b6250',
};

export class CreekScene {
  readonly el: HTMLElement;
  private readonly cv: HTMLCanvasElement;
  private readonly labels: HTMLElement;
  private W = 0;
  private spots: FishSpot[] = [];
  private more = 0;
  private ripples: Ripple[] = [];
  private base: HTMLCanvasElement | null = null;
  private last = -1;
  private readonly fish: readonly CreekFish[];
  private readonly times: readonly { from: number; at: number }[];

  constructor(fish: readonly CreekFish[], times: readonly { from: number; at: number }[], label: string) {
    [this.fish, this.times] = [fish, times];
    this.cv = h('canvas.an-creek-cv', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.labels = h('div.an-creek-names', { 'aria-hidden': 'true' });
    this.el = h('div.an-creek', { role: 'img', 'aria-label': label }, this.cv, this.labels);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.fit()).observe(this.el);
  }

  /** Sizes the scene to its box; the names go where their fish swim to. */
  private fit(): void {
    const cw = this.el.clientWidth;
    if (!cw) return;
    const W = Math.max(60, Math.ceil(cw / CREEK.scale));
    if (W === this.W) return;
    this.W = W;
    // 1 CSS px a canvas pixel: the sheets keep their detail, the banks are blown up 3 times
    [this.cv.width, this.cv.height] = [W * CREEK.scale, CREEK.H * CREEK.scale];
    this.cv.style.width = `${W * CREEK.scale}px`;
    this.cv.style.height = `${CREEK.H * CREEK.scale}px`;
    ({ spots: this.spots, more: this.more } = creekLayout(W, this.fish, this.times));
    const rnd = seeded(W * 7 + 3);
    this.ripples = Array.from({ length: Math.round(W / 5) }, () => ({
      x: Math.floor(rnd() * (W + 8)), y: CREEK.bank + 2 + Math.floor(rnd() * (CREEK.H - CREEK.bank * 2 - 4)),
      len: 2 + Math.floor(rnd() * 4), c: rnd() < 0.25 ? C.white : C.lite,
    }));
    this.base = this.paintBase(W);
    this.names(cw);
    if (this.last >= 0) this.draw(this.last, true);
  }

  private names(cw: number): void {
    const s = CREEK.scale;
    this.labels.replaceChildren(...this.spots.filter((f) => f.name).map((f) => h('span.an-creek-name' + (f.top ? '.an-top' : '.an-bot'), { 'data-at': String(f.at), style: `--x:${(f.x + FISH_W / 2) * s}px` }, f.name)));
    if (this.more) this.labels.append(h('span.an-creek-name.an-more' + (this.spots.length % 2 ? '.an-bot' : '.an-top'), { 'data-at': String(this.spots.at(-1)?.at ?? 0) }, `+${this.more} more`));
    // keep each name inside the box
    requestAnimationFrame(() => {
      for (const l of this.labels.querySelectorAll<HTMLElement>('.an-creek-name:not(.an-more)')) {
        const x = parseFloat(l.style.getPropertyValue('--x')), half = l.offsetWidth / 2;
        l.style.setProperty('--x', `${Math.round(Math.min(cw - half - 4, Math.max(half + 4, x)))}px`);
      }
    });
  }

  /** The banks and still water, painted once per size. */
  private paintBase(W: number): HTMLCanvasElement {
    const c = document.createElement('canvas'), H = CREEK.H, b = CREEK.bank;
    [c.width, c.height] = [W, H];
    const x = c.getContext('2d')!, rnd = seeded(91);
    const band = (y: number, hh: number, col: string) => { x.fillStyle = col; x.fillRect(0, y, W, hh); };
    band(0, b, C.grass); band(H - b, b, C.grass);
    band(b - 1, 1, C.edge); band(H - b, 1, C.edge);
    band(b, 1, C.deep); band(b + 1, 1, C.mid); band(b + 2, H - b * 2 - 4, C.water); band(H - b - 2, 1, C.mid); band(H - b - 1, 1, C.deep);
    for (let i = 0; i < W / 3; i++) {
      x.fillStyle = rnd() < 0.5 ? C.tuft : C.grass2;
      x.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * (b - 2)), 1, 1);
      x.fillRect(Math.floor(rnd() * W), H - b + 1 + Math.floor(rnd() * (b - 1)), 1, 1);
    }
    for (let i = 0; i < W / 14; i++) {
      x.fillStyle = C.stone;
      x.fillRect(Math.floor(rnd() * W), b + 3 + Math.floor(rnd() * (H - b * 2 - 6)), 2, 1);
    }
    return c;
  }

  /** Draws the scene t ms into the reveal. idle: after it, the water keeps running and the fish rest. */
  draw(t: number, idle = false): void {
    this.last = t;
    if (!this.W) this.fit();
    const ctx = this.cv.getContext('2d');
    if (!ctx || !this.base) return;
    const k = CREEK.scale, W = this.W * k, H = CREEK.H * k, b = CREEK.bank * k, tf = onFrame(t);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, W, H);
    const S = SPRITES, flow = tf / 1000;
    if (S.creek.hi) {
      // the water sheet, in bands that run downstream (left) at a little different speeds
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, b, W, H - b * 2);
      ctx.clip();
      for (let row = 0, y = b - 2; y < H - b; row++, y += S.creek.h - 2) {
        const off = Math.round(flow * (18 + row * 5) + row * 47) % S.creek.w;
        for (let x = -off; x < W; x += S.creek.w) S.creek.draw(ctx, frameAt(S.creek, tf + row * 170), x, y);
      }
      ctx.restore();
    } else {
      for (const r of this.ripples) {
        ctx.fillStyle = r.c;
        ctx.fillRect(Math.round(((((r.x - flow * 8) % (this.W + 8)) + this.W + 8) % (this.W + 8)) - 4) * k, r.y * k, r.len * k, k);
      }
    }
    this.spots.forEach((f, i) => this.drawFish(ctx, f, i, tf, idle));
    for (const l of this.labels.children) (l as HTMLElement).classList.toggle('an-on', t >= Number((l as HTMLElement).dataset.at) - 120);
  }

  private drawFish(ctx: CanvasRenderingContext2D, f: FishSpot, i: number, t: number, idle: boolean): void {
    const S = SPRITES, k = CREEK.scale, b = CREEK.bank * k, cy = (f.y + 3.5) * k;
    // a hard brake: dust puffs off the bank and settles into the water
    if (f.hard && t >= f.at - 300) {
      const n = Math.floor((t - (f.at - 300)) / (1000 / S.puff.fps)), px = (f.x + FISH_W / 2) * k;
      if (n < S.puff.n) drawPx(ctx, S.puff, n, px - 6, b - 8, k);
      const p = easeOut((t - f.at + 150) / 1200);
      for (let j = 0; j < 7 && p > 0; j++) {
        ctx.fillStyle = j % 2 ? C.dust : C.dust2;
        ctx.fillRect(Math.round(px - 10 + j * 5 - p * (14 + j * 3)), Math.round(b + 2 + p * (6 + (j % 3) * 7)), 2, 2);
      }
    }
    if (t < f.from) return;
    const swimming = t < f.at;
    const ax = swimming ? Math.round(-FISH_W - 6 + (f.x + FISH_W + 6) * easeOut((t - f.from) / (f.at - f.from))) : f.x + (idle ? Math.round(Math.sin(t / 1100 + i * 1.7)) : 0);
    const cx = (ax + FISH_W / 2) * k, y = cy + (idle && !swimming ? Math.round(Math.sin(t / 1500 + i)) * 2 : 0);
    // a little wake behind a swimming fish
    if (swimming) {
      ctx.fillStyle = C.white;
      const w = Math.floor(t / 83) % 2;
      ctx.fillRect(cx - 30 - w * 3, y + 2, 4, 2);
      ctx.fillRect(cx - 40 + w * 2, y - 1 + w * 2, 2, 2);
    }
    drawPx(ctx, S.coho, swimming ? frameAt(S.coho, t) : frameAt({ n: S.coho.n, fps: 5 }, t + i * 300), cx, y, k);
    // a gentle crossing: a sparkle when it arrives, then now and then, small in between
    if (f.gentle && !swimming) {
      const since = t - f.at, n = Math.floor(since / (1000 / S.sparkle.fps));
      const tw = Math.floor((((since - i * 900) % 3600) + 3600) % 3600 / (1000 / S.sparkle.fps));
      const fr = n < S.sparkle.n ? n : idle && tw < S.sparkle.n ? tw : 0;
      drawPx(ctx, S.sparkle, fr, cx + 26, y - 14, k);
    }
  }
}
