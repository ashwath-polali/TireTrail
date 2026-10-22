/** Drive home's words: the line under the title and this week's salmon line */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HOME_LINE, salmonLine } from '../src/app/screens/home-words.ts';

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
});
