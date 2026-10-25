// The live drive's bottom sheet over the map: REC, time, miles, speed and limit, the next salmon creek, Voice and End drive.
// Drag the handle down for a slim bar and more map, up for the full panel. Voice and End drive show either way, moving or parked.
import { h } from '../dom.ts';
import { button, glyph, salmonSVG } from '../ui/ui.ts';
import { roadDist } from './drive-coach.ts';
import { REC } from './drive-words.ts';

export type Snap = 'slim' | 'full';

/** a flick faster than this settles the sheet its way, px/ms */
export const FLICK = 0.45;
/** a drag shorter than this is a tap on the handle: it flips, px */
export const TAP_PX = 6;

/** How open the sheet is mid drag, 0 slim .. 1 full: from where it was, dy px dragged (down is +), range px between slim and full. */
export function sheetOpen(from: Snap, dy: number, range: number): number {
  if (!(range > 0)) return from === 'full' ? 1 : 0;
  return Math.min(1, Math.max(0, ((from === 'full' ? range : 0) - dy) / range));
}

/** Where the sheet settles after a drag of dy px at v px/ms (down is +): a tap flips it, a flick goes its way, else the nearer end. */
export function sheetSnap(from: Snap, dy: number, v: number, range: number): Snap {
  if (Math.abs(v) >= FLICK && Math.abs(dy) >= TAP_PX) return v > 0 ? 'slim' : 'full';
  if (Math.abs(dy) < TAP_PX) return from === 'full' ? 'slim' : 'full';
  return sheetOpen(from, dy, range) >= 0.5 ? 'full' : 'slim';
}

/** What the sheet shows: Voice and End drive always; the big tiles only open, the short numbers only slim; the voice ask only parked. */
export function sheetShows(s: { snap: Snap; moving: boolean; ask: boolean }): { end: boolean; voice: boolean; tiles: boolean; inline: boolean; ask: boolean } {
  return { end: true, voice: true, tiles: s.snap === 'full', inline: s.snap === 'slim', ask: s.ask && !s.moving };
}

export interface LiveSheetIn { autoEnds: boolean; muted: boolean; locked: boolean; snap?: Snap; end(): void; toggleVoice(): void; unlock(): void; snapped?(s: Snap): void }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const miles = (m: number) => (m / 1609.344).toFixed(1);

export class LiveSheet {
  readonly el: HTMLElement;
  private readonly c: LiveSheetIn;
  private snap: Snap;
  private moving = false;
  private wantAsk = false;
  private readonly grip: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly chipName: HTMLElement;
  private readonly chipDist: HTMLElement;
  private readonly inline: HTMLElement;
  private readonly inT: HTMLElement;
  private readonly inM: HTMLElement;
  private readonly mph: HTMLElement;
  private readonly sign: HTMLElement;
  private readonly signN: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly more: HTMLElement;
  private readonly moreIn: HTMLElement;
  private readonly time: HTMLElement;
  private readonly miles: HTMLElement;
  private readonly note: HTMLElement;
  private readonly askEl: HTMLElement;
  private readonly askT: HTMLElement;
  private readonly vk: HTMLElement;
  private readonly endK: HTMLElement;
  private settle = 0;
  /** the Silent mode hint under the Voice switch, for a moment */
  private readonly hintEl = h('p.dl-hint', { hidden: true, 'aria-live': 'polite' }, '');
  private hintT = 0;
  private drag:{ id: number; y: number; t: number; lastY: number; lastT: number; v: number; range: number } | null = null;

