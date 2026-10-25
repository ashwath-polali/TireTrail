/** voice queue: one line at a time, ranks cut through, stale lines dropped, pacing, chimes, Voice off at once, names respelled, a good voice */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { Cue } from '../src/drive/coach/live.ts';
import { mayCome, PACE, remember, URGENT } from '../src/drive/coach/pace.ts';
import { CHIME_MS, CHIMES, CUT_MS, pickVoice, playCue, primeVoice, RANK, resetVoice, SERIOUS_MS, setMuted, speak, voiceReady } from '../src/drive/coach/voice.ts';
import { sayable } from '../src/drive/coach/sayable.ts';
import { useStorage } from './engine-helpers.ts';

type Any = Record<string, unknown>;
const G = globalThis as unknown as Any;
let log: string[] = [];
/** the utterances the phone was given, so a test can end them */
let given: Any[] = [];

function fakeSpeech(events = true, voices: Any[] = [{ name: 'Samantha', lang: 'en-US', localService: true }]): Any {
  const s: Any = {
    speaking: false,
    speak: (u: Any) => {
      given.push(u);
      log.push(`speak ${u.text}`);
      if (events) { s.speaking = true; (u.onstart as (() => void) | null)?.(); }
    },
    cancel: () => { log.push('cancel'); s.speaking = false; },
    getVoices: () => voices,
  };
  G.speechSynthesis = s;
  G.SpeechSynthesisUtterance = class { text: string; rate = 0; pitch = 0; volume = 0; lang = ''; voice: unknown = null; onstart = null; onend = null; onerror = null; constructor(t: string) { this.text = t; } };
  return s;
}

/** phone audio that runs, logging each note's pitch */
function fakeAudio(beeps: number[], state = 'running'): void {
  const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
  G.AudioContext = class {
    state = state; currentTime = 0; destination = {};
    resume() { return Promise.resolve(); }
    createGain() { return { gain: param, connect: (d: unknown) => d }; }
    createOscillator() { const o = { type: '', frequency: { value: 0 }, connect: (x: unknown) => x, start: () => beeps.push(o.frequency.value), stop() {} }; return o; }
  };
}

/** the phone finishes the line it is saying */
function end(s: Any): void {
  s.speaking = false;
  const u = given.at(-1);
  (u?.onend as (() => void) | null)?.();
}

const cue = (kind: Cue['kind'], say: string): Cue => ({ kind, say, tone: 'soft', priority: 1, at: 0, ref: '' });
const spoken = () => log.filter((l) => l.startsWith('speak '));

