/** voice: speaks calmly, cuts off the line before, plays tones, remembers mute, and never crashes without speech or audio */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Cue } from '../src/drive/coach/live.ts';
import { canSpeak, isMuted, playCue, setMuted, speak, stopVoice, tone, unlockAudio } from '../src/drive/coach/voice.ts';
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
  beforeEach(() => { log.length = 0; useStorage(10_000); });
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

  test('speaks at a normal rate in an English voice, cutting off the line before', () => {
    fakeSpeech();
    assert.equal(speak('Stop ahead. Coast.'), true);
    assert.deepEqual(log, ['cancel', 'speak Stop ahead. Coast. rate=1 voice=Samantha']);
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
