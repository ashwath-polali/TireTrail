/** the weekly challenge strip's words: days left, the note behind a tap, the streak */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { challengeLeft, challengeNote, challengeTitle, startsNextWeek, streakNote } from '../src/app/features/challenge-words.ts';

describe('challenge strip words', () => {
  test('days left, then done or missed', () => {
    assert.equal(challengeLeft({ state: 'open', daysLeft: 4 }), '4 days left');
    assert.equal(challengeLeft({ state: 'open', daysLeft: 1 }), 'Last day');
    assert.equal(challengeLeft({ state: 'done', daysLeft: 3 }), 'Goal met');
    assert.equal(challengeLeft({ state: 'missed', daysLeft: 0 }), 'Missed');
  });
  test('the note: how, or how it went', () => {
    assert.equal(challengeNote({ state: 'open', kind: 'smooth', need: 3, how: 'A smooth drive has no hard brakes.' }), 'A smooth drive has no hard brakes.');
    assert.equal(challengeNote({ state: 'done', kind: 'smooth', need: 3, how: '' }), '3 smooth drives this week. Nice work.');
    assert.equal(challengeNote({ state: 'done', kind: 'spot', need: 3, how: '' }), 'You drove past it 3 times with no hard brake.');
    assert.match(challengeNote({ state: 'missed', kind: 'spot', need: 3, how: '' }), /A new goal starts Monday\.$/);
  });
  test('the streak, one line', () => {
    assert.equal(streakNote({ streak: 4, best: 6 }), '4 smooth drives in a row. Best: 6.');
    assert.equal(streakNote({ streak: 1, best: 1 }), '1 smooth drive in a row. Best: 1.');
    assert.equal(streakNote({ streak: 0, best: 2 }), '0 smooth drives in a row. Best: 2.');
    // home shows the challenge before the first drive: no "0 in a row" then
    assert.equal(streakNote({ streak: 0, best: 0 }), null);
    // a met goal doesn't sit over "0 in a row"
    assert.equal(streakNote({ streak: 0, best: 3, state: 'done' }), null);
    assert.equal(streakNote({ streak: 2, best: 3, state: 'done' }), '2 smooth drives in a row. Best: 3.');
  });
  test('a goal out of reach this week moves to next week', () => {
    const late = { state: 'open' as const, got: 0, need: 3, daysLeft: 1, title: 'Three smooth drives this week' };
    assert.equal(startsNextWeek(late), true);
    assert.equal(challengeLeft(late), 'Starts Monday');
    assert.equal(challengeTitle(late), 'Three smooth drives next week');
    // one done, or days enough: this week stands
    assert.equal(startsNextWeek({ ...late, got: 1 }), false);
    assert.equal(startsNextWeek({ ...late, daysLeft: 3 }), false);
    assert.equal(challengeLeft({ ...late, daysLeft: 4 }), '4 days left');
    assert.equal(challengeTitle({ ...late, daysLeft: 4 }), 'Three smooth drives this week');
  });
});