describe('voice queue', () => {
  beforeEach(() => {
    [log, given] = [[], []];
    useStorage(10_000);
    resetVoice();
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    resetVoice();
    mock.timers.reset();
    for (const k of ['speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext']) delete G[k];
  });

  test('one line at a time: a line that comes meanwhile waits in the page for the end, then goes', () => {
    const s = fakeSpeech();
    speak('Hard-brake spot ahead. Ease off.', { rank: RANK['spot-ahead'] });
    speak('Fennel Creek ahead. Coho stream.', { rank: RANK['salmon-ahead'] });
    assert.deepEqual(log, ['speak Hard-brake spot ahead. Ease off.']);
    mock.timers.tick(1500);
    end(s);
    mock.timers.tick(400);
    assert.deepEqual(log, ['speak Hard-brake spot ahead. Ease off.', 'speak Fennel Creek ahead. Coho stream.']);
  });

  test('a salmon warning never waits behind a tip: the tip is cut, the warning goes after the pause a cancel needs', () => {
    fakeSpeech();
    speak('Limit 45. Easing off saves gas.', { rank: RANK.speeding });
    playCue(cue('salmon-ahead', 'Fennel Creek ahead. Coho stream.'));
    assert.deepEqual(log, ['speak Limit 45. Easing off saves gas.', 'cancel']);
    mock.timers.tick(CUT_MS);
    assert.deepEqual(log.at(-1), 'speak Fennel Creek ahead. Coho stream.');
  });

  test('a tip never cuts or bumps a warning, and a stale tip is dropped', () => {
    const s = fakeSpeech();
    playCue(cue('salmon-ahead', 'Canyonfalls Creek ahead. Coho stream.'));
    speak('Rain today. Easy near the creeks.', { rank: 1 });
    // the warning goes on; the tip waits, then is too old once the warning ends 5 s later
    mock.timers.tick(5000);
    end(s);
    mock.timers.tick(1000);
    assert.deepEqual(log, ['speak Canyon Falls Creek ahead. Coho stream.']);
  });

  test('Voice off stops the line and the one waiting at once, and nothing comes after', () => {
    const s = fakeSpeech();
    speak('Hard-brake spot ahead. Ease off.', { rank: 3 });
    speak('Fennel Creek ahead. Coho stream.', { rank: 3 });
    setMuted(true);
    end(s);
    mock.timers.tick(10_000);
    assert.deepEqual(log, ['speak Hard-brake spot ahead. Ease off.', 'cancel']);
  });

  test('Voice off during the pause after a cut: the warning is not said', () => {
    fakeSpeech();
    speak('Limit 45. Ease off.', { rank: 1 });
    playCue(cue('spot-ahead', 'Hard-brake spot ahead. Ease off.'));
    setMuted(true);
    mock.timers.tick(1000);
    assert.equal(spoken().length, 1);
  });

  test('no end event (an iPhone bug, or the e2e spy): the next line goes once the phone stops speaking', () => {
    fakeSpeech(false);
    primeVoice('Recording. Drive as usual.');
    // the rain line waits behind the start line, and isn't held back by the pacing (a tap's line doesn't count)
    assert.equal(speak('Rain today. Easy near the creeks.', { wait: 10_000 }), true);
    mock.timers.tick(700);
    mock.timers.tick(400);
    assert.deepEqual(log, ['speak Recording. Drive as usual.', 'speak Rain today. Easy near the creeks.']);
  });

  test('a line stuck speaking is cancelled, and the next one waits for the pause a cancel needs', () => {
    const s = fakeSpeech();
    speak('Hard-brake spot ahead. Ease off.', { rank: 3 });
    speak('Fennel Creek ahead. Coho stream.', { rank: 3, wait: 60_000 });
    // speaking never ends: after its time is up the phone is told to stop
    mock.timers.tick(10_000);
    assert.equal(log.includes('cancel'), true);
    mock.timers.tick(CUT_MS + 400);
    assert.equal(log.at(-1), 'speak Fennel Creek ahead. Coho stream.');
    assert.equal(s.speaking, true);
  });

  test('a salmon warning gets the soft chime first when the phone audio runs, then its words', () => {
    fakeSpeech();
    const beeps: number[] = [];
    fakeAudio(beeps);
    primeVoice();
    log.length = 0;
    playCue(cue('salmon-ahead', 'Puyallup River ahead. Coho stream.'));
    assert.deepEqual(beeps, [660, 880]);
    assert.deepEqual(log, []);
    mock.timers.tick(CHIME_MS);
    assert.deepEqual(log, ['speak pew allup River ahead. Coho stream.']);
  });

  test('a serious alert cuts even a salmon warning, after the strong double chime', () => {
    fakeSpeech();
    const beeps: number[] = [];
    fakeAudio(beeps);
    primeVoice();
    log.length = 0;
    speak('Fennel Creek ahead. Coho stream.', { rank: RANK['salmon-ahead'] });
    assert.equal(speak('Slow down now.', { rank: RANK.serious, chime: 'serious' }), true);
    assert.deepEqual(log, ['speak Fennel Creek ahead. Coho stream.', 'cancel']);
    assert.deepEqual(beeps, CHIMES.serious.notes.map(([, hz]) => hz));
    mock.timers.tick(CUT_MS + SERIOUS_MS - 1);
    assert.equal(log.at(-1), 'cancel');
    mock.timers.tick(1);
    assert.equal(log.at(-1), 'speak Slow down now.');
    // and a salmon warning never cuts the serious one
    speak('Canyonfalls Creek ahead. Coho stream.', { rank: RANK['salmon-ahead'] });
    assert.equal(log.at(-1), 'speak Slow down now.');
  });

  test('no chime when the phone audio was never unlocked, so the words are never held back', () => {
    fakeSpeech();
    const beeps: number[] = [];
    fakeAudio(beeps, 'suspended');
    primeVoice();
    log.length = 0;
    playCue(cue('salmon-ahead', 'Fennel Creek ahead. Coho stream.'));
    assert.deepEqual(beeps, []);
    assert.deepEqual(log, ['speak Fennel Creek ahead. Coho stream.']);
  });

  test('pacing: tips 10 s apart, the same words not within 2 minutes, warnings always', () => {
    const s = fakeSpeech();
    assert.equal(speak('Limit 45. Ease off.'), true);
    end(s);
    mock.timers.tick(5000);
    // a tip 5 s after a tip is dropped, not said late
    assert.equal(speak('Hard brake. Ease off sooner.'), false);
    // a warning always comes
    assert.equal(playCue(cue('salmon-ahead', 'Fennel Creek ahead. Coho stream.')), true);
    end(s);
    mock.timers.tick(6000);
    assert.equal(speak('Hard brake. Ease off sooner.'), true);
    end(s);
    mock.timers.tick(30_000);
    assert.equal(speak('Hard brake. Ease off sooner.'), false);
    mock.timers.tick(PACE.sameMs);
    assert.equal(speak('Hard brake. Ease off sooner.'), true);
    assert.deepEqual(spoken(), ['speak Limit 45. Ease off.', 'speak Fennel Creek ahead. Coho stream.', 'speak Hard brake. Ease off sooner.', 'speak Hard brake. Ease off sooner.']);
  });

  test('the Start tap hands its line to the phone inside the tap, and the phone is ready only once it starts', () => {
    fakeSpeech(false);
    assert.equal(primeVoice('Recording. Drive as usual.'), true);
    assert.deepEqual(log, ['speak Recording. Drive as usual.']);
    // no start event came: the phone may have refused it
    assert.equal(voiceReady(), false);
  });

  test('every tap with nothing to say hands the phone a silent word until one has started', () => {
    fakeSpeech(false);
    primeVoice();
    primeVoice();
    assert.deepEqual(log, ['speak  ', 'speak  ']);
    assert.equal(voiceReady(), false);
  });

  test('the Start tap right after a cancel still hands the phone a word inside the tap', () => {
    const s = fakeSpeech();
    speak('Hard brake.');
    assert.equal(primeVoice('Recording. Drive as usual.'), true);
    assert.deepEqual(log, ['speak Hard brake.', 'cancel', 'speak  ']);
    mock.timers.tick(CUT_MS);
    assert.equal(log.at(-1), 'speak Recording. Drive as usual.');
    assert.equal(voiceReady(), true);
    assert.equal(s.speaking, true);
  });
});

