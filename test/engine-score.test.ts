/** the smooth score: simple, explainable, never better for doing more of a bad thing */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PART_LABEL, scoreDrive } from '../src/drive/score.ts';

describe('smooth score', () => {
  test('a drive with nothing to fix scores 100, with no fix', () => {
    const s = scoreDrive({ miles: 12, hardBrakes: 0, fastStarts: 0, overMi: 0 });
    assert.equal(s.score, 100);
    assert.equal(s.fix, null);
  });

  test('a typical calm driver lands around 85 to 92', () => {
    // about 1 hard brake and 1 fast start in 20 miles, a little over the limit for 5% of it
    const s = scoreDrive({ miles: 20, hardBrakes: 1, fastStarts: 1, overMi: 1 });
    assert.ok(s.score >= 85 && s.score <= 92, `${s.score}`);
    const commute = scoreDrive({ miles: 8, hardBrakes: 0, fastStarts: 0, overMi: 0.3 });
    assert.ok(commute.score >= 85 && commute.score <= 95, `${commute.score}`);
  });

  test('more of anything never raises the score', () => {
    for (const k of ['hardBrakes', 'fastStarts', 'overMi'] as const) {
      let last = 101;
      for (let n = 0; n <= 30; n++) {
        const x = { miles: 10, hardBrakes: 1, fastStarts: 1, overMi: 0.5, [k]: k === 'overMi' ? n / 3 : n };
        const s = scoreDrive(x).score;
        assert.ok(s <= last, `${k} ${n}: ${s} > ${last}`);
        last = s;
      }
    }
    // the same count over more miles is gentler
    assert.ok(scoreDrive({ miles: 30, hardBrakes: 3, fastStarts: 0, overMi: 0 }).score > scoreDrive({ miles: 3, hardBrakes: 3, fastStarts: 0, overMi: 0 }).score);
  });

  test('parts add up, stay in 0 to 100, and name the biggest thing to fix', () => {
    const s = scoreDrive({ miles: 3.1, hardBrakes: 3, fastStarts: 0, overMi: 0.36 });
    const lost = s.parts.brakes.lost + s.parts.starts.lost + s.parts.speed.lost;
    assert.equal(100 - lost, s.score);
    assert.ok(s.parts.brakes.lost >= 20, 'hard stops visibly cost points');
    assert.equal(s.fix?.key, 'brakes');
    assert.equal(s.fix?.text, 'You braked hard 3 times. Start slowing sooner so you can stop gently.');
    const worst = scoreDrive({ miles: 1, hardBrakes: 50, fastStarts: 50, overMi: 1 });
    assert.ok(worst.score >= 0 && worst.score <= 10, `${worst.score}`);
    assert.equal(scoreDrive({ miles: 10, hardBrakes: 0, fastStarts: 1, overMi: 0 }).fix?.text, 'You sped up fast once. Press the gas slowly when you pull away.');
    assert.match(scoreDrive({ miles: 10, hardBrakes: 0, fastStarts: 0, overMi: 2 }).fix?.text ?? '', /over the speed limit for 20% of the drive/);
  });

  test('the points lost always add up to the score shown', () => {
    for (let mi = 0.6; mi < 25; mi += 0.7) {
      for (let b = 0; b < 9; b++) {
        for (const over of [0, 0.05, 0.13, 0.36, 1.2]) {
          const s = scoreDrive({ miles: mi, hardBrakes: b, fastStarts: b % 3, overMi: Math.min(over, mi) });
          const lost = s.parts.brakes.lost + s.parts.starts.lost + s.parts.speed.lost;
          assert.equal(100 - lost, s.score, `${mi} ${b} ${over}`);
          for (const p of Object.values(s.parts)) assert.ok(p.lost >= 0 && p.lost <= p.max, `${p.key} ${p.lost}`);
        }
      }
    }
    // a part that cost nothing never shows a point
    assert.equal(scoreDrive({ miles: 3.1, hardBrakes: 3, fastStarts: 0, overMi: 0.36 }).parts.starts.lost, 0);
  });

  test('plain words, no dashes', () => {
    const texts = [...Object.values(PART_LABEL)];
    for (const x of [{ hardBrakes: 1 }, { fastStarts: 2 }, { overMi: 1 }]) {
      const f = scoreDrive({ miles: 5, hardBrakes: 0, fastStarts: 0, overMi: 0, ...x }).fix!;
      texts.push(f.title, f.text);
    }
    for (const t of texts) assert.doesNotMatch(t, /[–—]/, t);
  });
});
