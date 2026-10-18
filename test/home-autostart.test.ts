/** Drive home: Start by itself and its setup steps, the week card's money and salmon lines */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DriveSummary, StopPoint } from '../src/drive/summary.ts';
import type { StopClass } from '../src/drive/tips.ts';
import {
  autoState, autoStatus, browserOf, EACH_DRIVE, installLine, IOS_SHORTCUT_URL, mustAsk, phoneOf, readProgress, RESUME_MS, samsungModel,
  stepsFor, testWord, whenWord, type Phone,
} from '../src/app/screens/autostart-words.ts';
import { salmonCount, salmonLine } from '../src/app/screens/home-words.ts';

const DASHES = /[–—]/;
const usd = (typical: number) => ({ low: typical / 2, typical, high: typical * 2 });
const at = (day: number, hour = 9) => new Date(2026, 9, 12 + day, hour).getTime(); // Monday 12 Oct 2026
const stop = (lon: number, hard = false): StopPoint => ({ t: 0, lat: 47.17, lon, heading: null, hard, usd: 0, name: '' });
const sum = (t: number, o: Partial<DriveSummary> = {}): DriveSummary => ({
  v: 2, at: t, mi: 5, min: 12, score: 90, lost: { brakes: 0, starts: 0, speed: 0 }, hardBrakes: 0, fastStarts: 0, overMi: 0, stops: 0, hardStops: 0,
  gas: usd(0), tires: usd(0), salmon: 0, brakes: [], ...o,
});

describe('which phone', () => {
  test('iPhones and iPads, Samsung by its browser or model, other Android, or unknown', () => {
    assert.equal(phoneOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'), 'iphone');
    assert.equal(phoneOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5), 'iphone');
    assert.equal(phoneOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 0), null);
    assert.equal(phoneOf('Mozilla/5.0 (Linux; Android 14; SM-S921U) SamsungBrowser/25.0 Chrome/121'), 'samsung');
    assert.equal(phoneOf('Mozilla/5.0 (Linux; Android 10; K) Chrome/130.0.0.0 Mobile Safari/537.36'), 'android');
    assert.equal(phoneOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130'), null);
  });

  test('asks when unknown, or when Chrome hides whether it is a Samsung', () => {
    assert.equal(mustAsk(null, null), true);
    assert.equal(mustAsk('android', null), true);
    assert.equal(mustAsk('iphone', null), false);
    assert.equal(mustAsk('samsung', null), false);
    assert.equal(mustAsk('android', 'android'), false);
  });
});