describe('pacing, pure', () => {
  const p = (text: string, at: number, rank: number) => ({ text, at, rank });

  test('a warning or serious alert always comes', () => {
    assert.equal(URGENT, RANK['salmon-ahead']);
    assert.equal(mayCome([p('Fennel Creek ahead. Coho stream.', 0, 3)], 'Fennel Creek ahead. Coho stream.', 3, 1000), true);
    assert.equal(mayCome([p('Limit 45. Ease off.', 0, 1)], 'Slow down now.', RANK.serious, 1), true);
  });

  test('a tip waits 10 s after the last tip; a warning before it does not count', () => {
    assert.equal(mayCome([p('Limit 45. Ease off.', 0, 1)], 'Hard brake. Ease off sooner.', 1, PACE.gapMs - 1), false);
    assert.equal(mayCome([p('Limit 45. Ease off.', 0, 1)], 'Hard brake. Ease off sooner.', 1, PACE.gapMs), true);
    assert.equal(mayCome([p('Fennel Creek ahead. Coho stream.', 0, 3)], 'Hard brake. Ease off sooner.', 1, 2000), true);
  });

  test('the same tip not again within 2 minutes', () => {
    assert.equal(mayCome([p('Stop ahead. Coast.', 0, 2)], 'Stop ahead. Coast.', 2, PACE.sameMs - 1), false);
    assert.equal(mayCome([p('Stop ahead. Coast.', 0, 2)], 'Stop ahead. Coast.', 2, PACE.sameMs), true);
  });

  test('remember keeps only what still matters', () => {
    const past = remember([p('a', 0, 1), p('b', 60_000, 1)], p('c', PACE.sameMs, 1));
    assert.deepEqual(past.map((x) => x.text), ['b', 'c']);
  });
});

