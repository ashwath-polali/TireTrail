// The water story: the whole trip, then a drain, rain, the ground opens, one drop runs the real pipes,
// and it ends back on the whole trip with the steps numbered.
import { dist, nearestOnPolyline, pointAlong, polylineLength, type XY } from '../../geo/geo.ts';
import { esc, fmt } from '../dom.ts';
import type { Cam, Ending, Scene, Tag, Trip } from './render.ts';
import { CLS, type Cls, type World } from './world.ts';

/** Something the drop passes, in flow order. at: where it starts; mid: where its tag sits. */
export interface Mark { kind: 'pipe' | 'manhole' | 'ditch' | 'tank' | 'pond' | 'outfall'; at: XY; mid?: XY }

export interface StoryInput {
  path: XY[]; // world points from the drain to the end
  street: XY[] | null; // the street that was tapped, if any
  cls: string;
  code: string; // ending code, e.g. pond-to-creek
  focusY: number; // middle of the open band, 0 top .. 1 bottom
  viewW: number; // canvas size in art px
  viewH: number;
  bandH: number; // height of the open band in art px
  side?: number; // art px the open band's middle sits right of the canvas middle (the laptop card)
  name?: string; // the street's name
  receiving?: string; // the water it ends up in, if the map names it
  owner?: 'city' | 'county' | null; // whose pipe map
  marks?: Mark[];
  phone?: boolean; // short tag words
}

export interface StoryFrame {
  cam: Cam | null; // camera the story wants, or null to leave it alone
  scene: Scene;
  step: number; // 0 the whole trip, 1 rain, 2 drain, 3 pipes, 4 end
  prog: number; // 0..1 along the pipes
  ended: boolean;
}

/** beat lengths, ms */
export const BEAT = { pro: 1400, proFly: 800, zoom: 900, rain: 1400, dis: 750, hold: 1300, back: 1000, skip: 1000, tag: 1600 };
const ST = 1.0; // close-up zoom
const FIT = [1.2, 12]; // whole-trip zoom range
const PAD = 14; // art px kept clear around the whole trip
// Fennel Creek system waters that aren't coho streams themselves
const NOT_COHO = /lake bonney outflow|bonney lake outflow|debra jane|^bonney lake$/i;

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// the time at which ease() reaches y
const unease = (y: number) => (y < .5 ? Math.cbrt(y / 4) : 1 - Math.cbrt(2 * (1 - y)) / 2);
const out3 = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
const isTag = (t: Tag | null): t is Tag => t !== null;
/** feet up to a mile, then miles */
export const far = (m: number) => (m < 1609.344 ? fmt.ft(m) : fmt.mi(m));

export class Story {
  readonly inp: StoryInput;
  /** the path every half meter */
  private readonly pts: XY[];
  /** real path length, m */
  readonly lengthM: number;
  /** under 2 m: the water stops at the drain (a dry well), so there is no trip to show */
  readonly tiny: boolean;
  readonly cls: Cls;
  private readonly from: Cam;
  private t0: number;
  private readonly pondEnd: boolean; // the path ends at a pond
  private readonly pond: boolean; // ...and the city says where that pond drains
  private readonly water: XY | null; // where the salmon rests or the ripples spread
  private readonly mode: Ending['kind'] | null; // null: no end mark (the sewer)
  private readonly t: { pro: number; zoom: number; rain: number; dis: number; travel: number; hold: number; back: number };
  // the first thing of each kind on the way: its tag spot, and when (0..1 of the travel time) the drop gets there
  private readonly seen: { kind: Mark['kind']; at: XY; t: number }[] = [];
  private readonly facility: { kind: 'pond' | 'tank'; at: XY } | null;
  private readonly ditchy: boolean;
  private skipped: { t: number; from: Cam; dis: number } | null = null;
  private said: { phone: boolean; w: TagWords } | null = null;

