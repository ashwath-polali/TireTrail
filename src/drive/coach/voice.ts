// Speaking cues and soft tones in the browser. Every call is guarded: no speech, no audio or no storage just does nothing.
// One line at a time: the phone's speech queue never holds more than the line being said. A line that comes meanwhile
// waits in one slot (a higher rank takes the slot) and is dropped once stale; a higher rank cuts a lower line being said.
// Below URGENT, lines are paced (pace.ts): 10 s apart, the same words not again within 2 minutes.
// Names are respelled for the voice only (sayable.ts). A salmon warning gets a soft chime first, a serious alert a strong one.
import type { Cue, CueKind } from './live.ts';
import { mayCome, remember, URGENT, type Spoken } from './pace.ts';
import { sayable } from './sayable.ts';

export { URGENT } from './pace.ts';

const MUTE = 'tt-voice-muted';

interface Voice { name: string; lang: string; localService?: boolean; voiceURI?: string }
interface Utt { text: string; rate: number; pitch: number; volume: number; lang: string; voice: unknown; onstart?: (() => void) | null; onend?: (() => void) | null; onerror?: (() => void) | null }
interface Speech {
  speak(u: unknown): void;
  cancel(): void;
  resume?(): void;
  speaking?: boolean;
  pending?: boolean;
  paused?: boolean;
  getVoices?(): Voice[];
  addEventListener?(k: string, f: () => void): void;
}

type G = typeof globalThis & {
  speechSynthesis?: Speech;
  SpeechSynthesisUtterance?: new (text: string) => Utt;
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
};

const g = () => globalThis as G;
let ctx: AudioContext | null = null;

/**
 * How much a line matters: a higher one cuts a lower one being said and takes the waiting slot from it.
 * URGENT (3) and up always come; lower ones are paced. For alerts: speak(line, { rank: RANK.serious, chime: 'serious' }).
 */
export const RANK: Readonly<Record<CueKind | 'serious', number>> = { serious: 4, 'salmon-ahead': 3, 'spot-ahead': 3, coast: 2, speeding: 1, 'hard-brake': 1, 'fast-start': 1 };
/** a waiting line is dropped after this long by default, ms: a tip about a moment that has passed is noise */
export const STALE_MS = 4000;
/** a waiting warning is dropped sooner, ms: late, it would point at the wrong place */
export const WARN_STALE_MS = 3000;
/** after a cancel the iPhone drops a line spoken at once, so the next waits this long, ms */
export const CUT_MS = 180;
/** quiet between two lines, ms */
const GAP_MS = 350;
/** the soft chime before a salmon warning, and the strong one before a serious alert: their words start this much later, ms */
export const CHIME_MS = 380;
export const SERIOUS_MS = 760;
/** the phone says a line is over (no end event came) once it has stopped speaking this long after the line went in, ms */
const SETTLE_MS = 700;

export type Chime = 'soft' | 'serious';
export interface SayOptions {
  /** how much it matters (RANK); 1 if not given */
  rank?: number;
  /** a chime first: true or 'soft' for a salmon warning, 'serious' for a serious alert */
  chime?: boolean | Chime;
  /** dropped if it has to wait longer than this, ms (default 4 s, warnings 3 s) */
  wait?: number;
  /** stop the line being said first, whatever its rank */
  cut?: boolean;
  volume?: number;
}

interface Line { text: string; rank: number; volume: number; chime: Chime | null; staleAt: number; paced: boolean }
/** the line the phone is saying (or about to: after a cut or a chime), the one waiting, and the one timer */
let cur: { line: Line; u: Utt | null; until: number } | null = null;
let next: Line | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let cutAt = -Infinity;
/** lines handed to the phone lately, for the pacing */
let past: Spoken[] = [];