describe('words for the voice', () => {
  test('hard names are respelled for the voice only, in any name that holds them', () => {
    assert.equal(sayable('Puyallup River ahead. Coho stream.'), 'pew allup River ahead. Coho stream.');
    assert.equal(sayable('North Fork Skykomish River ahead.'), 'North Fork sky ko mish River ahead.');
    assert.equal(sayable('Canyonfalls Creek ahead.'), 'Canyon Falls Creek ahead.');
    assert.equal(sayable('Duckabush River ahead. Chum stream.'), 'duck uh bush River ahead. Chum stream.');
    assert.equal(sayable('Klickitat River ahead.'), 'click ih tat River ahead.');
    assert.equal(sayable('Entiat River ahead.'), 'en tee at River ahead.');
    assert.equal(sayable('Fennel Creek ahead. Coho stream.'), 'Fennel Creek ahead. Coho stream.');
    // whole words only
    assert.equal(sayable('Solberg Creek'), 'Solberg Creek');
  });

  test('the voice: premium over enhanced over the plain one; novelty and robotic voices never', () => {
    const v = (name: string, voiceURI = '', lang = 'en-US') => ({ name, lang, voiceURI, localService: true });
    assert.equal(pickVoice([v('Albert'), v('Samantha', 'com.apple.voice.compact.en-US.Samantha'), v('Samantha (Enhanced)', 'com.apple.voice.enhanced.en-US.Samantha'), v('Ava (Premium)', 'com.apple.voice.premium.en-US.Ava')])?.name, 'Ava (Premium)');
    assert.equal(pickVoice([v('Bad News'), v('Fred'), v('Eddy (English (US))', 'com.apple.eloquence.en-US.Eddy'), v('Aaron')])?.name, 'Aaron');
    assert.equal(pickVoice([v('Zarvox'), v('Anna', '', 'de-DE')]), null);
    assert.equal(pickVoice([v('Daniel', '', 'en-GB'), v('Samantha')])?.name, 'Samantha');
  });

  test('the voice is picked again once the phone lists its voices', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    try {
      resetVoice();
      useStorage(10_000);
      const voices: Any[] = [], seen: Record<string, () => void> = {};
      const s = fakeSpeech(true, voices);
      s.addEventListener = (k: string, f: () => void) => { seen[k] = f; };
      speak('Fennel Creek ahead. Coho stream.', { rank: 3 });
      assert.equal(given.at(-1)?.voice, null);
      end(s);
      voices.push({ name: 'Ava (Premium)', lang: 'en-US', voiceURI: 'com.apple.voice.premium.en-US.Ava' });
      seen.voiceschanged?.();
      mock.timers.tick(1000);
      speak('Canyonfalls Creek ahead. Coho stream.', { rank: 3 });
      assert.equal((given.at(-1)?.voice as Any | null)?.name, 'Ava (Premium)');
    } finally {
      resetVoice();
      mock.timers.reset();
      for (const k of ['speechSynthesis', 'SpeechSynthesisUtterance']) delete G[k];
    }
  });
});
