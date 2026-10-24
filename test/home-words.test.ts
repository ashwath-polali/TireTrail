/** Drive home's words: the line under the title and this week's salmon line */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HOME_LINE, salmonLine, weekStopBoxes } from '../src/app/screens/home-words.ts';
import type { DriveSummary } from '../src/drive/summary.ts';

describe('home words', () => {
  test('the line under the title says less dust, never that it keeps dust out', () => {
    assert.equal(HOME_LINE, 'Shed less tire dust. Spend less on gas.');
    assert.doesNotMatch(HOME_LINE, /keep|out of/i);
  });
  test('the salmon line: spots drain, brakes and stops never do', () => {
    assert.equal(salmonLine({ gentle: 3, hard: 1 }), '3 gentle stops where rain flows to salmon streams');
    assert.equal(salmonLine({ gentle: 0, hard: 1 }), '1 hard brake where rain flows to a salmon stream. Ease off there.');
    assert.equal(salmonLine({ gentle: 0, hard: 2 }), '2 hard brakes where rain flows to salmon streams. Ease off there.');
    assert.equal(salmonLine({ gentle: 0, hard: 0 }), 'Gentle stops leave less tire dust for salmon streams');
    for (const s of [salmonLine({ gentle: 2, hard: 0 }), salmonLine({ gentle: 0, hard: 2 })]) assert.doesNotMatch(s, /above|drained|hard stop/);
  });
  test("home asks for the pipe areas under the week's gentle stops only", () => {
    const now = Date.UTC(2026, 9, 22, 18), old = now - 30 * 86_400_000;
    const sums = [
      { at: now - 3_600_000, stopPts: [{ lon: -122.441, lat: 47.101, hard: false }, { lon: -122.442, lat: 47.102, hard: false }, { lon: -122.30, lat: 47.20, hard: true }] },
      { at: old, stopPts: [{ lon: -122.0, lat: 47.5, hard: false }] },
    ] as unknown as DriveSummary[];
    const boxes = weekStopBoxes(sums, now);
    assert.equal(boxes.length, 1);
    const [w, s0, e, n] = boxes[0];
    assert.ok(w < -122.441 && e > -122.441 && s0 < 47.101 && n > 47.101);
    assert.deepEqual(weekStopBoxes([], now), []);
  });
});