/** the switch as last set on this page: the one truth while storage is blocked or slow */
let mutedNow: boolean | null = null;
const heard = new Set<(muted: boolean) => void>();
/** the phone started a line on this page (its start event came), so it lets later lines speak */
let primed = false;
/** the chosen voice, picked again when the phone's list changes */
let voice: Voice | null | undefined;
let watching = false;

/** Muted, as saved on this phone. */
export function isMuted(): boolean {
  if (mutedNow != null) return mutedNow;
  try { return g().localStorage?.getItem(MUTE) === '1'; } catch { return false; }
}

/** Mutes or unmutes, saved on this phone. Muting stops anything being said, and anything waiting, at once. */
export function setMuted(muted: boolean): void {
  mutedNow = muted;
  try { g().localStorage?.setItem(MUTE, muted ? '1' : '0'); } catch { /* blocked */ }
  if (muted) stopVoice();
  for (const f of heard) { try { f(muted); } catch { /* a switch gone */ } }
}

/** Calls f with every change of the switch; returns the way to stop. */
export function onVoice(f: (muted: boolean) => void): () => void {
  heard.add(f);
  return () => { heard.delete(f); };
}

/** For tests: forget the page's switch, tap, voice and lines, as a fresh page would. */
export function resetVoice(): void {
  [mutedNow, primed, voice, watching, cutAt, past] = [null, false, undefined, false, -Infinity, []];
  heard.clear();
  clear();
  [cur, next] = [null, null];
  ctx = null;
}

/** This browser can speak. */
export function canSpeak(): boolean {
  return !!g().speechSynthesis && typeof g().SpeechSynthesisUtterance === 'function';
}

// novelty and robotic voices the iPhone lists under en-US: never for a driver
const ODD = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
const NICE = /\b(ava|zoe|samantha|allison|susan|evan|nathan|tom|joelle|noelle|nicky|aaron|google us english|aria|jenny|guy)\b/i;

/** How good a voice is for a driver: premium over enhanced over a known clear US voice; null for one to skip. */
export function voiceScore(v: Voice): number | null {
  const id = `${v.name} ${v.voiceURI ?? ''}`;
  if (!/^en(-|_|$)/i.test(v.lang) || ODD.test(v.name) || /eloquence|speech\.synthesis\.voice/i.test(v.voiceURI ?? '')) return null;
  return (/premium/i.test(id) ? 40 : /enhanced|natural|neural/i.test(id) ? 20 : 0) + (NICE.test(v.name) ? 10 : 0) + (/en[-_]US/i.test(v.lang) ? 5 : 0) + (v.localService ? 1 : 0);
}

/** The best voice the phone lists, or null to leave the phone's own default for en-US. */
export function pickVoice(list: readonly Voice[]): Voice | null {
  let best: Voice | null = null, bs = -1;
  for (const v of list) {
    const s = voiceScore(v);
    if (s != null && s > bs) [best, bs] = [v, s];
  }
  return best;
}

function theVoice(s: Speech): Voice | null {
  if (!watching) {
    watching = true;
    // the iPhone often lists no voices until this fires
    try { s.addEventListener?.('voiceschanged', () => { voice = undefined; }); } catch { /* none */ }
  }
  if (voice === undefined) {
    try {
      const list = s.getVoices?.() ?? [];
      voice = pickVoice(list);
      // an empty list may fill in later: try again next line
      if (!list.length) { const v = voice; voice = undefined; return v; }
    } catch { voice = null; }
  }
  return voice ?? null;
}

/** About how long a line takes to say, ms (live.ts sayMs). */
const sayMs = (text: string) => 500 + 380 * text.split(/\s+/).filter(Boolean).length;

