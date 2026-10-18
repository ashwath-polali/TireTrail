/** the UI kit's pure helpers: numbers, scoreboard ticks, meters and block charts */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { barBlocks, clampScore, formatNumber, meterLit, roundTo, scoreTone, snap4, tickAt, TONES } from '../src/app/ui/format.ts';

describe('formatNumber', () => {
  test('adds commas and keeps the asked places', () => {
    assert.equal(formatNumber(1234.5, 1), '1,234.5');
    assert.equal(formatNumber(0.426, 2), '0.43');
    assert.equal(formatNumber(235), '235');
    assert.equal(formatNumber(3, 2), '3.00');
  });
  test('never shows -0 and survives junk', () => {
    assert.equal(formatNumber(-0.001, 2), '0.00');
    assert.equal(formatNumber(-2.5, 1), '-2.5');
    assert.equal(formatNumber(NaN), '0');
    assert.equal(formatNumber(Infinity, 2), '0');
  });
});

describe('roundTo', () => {
  test('rounds to cents and to the nearest $5', () => {
    assert.equal(roundTo(0.426, 0.01), 0.43);
    assert.equal(roundTo(237, 5), 235);
    assert.equal(roundTo(238, 5), 240);
    assert.equal(roundTo(0.1 + 0.2, 0.01), 0.3);
  });
  test('a bad step gives 0', () => {
    assert.equal(roundTo(5, 0), 0);
    assert.equal(roundTo(NaN, 5), 0);
  });
});

describe('tickAt (scoreboard count up)', () => {
  test('starts at 0, ends exactly on the value', () => {
    assert.equal(tickAt(235, 0), 0);
    assert.equal(tickAt(235, 14), 235);
    assert.equal(tickAt(0.42, 14, 14, 2), 0.42);
  });
  test('only climbs, and never passes the end', () => {
    let last = 0;
    for (let k = 0; k <= 14; k++) {
      const v = tickAt(0.42, k, 14, 2);
      assert.ok(v >= last && v <= 0.42, `tick ${k} gave ${v}`);
      last = v;
    }
  });
  test('negative values count down to the value', () => {
    assert.equal(tickAt(-12, 14), -12);
    assert.ok(tickAt(-12, 7) >= -12 && tickAt(-12, 7) <= 0);
  });
});

describe('scores and meters', () => {
  test('scores clamp to 0..100', () => {
    assert.equal(clampScore(120), 100);
    assert.equal(clampScore(-5), 0);
    assert.equal(clampScore(NaN), 0);
  });
  test('score tones: green 80 and up, amber 60 to 79, orange under 60', () => {
    assert.equal(scoreTone(80), 'money');
    assert.equal(scoreTone(79.4), 'you');
    assert.equal(scoreTone(60), 'you');
    assert.equal(scoreTone(59), 'warn');
    for (const s of [0, 50, 100]) assert.ok(TONES.includes(scoreTone(s)));
  });
  test('a meter lights one block for anything above zero, all only when full', () => {
    assert.equal(meterLit(0, 100, 10), 0);
    assert.equal(meterLit(1, 100, 10), 1);
    assert.equal(meterLit(95, 100, 10), 9);
    assert.equal(meterLit(100, 100, 10), 10);
    assert.equal(meterLit(150, 100, 10), 10);
    assert.equal(meterLit(82, 100, 20), 16);
    assert.equal(meterLit(5, 0, 10), 0);
  });
});

describe('barBlocks', () => {
  test('the tallest fills every row and small values still show one block', () => {
    assert.deepEqual(barBlocks([4, 2, 1, 0], 8), [8, 4, 2, 0]);
    assert.deepEqual(barBlocks([100, 1], 8), [8, 1]);
  });
  test('all zero or junk gives empty columns', () => {
    assert.deepEqual(barBlocks([0, 0], 8), [0, 0]);
    assert.deepEqual(barBlocks([NaN, -3], 8), [0, 0]);
  });
});

test('snap4 puts sizes on the 4 px grid', () => {
  assert.equal(snap4(13), 12);
  assert.equal(snap4(14), 16);
  assert.equal(snap4(48), 48);
});
