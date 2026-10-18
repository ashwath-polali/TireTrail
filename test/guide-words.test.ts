/** The first-open guide's words and About's problem lines */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { beat, PROBLEM, SCIENCE, STEPS } from '../src/app/screens/guide-words.ts';

const all = [PROBLEM, ...STEPS.flatMap((s) => [s.kicker, s.title, s.text ?? '', ...(s.lines ?? [])]), ...SCIENCE.flatMap((f) => [f.fact, f.source])];

describe('guide words', () => {
  test('three slides; the first keeps its 4-step chain, one picture per line', () => {
    assert.equal(STEPS.length, 3);
    assert.equal(STEPS[0].lines?.length, 4);
    assert.equal(STEPS[0].art.length, 4);
    assert.match(STEPS[0].lines![3], /6PPD-quinone/);
  });
  test('some drains reach creeks, never most', () => {
    assert.match(STEPS[0].lines![2], /^Some drains/);
    assert.doesNotMatch(all.join(' '), /most drains|all drains/i);
  });
  test('every number carries a source', () => {
    for (const f of SCIENCE) if (/\d/.test(f.fact)) assert.match(f.source, /\d{4}|Association/);
    assert.match(SCIENCE[0].fact, /60 to 100%/);
    assert.match(SCIENCE[0].source, /Scholz et al\. 2011/);
    assert.match(SCIENCE[1].source, /Tian et al\. 2021/);
  });
  test('slow enough to read: about 3 s a step, the first held longer', () => {
    assert.equal(beat(1), 3000);
    assert.ok(beat(0) > beat(1));
  });
  test('plain text: no dashes or emoji', () => {
    for (const t of all) assert.doesNotMatch(t, /[–—]|\p{Extended_Pictographic}/u, t);
  });
});