function clear(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function after(ms: number, f: () => void): void {
  clear();
  timer = setTimeout(() => { timer = null; f(); }, ms);
}

/** Hands the line to the phone now, after its chime, or after the pause a cancel needs. */
function begin(line: Line, wait: number): void {
  let ms = Math.max(wait, CUT_MS - (Date.now() - cutAt), 0);
  if (line.chime && chime(line.chime, ms)) ms += line.chime === 'serious' ? SERIOUS_MS : CHIME_MS;
  cur = { line, u: null, until: Infinity };
  if (ms > 0) after(ms, () => { if (cur?.line === line) hand(line); });
  else hand(line);
}

function hand(line: Line): void {
  const s = g().speechSynthesis;
  if (!s || isMuted()) { [cur, next] = [null, null]; return; }
  try {
    const u = new (g().SpeechSynthesisUtterance!)(sayable(line.text)) as unknown as Utt;
    u.rate = 1;
    u.pitch = 1;
    u.volume = line.volume;
    const v = theVoice(s);
    u.lang = v?.lang?.replace('_', '-') || 'en-US';
    if (v) u.voice = v as never;
    u.onstart = () => { primed = true; };
    u.onend = u.onerror = () => { if (cur?.u === u) done(); };
    // the phone pauses speech when the page was in the background
    if (s.paused) s.resume?.();
    s.speak(u);
    const t = Date.now();
    if (line.paced) past = remember(past, { text: line.text, at: t, rank: line.rank });
    // kept in cur: an utterance the page drops can be cleaned up mid line, and its end never comes
    cur = { line, u, until: t + sayMs(line.text) * 2 + 2000 };
    after(SETTLE_MS, watch);
  } catch { [cur, next] = [null, null]; }
}

/** No end event (a known iPhone bug, or a test's fake): the phone stopped speaking, or the line is stuck. */
function watch(): void {
  const s = g().speechSynthesis;
  if (!cur || !s) return;
  const t = Date.now(), talking = !!(s.speaking || s.pending);
  if (talking && t < cur.until) { after(250, watch); return; }
  if (talking) { s.cancel(); cutAt = t; }
  done();
}

/** The line is over: the waiting one goes next, unless it went stale. */
function done(): void {
  clear();
  cur = null;
  const n = next;
  next = null;
  if (n && Date.now() <= n.staleAt && !isMuted()) begin(n, GAP_MS);
}

/**
 * Says text calmly. With nothing being said it goes now; a line being said is left to finish and this one waits its turn
 * (dropped if it waits past o.wait). A higher rank than the line being said, or cut: true, stops that line first.
 * Below URGENT it is paced: false, and nothing said, within 10 s of the last such line or the same words within 2 min.
 * False if muted or the browser can't speak.
 */
export function speak(text: string, o: SayOptions = {}): boolean {
  if (!text || isMuted() || !canSpeak()) return false;
  const rank = o.rank ?? 1, now = Date.now();
  if (!mayCome(past, text, rank, now)) return false;
  return say({ text, rank, volume: o.volume ?? 1, chime: o.chime === true ? 'soft' : o.chime || null, staleAt: now + (o.wait ?? (rank >= URGENT ? WARN_STALE_MS : STALE_MS)), paced: rank < URGENT }, !!o.cut);
}

function say(line: Line, cut: boolean): boolean {
  try {
    if (!cur) { begin(line, 0); return true; }
    if (cut || line.rank > cur.line.rank) {
      // a warning over a tip: the tip stops, and nothing older waits behind it
      const s = g().speechSynthesis!;
      clear();
      [cur, next] = [null, null];
      s.cancel();
      cutAt = Date.now();
      begin(line, CUT_MS);
      return true;
    }
    if (!next || line.rank >= next.rank) next = line;
    return true;
  } catch { return false; }
}

/**
 * Call inside a tap (Start a drive, the voice switch, any first tap): the iPhone only speaks once a line was spoken from a tap.
 * Says text if given (and not muted), else a silent word, inside the tap, so every later line speaks with no more taps.
 * A tap's own line is never paced: it answers the driver.
 */
export function primeVoice(text = ''): boolean {
  unlockAudio();
  if (!canSpeak()) return false;
  if (!text || isMuted()) return primed || speakSilent();
  // the tap's line replaces anything being said
  if (cur) stopVoice();
  begin({ text, rank: 2, volume: 1, chime: null, staleAt: Infinity, paced: false }, 0);
  // held for the pause a cancel needs, the line goes in after the tap: a silent word now is what the tap hands the phone
  if (!cur?.u) speakSilent();
  return true;
}

/** The phone started a line on this page, so later lines will be heard (not just handed to it). */
export function voiceReady(): boolean {
  return primed;
}

function speakSilent(): boolean {
  if (!canSpeak()) return false;
  try {
    const s = g().speechSynthesis!, u = new (g().SpeechSynthesisUtterance!)(' ') as unknown as Utt;
    u.volume = 0;
    u.lang = 'en-US';
    u.onstart = () => { primed = true; };
    if (s.paused) s.resume?.();
    s.speak(u);
    return true;
  } catch { return false; }
}

/** Stops anything being said, and anything waiting. */
export function stopVoice(): void {
  clear();
  [cur, next] = [null, null];
  try { g().speechSynthesis?.cancel(); } catch { /* none */ }
  cutAt = Date.now();
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const A = g().AudioContext ?? g().webkitAudioContext;
  if (!A) return null;
  try { return (ctx = new A()); } catch { return null; }
}

/** Call from a tap (the Start button) so phones allow tones and chimes later: the iPhone wants a sound played in the tap too. */
export function unlockAudio(): void {
  const a = audio();
  if (!a) return;
  try { void a.resume(); } catch { /* none */ }
  try {
    const src = a.createBufferSource();
    src.buffer = a.createBuffer(1, 1, 22050);
    src.connect(a.destination);
    src.start(0);
  } catch { /* none */ }
}

function notes(a: AudioContext, list: readonly (readonly [number, number])[], peak: number, at = 0): void {
  for (const [dt, hz] of list) {
    const o = a.createOscillator(), gain = a.createGain(), t = a.currentTime + at + dt;
    o.type = 'sine';
    o.frequency.value = hz;
    // quick fade in and out so it doesn't click
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.02);
    gain.gain.linearRampToValueAtTime(0, t + 0.15);
    o.connect(gain).connect(a.destination);
    o.start(t);
    o.stop(t + 0.16);
  }
}

