/** Drive home's words: the plain pitch and the week strip's captions */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HOME_LINE, HOME_TITLE, WEEK_CAPS } from '../src/app/screens/home-words.ts';

describe('home words', () => {
  test('the pitch is plain and whole: what to do near salmon creeks, and the gas you save', () => {
    assert.deepEqual([...HOME_TITLE], ['Brake gently near salmon creeks.', 'Save gas.']);
    assert.match(HOME_LINE, /voice/);
    // nothing promises to keep dust out of creeks, and no science on home
    for (const s of [...HOME_TITLE, HOME_LINE]) assert.doesNotMatch(s, /keep|out of|tire dust|6PPD|\d/i, s);
  });
  test('the week strip: salmon first, no tires or money a month', () => {
    assert.equal(WEEK_CAPS.streams(1), 'salmon stream');
    assert.equal(WEEK_CAPS.streams(4), 'salmon streams');
    const all = [...HOME_TITLE, HOME_LINE, WEEK_CAPS.less, WEEK_CAPS.more, WEEK_CAPS.typical, WEEK_CAPS.gas];
    for (const s of all) assert.doesNotMatch(s, /[–—]|\$|a month|tires last|\p{Extended_Pictographic}/u, s);
  });
});
