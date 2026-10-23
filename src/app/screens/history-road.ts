// My drives, the week road: each drive is a sign on a road that climbs when you get smoother. The car drives the week in,
// signs pop up and count, dust where you braked hard, rain over the days ahead when the forecast has it.
// Drawn in pixels on two canvases (land and road behind the signs, car and weather in front) at 12 frames a second.
import { h } from '../dom.ts';
import { calm } from '../ui/ui.ts';
import { run } from './pixel-anim.ts';

export type Tone = '' | 'hard' | 'best' | 'quiet';
export type Extra = 'skid' | 'coins' | 'creek' | null;

/** one sign: its day (0 Monday) and what the road needs from it */
export interface RoadSign { day: number; score: number; hardBrakes: number; cents: number | null }

/** what the road shows for one question */
export interface RoadLens {
  legend: string;
  /** last week's score as a dashed line, or null */
  ref: number | null;
  val(i: number): string;
  tone(i: number): Tone;
  /** the faces hold words ("2 of 3"), not one number */
  words: boolean;
  say(i: number): string;
  tags: { i: number; tone: 'hard' | 'best' | 'soak'; k: string; t: string; mid?: boolean }[];
  extra: Extra;
  /** the sign that sparkles as it goes up, or null */
  sparkle: number | null;
  /** where counting starts for sign i */
  base(i: number): number;
}

export interface RoadIn {
  signs: readonly RoadSign[];
  /** last week's score, for the scale */
  last: number | null;
  /** the days still ahead, "Fri to Sun" on laptop; '' with none */
  ahead: { short: string; long: string };
  /** rain from the forecast: 'tomorrow' and so on; null with none */
  rain: string | null;
  /** with no drives yet: where the car waits */
  empty: boolean;
  open(i: number): void;
}

/** how the road arrives: the car drives it in, drives the new week (no counting), or it is simply there */
export type Play = 'intro' | 'week' | 'still';
export interface RoadClock { play: Play; t0: number; lensAt: number }

const F = 1000 / 12;
const INTRO = { intro: { start: 250, dur: 2600 }, week: { start: 0, dur: 1200 }, still: { start: 0, dur: 0 } } as const;
const C = {
  sky: '#0d1310', hill: '#111a15', ground: '#16241c', groundDk: '#121d17', speck: '#1c2d23', grass: '#2e5a3e',
  road: '#2c3631', roadHi: '#55645b', roadDk: '#020302', dash: '#c9a14a', skid: '#ff7a66', ref: '#6b7a71', rain: '#7fb6d8',
};

// ---------- art ----------

const IMG: Record<string, HTMLImageElement> = {};
const ART: Record<string, string> = {
  car: 'art/anim/car-side.png', dust: 'art/anim/dust-puff.png', coin: 'art/anim/coin-spin.png', creek: 'art/anim/creek-strip.png',
  fish: 'art/anim/salmon-swim.png', sparkle: 'art/anim/sparkle.png', fir: 'art/anim/fir.png',
};
let loading: Promise<void> | null = null;
function loadArt(): Promise<void> {
  return (loading ??= Promise.all(Object.entries(ART).map(([k, src]) => new Promise<void>((r) => {
    const i = new Image();
    i.onload = () => r();
    i.onerror = () => r();
    i.src = src;
    IMG[k] = i;
  }))).then(() => undefined));
}
const ok = (k: string) => !!IMG[k]?.complete && IMG[k].naturalWidth > 0;

const hash = (n: number) => { n = (n ^ 61) ^ (n >>> 16); n += n << 3; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };
const rect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h2: number, c: string) => { g.fillStyle = c; g.fillRect(x, y, w, h2); };

interface Geo {
  W: number; H: number; S: number; U: number; xs: number[]; ys: number[]; yOf(s: number): number;
  sw: number; sh: number; sf: number; post: number; roadH: number; plat: number; xEnd: number; left: number; laptop: boolean;
  /** the hills' ridge at x */
  ridge(x: number): number;
}

export class Road {
  readonly el: HTMLElement;
  private readonly c: RoadIn;
  private lens: RoadLens;
  private readonly back: HTMLCanvasElement;
  private readonly front: HTMLCanvasElement;
  private readonly signsEl: HTMLElement;
  private readonly tagsEl: HTMLElement;
  private readonly legendT: HTMLElement;
  private readonly legendR: HTMLElement;
  private readonly rainEl: HTMLElement;
  private G: Geo | null = null;
  private play: Play;
  private t0 = 0;
  private lensAt = -1;
  private backKey = '';
  private still: boolean;
  /** the time of the last frame drawn, and whether anything still moves */
  private T = 0;

