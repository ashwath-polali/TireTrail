// The live driving screen: a heading-up pixel road with the next salmon creek sliding toward the car, one line, and the speed.
// Keys show only while parked. The words come from drive-coach.ts; the state from drive-screen.ts.
import { SPRITES } from '../anim/sprites.ts';
import type { Frames } from '../anim/px.ts';
import { h } from '../dom.ts';
import { button, calm, glyph, salmonSVG } from '../ui/ui.ts';
import { REC } from './drive-words.ts';
import { gentleLabel, NEAR_M, ROAD_L, roadDist, roadLine, roadY, SPOT_SHOW_M, type RoadLine } from './drive-coach.ts';

const C = {
  grass: '#1f3a28', speck: '#2a4a33', speck2: '#183021', road: '#3a403d', edge: '#59625d', dash: '#c9a54a',
  bank: '#2c4a3a', rail: '#b9c2bc', fog: '#14261b', plate: '#070a09', text: '#eef3ef',
  soak: '#7fd8c0', salmon: '#e98552', warn: '#ffb547', dark: '#0b0f0d', splash: '#cfe6e8',
};

const img = (src: string) => (typeof Image === 'undefined' ? null : Object.assign(new Image(), { src }));
const CAR = img('art/anim/car-top.png'), FIR = img('art/anim/fir.png');

