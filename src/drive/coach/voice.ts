// Speaking cues and soft tones in the browser. Every call is guarded: no speech, no audio or no storage just does nothing.
import type { Cue } from './live.ts';

const MUTE = 'tt-voice-muted';

interface Speech {
  speak(u: unknown): void;
  cancel(): void;
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

/** Muted, as saved on this phone. */
export function isMuted(): boolean {
  try { return g().localStorage?.getItem(MUTE) === '1'; } catch { return false; }
}

/** Mutes or unmutes, saved on this phone. Muting stops anything being said. */
export function setMuted(muted: boolean): void {
  try { g().localStorage?.setItem(MUTE, muted ? '1' : '0'); } catch { /* blocked */ }
  if (muted) stopVoice();
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

/** Says text calmly, cutting off the line before. False if muted or the browser can't speak. */
export function speak(text: string): boolean {
  if (!text || isMuted() || !canSpeak()) return false;
  try {
    const s = g().speechSynthesis!, u = new (g().SpeechSynthesisUtterance!)(text);
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    u.lang = 'en-US';
    const v = pickVoice(s);
    if (v) u.voice = v as never;
    s.cancel();
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