  /** resume: the clock of the road this one replaces (new data mid-intro), so the drive carries on */
  constructor(c: RoadIn, lens: RoadLens, play: Play, resume?: RoadClock | null) {
    this.c = c;
    this.lens = lens;
    this.still = calm();
    this.play = this.still ? 'still' : resume?.play ?? play;
    if (resume && !this.still) [this.t0, this.lensAt] = [resume.t0, resume.lensAt];
    const id = `wr-legend-${Math.random().toString(36).slice(2, 7)}`;
    this.back = h('canvas.wr-back', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.front = h('canvas.wr-front', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
    this.legendT = h('span', { id });
    this.legendR = h('span.wr-ref');
    this.signsEl = h('div.wr-signs');
    this.tagsEl = h('div.wr-tags', { 'aria-hidden': 'true' });
    this.rainEl = h('p.sr');
    this.el = h('section.wr-stage', { 'aria-labelledby': id },
      this.back, h('div.wr-legend', {}, this.legendT, this.legendR), this.rainEl, this.signsEl, this.tagsEl, this.front);
    this.signsEl.append(...c.signs.map((_, i) => h('button.wr-sign', { type: 'button', 'data-i': String(i), onclick: () => c.open(i) },
      h('span.wr-face'), h('span.wr-post', { 'aria-hidden': 'true' }))));
    this.paintLens();
    this.setRain(c.rain);
    void loadArt().then(() => this.kick());
    new ResizeObserver(() => { if (this.el.isConnected) { this.size(); this.kick(); } }).observe(this.el);
    if (!this.still) {
      run(this.el, 12, (now) => {
        if (!this.t0) this.t0 = now;
        this.frame(now - this.t0);
        for (const f of this.also) f(now);
      });
    }
  }

  /** where the road is in its arrival, for a road that replaces it */
  get clock(): RoadClock {
    return { play: this.play, t0: this.t0, lensAt: this.lensAt };
  }

  /** more drawing on the road's clock (the laptop's spot map), so the page has one */
  readonly also: ((now: number) => void)[] = [];

  /** A new question: the signs flip to its values, the legend and tags change. */
  setLens(lens: RoadLens): void {
    this.lens = lens;
    this.lensAt = this.still ? -1 : this.T;
    this.paintLens();
    this.kick();
  }

  setRain(when: string | null): void {
    this.c.rain = when;
    this.rainEl.textContent = when ? `Rain ${when}, from the National Weather Service. Brake gently.` : '';
    this.size();
    this.kick();
  }

  /** a still screen draws once now; a moving one on its next frame */
  private kick(): void {
    if (!this.G) this.size();
    if (this.still) this.frame(1e9);
  }

  // ---------- layout ----------

  private geometry(): Geo | null {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    if (!W || !H) return null;
    const cs = getComputedStyle(this.el), v = (k: string, d: number) => parseFloat(cs.getPropertyValue(k)) || d;
    const S = v('--S', 1), U = 2 * S, laptop = S > 1;
    const sw = v('--sw', 46), sh = v('--sh', 38), sf = v('--sf', 19), post = v('--post', 22), tail = v('--tail', 66), left = v('--left', 32);
    const signs = this.c.signs, n = signs.length, roadH = 12 * S;
    const span = W - left - tail;
    const step = n > 1 ? span / (n - 1 + 0.35) : span;
    const xs = n === 1 ? [Math.round((left + span * 0.3) / U) * U] : signs.map((_, i) => Math.round((left + i * step) / U) * U);
    // the scale fits the week: its best drive near the top, its lowest (or last week) near the bottom, never steeper than 16 points
    const scores = signs.map((s) => s.score), ref = this.c.last;
    let lo = Math.min(...scores, ref ?? Infinity) - 4, hi = Math.max(...scores, -Infinity) + 2;
    if (!n) [lo, hi] = [0, 100];
    if (hi - lo < 16) { const m = (hi + lo) / 2; [lo, hi] = [m - 8, m + 8]; }
    const yTop = (laptop ? 52 : 34) + sh + post + roadH / 2;
    const yBot = H - v('--foot', 64);
    const yOf = (s: number) => Math.round((yBot - ((s - lo) / (hi - lo)) * (yBot - yTop)) / (2 * U)) * 2 * U;
    const ys = n ? scores.map(yOf) : [];
    const plat = Math.min(laptop ? 26 : 14, step * 0.28);
    const ridge = (x: number) => Math.round((H * 0.42 + Math.sin(x / 70) * 14 + Math.sin(x / 23) * 5) / 4) * 4;
    return { W, H, S, U, xs, ys, yOf, sw, sh, sf, post, roadH, plat, xEnd: n ? xs[n - 1] : left, left, laptop, ridge };
  }

  private roadY(x: number): number {
    const { xs, ys, plat, H, U } = this.G!;
    if (!xs.length) return Math.round((H * 0.62) / (2 * U)) * 2 * U;
    if (x <= xs[0] + plat) return ys[0];
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i] + plat, b = xs[i + 1] - plat;
      if (x <= a) return ys[i];
      if (x <= b) { const t = (x - a) / (b - a); return Math.round((ys[i] + (ys[i + 1] - ys[i]) * t) / (2 * U)) * 2 * U; }
    }
    return ys[ys.length - 1];
  }

