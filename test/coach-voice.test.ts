/** voice: speaks calmly, lets a line finish, plays tones, remembers mute, and never crashes without speech or audio */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Cue } from '../src/drive/coach/live.ts';
import { canSpeak, isMuted, onVoice, playCue, primeVoice, resetVoice, setMuted, speak, stopVoice, tone, unlockAudio, voiceReady } from '../src/drive/coach/voice.ts';
import { useStorage } from './engine-helpers.ts';

type Any = Record<string, unknown>;
const G = globalThis as unknown as Any;
const log: string[] = [];

function fakeSpeech(): void {
  G.speechSynthesis = {
    speak: (u: Any) => log.push(`speak ${u.text} rate=${u.rate} voice=${(u.voice as Any | undefined)?.name ?? '-'}`),
    cancel: () => log.push('cancel'),
    getVoices: () => [{ name: 'Fred', lang: 'de-DE' }, { name: 'Samantha', lang: 'en-US', localService: true }],
  };
  G.SpeechSynthesisUtterance = class { text: string; rate = 0; pitch = 0; volume = 0; lang = ''; voice: unknown = null; constructor(t: string) { this.text = t; } };
}

function fakeAudio(): void {
  const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
  G.AudioContext = class {
    currentTime = 0;
    destination = {};
    resume() { log.push('resume'); return Promise.resolve(); }
    createGain() { return { gain: param, connect: (d: unknown) => d }; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect: (g: unknown) => g, start: () => log.push('beep'), stop() {} }; }
  };
}

const cue = (say: string, t: 'soft' | 'alert' = 'soft'): Cue => ({ kind: say ? 'coast' : 'hard-brake', say, tone: t, priority: 1, at: 0, ref: '' });

describe('voice', () => {
  beforeEach(() => { log.length = 0; useStorage(10_000); resetVoice(); });
  afterEach(() => { for (const k of ['speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext']) delete G[k]; });

  test('without speech or audio nothing crashes and nothing is played', () => {
    assert.equal(canSpeak(), false);
    assert.equal(speak('Stop ahead. Coast.'), false);
    assert.equal(tone('alert'), false);
    assert.equal(playCue(cue('')), false);
    assert.equal(playCue(null), false);
    stopVoice();
    unlockAudio();
  });

  test('speaks at a normal rate in an English voice', () => {
    fakeSpeech();
    assert.equal(speak('Stop ahead. Coast.'), true);
    // no cancel first: the iPhone drops a line spoken right after one
    assert.deepEqual(log, ['speak Stop ahead. Coast. rate=1 voice=Samantha']);
  });

  test('speech paused in the background is resumed before a line', () => {
    fakeSpeech();
    Object.assign(G.speechSynthesis as Any, { paused: true, resume: () => log.push('resume') });
    speak('Hard brake.');
    assert.deepEqual(log, ['resume', 'speak Hard brake. rate=1 voice=Samantha']);
  });

  test('the Start tap speaks its line inside the tap, and the phone is ready after', () => {
    fakeSpeech();
    assert.equal(voiceReady(), false);
    assert.equal(primeVoice('Recording. Drive as usual.'), true);
    assert.deepEqual(log, ['speak Recording. Drive as usual. rate=1 voice=Samantha']);
    assert.equal(voiceReady(), true);
  });

  test('muted, the tap still readies the phone with a silent word, so turning the voice on later speaks', () => {
    fakeSpeech();
    setMuted(true);
    log.length = 0;
    assert.equal(primeVoice('Recording. Drive as usual.'), true);
    assert.deepEqual(log, ['speak   rate=0 voice=-']);
    assert.equal(voiceReady(), true);
    // once ready, another tap with nothing to say speaks nothing
    log.length = 0;
    primeVoice();
    assert.deepEqual(log, []);
  });

  test('the switch: one truth, every listener told at once, off stops speech, a stopped listener hears nothing', () => {
    fakeSpeech();
    const seen: boolean[] = [], stop = onVoice((m) => seen.push(m));
    setMuted(true);
    assert.deepEqual(log, ['cancel']);
    assert.equal(isMuted(), true);
    setMuted(false);
    assert.equal(isMuted(), false);
    stop();
    setMuted(true);
    assert.deepEqual(seen, [true, false]);
  });

  test('blocked storage: the switch still holds on this page', () => {
    G.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    setMuted(true);
    assert.equal(isMuted(), true);
    setMuted(false);
    assert.equal(isMuted(), false);
  });

  test('a line still being said is not cut off, unless asked', () => {
    fakeSpeech();
    (G.speechSynthesis as Any).speaking = true;
    speak('Hard-brake spot ahead. Ease off.');
    log.length = 0;
    speak('Hard brake.');
    assert.deepEqual(log, ['speak Hard brake. rate=1 voice=Samantha']);
    log.length = 0;
    speak('Voice on.', { cut: true });
    assert.deepEqual(log, ['cancel', 'speak Voice on. rate=1 voice=Samantha']);
  });

  test('a cue with words is spoken; one without plays its tone', () => {
    fakeSpeech();
    fakeAudio();
    playCue(cue('Limit 45. Ease off.'));
    playCue(cue('', 'alert'));
    assert.deepEqual(log.filter((l) => l !== 'cancel'), ['speak Limit 45. Ease off. rate=1 voice=Samantha', 'beep', 'beep']);
  });

  test('mute is remembered and silences both', () => {
    fakeSpeech();
    fakeAudio();
    assert.equal(isMuted(), false);
    setMuted(true);
    assert.equal(isMuted(), true);
    assert.equal(localStorage.getItem('tt-voice-muted'), '1');
    log.length = 0;
    assert.equal(speak('hi'), false);
    assert.equal(tone(), false);
    assert.deepEqual(log, []);
    setMuted(false);
    assert.equal(speak('hi'), true);
  });

  test('blocked storage reads as not muted', () => {
    G.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(isMuted(), false);
    setMuted(true);
  });
});
