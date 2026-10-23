/** Drive home's words: the plain pitch and the week line */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HOME_LINE, HOME_TITLE } from '../src/app/screens/home-words.ts';

describe('home words', () => {
  test('the pitch is plain and whole: what to do near salmon creeks, and the gas you save', () => {
    assert.deepEqual([...HOME_TITLE], ['Brake gently near salmon creeks.', 'Save gas.']);
    assert.match(HOME_LINE, /voice/);
    // nothing promises to keep dust out of creeks, and no science on home
    for (const s of [...HOME_TITLE, HOME_LINE]) assert.doesNotMatch(s, /keep|out of|tire dust|6PPD|\d/i, s);
  });
  test('no dashes, money a month or emoji', () => {
    for (const s of [...HOME_TITLE, HOME_LINE]) assert.doesNotMatch(s, /[–—]|\$|a month|\p{Extended_Pictographic}/u, s);
  });
});