  constructor(world: World, inp: StoryInput, from: Cam, t0: number) {
    [this.inp, this.from, this.t0] = [inp, from, t0];
    const path = inp.path.length ? inp.path : [inp.street?.[0] ?? [0, 0] as XY];
    this.pts = densify(path, 0.5);
    this.lengthM = polylineLength(path);
    this.tiny = this.lengthM < 2;
    this.cls = (CLS as readonly string[]).includes(inp.cls) ? inp.cls as Cls : 'unknown';
    const E = this.end;
    const wet = this.cls === 'creek' || this.cls === 'elsewhere';
    this.pondEnd = /pond/.test(inp.code);
    this.pond = this.pondEnd && wet;
    // a pond's outlet may be unmapped, so its water can be a field away
    this.water = wet ? world.nearestWater(E, this.pond ? 160 : 40) : null;
    this.mode = this.cls === 'treatment' ? null : this.cls === 'unknown' || this.cls === 'none' ? 'stop'
      : this.cls === 'ground' && !this.pondEnd ? 'soak' : this.cls === 'creek' && this.water ? 'salmon' : 'ripple';
    this.t = {
      pro: this.tiny ? 0 : BEAT.pro, zoom: BEAT.zoom, rain: BEAT.rain, dis: BEAT.dis,
      travel: this.tiny ? 0 : clamp(this.lengthM * 16, 2600, 6000), hold: BEAT.hold, back: BEAT.back,
    };
    // walk the marks in order, each found at or after the one before
    const marks = inp.marks ?? [], n = this.pts.length, kinds = new Set<string>();
    let from0 = 0, fac: Story['facility'] = null;
    for (const m of marks) {
      let best = from0, bd = Infinity;
      for (let i = from0; i < n; i++) {
        const d = (this.pts[i][0] - m.at[0]) ** 2 + (this.pts[i][1] - m.at[1]) ** 2;
        if (d < bd) [best, bd] = [i, d];
      }
      from0 = best;
      if (!fac && (m.kind === 'pond' || m.kind === 'tank')) fac = { kind: m.kind, at: m.mid ?? m.at };
      if (kinds.has(m.kind)) continue;
      kinds.add(m.kind);
      this.seen.push({ kind: m.kind, at: m.mid ?? m.at, t: n > 1 ? unease(best / (n - 1)) : 0 });
    }
    // the pond at the end gets its own number when the water goes on past it; otherwise the end tag names it
    this.facility = this.pond ? { kind: 'pond', at: E } : fac && !(this.pondEnd && fac.kind === 'pond' && dist(fac.at, E) < 60) ? fac : null;
    this.ditchy = marks.filter((x) => x.kind === 'ditch').length > marks.filter((x) => x.kind === 'pipe').length;
  }

  private get end(): XY {
    return this.pts[this.pts.length - 1];
  }

  /** The beats in order, ms from the start. */
  get beats(): { pro: number; rain: number; drain: number; pipes: number; end: number; back: number; rest: number } {
    const t = this.t, rain = t.pro, drain = rain + t.zoom + t.rain, pipes = drain + t.dis, end = pipes + t.travel, back = end + t.hold;
    return { pro: 0, rain, drain, pipes, end, back, rest: back + t.back };
  }

  /** Meters from a pond to the water the city says it drains to (0 if none). */
  get hopM(): number {
    return this.pond && this.water ? dist(this.end, this.water) : 0;
  }

  /** Jumps to the moment the water arrives. */
  skip(now: number): void {
    this.t0 = Math.min(this.t0, now - this.beats.end);
  }

  /** Goes straight to the end: the camera glides back to the whole trip from wherever it is. */
  skipToEnd(now: number, cur: Cam): void {
    if (this.skipped || now - this.t0 >= this.beats.rest) return;
    const dis = this.frame(now).scene.dissolve ?? 0;
    this.skipped = { t: now, from: { ...cur }, dis };
  }

  /** Camera with p in the middle of the open band. */
  private cam(p: XY, mpp: number): Cam {
    return { x: p[0] - (this.inp.side ?? 0) * mpp, y: p[1] + (0.5 - this.inp.focusY) * this.inp.viewH * mpp, mpp };
  }

  // zoom about the target, so it glides to the middle instead of swinging past
  private glide(a: Cam, p: XY, mpp: number, e: number): Cam {
    const b0 = this.cam(p, a.mpp);
    const ox = (a.x - b0.x) / a.mpp, oy = (a.y - b0.y) / a.mpp;
    const m = logLerp(a.mpp, mpp, e), b = this.cam(p, m);
    return { x: b.x + ox * (1 - e) * m, y: b.y + oy * (1 - e) * m, mpp: m };
  }