describe('which browser', () => {
  test('Samsung Internet, Chrome, Safari, or another browser', () => {
    assert.equal(browserOf('Mozilla/5.0 (Linux; Android 14; SM-S921U) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'), 'samsung');
    assert.equal(browserOf('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'), 'chrome');
    assert.equal(browserOf('Mozilla/5.0 (Linux; Android 10; K) Gecko/130.0 Firefox/130.0'), 'other');
    assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1'), 'safari');
    assert.equal(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile/15E148 Safari/604.1'), 'other');
  });

  test("Chrome's model hint tells a Samsung apart", () => {
    assert.equal(samsungModel('SM-S921U'), true);
    assert.equal(samsungModel('Pixel 9'), false);
    assert.equal(samsungModel(undefined), false);
  });

  test('install words match the browser, and the one-tap dialog wins', () => {
    assert.match(installLine('samsung', false), /Add page to/);
    assert.doesNotMatch(installLine('samsung', false), /Chrome|three dots/);
    assert.match(installLine('chrome', false), /three dots/);
    assert.match(installLine('other', false), /Chrome/);
    assert.equal(installLine('samsung', true), installLine('chrome', true));
  });
});

describe('setup steps', () => {
  const phones: Phone[] = ['iphone', 'samsung', 'android'];
  const variants = (p: Phone) => [
    stepsFor(p), stepsFor(p, { app: true, installed: true }), stepsFor(p, { browser: 'samsung' }), stepsFor(p, { canPrompt: true }),
    stepsFor(p, { shortcut: 'https://www.icloud.com/shortcuts/x' }),
  ];
  const all = phones.flatMap((p) => variants(p).flat());

  test('every step is short: a title of 8 words or fewer, lines under 90 characters, no dashes', () => {
    for (const s of all) {
      assert.ok(s.title.split(/\s+/).length <= 8, s.title);
      for (const x of [s.line, ...(s.list ?? []), ...(s.notes ?? [])]) {
        assert.ok(x.length <= 90, x);
        assert.doesNotMatch(x, DASHES);
      }
      assert.doesNotMatch(s.title, DASHES);
      assert.ok(s.art.length >= 1);
      assert.ok(!s.list || s.list.length <= 5, s.title);
    }
  });

  test('step names are unique, so a saved step reopens in the right place', () => {
    for (const p of phones) for (const xs of variants(p)) assert.equal(new Set(xs.map((s) => s.id)).size, xs.length);
  });

  test('each leads with what to do and how long, the reason in one short note, and ends with a test', () => {
    for (const p of phones) {
      const xs = stepsFor(p);
      assert.equal(xs[0].id, 'intro');
      assert.match(xs[0].line, /minute.*parked/);
      assert.equal(xs[0].notes?.length, 1);
      assert.equal(xs.at(-1)!.id, 'test');
      assert.ok(xs.length <= 4, `${p}: ${xs.length} steps`);
    }
  });

  test('iPhone: one screen for Shortcuts, its key copies the link and opens Shortcuts', () => {
    const xs = stepsFor('iphone', { shortcut: '' });
    assert.equal(xs.length, 3);
    assert.equal(xs[1].act, 'copy-shortcuts');
    const words = xs.map((s) => [s.title, s.line, ...(s.list ?? [])].join(' ')).join(' ');
    for (const w of ['Shortcuts', 'Automation', 'CarPlay', 'Bluetooth', 'Run Immediately', 'New Blank Automation', 'Open URLs', 'Done']) assert.ok(words.includes(w), w);
  });

  test('iPhone with the shared shortcut: add it, have the car run it, test', () => {
    const xs = stepsFor('iphone', { shortcut: 'https://www.icloud.com/shortcuts/x' });
    assert.deepEqual(xs.map((s) => s.act ?? s.id), ['intro', 'shortcut', 'shortcuts', 'test']);
    assert.match(xs[2].list!.join(' '), /Pick the TireTrail shortcut/);
    assert.equal(IOS_SHORTCUT_URL, '', 'the owner fills this in once the shortcut exists');
  });

  test('iPhone says it opens in Safari, and a Home Screen icon has to ask, since its drives are kept apart', () => {
    assert.ok(stepsFor('iphone').at(-1)!.notes!.some((n) => /Safari/.test(n) && /Home Screen/.test(n)));
    assert.equal(stepsFor('iphone').at(-1)!.test, 'watch');
    assert.equal(stepsFor('iphone', { app: true }).at(-1)!.test, 'ask');
  });

  test('Samsung installs first unless installed, then one routine screen, and asks if it opened', () => {
    assert.equal(stepsFor('samsung')[1].act, 'install');
    assert.match(stepsFor('samsung', { browser: 'samsung' })[1].line, /Add page to/);
    assert.ok(!stepsFor('samsung', { installed: true }).some((s) => s.act === 'install'));
    const routine = stepsFor('samsung').find((s) => s.id === 'routine')!;
    assert.match(`${routine.line} ${routine.list!.join(' ')}`, /Modes and Routines.*Bluetooth device.*Open an app.*Save/);
    assert.equal(stepsFor('samsung').at(-1)!.test, 'ask');
    assert.ok(!stepsFor('samsung').some((s) => /You're done/.test(s.line)));
  });

  test('other Android uses MacroDroid, copies the link, and notices when it opens', () => {
    const xs = stepsFor('android');
    assert.equal(xs[1].act, 'play');
    assert.ok(xs.some((s) => s.act === 'copy' && s.list!.some((x) => x.includes('Open Website'))));
    assert.equal(xs.at(-1)!.test, 'watch');
  });

  test('the test says what to do each drive: tap once before pulling out, keep it on screen', () => {
    for (const p of phones) {
      const notes = stepsFor(p).at(-1)!.notes!;
      assert.ok(notes.includes(EACH_DRIVE));
      assert.match(EACH_DRIVE, /before you pull out/i);
      assert.ok(notes.some((n) => /on screen/.test(n)));
    }
  });
});

describe('the saved step', () => {
  const now = 1_800_000_000_000;
  test('reopens a recent setup on its step', () => {
    const raw = JSON.stringify({ p: 'iphone', id: 'ios-auto', since: 0, at: now - 60_000, acted: ['ios-auto'] });
    assert.deepEqual(readProgress(raw, now), { p: 'iphone', id: 'ios-auto', since: 0, at: now - 60_000, acted: ['ios-auto'] });
  });

  test('forgets an old, broken or strange one', () => {
    assert.equal(readProgress(null, now), null);
    assert.equal(readProgress('{oops', now), null);
    assert.equal(readProgress(JSON.stringify({ p: 'nokia', id: 'x', at: now }), now), null);
    assert.equal(readProgress(JSON.stringify({ p: 'samsung', id: 'routine', at: now - RESUME_MS - 1 }), now), null);
    assert.deepEqual(readProgress(JSON.stringify({ p: 'samsung', id: 'routine', at: now }), now)?.acted, []);
  });
});

describe('the switch', () => {
  const now = new Date(2026, 9, 17, 12).getTime();
  test('gray when off, yellow until the phone has opened TireTrail, green after', () => {
    assert.equal(autoState(false, null), 'off');
    assert.equal(autoState(false, now), 'off');
    assert.equal(autoState(true, null), 'setup');
    assert.equal(autoState(true, now), 'ok');
  });

  test('its line: what off does, finish setup, and when the car last opened it', () => {
    const off = autoStatus({ on: false, okAt: null });
    assert.match(off.text, /^Off\./);
    assert.doesNotMatch(off.text, /without a tap/);
    assert.deepEqual(autoStatus({ on: true, okAt: null }), { text: 'Starts when TireTrail is open.', act: 'Finish setup' });
    assert.deepEqual(autoStatus({ on: true, okAt: new Date(2026, 9, 17, 8, 2).getTime(), now }), { text: 'Opens by itself in your car', when: 'last time 8:02 AM' });
  });

  test('times: today, yesterday, or a date', () => {
    assert.equal(whenWord(new Date(2026, 9, 17, 8, 2).getTime(), now), '8:02 AM');
    assert.equal(whenWord(new Date(2026, 9, 16, 17, 30).getTime(), now), 'yesterday 5:30 PM');
    assert.equal(whenWord(new Date(2026, 9, 14, 7, 0).getTime(), now), 'Oct 14');
  });

  test('the test only counts an opening after it started', () => {
    const since = new Date(2026, 9, 17, 8).getTime();
    assert.equal(testWord(null, since, now).done, false);
    assert.equal(testWord(since - 60_000, since, now).done, false);
    assert.deepEqual(testWord(since + 120_000, since, now), { done: true, text: 'Opened by itself at 8:02 AM.' });
  });
});

describe('the app icon', () => {
  test('a long press offers Start a drive', () => {
    const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as { shortcuts?: { name: string; url: string }[]; start_url: string };
    assert.ok(m.shortcuts?.some((s) => s.name === 'Start a drive' && s.url.endsWith('#start')));
    assert.equal(m.start_url, './');
  });
});

describe('the week card', () => {
  test('gentle stops at spots that drain to salmon streams this week, from where their rain goes', () => {
    const creekAt = (p: [number, number]): StopClass => (p[0] < -122.2 ? 'creek' : 'ground');
    const sums = [
      sum(at(-3), { stopPts: [stop(-122.25), stop(-122.25)] }),
      sum(at(1), { stopPts: [stop(-122.25), stop(-122.25, true), stop(-122.1)] }),
      sum(at(2), { stopPts: [stop(-122.3)], salmon: 1 }),
    ];
    const c = salmonCount(sums, creekAt, at(4));
    assert.deepEqual(c, { gentle: 2, hard: 1 });
    assert.equal(salmonLine(c), '2 gentle stops at spots that drain to salmon streams');
  });

  test('only this week: totals for every drive are on My drives, so home never repeats them', () => {
    const creek = (): StopClass => 'creek';
    assert.deepEqual(salmonCount([sum(at(-3), { salmon: 2, stopPts: [stop(-122.25)] })], creek, at(4)), { gentle: 0, hard: 0 });
    // hard brakes only when there are no gentle ones
    const c = salmonCount([sum(at(1), { salmon: 2, stopPts: [stop(-122.25, true)] })], creek, at(4));
    assert.deepEqual(c, { gentle: 0, hard: 2 });
    assert.equal(salmonLine(c), '2 hard brakes at spots that drain to salmon streams. Ease off there.');
  });

  test('nothing to count: a plain line with no number', () => {
    const line = salmonLine({ gentle: 0, hard: 0 });
    assert.doesNotMatch(line, /\d/);
    assert.match(line, /salmon/);
  });
});

describe('the laptop code', () => {
  test('is a committed pixel QR, not a runtime library', () => {
    const svg = readFileSync('public/qr.svg', 'utf8');
    assert.match(svg, /shape-rendering="crispEdges"/);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    assert.ok(!Object.keys(pkg.dependencies ?? {}).some((d) => /qr/i.test(d)));
  });
});
