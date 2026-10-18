/** Drive home: Start by itself and its setup steps, the week card's money and salmon lines */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DriveSummary, StopPoint } from '../src/drive/summary.ts';
import type { StopClass } from '../src/drive/tips.ts';
import { autoStatus, INTRO, mustAsk, phoneOf, stepsFor, testWord, whenWord, type Phone } from '../src/app/screens/autostart-words.ts';
import { moneyLine, salmonCount, salmonLine } from '../src/app/screens/home-words.ts';

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

describe('setup steps', () => {
  const phones: Phone[] = ['iphone', 'samsung', 'android'];
  const all = phones.flatMap((p) => [...stepsFor(p), ...stepsFor(p, { app: true, installed: true })]);

  test('every step is short: a title of 8 words or fewer and one line under 90 characters', () => {
    for (const s of all) {
      assert.ok(s.title.split(/\s+/).length <= 8, s.title);
      assert.ok(s.line.length <= 90, s.line);
      assert.doesNotMatch(s.title + s.line, DASHES);
      assert.ok(s.art.length >= 1);
    }
  });

  test('each starts with the honest reason and ends with a test', () => {
    for (const p of phones) {
      const xs = stepsFor(p);
      assert.equal(xs[0], INTRO);
      assert.match(xs[0].line, /background/);
      assert.equal(xs[xs.length - 1].title, 'Test it');
    }
  });

  test('iPhone: Shortcuts, CarPlay or Bluetooth, Run Immediately, Open URLs, paste the link', () => {
    const words = stepsFor('iphone').map((s) => `${s.title} ${s.line}`).join(' ');
    for (const w of ['Shortcuts', 'Automation', 'CarPlay', 'Bluetooth', 'Run Immediately', 'New Blank Automation', 'Open URLs', 'Done']) assert.ok(words.includes(w), w);
    assert.equal(stepsFor('iphone')[1].act, 'copy-shortcuts');
  });

  test('iPhone from a Home Screen icon also says the link opens in Safari', () => {
    assert.ok(!stepsFor('iphone').some((s) => /Safari/.test(s.title)));
    assert.ok(stepsFor('iphone', { app: true }).some((s) => /Safari/.test(s.line)));
  });

  test('Samsung installs TireTrail first, unless it already runs installed, and asks if it opened', () => {
    assert.equal(stepsFor('samsung')[1].act, 'install');
    assert.ok(!stepsFor('samsung', { installed: true }).some((s) => s.act === 'install'));
    assert.match(stepsFor('samsung').map((s) => s.title).join(' '), /Modes and Routines/);
    assert.equal(stepsFor('samsung').at(-1)!.act, 'opened');
  });

  test('other Android uses MacroDroid and opens the link as a website', () => {
    const xs = stepsFor('android');
    assert.equal(xs[1].act, 'play');
    assert.ok(xs.some((s) => s.title.includes('Open Website') && s.act === 'copy'));
  });
});

describe('the status line', () => {
  const now = new Date(2026, 9, 17, 12).getTime();
  test('off, on without a car yet, and when the car last opened it', () => {
    assert.match(autoStatus({ on: false, okAt: null }), /^Off\./);
    assert.match(autoStatus({ on: true, okAt: null }), /while TireTrail is open/);
    assert.equal(autoStatus({ on: true, okAt: new Date(2026, 9, 17, 8, 2).getTime(), now }), 'Opens by itself in your car · last time 8:02 AM');
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
    assert.deepEqual(testWord(since + 120_000, since, now), { done: true, text: 'It works. Opened at 8:02 AM.' });
  });
});

describe('the week card', () => {
  test('money is a year, never cents', () => {
    assert.equal(moneyLine(null), null);
    assert.equal(moneyLine(0), 'Nothing extra spent on gas or tires');
    assert.equal(moneyLine(21.4), 'Could save about $20 a year');
    assert.equal(moneyLine(0.4), 'Could save under $5 a year');
    for (const x of [0.01, 0.4, 3, 21.4, 180]) assert.doesNotMatch(moneyLine(x)!, /¢|\.\d/);
  });

  test('gentle stops above salmon streams this week, from where their rain goes', () => {
    const creekAt = (p: [number, number]): StopClass => (p[0] < -122.2 ? 'creek' : 'ground');
    const sums = [
      sum(at(-3), { stopPts: [stop(-122.25), stop(-122.25)] }),
      sum(at(1), { stopPts: [stop(-122.25), stop(-122.25, true), stop(-122.1)] }),
      sum(at(2), { stopPts: [stop(-122.3)], salmon: 1 }),
    ];
    const c = salmonCount(sums, creekAt, at(4));
    assert.deepEqual(c, { gentle: 2, hard: 1, week: true });
    assert.equal(salmonLine(c), '2 gentle stops above salmon streams');
  });

  test('no drives this week: every drive, said as so far; hard brakes only when no gentle ones', () => {
    const creek = (): StopClass => 'creek';
    const c = salmonCount([sum(at(-3), { salmon: 2, stopPts: [stop(-122.25, true)] })], creek, at(4));
    assert.deepEqual(c, { gentle: 0, hard: 2, week: false });
    assert.match(salmonLine(c), /^2 hard brakes drained to salmon streams so far/);
  });

  test('nothing to count: a plain line with no number', () => {
    const line = salmonLine({ gentle: 0, hard: 0, week: true });
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