/** A short soft tone ('alert': two quick notes). False if muted or no audio. */
export function tone(kind: 'soft' | 'alert' = 'soft'): boolean {
  if (isMuted()) return false;
  const a = audio();
  if (!a) return false;
  try {
    notes(a, kind === 'alert' ? [[0, 740], [0.18, 740]] : [[0, 523]], kind === 'alert' ? 0.22 : 0.15);
    return true;
  } catch { return false; }
}

/** the notes of each chime: the soft one rises once, the serious one falls twice and louder */
export const CHIMES: Readonly<Record<Chime, { notes: readonly (readonly [number, number])[]; peak: number }>> = {
  soft: { notes: [[0, 660], [0.14, 880]], peak: 0.25 },
  serious: { notes: [[0, 988], [0.15, 784], [0.36, 988], [0.51, 784]], peak: 0.4 },
};

/** TireTrail's own chime, in ms from now; false (and no wait) when the phone's audio isn't running or Voice is off. */
function chime(kind: Chime, inMs: number): boolean {
  const a = ctx;
  if (!a || a.state !== 'running' || isMuted()) return false;
  try { notes(a, CHIMES[kind].notes, CHIMES[kind].peak, inMs / 1000); return true; } catch { return false; }
}

/** Gives a live coach cue: speaks its words (a salmon warning after a soft chime), or plays its tone when it has none. */
export function playCue(cue: Cue | null): boolean {
  if (!cue) return false;
  if (!cue.say) return tone(cue.tone);
  return speak(cue.say, { rank: RANK[cue.kind] ?? 1, chime: cue.kind === 'salmon-ahead' });
}