/** a small seeded hash, 0..1, so the trees stay put */
function hash(a: number, b: number): number {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

interface Creek { id: string; name: string; m: number; to: number; at: number; passed: boolean; gentle: boolean; leap: number }
interface Puff { t: number }

export interface LiveRoadIn { autoEnds: boolean; muted: boolean; locked: boolean; end(): void; toggleVoice(): void; unlock(): void }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class LiveRoad {
  readonly el: HTMLElement;
  private readonly cv: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly timeEl: HTMLElement;
  private readonly fishEl: HTMLElement;
  private readonly fishN: HTMLElement;
  private readonly voiceOff: HTMLElement;
  private readonly lineEl: HTMLElement;
  private readonly askEl: HTMLElement;
  private readonly askT: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly speedN: HTMLElement;
  private readonly sign: HTMLElement;
  private readonly signN: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly vk: HTMLElement;
  private readonly note: HTMLElement;
  // what the road shows
  private v = 0;
  private odo = 0;
  private creeks: Creek[] = [];
  private spot: { m: number; to: number; at: number } | null = null;
  private puffs: Puff[] = [];
  private status = '';
  private temp: (RoadLine & { until: number }) | null = null;
  private shown = '';
  private isParked = true;
  private wantAsk = false;
  private raf = 0;
  private last = 0;
  private drawn = 0;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private readonly ro: ResizeObserver | null;

  constructor(c: LiveRoadIn) {
    this.timeEl = h('span.lr-time', {}, '0:00');
    this.voiceOff = h('span.lr-mute', { hidden: true }, h('span.u-ico', { 'aria-hidden': 'true', html: glyph('sound') }), 'Voice off');
    this.fishN = h('b', {}, '0 gentle');
    this.fishEl = h('span.lr-fish', { 'data-n': '0', role: 'img', 'aria-label': gentleLabel(0) }, h('span', { 'aria-hidden': 'true', html: salmonSVG(2) }), this.fishN);
    this.cv = h('canvas.lr-cv', { role: 'img', 'aria-label': 'The road ahead' }) as HTMLCanvasElement;
    this.ctx = this.cv.getContext('2d')!;
    this.lineEl = h('p.lr-line', { 'aria-live': 'polite' });
    this.askT = h('b', {}, '');
    this.askEl = h('button.lr-ask', { type: 'button', hidden: true, onclick: () => c.unlock() },
      h('span.u-ico', { 'aria-hidden': 'true', html: glyph('sound', 3) }), h('span', {}, this.askT, h('span', {}, 'Before you pull out.')));
    this.speedN = h('b', {}, '0');
    this.signN = h('b', {}, '');
    this.sign = h('span.lr-sign', { role: 'img', hidden: true }, h('small', { 'aria-hidden': 'true' }, 'SPEED'), h('small', { 'aria-hidden': 'true' }, 'LIMIT'), this.signN);
    this.speedEl = h('div.lr-speed', {}, h('span.lr-mph', {}, this.speedN, h('span', {}, 'mph')), this.sign);
    // a switch, so it says both what it is and whether it's on
    this.vk = h('button.u-btn.u-secondary.dv-voice', { type: 'button', role: 'switch', 'aria-label': 'Voice tips', onclick: () => c.toggleVoice() });
    this.keys = h('div.lr-keys', { hidden: true }, this.vk, button('End drive', { kind: 'primary', icon: 'end', onClick: c.end }));
    this.note = h('p.lr-note', { hidden: true }, c.autoEnds ? REC.autoEnds : '');
    this.el = h('section.lr', { 'aria-label': 'Recording' },
      h('header.lr-top', {}, h('span.lr-rec', {}, h('i', { 'aria-hidden': 'true' }), h('b', {}, 'REC'), this.timeEl), this.voiceOff, this.fishEl),
      h('div.lr-road', {}, this.cv),
      h('div.lr-read', {}, h('div.lr-say', {}, this.lineEl, this.askEl), this.speedEl, this.keys, this.note));
    this.voice(c.muted, c.locked);
    this.parked(true);
    this.ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.size());
    this.ro?.observe(this.cv);
    void document.fonts?.load('700 16px Silkscreen').then(() => this.draw(performance.now()));
    for (const f of [SPRITES.coho, SPRITES.creek, SPRITES.puff, SPRITES.sparkle]) void f.ready?.then(() => this.draw(performance.now()));
    for (const i of [CAR, FIR]) i?.addEventListener('load', () => this.draw(performance.now()));
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Stops drawing; the element can go. */
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
  }

  // ---------- inputs ----------

  /** Time and whether there's a fix yet. */
  set(sec: number, fix: boolean): void {
    const t = clock(sec);
    if (this.timeEl.textContent !== t) this.timeEl.textContent = t;
    this.el.classList.toggle('lr-nofix', !fix);
  }

  /** Speed now, m/s; limit in mph when known. */
  speed(v: number, limitMph: number | null): void {
    this.v = v;
    const mph = String(Math.round(v / 0.44704));
    if (this.speedN.textContent !== mph) this.speedN.textContent = mph;
    this.sign.hidden = !limitMph;
    if (limitMph && this.signN.textContent !== String(limitMph)) {
      this.signN.textContent = String(limitMph);
      this.sign.setAttribute('aria-label', `Speed limit ${limitMph}`);
    }
    this.speedEl.dataset.over = String(!!limitMph && v / 0.44704 > limitMph + 5);
  }

  /** The next salmon creek and learned spot ahead, meters (null: none). */
  ahead(fish: { id: string; name: string; m: number } | null, spot: { m: number } | null): void {
    const now = performance.now();
    // a creek the car didn't reach (it turned off) goes; one driven over keeps sliding by
    this.creeks = this.creeks.filter((k) => k.passed || k.id === fish?.id);
    if (fish) {
      const k = this.creeks.find((x) => x.id === fish.id && !x.passed);
      if (k) [k.to, k.at] = [fish.m, now];
      else this.creeks.push({ id: fish.id, name: fish.name, m: fish.m, to: fish.m, at: now, passed: false, gentle: false, leap: 0 });
    }
    if (spot) this.spot = this.spot ? { ...this.spot, to: spot.m, at: now } : { m: spot.m, to: spot.m, at: now };
    else this.spot = null;
    this.say();
  }

  /** The car drove over a salmon creek. */
  crossed(id: string, name: string, gentle: boolean, line: RoadLine): void {
    let k = this.creeks.find((x) => x.id === id);
    if (!k) this.creeks.push((k = { id, name, m: 0, to: 0, at: performance.now(), passed: true, gentle, leap: 0 }));
    [k.passed, k.gentle, k.m] = [true, gentle, Math.min(k.m, 2)];
    if (gentle) k.leap = performance.now();
    this.flash(line, 6000);
  }

  /** A hard brake: a puff of tire dust behind the car. */
  brake(): void {
    this.puffs.push({ t: performance.now() });
    if (this.puffs.length > 4) this.puffs.shift();
  }

  /** A line for a few seconds over what the road would say. */
  flash(line: RoadLine, ms: number): void {
    this.temp = { ...line, until: Date.now() + ms };
    this.say();
  }

  /** The status when nothing else is going on (recording, paused, no GPS). */
  setStatus(text: string): void {
    this.status = text;
    this.say();
  }

  /** A note under the keys, shown while parked (the Maps tip). */
  tip(text: string): void {
    this.note.textContent = text;
    this.sync();
  }

  /** The tiny coho counter: gentle creeks this drive, with its word ("1 gentle"); hidden until the first. */
  gentle(n: number): void {
    const t = `${n} gentle`;
    if (this.fishN.textContent === t) return;
    this.fishN.textContent = t;
    this.fishEl.dataset.n = String(n);
    this.fishEl.setAttribute('aria-label', gentleLabel(n));
  }

  voice(muted: boolean, locked = false): void {
    const on = !muted && !locked;
    this.vk.setAttribute('aria-checked', String(on));
    this.vk.replaceChildren(h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')), h('span.u-btn-label', {}, 'Voice'), h('span.dv-voice-state', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'));
    this.voiceOff.hidden = on;
    this.askT.textContent = locked ? 'Tap to turn on the voice' : 'Tap once to sense hard brakes';
  }

  /** The one-tap ask, only while parked before the drive starts. */
  ask(show: boolean): void {
    this.wantAsk = show;
    this.sync();
  }

  /** Parked: the speed gives way to the keys. Moving: nothing to touch. */
  parked(p: boolean): void {
    if (p === this.isParked && !this.keys.hidden === p) return;
    this.isParked = p;
    this.sync();
  }

  private sync(): void {
    const p = this.isParked, ask = p && this.wantAsk;
    this.keys.hidden = !p;
    this.speedEl.hidden = p;
    this.note.hidden = !p || !this.note.textContent;
    this.askEl.hidden = !ask;
    this.lineEl.hidden = ask;
  }

  /** Picks the line to show now. */
  private say(): void {
    if (this.temp && Date.now() > this.temp.until) this.temp = null;
    const fish = this.creeks.find((k) => !k.passed);
    const l = this.temp ?? roadLine({ fish: fish ? { m: fish.to } : null, spot: this.spot ? { m: this.spot.to } : null, status: this.status });
    const key = `${l.tone}|${l.text}`;
    if (key === this.shown) return;
    this.shown = key;
    this.lineEl.textContent = l.text;
    this.lineEl.dataset.tone = l.tone;
    this.lineEl.dataset.long = String(l.text.length > 42);
    this.cv.setAttribute('aria-label', fish ? `The road ahead: ${fish.name || 'a salmon creek'}, ${roadDist(fish.to)}` : 'The road ahead');
  }

  // ---------- drawing ----------

  private size(): void {
    const r = this.cv.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    [this.W, this.H, this.dpr] = [Math.round(r.width), Math.round(r.height), dpr];
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.draw(performance.now());
  }

  private readonly tick = (t: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (document.visibilityState === 'hidden' || !this.el.isConnected) return;
    const dt = Math.min(0.1, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    const still = calm(), step = this.v * dt;
    if (!still) this.odo += step;
    for (const k of this.creeks) {
      if (k.passed) k.m -= step;
      else {
        // between fixes the car keeps going; ease toward each new reading
        const want = Math.max(0, k.to - (this.v * (t - k.at)) / 1000);
        k.m = still ? want : k.m + (want - k.m) * Math.min(1, dt * 4);
      }
    }
    if (this.spot) {
      const want = Math.max(0, this.spot.to - (this.v * (t - this.spot.at)) / 1000);
      this.spot.m = still ? want : this.spot.m + (want - this.spot.m) * Math.min(1, dt * 4);
    }
    this.creeks = this.creeks.filter((k) => !k.passed || k.m > -400);
    this.puffs = this.puffs.filter((p) => t - p.t < 2500);
    if (this.temp && Date.now() > this.temp.until) this.say();
    // about 30 frames a second while moving or a leap or puff plays, 10 when still: easy on the battery
    const busy = this.v > 0.5 || this.puffs.length > 0 || this.creeks.some((k) => t - k.leap < 1200);
    if (t - this.drawn < (busy && !still ? 32 : 100)) return;
    this.drawn = t;
    this.draw(t);
  };

  private draw(t: number): void {
    const { W, H, ctx } = this;
    if (!W || !H) return;
    const still = calm();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // bigger art on big screens
    const k = W >= 700 && H >= 560 ? 3 : 2;
    const roadW = 74 * k, cx = Math.round(W / 2), rx0 = cx - roadW / 2, rx1 = cx + roadW / 2;
    const carH = 32 * (k + 1), carY = H - Math.max(carH * 0.75, Math.round(H * 0.15));
    const top = 10 * k, A = carY - top, ppm = A / ROAD_L;
    // too short to draw a road (mid resize)
    if (!(A > 40)) return;
    const Y = (d: number) => Math.round(carY - roadY(d, A));
    const dMin = -(H - carY + 80) / ppm, dMax = ROAD_L * Math.log(A / 2);

    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, W, H);
    // grass specks, fixed to the ground
    const odo = this.odo, sz = k;
    for (let j = Math.floor((odo + dMin) / 7); j * 7 - odo < ROAD_L * 2; j++) {
      const y = Y(j * 7 - odo);
      for (let q = 0; q < 4; q++) {
        const r = hash(j, q), x = Math.floor(r * (W / (3 * k))) * 3 * k;
        if (x > rx0 - 4 * k && x < rx1 + 2 * k) continue;
        ctx.fillStyle = hash(q, j) > 0.5 ? C.speck : C.speck2;
        ctx.fillRect(x, y, sz * 2, sz * 2);
      }
    }

    // the road, its edges and its center dashes
    ctx.fillStyle = C.road;
    ctx.fillRect(rx0, 0, roadW, H);
    ctx.fillStyle = C.edge;
    ctx.fillRect(rx0, 0, 3 * k, H);
    ctx.fillRect(rx1 - 3 * k, 0, 3 * k, H);
    ctx.fillStyle = C.dash;
    // far off, dashes shorter than an art pixel are left out so they never blur into a ladder
    for (let j = Math.floor((odo + dMin) / 12); j * 12 - odo < dMax; j++) {
      const d = j * 12 - odo, y0 = Y(d + 5), y1 = Y(d);
      if (y1 - y0 >= k) ctx.fillRect(cx - Math.round(1.5 * k), y0, 3 * k, y1 - y0);
    }

    // creeks and the learned spot, far first
    const bandH = 24 * (k + 1);
    const bands = this.creeks.map((c) => ({ c, y: Y(c.m) })).sort((a, b) => a.y - b.y);
    const spotY = this.spot && this.spot.m <= SPOT_SHOW_M * 1.6 ? Y(this.spot.m) : null;
    if (spotY != null) {
      ctx.fillStyle = C.warn;
      for (let q = 0; q < 3; q++) ctx.fillRect(rx0 + 3 * k, spotY - q * 5 * k, roadW - 6 * k, 2 * k);
    }

    // trees on both sides, from the horizon down; none on a creek
    const fw = 32 * k, sw = rx0;
    if (FIR?.complete && FIR.naturalWidth) {
      for (let j = Math.ceil((odo + dMax) / 18); j * 18 - odo > dMin; j--) {
        const d = j * 18 - odo, base = Y(d);
        for (const side of [0, 1]) {
          if (hash(j, side + 7) > 0.42) continue;
          const room = Math.max(0, sw - fw - 2 * k), x = side ? rx1 + 2 * k + Math.round(hash(j, side) * room) : Math.round(hash(j, side) * room);
          if (bands.some((b) => base > b.y - bandH / 2 - 6 * k && base - fw < b.y + bandH / 2 + 4 * k)) continue;
          if (spotY != null && side && base > spotY - 30 * k && base - fw < spotY + 6 * k) continue;
          ctx.drawImage(FIR, x, base - fw, fw, fw);
        }
      }
    }

    for (const { c, y } of bands) this.creek(c, y, bandH, k, rx0, rx1, roadW, t, still, top);
    if (spotY != null) this.plate('HARD-BRAKE SPOT', rx1, spotY - 18 * k, spotY + 8 * k, top, k, 'warn');

    // the car, in the right lane
    const carX = Math.round(cx + roadW / 4);
    // the puff sits at the back tires, under the car
    for (const p of this.puffs) this.puff(p, carY + carH / 2 - 4 * k, carX, k, t, still);
    if (CAR?.complete && CAR.naturalWidth) ctx.drawImage(CAR, carX - carH / 2, carY - carH / 2, carH, carH);

    // the horizon: far forest the trees come out of
    ctx.fillStyle = C.fog;
    ctx.fillRect(0, 0, W, top);
  }

  private creek(c: Creek, y: number, bandH: number, k: number, rx0: number, rx1: number, roadW: number, t: number, still: boolean, top: number): void {
    const ctx = this.ctx, W = this.W, y0 = Math.round(y - bandH / 2), s = k + 1, f = SPRITES.creek;
    if (y0 > this.H + 40 || y0 + bandH < -40) return;
    const near = !c.passed && c.m <= NEAR_M;
    ctx.fillStyle = C.bank;
    ctx.fillRect(0, y0 - 2 * k, W, bandH + 4 * k);
    // running water across the screen
    const tile = f.w * s, fr = still ? 0 : Math.floor(t / (1000 / f.fps));
    ctx.save();
    ctx.translate(0, y0);
    ctx.scale(s, s);
    for (let x = 0; x * s < W; x += f.w) f.draw(ctx, fr, x, 0);
    ctx.restore();
    if (tile <= 0) return;
    // a coho holding in the current, or leaping just after a gentle crossing
    const fish = SPRITES.coho, fs = k, fwid = fish.w * fs, fhi = fish.h * fs;
    const leapMs = 1100, p = c.leap ? (t - c.leap) / leapMs : -1;
    if (c.leap && p < 1 && !still) this.leap(fish, p, rx1 + Math.min((W - rx1) / 2, 48 * k), y, k);
    else if (c.leap && still && t - c.leap < 3500) this.leap(fish, 0.5, rx1 + Math.min((W - rx1) / 2, 48 * k), y, k);
    else {
      const sway = still ? 0 : Math.round(Math.sin(t / 900) * 2) * k;
      ctx.save();
      ctx.translate(Math.round(Math.max(4, rx0 - fwid - 16 * k) + sway), Math.round(y - fhi / 2));
      ctx.scale(fs, fs);
      fish.draw(ctx, still ? 0 : Math.floor(t / (1000 / fish.fps)), 0, 0);
      ctx.restore();
    }
    // the bridge
    ctx.fillStyle = C.road;
    ctx.fillRect(rx0 - 2 * k, y0 - 4 * k, roadW + 4 * k, bandH + 8 * k);
    ctx.fillStyle = C.edge;
    ctx.fillRect(rx0 - 2 * k, y0 - 4 * k, 3 * k, bandH + 8 * k);
    ctx.fillRect(rx0 + roadW - k, y0 - 4 * k, 3 * k, bandH + 8 * k);
    ctx.fillStyle = C.rail;
    ctx.fillRect(rx0 - 2 * k, y0 - 4 * k, roadW + 4 * k, 3 * k);
    ctx.fillRect(rx0 - 2 * k, y0 + bandH + k, roadW + 4 * k, 3 * k);
    if (!c.passed) {
      this.plate((c.name || 'Salmon creek').toUpperCase(), rx1, y0 - 8 * k, y0 + bandH + 8 * k, top, k, near ? 'salmon' : 'soak');
    }
  }

  /** A sign on the right of the road, wrapped so it stays right of the car's lane. Its lower edge at bottom, or its top at below near the horizon. */
  private plate(text: string, rx1: number, bottom: number, below: number, top: number, k: number, tone: 'soak' | 'salmon' | 'warn'): void {
    const ctx = this.ctx, W = this.W, fs = 8 * k, pad = 4 * k, lh = fs + 3 * k;
    ctx.font = `700 ${fs}px Silkscreen, monospace`;
    const wOf = (ls: string[]) => Math.max(...ls.map((l) => ctx.measureText(l).width)) + pad * 2;
    const right = W - 4 * k, room = right - (rx1 - (rx1 - W / 2) / 2), lines: string[] = [];
    for (const word of text.split(' ')) {
      const cur = lines.at(-1);
      if (cur && wOf([`${cur} ${word}`]) <= room) lines[lines.length - 1] = `${cur} ${word}`;
      else lines.push(word);
    }
    const w = Math.ceil(wOf(lines)), hgt = lines.length * lh + pad * 2 - 3 * k;
    const x = Math.max(4, Math.round(Math.min(rx1 + 8 * k, right - w))), y = Math.round(bottom - hgt < top + 4 * k ? below : bottom - hgt);
    const fill = tone === 'soak' ? C.plate : tone === 'salmon' ? C.salmon : C.warn;
    const ink = tone === 'soak' ? C.text : C.dark;
    ctx.fillStyle = tone === 'soak' ? C.soak : C.dark;
    ctx.fillRect(x - k, y - k, w + 2 * k, hgt + 2 * k);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, hgt);
    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * lh));
  }

  /** A coho arcs out of the water beside the road, with one sparkle at the top. p: 0..1 */
  private leap(fish: Frames, p: number, x: number, y: number, k: number): void {
    const ctx = this.ctx, step = Math.floor(p * 12) / 12, up = Math.round(Math.sin(Math.PI * step) * 30) * k;
    const tilt = step < 0.4 ? -0.45 : step > 0.6 ? 0.45 : 0;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y - up));
    ctx.rotate(tilt);
    ctx.scale(k, k);
    fish.draw(ctx, 2, -fish.w / 2, -fish.h / 2);
    ctx.restore();
    if (step > 0.85) {
      ctx.fillStyle = C.splash;
      for (const [dx, dy] of [[-14, 2], [-6, -3], [4, 1], [12, -2]]) ctx.fillRect(Math.round(x + dx * k), Math.round(y + dy * k), 2 * k, 2 * k);
    }
    if (step >= 0.3) {
      const sp = SPRITES.sparkle, i = Math.min(sp.n - 1, Math.floor((p - 0.3) * sp.n * 1.6));
      ctx.save();
      ctx.translate(Math.round(x + 12 * k), Math.round(y - 30 * k - 12 * k));
      ctx.scale(k, k);
      sp.draw(ctx, i, -sp.w / 2, -sp.h / 2);
      ctx.restore();
    }
  }

  /** A puff of tire dust centered on carX, cy, once. */
  private puff(p: Puff, cy: number, carX: number, k: number, t: number, still: boolean): void {
    const f = SPRITES.puff, ctx = this.ctx, age = t - p.t;
    // slower than the sheet's own pace, so it reads at a glance
    const i = still ? 3 : Math.floor(age / 140);
    if (i >= f.n || (still && age > 2000)) return;
    ctx.save();
    ctx.translate(Math.round(carX - (f.w * k) / 2), Math.round(cy - (f.h * k) / 2));
    ctx.scale(k, k);
    f.draw(ctx, i, 0, 0);
    ctx.restore();
  }
}
