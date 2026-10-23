// My drives, the week road: each drive is a road sign on a winding road that climbs when you get smoother. Behind it the
// sky by the clock and the NWS forecast, Mount Rainier, the foothills and a fir hill. The car drives the week in, signs
// pop up and count, dust where you braked hard, headlights after dark, rain when it falls or is coming.
// Painted in art pixels (1 on a phone, 2 on a laptop) on two canvases at 12 frames a second; the signs are real buttons.
import { h } from '../dom.ts';
import { calm } from '../ui/ui.ts';
import { canvas, paintGround, paintLand, rnd, type Land, type Pal } from './history-land.ts';
import { roadScale, type Light, type Weather } from './history-week.ts';
import { run } from './pixel-anim.ts';

export type Tone = '' | 'hard' | 'best' | 'quiet';
export type Extra = 'skid' | 'coins' | 'creek' | null;

/** one sign: its day (0 Monday) and what the road needs from it */
export interface RoadSign { day: number; score: number; hardBrakes: number; cents: number | null }

/** what the road shows for one question */
export interface RoadLens {
  legend: string;
  /** the word on each sign over its value: "Score" */
  kicker: string;
  /** last week's score as a dashed line, and its words ("Last week"), or null */
  ref: number | null;
  refWord?: string;
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

/** the sky: light by the Washington clock, weather from the forecast */
export interface RoadSky { light: Light; weather: Weather; now: number }

export interface RoadIn {
  signs: readonly RoadSign[];
  /** last week's score, for the scale */
  last: number | null;
  /** the days still ahead, "Fri to Sun" on laptop; '' with none */
  ahead: { short: string; long: string };
  /** rain coming: 'tomorrow' and so on; null with none */
  rain: string | null;
  sky: RoadSky;
  /** no drives: the car waits at the start */
  empty: boolean;
  open(i: number): void;
}

/** how the road arrives: the car drives it in, drives the new week (no counting), or it is simply there */
export type Play = 'intro' | 'week' | 'still';
export interface RoadClock { play: Play; t0: number; lensAt: number }

const F = 1000 / 12;
const INTRO = { intro: { start: 250, dur: 2600 }, week: { start: 0, dur: 1200 }, still: { start: 0, dur: 0 } } as const;
/** the steepest a stretch of road may climb, rise over run */
const SLOPE = 1;
const C = { skid: '#ff7a66', rubber: '#141716', ref: '#d6ddd8', rain: '#9cc4dc', splash: '#d8ecf6', beam: '#ffe7a3', lamp: '#fff6d8', tail: '#ff5a4a', bracket: '#56635b' };

// ---------- art ----------

const IMG: Record<string, HTMLImageElement> = {};
const ART: Record<string, string> = {
  car: 'art/anim/car-side.png', dust: 'art/anim/dust-puff.png', coin: 'art/anim/coin-spin.png', creek: 'art/anim/creek-strip.png',
  fish: 'art/anim/salmon-swim.png', sparkle: 'art/anim/sparkle.png', mtn: 'art/drives/rainier.png',
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
const px = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h2: number, c: string) => { g.fillStyle = c; g.fillRect(x, y, w, h2); };
const ease = (t: number) => t * t * (3 - 2 * t);

/** Everything in art pixels, except W, H (CSS px). */
interface Geo {
  W: number; H: number; S: number; dpr: number; Wa: number; Ha: number; laptop: boolean;
  xs: number[]; ys: number[]; road: Int16Array; roadH: number; plat: number; xEnd: number;
  yOf(score: number): number; horizon: number; footTop: number;
  /** sign face and post, CSS px */
  sw: number; sh: number; post: number;
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
  /** the painted part, under the legend */
  private readonly scene: HTMLElement;
  private G: Geo | null = null;
  private land: Land | null = null;
  private near: HTMLCanvasElement | null = null;
  private nearKey = '';
  private play: Play;
  private t0 = 0;
  private lensAt = -1;
  private readonly still: boolean;
  private T = 0;
  private drawn = '';

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
    this.scene = h('div.wr-scene', {}, this.back, this.rainEl, this.signsEl, this.tagsEl, this.front);
    this.el = h('section.wr-stage', { 'aria-labelledby': id, 'data-light': c.sky.light },
      h('div.wr-legend', {}, this.legendT, this.legendR), this.scene);
    this.signsEl.append(...c.signs.map((_, i) => h('button.wr-sign', { type: 'button', 'data-i': String(i), onclick: () => c.open(i) },
      h('span.wr-face', {}, h('span.wr-kick', { 'aria-hidden': 'true' }), h('span.wr-val')), h('span.wr-post', { 'aria-hidden': 'true' }))));
    this.paintLens();
    this.setRain(c.rain);
    void loadArt().then(() => { this.land = null; this.kick(); });
    new ResizeObserver(() => { if (this.el.isConnected) { this.size(); this.kick(); } }).observe(this.scene);
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
    const now = this.c.sky.weather === 'rain' ? 'Rain now' : '';
    this.rainEl.textContent = when || now ? `${when ? `Rain ${when}` : now}, from the National Weather Service. Brake gently.` : '';
    this.size();
    this.kick();
  }