  /** Days with their signs, for one label each. */
  private days(): { day: number; is: number[]; x: number; x0: number; x1: number }[] {
    const out: { day: number; is: number[] }[] = [];
    this.c.signs.forEach((s, i) => { const g = out[out.length - 1]; if (g && g.day === s.day) g.is.push(i); else out.push({ day: s.day, is: [i] }); });
    const xs = this.G!.xs;
    return out.map((g) => ({ ...g, x: (xs[g.is[0]] + xs[g.is[g.is.length - 1]]) / 2, x0: xs[g.is[0]], x1: xs[g.is[g.is.length - 1]] }));
  }

  private size(): void {
    const G = (this.G = this.geometry());
    if (!G) return;
    const dpr = Math.max(1, Math.round(devicePixelRatio || 1));
    for (const cv of [this.back, this.front]) { cv.width = G.W * dpr; cv.height = G.H * dpr; }
    this.backKey = '';
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i);
      s.style.cssText = `left:${G.xs[i]}px;top:${G.ys[i] - G.roadH / 2 - G.post - G.sh}px`;
    });
    // day labels and the rain sit with the signs, out of the reading order (aria-hidden)
    this.signsEl.querySelectorAll('.wr-day, .wr-rainico, .wr-tag-rain').forEach((e) => e.remove());
    const foot = G.H - (G.laptop ? 30 : 22), DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const extra: HTMLElement[] = this.days().map((d) => h('span.wr-day', { 'aria-hidden': 'true', style: `left:${d.x}px;top:${foot}px` }, DAY[d.day]));
    const ahead = G.laptop ? this.c.ahead.long : this.c.ahead.short;
    const tailX = G.xEnd + (G.W - G.xEnd) / 2 + (G.laptop ? 10 : 4);
    if (ahead) extra.push(h('span.wr-day.wr-ahead', { 'aria-hidden': 'true', style: `left:${tailX}px;top:${foot}px` }, ahead));
    if (this.c.rain) {
      const ix = this.rainX();
      extra.push(h('img.wr-rainico', { src: 'art/home/icon-rain.png', alt: '', 'aria-hidden': 'true', style: `left:${ix - 16 * G.S}px;top:${G.laptop ? 48 : 30}px;width:${32 * G.S}px;height:${32 * G.S}px` }));
      if (G.laptop) extra.push(h('span.wr-tag.wr-tag-rain', { 'data-tone': 'soak', 'aria-hidden': 'true', style: `left:${ix}px;top:${G.H - 30 - 58}px` }, h('b', {}, `Rain ${this.c.rain}`), 'Brake gently'));
    }
    this.signsEl.append(...extra);
    this.placeTags();
  }

  private rainX(): number {
    const G = this.G!;
    return G.xEnd + 18 * G.S + (G.W - G.xEnd - 18 * G.S) / 2;
  }

  /** The legend, each sign's tone and label, and the tags, for the lens. */
  private paintLens(): void {
    const L = this.lens;
    this.legendT.textContent = L.legend;
    this.legendR.replaceChildren(...(L.ref != null ? [h('b', { 'aria-hidden': 'true' }, '- - -'), ` Last week ${L.ref}`] : []));
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i);
      s.dataset.tone = L.tone(i);
      s.classList.toggle('wr-words', L.words);
      // three figures (100, $1.10) take a smaller face font so neighbors never touch
      s.classList.toggle('wr-long', !L.words && L.val(i).length >= 3);
      s.setAttribute('aria-label', L.say(i));
    });
    this.tagsEl.replaceChildren(...L.tags.map((t) => h('span.wr-tag', { 'data-tone': t.tone, 'data-i': String(t.i), 'data-mid': t.mid ? '1' : '' }, h('b', {}, t.k), t.t)));
    this.placeTags();
  }

  /** Each tag just under the road it spans, clear of the day labels. */
  private placeTags(): void {
    const G = this.G;
    if (!G) return;
    this.tagsEl.querySelectorAll<HTMLElement>('.wr-tag').forEach((el) => {
      const i = Number(el.dataset.i), x = G.xs[i];
      if (x == null) return;
      const w = el.offsetWidth, mid = !!el.dataset.mid && G.xs[i + 1] != null;
      let a = mid ? (x + G.xs[i + 1]) / 2 - w / 2 : x > G.W * 0.6 ? x + (G.laptop ? 40 : 30) - w : x - (G.laptop ? 24 : 18);
      a = Math.max(8, Math.min(a, G.W - 8 - w));
      let y = 0;
      for (let k = a; k <= a + w; k += G.U) y = Math.max(y, this.roadY(k));
      const top = Math.min(y + G.roadH / 2 + (G.laptop ? 14 : 8), G.H - (G.laptop ? 44 : 34) - el.offsetHeight);
      el.style.left = `${Math.round(a)}px`;
      el.style.top = `${Math.round(top)}px`;
    });
  }

  // ---------- time ----------

  private reveal(T: number): number {
    const G = this.G!, I = INTRO[this.play];
    const end = G.xEnd + 80 * G.S;
    if (!I.dur) return end;
    const p = Math.min(1, Math.max(0, (Math.floor(T / F) * F - I.start) / I.dur));
    return -40 + (end + 40) * (1 - (1 - p) ** 2);
  }

  /** When the road reaches x. */
  private crossT(x: number): number {
    const I = INTRO[this.play];
    if (!I.dur) return -Infinity;
    let a = 0, b = I.start + I.dur + F;
    if (this.reveal(b) < x) return Infinity;
    for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (this.reveal(m) >= x) b = m; else a = m; }
    return Math.ceil(b / F) * F;
  }

  private frame(T: number): void {
    this.T = T;
    if (!this.G) this.size();
    if (!this.G) return;
    const I = INTRO[this.play], intro = T < I.start + I.dur + 1500, flip = this.lensAt >= 0 && T - this.lensAt < 1200;
    const loops = !!this.c.rain || this.lens.extra === 'coins' || this.lens.extra === 'creek';
    // after the intro, a quiet road draws only when something moves
    if (!intro && !flip && !loops && this.backKey && !this.still && this.frontDrawn) return;
    this.drawBack(T);
    this.drawFront(T);
    this.drawSigns(T);
    this.frontDrawn = !intro && !flip;
  }
  private frontDrawn = false;

  // ---------- drawing ----------

  private ctx(cv: HTMLCanvasElement): CanvasRenderingContext2D {
    const g = cv.getContext('2d')!, dpr = cv.width / this.G!.W;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    return g;
  }

  /** The hills, firs, land, road, skid marks, brackets and last week's line; drawn again only when they change. */
  private drawBack(T: number): void {
    const G = this.G!, rx = this.reveal(T), key = `${Math.round(rx)}|${this.lens.extra}|${this.lens.ref}|${ok('fir')}`;
    if (key === this.backKey) return;
    this.backKey = key;
    const g = this.ctx(this.back), { W, H, U, S, xs, ys, roadH, xEnd, laptop } = G;
    rect(g, 0, 0, W, H, C.sky);
    for (let x = 0; x < W; x += 4) { const y = G.ridge(x); rect(g, x, y, 4, H - y, C.hill); }
    if (ok('fir')) {
      g.globalAlpha = 0.28;
      for (let k = 0; k < 40; k++) {
        const x = Math.floor((hash(k + 7) * W) / 4) * 4, s = (hash(k + 99) > 0.6 ? 32 : 24) * S;
        g.drawImage(IMG.fir, x - s / 2, G.ridge(x) - s + 6 * S, s, s);
      }
      g.globalAlpha = 1;
    }
    for (let x = 0; x < W; x += U) {
      const cy = this.roadY(x + 1), top = cy - roadH / 2, ahead = x > xEnd + G.plat || this.c.empty;
      if (x > rx) { rect(g, x, top + roadH, U, H - top - roadH, C.groundDk); continue; }
      g.globalAlpha = ahead ? 0.55 : 1;
      rect(g, x, top + roadH, U, H - top - roadH, C.ground);
      for (let y = top + roadH + 6; y < H; y += 6) if (hash(x * 31 + y) > 0.86) rect(g, x, y, U, U, C.speck);
      if (ahead) {
        rect(g, x, top, U, roadH, C.groundDk);
        if ((x / U) % 3 === 0) { rect(g, x, top, U, U, C.roadHi); rect(g, x, top + roadH - U, U, U, C.roadHi); }
      } else {
        rect(g, x, top, U, roadH, C.road);
        rect(g, x, top, U, U, C.roadHi);
        rect(g, x, top + roadH - U, U, U, C.roadDk);
        rect(g, x, top + roadH, U, U, C.grass);
        if (Math.floor(x / (laptop ? 12 : 8)) % 2 === 0) rect(g, x, cy - 1, U, U, C.dash);
      }
      g.globalAlpha = 1;
    }
    // skid marks where hard brakes happened, strong when the question is about them
    this.c.signs.forEach((s, i) => {
      if (!s.hardBrakes || xs[i] > rx) return;
      g.globalAlpha = this.lens.extra === 'skid' ? 1 : 0.45;
      for (let k = 0; k < Math.min(3, s.hardBrakes); k++) {
        const y = ys[i] - roadH / 2 + 4 * S + k * 4 * S;
        for (let x = xs[i] - 22 * S; x < xs[i] - 4 * S; x += U) if (hash(x + k * 13 + i * 7) > 0.25) rect(g, x, y, U, U, C.skid);
      }
      g.globalAlpha = 1;
    });
    // one day, more drives: a bracket over its label
    const by = H - (laptop ? 38 : 28);
    for (const d of this.days()) {
      if (d.is.length < 2) continue;
      rect(g, d.x0 - 6, by, d.x1 - d.x0 + 12, 2, C.ref);
      rect(g, d.x0 - 6, by - 4, 2, 4, C.ref);
      rect(g, d.x1 + 4, by - 4, 2, 4, C.ref);
    }
    if (this.lens.ref != null) {
      const y = G.yOf(this.lens.ref);
      for (let x = 4; x < xEnd + 30; x += 8 * S) rect(g, x, y, 4 * S, 2, C.ref);
    }
  }

  /** Rain over the days ahead, the car, dust, coins, the creek and its fish, and the best drive's sparkle. */
  private drawFront(T: number): void {
    const G = this.G!, g = this.ctx(this.front), { W, H, S, U, xs, ys, roadH, xEnd, laptop } = G;
    g.clearRect(0, 0, W, H);
    const fr = Math.floor(T / F), still = this.still, rx = this.reveal(T);
    if (this.c.rain) {
      // 8 frames a loop: drops step down and left
      const x0 = xEnd + 18 * S, top = (laptop ? 52 : 34) + 34 * S, f8 = still ? 0 : fr % 8, span = H - top, wide = W - x0 - 6;
      const n = wide > 0 ? Math.round(((W - x0) * span) / (laptop ? 700 : 220)) : 0;
      g.fillStyle = C.rain;
      for (let k = 0; k < n; k++) {
        const y = top + Math.floor((((hash(k * 13 + 5) * span) + (f8 * span) / 8) % span) / 2) * 2;
        const x = x0 + Math.floor((((hash(k * 7 + 3) * wide) - f8 * 2 + 400) % wide) / 2) * 2;
        if (y + 8 * S < this.roadY(x) - roadH / 2) { g.fillRect(x, y, U, 3 * U); g.fillRect(x - U, y + 3 * U, U, U); }
      }
    }
    // the car drives the week, then parks just past the latest sign (or waits at Monday)
    const cw = 64 * S, ch = 32 * S, stop = this.c.empty ? G.left + cw : xEnd + 40 * S;
    const cx = Math.round(Math.min(rx, stop) / U) * U - cw;
    const cy = this.roadY(cx + cw / 2) - roadH / 2 - ch + 3 * S;
    const bob = rx < stop - 1 && fr % 2 ? -U : 0;
    if (ok('car')) g.drawImage(IMG.car, cx, cy + bob, cw, ch);
    if (!still) {
      // a puff of dust behind the car at each hard brake as it passes
      this.c.signs.forEach((s, i) => {
        if (!s.hardBrakes || !ok('dust')) return;
        const k = Math.floor((T - this.crossT(xs[i])) / F);
        if (k >= 0 && k < 8) g.drawImage(IMG.dust, k * 48, 0, 48, 32, xs[i] - 40 * S, ys[i] - roadH / 2 - 26 * S, 48 * S, 32 * S);
      });
    }
    if (this.lens.extra === 'coins' && ok('coin')) {
      this.c.signs.forEach((s, i) => {
        if (!s.cents || xs[i] > rx) return;
        // a spin every 1.5 s, each coin a little after the one before
        const k = still ? 0 : (fr + i * 2) % 18, f = k < 6 ? k : 0;
        g.drawImage(IMG.coin, f * 16, 0, 16, 16, xs[i] + 6 * S, ys[i] - roadH / 2 - 14 * S, 16 * S, 16 * S);
      });
    }
    if (this.lens.extra === 'creek' && ok('creek')) {
      const cyk = H - (laptop ? 92 : 48), sf = still ? 0 : Math.floor(T / 166) % 4;
      for (let x = 0; x < W; x += 128 * S) g.drawImage(IMG.creek, sf * 128, 0, 128, 24, x, cyk, 128 * S, 24 * S);
      if (ok('fish')) {
        (laptop ? [0.12, 0.46, 0.74] : [0.08, 0.56]).forEach((p, j) => {
          const f = still ? 0 : Math.floor(T / 100 + j * 3) % 8;
          const drift = still ? 0 : Math.round((Math.sin(T / 1400 + j) * 6) / U) * U;
          g.save();
          g.translate(Math.round(W * p) + drift * S + 64 * S, cyk - 6 * S);
          g.scale(-1, 1);
          g.drawImage(IMG.fish, f * 64, 0, 64, 32, 0, 0, 64 * S, 32 * S);
          g.restore();
        });
      }
    }
    // the best drive's sign sparkles twice as it goes up (6 frames a second, no flashing)
    const b = this.lens.sparkle;
    if (b != null && xs[b] != null && !still && ok('sparkle')) {
      const kb = Math.floor((T - this.crossT(xs[b])) / (F * 2));
      if (kb >= 0 && kb < 8) g.drawImage(IMG.sparkle, (kb % 4) * 16, 0, 16, 16, xs[b] + G.sw / 2 - 6 * S, ys[b] - roadH / 2 - G.post - G.sh - 8 * S, 16 * S, 16 * S);
    }
  }

  /** Signs pop up as the car passes, then count to their value; a new question flips them. */
  private drawSigns(T: number): void {
    const G = this.G!, L = this.lens, play = this.play;
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i), t = this.crossT(G.xs[i]), face = s.firstElementChild as HTMLElement;
      if (T < t) { s.style.visibility = 'hidden'; return; }
      s.style.visibility = '';
      const pop = Math.floor((T - t) / F);
      let tf = pop < 3 ? `translateY(${(3 - pop) * 4}px) scaleY(${[0.4, 0.7, 0.9][pop]})` : '';
      const fk = this.lensAt >= 0 ? Math.floor((T - this.lensAt) / F) : 99;
      if (fk < 2 && pop >= 3) tf = `scaleY(${fk === 0 ? 0.5 : 0.2})`;
      s.style.transform = tf;
      const val = L.val(i), n = parseInt(val, 10);
      // count in 6 steps: from the start of the drive in, or from the flip
      const from = this.lensAt >= 0 && this.lensAt > t ? this.lensAt + 2 * F : t + F;
      const k = Math.floor((T - from) / F), counts = play === 'intro' || this.lensAt >= 0;
      if (!counts || L.words || Number.isNaN(n) || k >= 6 || this.still || String(n) !== val) { face.textContent = val; return; }
      const b = L.base(i);
      face.textContent = String(Math.round(b + ((n - b) * Math.max(0, k)) / 6));
    });
    this.tagsEl.style.visibility = T >= this.crossT(G.xEnd) + 3 * F ? '' : 'hidden';
  }
}