  /** The street, the path and the water, fit inside the open band. */
  whole(): { p: XY; mpp: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (p: XY) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); };
    for (const p of this.inp.street ?? []) add(p);
    for (const p of this.inp.path) add(p);
    add(this.pts[0]);
    if (this.water) add(this.water);
    const inp = this.inp, W = Math.max(20, inp.viewW - 2 * (inp.side ?? 0) - 2 * PAD), H = Math.max(20, inp.bandH - 2 * PAD);
    return { p: [(x0 + x1) / 2, (y0 + y1) / 2], mpp: clamp(Math.max((x1 - x0) / W, (y1 - y0) / H), FIT[0], FIT[1]) };
  }

  /** The end up close, with the water it reaches. */
  private close(): { p: XY; mpp: number } {
    const E = this.end, w = this.mode === 'salmon' || this.mode === 'ripple' ? this.water : null;
    if (!w) return { p: E, mpp: ST };
    const inp = this.inp, W = Math.max(20, inp.viewW - 2 * (inp.side ?? 0));
    return { p: [(E[0] + w[0]) / 2, (E[1] + w[1]) / 2], mpp: clamp(Math.max(Math.abs(w[0] - E[0]) / (W * 0.62), Math.abs(w[1] - E[1]) / (inp.bandH * 0.55)), ST, 2.4) };
  }

  frame(now: number): StoryFrame {
    if (this.skipped) return this.skipFrame(now);
    const T = now - this.t0, t = this.t, b = this.beats, S = this.pts[0], E = this.end;
    const T2 = b.drain - t.rain;
    const base: Scene = { highlight: this.inp.street, pondAt: this.pondEnd ? E : null, drainMark: S };
    const w = this.whole();
    if (T < b.rain) {
      // the whole trip first, drawn faint, named at both ends
      const k = ease(clamp(T / BEAT.proFly, 0, 1));
      return { cam: this.glide(this.from, w.p, w.mpp, k), scene: { ...base, trip: this.trip(), tags: [this.streetTag(), this.destTag()].filter(isTag) }, step: 0, prog: 0, ended: false };
    }
    if (T < T2) {
      const z = ease((T - b.rain) / t.zoom), a = t.pro ? this.cam(w.p, w.mpp) : this.from;
      return { cam: this.glide(a, S, ST, z), scene: { ...base, tags: [this.streetTag(), this.drainTag()].filter(isTag) }, step: 1, prog: 0, ended: false };
    }
    if (T < b.drain) {
      const r = (T - T2) / t.rain;
      const drop: XY = [S[0], S[1] - 60 * (1 - out3(Math.min(1, r / .8)))];
      return { cam: this.cam(S, ST), scene: { ...base, rain: r, rainT: T, drop, tags: [this.streetTag(), this.drainTag()].filter(isTag) }, step: 1, prog: 0, ended: false };
    }
    if (T < b.pipes) {
      return { cam: this.cam(S, ST), scene: { ...base, highlight: null, dissolve: (T - b.drain) / t.dis, trail: { path: this.pts, prog: 0 }, tags: [this.drainTag()] }, step: 2, prog: 0, ended: false };
    }
    if (T < b.end) {
      const prog = ease((T - b.pipes) / t.travel);
      const head = this.pts[Math.round(prog * (this.pts.length - 1))];
      // pull back mid-journey so more of the path shows
      const mpp = ST * (1 + 0.5 * Math.sin(Math.PI * prog));
      return { cam: this.cam(head, mpp), scene: { ...base, highlight: null, dissolve: 1, trail: { path: this.pts, prog }, drop: head, tags: this.travelTags(T - b.pipes) }, step: 3, prog, ended: false };
    }
    const c = this.close();
    if (T < b.back) {
      const k = (T - b.end) / t.hold;
      const cam = this.glide(this.cam(E, ST), c.p, c.mpp, ease(Math.min(1, k * 2)));
      const tags = [...this.travelTags(T - b.pipes), this.destTag(), this.hopTag()].filter(isTag);
      return { cam, scene: { ...base, highlight: null, drainMark: null, dissolve: 1, trail: { path: this.pts, prog: 1 }, link: this.link(), ending: this.ending(k), tags }, step: 4, prog: 1, ended: false };
    }
    if (T < b.rest) {
      const k = ease((T - b.back) / t.back);
      return { cam: this.glide(this.cam(c.p, c.mpp), w.p, w.mpp, k), scene: this.rest(Math.max(0, 1 - 2 * k)), step: 4, prog: 1, ended: false };
    }
    return { cam: this.cam(w.p, w.mpp), scene: this.rest(0), step: 4, prog: 1, ended: true };
  }

  private skipFrame(now: number): StoryFrame {
    const s = this.skipped!, k = ease(clamp((now - s.t) / BEAT.skip, 0, 1)), w = this.whole();
    return { cam: this.glide(s.from, w.p, w.mpp, k), scene: this.rest(Math.max(0, s.dis * (1 - k / .4))), step: 4, prog: 1, ended: k >= 1 };
  }

  /** Reduced motion: four still frames, all on the whole trip. */
  still(step: number): StoryFrame {
    const w = this.whole(), k = clamp(Math.round(step), 1, 4);
    const base: Scene = { highlight: this.inp.street, pondAt: this.pondEnd ? this.end : null, drainMark: this.pts[0] };
    const scene: Scene = k === 1 ? { ...base, tags: [this.streetTag(), this.drainTag()].filter(isTag) }
      : k === 2 ? { ...base, tags: [this.drainTag()] }
        : k === 3 ? { ...base, trail: { path: this.pts, prog: 1 }, tags: this.seen.map((m) => this.markTag(m.kind, m.at)) }
          : this.rest(0);
    return { cam: this.cam(w.p, w.mpp), scene, step: k, prog: k >= 3 ? 1 : 0, ended: k === 4 };
  }

  /** The end at rest: the whole path, the ending still, the steps numbered. While still underground, only the end is named. */
  private rest(dis: number): Scene {
    const tags = dis > 0 ? [this.destTag(), this.hopTag()].filter(isTag) : this.numbered();
    return {
      highlight: dis > 0 ? null : this.inp.street, pondAt: this.pondEnd ? this.end : null, drainMark: dis > 0 ? null : this.pts[0],
      dissolve: dis, trail: { path: this.pts, prog: 1 }, link: this.link(), ending: this.ending(1, true), tags,
    };
  }

  private link(): Scene['link'] {
    return this.pond && this.water ? { from: this.end, to: this.water } : null;
  }

  private ending(k: number, rest = false): Ending | null {
    if (!this.mode) return null;
    const at = (this.mode === 'salmon' || this.mode === 'ripple') && this.water ? this.water : this.end;
    // a wet patch, partly soaked in, stays visible at rest
    return rest ? { kind: this.mode, at, t: this.mode === 'soak' ? .6 : 1, rest: true } : { kind: this.mode, at, t: k };
  }

  /** The whole trip, drawn like a picked street's. */
  private trip(): Trip {
    const E = this.end;
    const end: Trip['end'] = this.cls === 'treatment' ? 'plant' : this.mode === 'stop' ? 'gap' : this.pondEnd ? 'pond' : this.mode === 'soak' ? 'soak' : this.mode === 'salmon' ? 'salmon' : 'ripple';
    return { path: this.inp.path.length ? this.inp.path : [E], cls: this.cls, end, water: this.water, pond: this.pondEnd ? E : null };
  }

  // ---------- tags ----------

  private get words(): TagWords {
    const i = this.inp, phone = !!i.phone;
    if (this.said?.phone !== phone) {
      this.said = { phone, w: tagWords({ name: i.name ?? '', cls: this.cls, code: i.code, receiving: i.receiving ?? '', lengthM: this.lengthM, owner: i.owner ?? null, phone, ditch: this.ditchy }) };
    }
    return this.said.w;
  }

  private streetTag(n?: number): Tag | null {
    const st = this.inp.street;
    if (!st?.length) return null;
    return { at: pointAlong(st, polylineLength(st) / 2), text: this.words.street, tone: 'street', n };
  }

  private drainTag(n?: number): Tag {
    return { at: this.pts[0], text: this.words.drain, tone: 'drain', n };
  }

  private destTag(n?: number): Tag {
    const d = this.words.dest;
    const at = this.water && (this.mode === 'salmon' || this.mode === 'ripple') ? this.water : this.end;
    return { at, text: d.text, tone: d.tone, n, fish: d.fish || undefined };
  }

  private hopTag(): Tag | null {
    const l = this.link(), hop = this.words.hop;
    return l && hop ? { at: [(l.from[0] + l.to[0]) / 2, (l.from[1] + l.to[1]) / 2], text: hop, tone: 'plain' } : null;
  }

  private markTag(kind: Mark['kind'], at: XY): Tag {
    return { at, text: this.words.marks[kind], tone: kind === 'pond' || kind === 'tank' ? 'pond' : 'pipe' };
  }

  /** Underground, each thing is named as the drop gets there, for a moment. */
  private travelTags(dt: number): Tag[] {
    const out: Tag[] = [], travel = this.t.travel, st = this.inp.street;
    if (!travel) return out;
    if (st?.length && dt < BEAT.tag) out.push({ at: nearestOnPolyline(this.pts[0], st).point, text: this.words.above, tone: 'street' });
    for (const m of this.seen) {
      const at = m.t * travel;
      if (dt >= at && dt < at + BEAT.tag) out.push(this.markTag(m.kind, m.at));
    }
    return out;
  }

  /** At the end: 1 the street, 2 the drain, 3 the pipes, 4 a pond, then where it ends up. */
  private numbered(): Tag[] {
    const w = this.words, out: Tag[] = [];
    let n = 0;
    const st = this.streetTag(1);
    if (st) { out.push(st); n = 1; }
    out.push(this.drainTag(++n));
    if (!this.tiny) out.push({ at: pointAlong(this.inp.path, this.lengthM / 2), text: w.pipe, tone: 'pipe', n: ++n });
    if (this.facility) out.push({ at: this.facility.at, text: w.marks[this.facility.kind], tone: 'pond', n: ++n });
    // a pond whose water can't be found is as far as the map shows
    if (!(this.pond && !this.water)) out.push(this.destTag(++n));
    return out;
  }
}

