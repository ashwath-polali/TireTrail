// Speaking cues and soft tones in the browser. Every call is guarded: no speech, no audio or no storage just does nothing.
import type { Cue } from './live.ts';

const MUTE = 'tt-voice-muted';

interface Speech {
  speak(u: unknown): void;
  cancel(): void;
  resume?(): void;
  speaking?: boolean;
  pending?: boolean;
  paused?: boolean;
  getVoices?(): { name: string; lang: string; localService?: boolean }[];
}

type G = typeof globalThis & {
  speechSynthesis?: Speech;
  SpeechSynthesisUtterance?: new (text: string) => { rate: number; pitch: number; volume: number; lang: string; voice: unknown };
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
};

const g = () => globalThis as G;
let ctx: AudioContext | null = null;
let startedAt = 0;
/** a line still "speaking" after this long is stuck (a known phone bug), ms */
const STUCK_MS = 10_000;

/** the switch as last set on this page: the one truth while storage is blocked or slow */
let mutedNow: boolean | null = null;
const heard = new Set<(muted: boolean) => void>();
/** a line was spoken from a tap on this page, so the phone lets later lines speak */
let primed = false;

/** Muted, as saved on this phone. */
export function isMuted(): boolean {
  if (mutedNow != null) return mutedNow;
  try { return g().localStorage?.getItem(MUTE) === '1'; } catch { return false; }
}

/** Mutes or unmutes, saved on this phone. Muting stops anything being said at once. */
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

/** For tests: forget the page's switch and tap, as a fresh page would. */
export function resetVoice(): void {
  [mutedNow, primed] = [null, false];
  heard.clear();
}

/** This browser can speak. */
export function canSpeak(): boolean {
  return !!g().speechSynthesis && typeof g().SpeechSynthesisUtterance === 'function';
}

// a calm English voice: the phone's own US voice when there is one
function pickVoice(s: Speech): unknown {
  try {
    const all = s.getVoices?.() ?? [], en = all.filter((v) => /^en(-|_|$)/i.test(v.lang));
    return en.find((v) => /samantha|aria|jenny|natural|google us english/i.test(v.name)) ?? en.find((v) => /en[-_]US/i.test(v.lang) && v.localService) ?? en.find((v) => /en[-_]US/i.test(v.lang)) ?? en[0] ?? null;
  } catch { return null; }
}

/**
 * Says text calmly. A line still being said is left to finish and this one follows it (the coach spaces them);
 * cut: true stops it first. False if muted or the browser can't speak.
 */
export function speak(text: string, o: { cut?: boolean; volume?: number } = {}): boolean {
  if (!text || isMuted() || !canSpeak()) return false;
  try {
    const s = g().speechSynthesis!, u = new (g().SpeechSynthesisUtterance!)(text);
    u.rate = 1;
    u.pitch = 1;
    u.volume = o.volume ?? 1;
    u.lang = 'en-US';
    const v = pickVoice(s);
    if (v) u.voice = v as never;
    // only a cut or a stuck line clears the queue: the iPhone drops a line spoken right after a cancel
    if (o.cut || ((s.speaking || s.pending) && Date.now() - startedAt > STUCK_MS)) s.cancel();
    // the phone pauses speech when the page was in the background
    if (s.paused) s.resume?.();
    s.speak(u);
    startedAt = Date.now();
    return true;
  } catch { return false; }
}

/**
 * Call inside a tap (Start a drive, the voice switch): the iPhone only speaks once a line was spoken from a tap.
 * Says text if given (and not muted), else a silent word, so every later line speaks with no more taps.
 */
export function primeVoice(text = ''): boolean {
  unlockAudio();
  if (!canSpeak()) return false;
  const ok = text && !isMuted() ? speak(text) : primed || speakSilent();
  primed ||= ok;
  return ok;
}

/** A line was spoken from a tap on this page (or the browser says it has had one). */
export function voiceReady(): boolean {
  const ua = (globalThis as { navigator?: { userActivation?: { hasBeenActive?: boolean } } }).navigator?.userActivation;
  return primed || !!ua?.hasBeenActive;
}

function speakSilent(): boolean {
  if (!canSpeak()) return false;
  try {
    const s = g().speechSynthesis!, u = new (g().SpeechSynthesisUtterance!)(' ');
    u.volume = 0;
    u.lang = 'en-US';
    if (s.paused) s.resume?.();
    s.speak(u);
    return true;
  } catch { return false; }
}

/** Stops anything being said. */
export function stopVoice(): void {
  try { g().speechSynthesis?.cancel(); } catch { /* none */ }
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const A = g().AudioContext ?? g().webkitAudioContext;
  if (!A) return null;
  try { return (ctx = new A()); } catch { return null; }
}

/** Call from a tap (the Start button) so phones allow tones later. */
export function unlockAudio(): void {
  try { void audio()?.resume(); } catch { /* none */ }
}

/** A short soft tone ('alert': two quick notes). False if muted or no audio. */
export function tone(kind: 'soft' | 'alert' = 'soft'): boolean {
  if (isMuted()) return false;
  const a = audio();
  if (!a) return false;
  try {
    const notes = kind === 'alert' ? [[0, 740], [0.18, 740]] : [[0, 523]];
    for (const [at, hz] of notes) {
      const o = a.createOscillator(), gain = a.createGain(), t = a.currentTime + at;
      o.type = 'sine';
      o.frequency.value = hz;
      // quick fade in and out so it doesn't click
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(kind === 'alert' ? 0.22 : 0.15, t + 0.02);
      gain.gain.linearRampToValueAtTime(0, t + 0.15);
      o.connect(gain).connect(a.destination);
      o.start(t);
      o.stop(t + 0.16);
    }
    return true;
  } catch { return false; }
}

/** Gives a live coach cue: speaks its words, or plays its tone when it has none. */
export function playCue(cue: Cue | null): boolean {
  if (!cue) return false;
  return cue.say ? speak(cue.say) : tone(cue.tone);
}