  constructor(c: LiveSheetIn) {
    this.c = c;
    this.snap = c.snap ?? 'slim';
    this.grip = h('button.dl-grip', { type: 'button', 'aria-label': 'Show more', 'aria-expanded': 'false' }, h('i', { 'aria-hidden': 'true' }));
    this.chipName = h('b', {}, '');
    this.chipDist = h('span', {}, '');
    this.chip = h('p.dl-chip', { hidden: true, role: 'status' }, h('span.dl-chip-ico', { 'aria-hidden': 'true', html: salmonSVG(2) }), this.chipName, this.chipDist);
    this.inT = h('b', {}, '0:00');
    this.inM = h('b', {}, '0.0');
    this.inline = h('span.dl-inline', {}, this.inT, h('span', { 'aria-hidden': 'true' }, '·'), this.inM, h('span', {}, 'mi'));
    this.mph = h('b', {}, '0');
    this.signN = h('b', {}, '');
    this.sign = h('span.dl-sign', { role: 'img', hidden: true }, h('small', { 'aria-hidden': 'true' }, 'SPEED'), h('small', { 'aria-hidden': 'true' }, 'LIMIT'), this.signN);
    this.speedEl = h('span.dl-speed', {}, h('span.dl-mph', {}, this.mph, h('span', {}, 'mph')), this.sign);
    this.time = h('b.dv-rec-big', {}, '0:00');
    this.miles = h('b.dv-rec-big', {}, '0.0');
    this.note = h('p.u-caption.dv-rec-note', { hidden: !c.autoEnds }, c.autoEnds ? REC.autoEnds : '');
    this.moreIn = h('div.dl-more-in', {},
      h('div.dv-rec-nums', {},
        h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'TIME'), this.time),
        h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, 'MILES'), this.miles)),
      this.note);
    this.more = h('div.dl-more', {}, this.moreIn);
    // the voice can already talk when only the motion sensor still needs the tap
    this.askT = h('b', {}, '');
    this.askEl = h('button.dv-rec-ask', { type: 'button', hidden: true, onclick: () => c.unlock() },
      h('span.u-ico', { 'aria-hidden': 'true', html: glyph('sound', 3) }), h('span', {}, this.askT, h('span', {}, 'Before you pull out.')));
    // a switch, so it says both what it is and whether it's on
    this.vk = h('button.u-btn.u-secondary.dv-voice', { type: 'button', role: 'switch', 'aria-label': 'Voice tips', onclick: () => c.toggleVoice() });
    this.endK = button('End drive', { kind: 'primary', icon: 'end', onClick: c.end });
    this.el = h('section.dl', { 'aria-label': 'Recording', 'data-snap': this.snap },
      this.grip, this.chip,
      h('div.dl-top', {}, h('span.dl-rec', {}, h('i', { 'aria-hidden': 'true' }), h('b', {}, 'REC')), this.inline, this.speedEl),
      this.more, this.askEl,
      h('div.dv-rec-keys.dl-keys', {}, this.vk, this.endK),
      this.hintEl);
    this.voice(c.muted, c.locked);
    this.grip.addEventListener('pointerdown', (e) => this.down(e as PointerEvent));
    this.grip.addEventListener('pointermove', (e) => this.move(e as PointerEvent));
    this.grip.addEventListener('pointerup', (e) => this.up(e as PointerEvent));
    this.grip.addEventListener('pointercancel', () => this.cancel());
    // keys and screen readers: a click flips it (a drag's own click is swallowed in up)
    this.grip.addEventListener('click', (e) => { if ((e as MouseEvent).detail === 0) this.to(this.snap === 'full' ? 'slim' : 'full'); });
    this.apply(true);
  }

  // ---------- inputs ----------

  /** Seconds since the start, meters so far, and whether GPS has a fix yet. */
  set(sec: number, meters: number, fix: boolean): void {
    const t = clock(sec), m = miles(meters);
    if (this.time.textContent !== t) this.time.textContent = this.inT.textContent = t;
    if (this.miles.textContent !== m) this.miles.textContent = this.inM.textContent = m;
    this.el.classList.toggle('dv-nofix', !fix);
  }

  /** Speed now, m/s, and the posted limit in mph when known. */
  speed(v: number, limitMph: number | null): void {
    const mph = String(Math.max(0, Math.round(v / 0.44704)));
    if (this.mph.textContent !== mph) this.mph.textContent = mph;
    this.sign.hidden = !limitMph;
    if (limitMph && this.signN.textContent !== String(limitMph)) {
      this.signN.textContent = String(limitMph);
      this.sign.setAttribute('aria-label', `Speed limit ${limitMph}`);
    }
    this.speedEl.dataset.over = String(!!limitMph && v / 0.44704 > limitMph + 5);
  }

  /** Moving or parked: only the voice ask cares. */
  moved(moving: boolean): void {
    if (moving === this.moving) return;
    this.moving = moving;
    this.apply();
  }

  /** The next salmon creek ahead on this road, as the coach sees it; null hides the chip. */
  creek(c: { name: string; m: number } | null): void {
    this.chip.hidden = !c;
    if (!c) return;
    const name = c.name || 'Salmon creek', d = roadDist(c.m);
    if (this.chipName.textContent !== name) this.chipName.textContent = name;
    if (this.chipDist.textContent !== d) this.chipDist.textContent = d;
  }

  voice(muted: boolean, locked = false): void {
    const on = !muted && !locked;
    this.vk.setAttribute('aria-checked', String(on));
    this.vk.replaceChildren(h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')), h('span.u-btn-label', {}, 'Voice'), h('span.dv-voice-state', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'));
    this.askT.textContent = locked ? 'Tap to turn on the voice' : 'Tap once to sense hard brakes';
  }

  /** "Can't hear it? Turn off Silent mode…" under the Voice switch for ms (the phone's Silent switch mutes the voice); 0 hides it. */
  hint(ms: number): void {
    clearTimeout(this.hintT);
    const show = ms > 0;
    this.hintEl.textContent = show ? REC.voiceHint : '';
    this.hintEl.hidden = !show;
    if (show) this.hintT = window.setTimeout(() => this.hint(0), ms);
  }

  /** The one-tap ask, only while parked before the drive starts. */
  ask(show: boolean): void {
    if (show === this.wantAsk) return;
    this.wantAsk = show;
    this.apply();
  }

  /** A note in the open panel (the Maps tip). */
  tip(text: string): void {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  get snapped(): Snap {
    return this.snap;
  }

  /** Opens or closes the panel. */
  to(s: Snap): void {
    this.snap = s;
    this.settleTo(s);
    this.c.snapped?.(s);
  }

  // ---------- the handle ----------

  private down(e: PointerEvent): void {
    if (e.button > 0) return;
    // the extra panel's full height: how far apart slim and full sit
    const range = this.moreIn.scrollHeight;
    this.drag = { id: e.pointerId, y: e.clientY, t: e.timeStamp, lastY: e.clientY, lastT: e.timeStamp, v: 0, range };
    try { this.grip.setPointerCapture(e.pointerId); } catch { /* gone */ }
    clearTimeout(this.settle);
    this.more.style.transition = 'none';
    this.more.style.visibility = 'visible';
    this.more.style.height = `${this.snap === 'full' ? range : 0}px`;
    e.preventDefault();
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = 0.7 * ((e.clientY - d.lastY) / dt) + 0.3 * d.v;
    [d.lastY, d.lastT] = [e.clientY, e.timeStamp];
    const open = sheetOpen(this.snap, e.clientY - d.y, d.range);
    this.more.style.height = `${Math.round(open * d.range)}px`;
    this.el.dataset.snap = open >= 0.5 ? 'full' : 'slim';
    this.shows(open >= 0.5 ? 'full' : 'slim');
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    // an old reading isn't a flick
    const v = e.timeStamp - d.lastT > 120 ? 0 : d.v;
    this.to(sheetSnap(this.snap, e.clientY - d.y, v, d.range));
  }

  private cancel(): void {
    if (!this.drag) return;
    this.drag = null;
    this.settleTo(this.snap);
  }

  /** Glides the extra panel open or shut, then lets it size itself. */
  private settleTo(s: Snap): void {
    const range = this.moreIn.scrollHeight, now = this.more.getBoundingClientRect().height;
    clearTimeout(this.settle);
    this.more.style.transition = 'none';
    this.more.style.visibility = 'visible';
    this.more.style.height = `${now}px`;
    void this.more.offsetHeight;
    this.more.style.transition = '';
    this.more.style.height = `${s === 'full' ? range : 0}px`;
    this.apply();
    this.settle = window.setTimeout(() => this.apply(true), 260);
  }

  /** Shows what the snap says; done: the panel takes its own height. */
  private apply(done = false): void {
    const s = this.snap;
    this.el.dataset.snap = s;
    this.grip.setAttribute('aria-expanded', String(s === 'full'));
    this.grip.setAttribute('aria-label', s === 'full' ? 'Show less' : 'Show more');
    this.shows(s);
    if (done) {
      this.more.style.transition = 'none';
      this.more.style.height = s === 'full' ? 'auto' : '0px';
      this.more.style.visibility = s === 'full' ? 'visible' : 'hidden';
    }
  }

  private shows(s: Snap): void {
    const w = sheetShows({ snap: s, moving: this.moving, ask: this.wantAsk });
    this.endK.hidden = !w.end;
    this.vk.hidden = !w.voice;
    this.inline.hidden = !w.inline;
    this.askEl.hidden = !w.ask;
  }
}
