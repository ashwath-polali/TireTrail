/** account sheet words: last synced, sign-in errors, short names */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { agoWords, drivesWord, shortName, signInWords } from '../src/app/cloud/words.ts';

describe('account words', () => {
  const now = Date.UTC(2026, 9, 17, 18, 0, 0);

  test('last synced reads like a person says it', () => {
    assert.equal(agoWords(null, now), 'Not yet');
    assert.equal(agoWords(now - 20_000, now), 'Just now');
    assert.equal(agoWords(now - 5 * 60_000, now), '5 min ago');
    assert.equal(agoWords(now - 3 * 3600_000, now), '3 h ago');
    assert.equal(agoWords(now - 30 * 3600_000, now), 'Yesterday');
    assert.match(agoWords(now - 9 * 86400_000, now), /^Oct \d+$/);
  });

  test('a blocked pop-up says how to fix it; closing the window says nothing', () => {
    assert.match(signInWords('auth/popup-blocked')!, /Allow pop-ups/);
    assert.equal(signInWords('auth/popup-closed-by-user'), null);
    assert.equal(signInWords('auth/cancelled-popup-request'), null);
    assert.match(signInWords('auth/network-request-failed')!, /connection/);
    assert.match(signInWords('auth/unauthorized-domain')!, /Authorized domains/);
    assert.equal(signInWords('auth/something-new'), "Couldn't sign in. Try again.");
  });

  test('short names', () => {
    assert.equal(shortName('Ashwath Polali', 'a@b.com'), 'Ashwath');
    assert.equal(shortName('', 'sam.lee@school.org'), 'sam.lee');
    assert.equal(shortName('Bartholomew-Maximilian', ''), 'Bartholomew…');
    assert.equal(drivesWord(1), '1 drive');
    assert.equal(drivesWord(12), '12 drives');
  });
});
