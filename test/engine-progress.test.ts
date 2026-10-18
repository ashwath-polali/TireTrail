/** progress over saved drives, and an honest verdict */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { progressOf, VERDICT_TEXT } from '../src/drive/progress.ts';
import type { DriveSummary } from '../src/drive/summary.ts';

const usd = (x: number) => ({ low: x / 2, typical: x, high: x * 2 });
const sum = (at: number, score: number, hardBrakes = 0, mi = 5): DriveSummary => ({
  v: 2, at, mi, min: 12, score, lost: { brakes: 100 - score, starts: 0, speed: 0 }, hardBrakes, fastStarts: 0, overMi: 0,
  stops: 4, hardStops: hardBrakes, gas: usd(0.02), tires: usd(0.01), salmon: 0, brakes: [],
});

describe('progress', () => {
  test('no drives', () => {
    const p = progressOf([]);
    assert.equal(p.drives, 0);
    assert.equal(p.avgScore, null);
    assert.equal(p.verdict, null);
    assert.equal(p.needMore, 4);
    assert.equal(p.year, null);
    assert.equal(p.streak, 0);
  });

  test('fewer than 4 drives: no verdict yet, but scores, money and a year', () => {
    const p = progressOf([sum(2, 80, 1), sum(1, 70, 2)]);
    assert.equal(p.verdict, null);
    assert.equal(p.needMore, 2);
    assert.deepEqual(p.recent.map((d) => d.at), [1, 2], 'oldest first');
    assert.equal(p.avgScore, 75);
    assert.ok(Math.abs(p.recent[0].usd - 0.03) < 1e-9);
    assert.equal(p.recent[0].per10, 4);
    // pooled: 10 miles, 6¢ a drive pair
    assert.ok(p.year && Math.abs(p.year.total.typical - (0.06 / 10) * 11_100) < 1e-6);
  });

  test('verdicts compare the first drives with the latest', () => {
    const smoother = progressOf([sum(1, 60, 3), sum(2, 62, 3), sum(3, 70, 2), sum(4, 80, 1), sum(5, 85, 0), sum(6, 88, 0)]);
    assert.equal(smoother.verdict, 'smoother');
    assert.equal(smoother.verdictText, 'Smoother than your first drives');
    assert.ok(smoother.per10 && smoother.per10.latest < smoother.per10.first);
    assert.equal(smoother.streak, 2);
    assert.equal(progressOf([sum(1, 80), sum(2, 82), sum(3, 79), sum(4, 81)]).verdictText, 'About the same');
    assert.equal(progressOf([sum(1, 90), sum(2, 88), sum(3, 70, 2), sum(4, 72, 2)]).verdict, 'rougher');
    for (const t of Object.values(VERDICT_TEXT)) assert.doesNotMatch(t, /[–—]/);
  });

  test('the streak counts the latest drives with no hard brakes', () => {
    assert.equal(progressOf([sum(1, 90, 0), sum(2, 70, 1), sum(3, 95, 0), sum(4, 96, 0), sum(5, 97, 0)]).streak, 3);
    assert.equal(progressOf([sum(1, 90, 0), sum(2, 70, 1)]).streak, 0);
  });

  test('short drives count as 2 miles for the hard-brake rate', () => {
    assert.equal(progressOf([sum(1, 70, 1, 0.5)]).recent[0].per10, 5);
  });
});