function densify(path: XY[], step: number): XY[] {
  const out: XY[] = [];
  for (let k = 1; k < path.length; k++) {
    const [ax, ay] = path[k - 1], [bx, by] = path[k];
    const len = Math.hypot(bx - ax, by - ay);
    for (let d = 0; d < len; d += step) out.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
  }
  out.push(path[path.length - 1]);
  return out;
}

// ---------- words ----------

export interface Dest {
  /** "From {street} to {long}" (html) */
  long: string;
  /** the end of "It reaches ..." or "It ends up in ..." (html, no period) */
  tail: string;
  /** tag words, laptop and phone */
  tag: string;
  short: string;
  tone: Tag['tone'];
  fish: boolean;
}

/** Where the water ends up, named plainly. */
export function dest(cls: string, code: string, receiving: string): Dest {
  const r = receiving.trim(), b = `<b>${esc(r)}</b>`;
  if (cls === 'creek') {
    if (code === 'downstream-creek') {
      return /unnamed/i.test(r) || !r
        ? { long: 'a small salmon stream', tail: 'a smaller stream that runs into a salmon stream', tag: 'stream to a salmon stream', short: 'stream', tone: 'creek', fish: false }
        : { long: `a stream that feeds ${b}`, tail: `a smaller stream that runs into ${b}, where coho salmon live`, tag: `stream to ${r}`, short: `stream to ${r}`, tone: 'creek', fish: false };
    }
    if (!r || /^fennel creek$/i.test(r)) return { long: '<b>Fennel Creek</b>', tail: '<b>Fennel Creek</b>, where coho salmon live', tag: 'Fennel Creek', short: 'Fennel Creek', tone: 'creek', fish: true };
    if (/^fennel creek tributary/i.test(r)) return { long: 'a stream that feeds <b>Fennel Creek</b>', tail: 'a stream that feeds <b>Fennel Creek</b>, where coho salmon live', tag: 'stream to Fennel Creek', short: 'stream to Fennel Creek', tone: 'creek', fish: false };
    if (NOT_COHO.test(r)) return { long: b, tail: `${b}, which drains to Fennel Creek`, tag: r, short: r, tone: 'creek', fish: false };
    if (/unnamed/i.test(r)) return { long: 'a small salmon stream', tail: 'a small salmon stream with no name on the map', tag: 'salmon stream', short: 'salmon stream', tone: 'creek', fish: true };
    return { long: b, tail: `${b}, where coho salmon live`, tag: r, short: r, tone: 'creek', fish: true };
  }
  if (cls === 'elsewhere') {
    const [long, tag] = !r ? ['other water nearby', 'other water']
      : /^(an? )?unnamed stream/i.test(r) ? ['a small stream with no name on the map', 'small stream']
        : /unnamed (lake|pond)/i.test(r) ? ['a small lake or pond with no name on the map', 'small lake or pond']
          : /unnamed/i.test(r) ? ['water with no name on the map', 'unnamed water'] : [b, r];
    return { long, tail: long, tag, short: tag, tone: 'other', fish: false };
  }
  if (cls === 'ground') return { long: 'where it soaks in', tail: 'the ground', tag: 'soaks in here', short: 'soaks in', tone: 'soak', fish: false };
  if (cls === 'treatment') return { long: 'a sewer pipe that goes to a treatment plant', tail: 'a sewage treatment plant', tag: 'sewer pipe to a treatment plant', short: 'sewer pipe', tone: 'treatment', fish: false };
  return { long: 'where the map stops', tail: 'a gap in the pipe map', tag: 'map stops here', short: 'map stops', tone: 'gap', fish: false };
}