  setSky(sky: RoadSky): void {
    if (sky.light === this.c.sky.light && sky.weather === this.c.sky.weather) return;
    this.c.sky = sky;
    this.el.dataset.light = sky.light;
    this.land = null;
    this.nearKey = '';
    this.setRain(this.c.rain);
  }

  /** a still screen draws once now; a moving one on its next frame */
  private kick(): void {
    if (!this.G) this.size();
    this.drawn = '';
    if (this.still) this.frame(1e9);
  }

  // ---------- layout ----------

  private geometry(): Geo | null {
    const W = this.scene.clientWidth, H = this.scene.clientHeight;
    if (!W || !H) return null;
    const cs = getComputedStyle(this.el), v = (k: string, d: number) => parseFloat(cs.getPropertyValue(k)) || d;
    const S = v('--S', 1), laptop = S > 1, dpr = Math.max(1, Math.round(devicePixelRatio || 1));
    const Wa = Math.ceil(W / S), Ha = Math.ceil(H / S);
    const sw = v('--sw', 46), sh = v('--sh', 38), post = v('--post', 22);
    const signs = this.c.signs, n = signs.length, roadH = laptop ? 7 : 8;
    // the strip at the foot holds the day names; with none to show there is no strip
    const named = n > 0 || !!(laptop ? this.c.ahead.long : this.c.ahead.short);
    const left = v('--left', 32) / S, tail = v('--tail', 66) / S, footTop = Ha - (named ? Math.round(v('--foot', 26) / S) : 0);
    const span = Wa - left - tail, step = n > 1 ? span / (n - 1 + 0.35) : span;
    const xs = n === 1 ? [Math.round(left + span * 0.3)] : signs.map((_, i) => Math.round(left + i * step));
    const plat = Math.max(3, Math.round(Math.min(laptop ? 10 : 8, step * 0.16)));
    // the band the road may use: under the legend and the tallest sign, over the tags and the foot
    const yTop = Math.ceil((v('--top', 40) + sh + post) / S + roadH / 2);
    const yBot = Math.floor(footTop - v('--tagroom', 40) / S - roadH / 2);
    const scores = signs.map((s) => s.score), ref = this.c.last;
    const all = ref != null ? [...scores, ref] : scores;
    const lo = n ? Math.min(...all) : 0, hi = n ? Math.max(...all) : 0, mid = (yTop + yBot) / 2;
    const runs = xs.slice(1).map((x, i) => x - xs[i] - 2 * plat);
    const k = n ? roadScale(scores, Math.max(8, yBot - yTop), runs, SLOPE / 1.5) : 0;
    const kk = Math.min(k, (yBot - yTop) / Math.max(16, hi - lo));
    // the road keeps low, so the sky, the mountain and the fir hill get the room
    const floor = yBot - Math.max(0, yBot - yTop - Math.max(16, hi - lo) * kk) * 0.18;
    const yOf = (s: number) => Math.round(Math.min(yBot, Math.max(yTop, floor - (s - lo) * kk)));
    const ys = scores.map(yOf);
    // the road for each column: level at each sign, an eased climb between, then on toward the days ahead
    const road = new Int16Array(Wa + 2), flat = Math.round(yBot - (yBot - yTop) * 0.12);
    const xEnd = n ? xs[n - 1] : Math.round(left);
    for (let x = 0; x < Wa + 2; x++) {
      let y = flat;
      if (n) {
        y = ys[0];
        for (let i = 0; i < n - 1; i++) {
          const a = xs[i] + plat, b = xs[i + 1] - plat;
          if (x > a && x < b) { y = ys[i] + (ys[i + 1] - ys[i]) * ease((x - a) / (b - a)); break; }
          if (x >= b) y = ys[i + 1];
        }
        const a = xEnd + plat + 14, b = Wa - 4, to = Math.round((ys[n - 1] * 2 + mid) / 3);
        if (x > a && b > a) y = ys[n - 1] + (to - ys[n - 1]) * ease(Math.min(1, (x - a) / (b - a)));
      }
      road[x] = Math.round(y);
    }
    // the fir hill rises behind the road's highest stretch, never above the upper third
    const horizon = Math.round(Math.max(Ha * 0.34, Math.min(...Array.from(road.subarray(0, Wa))) - (laptop ? 10 : 14)));
    return { W, H, S, dpr, Wa, Ha, laptop, xs, ys, road, roadH, plat, xEnd, yOf, horizon, footTop, sw, sh, post };
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
    for (const cv of [this.back, this.front]) {
      cv.width = G.Wa * G.S * G.dpr;
      cv.height = G.Ha * G.S * G.dpr;
      cv.style.width = `${G.Wa * G.S}px`;
      cv.style.height = `${G.Ha * G.S}px`;
    }
    this.land = null;
    this.nearKey = '';
    this.drawn = '';
    const { S } = G;
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i);
      s.style.cssText = `left:${G.xs[i] * S}px;top:${(G.ys[i] - G.roadH / 2) * S - G.post - G.sh}px`;
    });
    // day names in the strip at the foot, out of the reading order (aria-hidden)
    this.signsEl.querySelectorAll('.wr-day, .wr-tag-rain').forEach((e) => e.remove());
    const mid = (G.footTop + G.Ha) / 2 * S, DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const extra: HTMLElement[] = this.days().map((d) => h('span.wr-day', { 'aria-hidden': 'true', style: `left:${d.x * S}px;top:${mid}px` }, DAY[d.day]));
    const ahead = G.laptop ? this.c.ahead.long : this.c.ahead.short;
    if (ahead) extra.push(h('span.wr-day.wr-ahead', { 'aria-hidden': 'true', style: `left:${this.tailX() * S}px;top:${mid}px` }, ahead));
    if (this.c.rain && G.laptop) {
      extra.push(h('span.wr-tag.wr-tag-rain', { 'data-tone': 'soak', 'aria-hidden': 'true', style: `left:${this.tailX() * S}px;top:${G.footTop * S - 70}px` }, h('b', {}, `Rain ${this.c.rain}`), 'Brake gently'));
    }
    this.signsEl.append(...extra);
    this.placeTags();
  }

  /** where the car stops: just past the latest sign, or a little way in on an empty road */
  private park(): number {
    const G = this.G!;
    return this.c.empty ? Math.round(Math.min(G.Wa * 0.34, 160)) : G.xEnd + 44;
  }

  /** the middle of the road still ahead */
  private tailX(): number {
    const G = this.G!, x0 = this.c.empty ? this.park() : G.xEnd + G.plat + 24;
    return Math.round(x0 + (G.Wa - x0) / 2);
  }

  /** The legend, each sign's tone, word and label, and the tags, for the lens. */
  private paintLens(): void {
    const L = this.lens;
    this.legendT.textContent = L.legend;
    this.legendR.hidden = L.ref == null;
    this.legendR.replaceChildren(...(L.ref != null ? [h('b', { 'aria-hidden': 'true' }, '- - -'), ` ${L.refWord ?? 'Last week'} ${L.ref}`] : []));
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i);
      s.dataset.tone = L.tone(i);
      s.classList.toggle('wr-words', L.words);
      // three figures (100, $1.10) take a smaller face font so neighbors never touch
      s.classList.toggle('wr-long', !L.words && L.val(i).length >= 3);
      (s.querySelector('.wr-kick') as HTMLElement).textContent = L.kicker;
      // a tag on the sign is read with it, before what a tap does: "... Hardest: 2 hard brakes. Open on the map."
      const tag = L.tags.find((t) => t.i === i), say = L.say(i);
      s.setAttribute('aria-label', tag ? say.replace(/\. ([^.]+)\.$/, `. ${tag.k}: ${tag.t}. $1.`) : say);
    });
    this.tagsEl.replaceChildren(...L.tags.map((t) => h('span.wr-tag', { 'data-tone': t.tone, 'data-i': String(t.i), 'data-mid': t.mid ? '1' : '' }, h('b', {}, t.k), t.t)));
    this.placeTags();
  }

  /** Each tag just under the road it spans, clear of the foot. */
  private placeTags(): void {
    const G = this.G;
    if (!G) return;
    const S = G.S;
    this.tagsEl.querySelectorAll<HTMLElement>('.wr-tag').forEach((el) => {
      const i = Number(el.dataset.i), x = G.xs[i];
      if (x == null) return;
      const w = el.offsetWidth, mid = !!el.dataset.mid && G.xs[i + 1] != null, W = G.Wa * S;
      let a = mid ? ((x + G.xs[i + 1]) / 2) * S - w / 2 : x * S > W * 0.6 ? x * S + (G.laptop ? 40 : 30) - w : x * S - (G.laptop ? 24 : 18);
      a = Math.max(8, Math.min(a, W - 8 - w));
      let y = 0;
      for (let k = Math.floor(a / S); k <= (a + w) / S; k++) y = Math.max(y, G.road[Math.min(G.Wa, Math.max(0, k))]);
      const top = Math.min((y + G.roadH / 2) * S + (G.laptop ? 14 : 8), G.footTop * S - 6 - el.offsetHeight);
      el.style.left = `${Math.round(a)}px`;
      el.style.top = `${Math.round(top)}px`;
    });
  }

  // ---------- time ----------

  /** How far the road is driven, art px. */
  private reveal(T: number): number {
    const G = this.G!, I = INTRO[this.play], end = this.park();
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
    const f = Math.floor(T / F), w = this.c.sky.weather;
    // after the intro a quiet road redraws only when something moves: rain every frame, clouds and stars now and then
    const loops = !!this.c.rain || w === 'rain' || this.lens.extra === 'coins' || this.lens.extra === 'creek';
    const key = this.still ? 's' : intro || flip || loops ? String(f) : String(Math.floor(f / 6));
    if (key === this.drawn) return;
    this.drawn = key;
    this.drawBack(T);
    this.drawFront(T);
    this.drawSigns(T);
  }

  // ---------- drawing ----------

  private ctx(cv: HTMLCanvasElement): CanvasRenderingContext2D {
    const g = cv.getContext('2d')!, G = this.G!, k = G.S * G.dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.imageSmoothingEnabled = false;
    return g;
  }

  private sky(): Land {
    const G = this.G!;
    return (this.land ??= paintLand({
      w: G.Wa, h: G.Ha, horizon: G.horizon, light: this.c.sky.light, weather: this.c.sky.weather, now: this.c.sky.now,
      mountain: ok('mtn') ? IMG.mtn : null, scale: G.S,
    }));
  }

  /** The near ground, guardrail, road and foot strip, painted once a size and lens. */
  private nearLayer(p: Pal): HTMLCanvasElement {
    const G = this.G!, key = `${this.lens.extra}|${G.Wa}|${G.Ha}|${this.c.sky.light}|${this.c.sky.weather}`;
    if (this.near && key === this.nearKey) return this.near;
    this.nearKey = key;
    const { Wa, Ha, road, roadH, footTop, xs, ys, xEnd, plat } = G, half = roadH / 2;
    const cv = (this.near = canvas(Wa, Ha)), g = cv.getContext('2d')!;
    const aheadX = this.c.empty ? 0 : xEnd + plat + 6;
    paintGround(g, Wa, footTop, (x) => road[x] + Math.ceil(half), p, 11, G.S);
    let dash = 0;
    for (let x = 0; x < Wa; x++) {
      const cy = road[x], top = Math.round(cy - half), ahead = x >= aheadX;
      const [asphalt, edge, line, rail] = p.road;
      // the guardrail on the far side: a rail and a post every 8 px
      px(g, x, top - 3, 1, 1, rail);
      if (x % 8 === 0) px(g, x, top - 3, 1, 3, rail);
      px(g, x, top, 1, roadH, asphalt);
      px(g, x, top, 1, 1, edge);
      px(g, x, top + roadH - 2, 1, 1, ahead && x % 3 ? asphalt : edge);
      px(g, x, top + roadH - 1, 1, 1, '#0c0f0e');
      if (!ahead) {
        if (Math.floor(dash / (G.laptop ? 5 : 4)) % 2 === 0) px(g, x, Math.round(cy) - 1, 1, 1, line);
        // the dashes follow the road's length, not just its width
        dash += Math.hypot(1, road[x + 1] - road[x]);
      }
      if (ahead) { g.globalAlpha = 0.35; px(g, x, top, 1, roadH, '#000'); g.globalAlpha = 1; }
    }
    // tire marks where hard brakes happened: red when the question is about them
    this.c.signs.forEach((s, i) => {
      if (!s.hardBrakes) return;
      const hr = rnd(i + 9);
      for (let k = 0; k < Math.min(3, s.hardBrakes); k++) {
        const y = ys[i] - half + 2 + k * 2;
        for (let x = xs[i] - 22; x < xs[i] - 3; x++) if (hr() > 0.22) px(g, x, y, 1, 1, this.lens.extra === 'skid' ? C.skid : C.rubber);
      }
    });
    // the strip at the foot, and a bracket over a day with two drives or more
    px(g, 0, footTop, Wa, Ha - footTop, p.foot);
    px(g, 0, footTop, Wa, 1, '#1f2b24');
    for (const d of this.days()) {
      if (d.is.length < 2) continue;
      const by = footTop + (G.laptop ? 3 : 4);
      px(g, d.x0 - 5, by, d.x1 - d.x0 + 10, 1, C.bracket);
      px(g, d.x0 - 5, by, 1, 3, C.bracket);
      px(g, d.x1 + 4, by, 1, 3, C.bracket);
    }
    return cv;
  }

  /** Sky, clouds, the hills with a little parallax, the road as far as it is driven, and last week's line. */
  private drawBack(T: number): void {
    const G = this.G!, g = this.ctx(this.back), L = this.sky(), { Wa, Ha, xEnd } = G, still = this.still;
    const rx = this.reveal(T), end = this.park(), prog = Math.max(0, Math.min(1, (rx + 40) / (end + 40)));
    g.clearRect(0, 0, Wa, Ha);
    g.drawImage(L.sky, 0, 0);
    if (L.pal.star && !still) {
      const f = Math.floor(T / 500);
      L.twinkle.forEach(([x, y], i) => { if ((f + i) % 5 === 0) px(g, x, y, 1, 1, L.pal.sky[1]); });
    }
    const drift = still ? 0 : T / 1000;
    for (const c of L.clouds) {
      const span = Wa + c.img.width + 60, x = ((((c.x + drift * c.v - prog * 2) % span) + span) % span) - c.img.width - 30;
      g.drawImage(c.img, Math.round(x), c.y);
    }
    g.drawImage(L.far, -Math.round(prog * 4), 0);
    g.drawImage(L.mid, -Math.round(prog * 10), 0);
    const near = this.nearLayer(L.pal);
    g.drawImage(near, 0, 0);
    // road not yet driven is in shadow, until the car parks
    if (rx < end && !this.c.empty) {
      g.globalAlpha = 0.55;
      g.fillStyle = '#050807';
      for (let x = Math.max(0, Math.ceil(rx)); x < Wa; x++) { const t = G.road[x] - G.roadH / 2 - 4; g.fillRect(x, t, 1, G.footTop - t); }
      g.globalAlpha = 1;
    }
    if (this.lens.ref != null && this.c.signs.length) {
      const y = G.yOf(this.lens.ref);
      g.globalAlpha = 0.7;
      for (let x = 4; x < Math.min(rx, xEnd + 18); x += 6) px(g, x, y, 3, 1, C.ref);
      g.globalAlpha = 1;
    }
    this.drawRain(g, T);
  }

  /** Rain behind the signs: everywhere when it falls now, else from a cloud over the days ahead when it is coming. */
  private drawRain(g: CanvasRenderingContext2D, T: number): void {
    const G = this.G!, { Wa, road, roadH, xEnd, footTop } = G, half = roadH / 2, w = this.c.sky.weather;
    if (w !== 'rain' && !this.c.rain) return;
    const fr = Math.floor(T / F), still = this.still;
    const x0 = w === 'rain' ? 0 : this.c.empty ? Math.round(Wa * 0.45) : xEnd + G.plat + 10;
    const f8 = still ? 0 : fr % 8, wide = Wa - x0 + 8, top = w === 'rain' ? 0 : Math.round(G.horizon * 0.45);
    if (w !== 'rain' && wide > 20) {
      const cx = x0 + Math.round(wide / 2) - 32, cy = top - 10;
      for (let y = 0; y < 18; y++) for (let x = 0; x < 66; x++) {
        const inA = (x - 18) ** 2 + (y - 12) ** 2 < 49, inB = (x - 33) ** 2 + (y - 8) ** 2 < 100, inC = (x - 49) ** 2 + (y - 12) ** 2 < 56;
        if (inA || inB || inC) { g.fillStyle = y > 13 ? '#28313a' : y < 4 ? '#5a6670' : '#46525c'; g.fillRect(cx + x, cy + y, 1, 1); }
      }
    }
    const span = footTop - top, n = wide > 0 ? Math.round((wide * span) / (w === 'rain' ? 170 : 150)) : 0;
    g.fillStyle = C.rain;
    g.globalAlpha = 0.85;
    for (let k = 0; k < n; k++) {
      const y = top + 8 + ((Math.floor(rndAt(k * 13 + 5) * span) + Math.floor((f8 * span) / 8)) % span);
      const x = x0 + ((Math.floor(rndAt(k * 7 + 3) * wide) - f8 * 2 + 4000) % wide);
      if (y + 3 < road[Math.min(Wa, Math.max(0, x))] - half) { g.fillRect(x, y, 1, 3); g.fillRect(x - 1, y + 3, 1, 1); }
    }
    g.globalAlpha = 1;
    // splashes on the road
    if (!still) {
      g.fillStyle = C.splash;
      for (let k = 0; k < Math.round(wide / 14); k++) {
        const x = x0 + Math.floor(rndAt(k * 31 + fr * 7) * wide);
        if (x < Wa && (fr + k) % 3 === 0) g.fillRect(x, road[x] - half + 1, 1, 1);
      }
    }
  }

  /** The car and its lights, dust, coins, the creek and its fish, and the best drive's sparkle. */
  private drawFront(T: number): void {
    const G = this.G!, g = this.ctx(this.front), { Wa, Ha, xs, ys, road, roadH, xEnd, footTop } = G, half = roadH / 2;
    g.clearRect(0, 0, Wa, Ha);
    const fr = Math.floor(T / F), still = this.still, rx = this.reveal(T), w = this.c.sky.weather, light = this.c.sky.light;
    // the car drives the week, then parks just past the latest sign (or waits at the start)
    const stop = this.park();
    const cx = Math.round(Math.min(rx, stop)) - 64, moving = rx < stop - 1;
    const c0 = Math.max(0, Math.min(Wa, cx + 16)), c1 = Math.max(0, Math.min(Wa, cx + 48));
    const slope = Math.max(-0.42, Math.min(0.42, (road[c1] - road[c0]) / 32));
    const cy = road[Math.max(0, Math.min(Wa, cx + 32))] + 2 - 31 + (moving && fr % 2 ? -1 : 0);
    const lights = light === 'night' || light === 'dusk' || w === 'rain';
    if (lights && cx > -64) {
      // headlights: a beam on the road ahead in three steps
      const hx = cx + 62, hy = cy + 19 + Math.round(slope * 30);
      for (let dx = 1; dx < 66; dx++) {
        const x = hx + dx;
        if (x >= Wa) break;
        const yc = hy + slope * dx, t = Math.round(yc - dx * 0.1), b = Math.min(Math.round(yc + dx * 0.32), road[x] + Math.floor(half));
        g.globalAlpha = dx < 20 ? 0.42 : dx < 42 ? 0.26 : 0.13;
        if (b > t) px(g, x, t, 1, b - t, C.beam);
      }
      g.globalAlpha = 1;
    }
    if (ok('car')) {
      // a column at a time, sheared to the road's slope, so the wheels sit on it
      for (let col = 0; col < 64; col++) g.drawImage(IMG.car, col, 0, 1, 32, cx + col, cy + Math.round(slope * (col - 32)), 1, 32);
      if (lights) {
        px(g, cx + 61, cy + 18 + Math.round(slope * 29), 2, 2, C.lamp);
        px(g, cx + 1, cy + 16 + Math.round(slope * -31), 1, 2, C.tail);
      }
    }
    if (!still) {
      // a puff of dust behind the car at each hard brake as it passes
      this.c.signs.forEach((s, i) => {
        if (!s.hardBrakes || !ok('dust')) return;
        const k = Math.floor((T - this.crossT(xs[i])) / F);
        if (k >= 0 && k < 8) g.drawImage(IMG.dust, k * 48, 0, 48, 32, xs[i] - 40, ys[i] - half - 24, 48, 32);
      });
    }
    if (this.lens.extra === 'coins' && ok('coin')) {
      this.c.signs.forEach((s, i) => {
        if (!s.cents || xs[i] > rx) return;
        // a spin every 1.5 s, each coin a little after the one before
        const k = still ? 0 : (fr + i * 2) % 18, f = k < 6 ? k : 0;
        g.drawImage(IMG.coin, f * 16, 0, 16, 16, xs[i] + 5, ys[i] - half - 15, 16, 16);
      });
    }
    if (this.lens.extra === 'creek' && ok('creek')) {
      const cyk = footTop - 24, sf = still ? 0 : Math.floor(T / 166) % 4;
      for (let x = 0; x < Wa; x += 128) g.drawImage(IMG.creek, sf * 128, 0, 128, 24, x, cyk, 128, 24);
      if (ok('fish')) {
        (G.laptop ? [0.12, 0.46, 0.74] : [0.08, 0.56]).forEach((p, j) => {
          const f = still ? 0 : Math.floor(T / 100 + j * 3) % 8, drift = still ? 0 : Math.round(Math.sin(T / 1400 + j) * 6);
          g.save();
          g.translate(Math.round(Wa * p) + drift + 64, cyk - 6);
          g.scale(-1, 1);
          g.drawImage(IMG.fish, f * 64, 0, 64, 32, 0, 0, 64, 32);
          g.restore();
        });
      }
    }
    // the best drive's sign sparkles twice as it goes up (6 frames a second, no flashing)
    const b = this.lens.sparkle;
    if (b != null && xs[b] != null && !still && ok('sparkle')) {
      const kb = Math.floor((T - this.crossT(xs[b])) / (F * 2));
      const top = (ys[b] - half) - (G.post + G.sh) / G.S;
      if (kb >= 0 && kb < 8) g.drawImage(IMG.sparkle, (kb % 4) * 16, 0, 16, 16, xs[b] + G.sw / 2 / G.S - 8, top - 8, 16, 16);
    }
  }

  /** Signs pop up as the car passes, then count to their value; a new question flips them. */
  private drawSigns(T: number): void {
    const G = this.G!, L = this.lens, play = this.play;
    this.signsEl.querySelectorAll<HTMLElement>('.wr-sign').forEach((s) => {
      const i = Number(s.dataset.i), t = this.crossT(G.xs[i]), face = s.querySelector('.wr-val') as HTMLElement;
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

/** a fixed random for a whole number, for rain that loops */
function rndAt(n: number): number {
  n = (n ^ 61) ^ (n >>> 16); n += n << 3; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}