export interface Words {
  /** captions, html: the whole trip, then pips 1 to 4 */
  pro: string;
  rain: string;
  drain: string;
  pipes: string;
  end: string;
  /** the laptop step list, plain text */
  steps: [string, string, string, string];
}

/** Whose pipes, in a few words; null when nobody knows. */
export const ownerOf = (o: 'city' | 'county' | null | undefined) => (o === 'city' ? "the city's" : o === 'county' ? "the county's" : null);

/** Everything the caption and the step list say. calm: still steps, with no look under the street. */
export function words(o: { name: string; cls: string; code: string; receiving: string; lengthM: number; hopM?: number; tiny?: boolean; owner?: 'city' | 'county' | null; calm?: boolean; intro?: string }): Words {
  const n = `<b>${esc(o.name)}</b>`, d = dest(o.cls, o.code, o.receiving), pond = /^pond-to-/.test(o.code);
  const about = far(o.lengthM + (o.hopM ?? 0));
  const pro = o.cls === 'unknown' || o.cls === 'none' ? `From ${n}, TireTrail can follow the rain ${far(o.lengthM)}.`
    : o.cls === 'ground' ? `From ${n} to where it soaks in: about ${about}.`
      : `From ${n} to ${d.long}: about ${about}.`;
  let end: string;
  if (o.cls === 'creek') end = pond ? `It flows into a pond, then on to ${d.tail}.` : `It reaches ${d.tail}.`;
  else if (o.cls === 'elsewhere') end = pond ? `It flows into a pond, then on to ${d.tail}.` : `It ends up in ${d.tail}.`;
  else if (o.cls === 'ground') end = o.tiny ? 'It soaks into the ground right at the drain.' : /pond/.test(o.code) ? 'It flows into a pond built to let it soak into the ground.' : 'It soaks into the ground here.';
  else if (o.cls === 'treatment') end = 'It joins a sewer pipe that goes to a sewage treatment plant.';
  else end = 'Here the pipe map stops, so TireTrail stops too.';
  const own = ownerOf(o.owner);
  return {
    pro,
    rain: o.intro ?? `Rain washes tire dust off ${n} toward the storm drain at the curb.`,
    drain: o.calm ? 'It pours into the storm drain, then into pipes under the street.' : "It pours into the storm drain. Now you're looking under the street.",
    pipes: o.calm ? 'The dotted blue line shows its path through the storm pipes, downhill.' : 'Gray tubes are storm pipes. The blue dot is the rain, running downhill.',
    end,
    steps: [`Rain washes tire dust off ${o.name}`, 'It pours into a storm drain', own ? `It runs through ${own} pipes` : 'It runs through the storm pipes', 'Where it ends up'],
  };
}

export interface TagWords {
  street: string;
  drain: string;
  pipe: string;
  above: string;
  hop: string | null;
  dest: { text: string; tone: Tag['tone']; fish: boolean };
  marks: Record<Mark['kind'], string>;
}

/** Words for the map's tags; phones get the short ones. */
export function tagWords(o: { name: string; cls: string; code: string; receiving: string; lengthM: number; owner?: 'city' | 'county' | null; phone?: boolean; ditch?: boolean }): TagWords {
  const d = dest(o.cls, o.code, o.receiving), ph = !!o.phone;
  const who = o.owner === 'city' ? 'the city' : o.owner === 'county' ? 'the county' : 'the map';
  return {
    street: o.name || 'this street',
    drain: ph ? 'drain' : 'storm drain',
    pipe: ph ? (o.ditch ? 'ditch' : 'pipes') : `${far(o.lengthM)} of ${o.ditch ? 'ditch' : 'pipe'}`,
    above: `${o.name || 'The street'} is above`,
    hop: /^pond-to-/.test(o.code) ? `${who} lists this pond as draining here` : null,
    dest: { text: ph ? d.short : d.tag, tone: d.tone, fish: d.fish },
    marks: {
      pipe: 'pipe', ditch: 'ditch', pond: 'pond',
      manhole: ph ? 'manhole' : 'manhole, where pipes meet',
      tank: ph ? 'tank' : 'underground tank',
      outfall: ph ? 'outfall' : 'outfall, where the pipe empties',
    },
  };
}
