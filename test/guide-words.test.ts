/** The first-open guide's words and About's problem lines */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { beat, PROBLEM, sampleSalmon, SCIENCE, STEPS } from '../src/app/screens/guide-words.ts';

const all = [PROBLEM, ...STEPS.flatMap((s) => [s.kicker, s.title, s.text ?? '', ...(s.lines ?? [])]), ...SCIENCE.flatMap((f) => [f.fact, f.source])];

describe('guide words', () => {
  test('three slides; the first keeps its 4-step chain, one picture per line', () => {
    assert.equal(STEPS.length, 3);
    assert.equal(STEPS[0].lines?.length, 4);
    assert.equal(STEPS[0].art.length, 4);
    assert.match(STEPS[0].lines![3], /^6PPDQ,/);
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
  test('quick but readable: under 2 s a step, the first held a little longer', () => {
    assert.equal(beat(1), 1800);
    assert.ok(beat(0) > beat(1));
  });
  test('6PPDQ, capital Q, never 6PPD-quinone or 6PPD-q', () => {
    assert.match(all.join(' '), /6PPDQ/);
    assert.doesNotMatch(all.join(' '), /6PPD-|6PPDq|[Qq]uinone/);
  });
  test('names the discovery: Ed Kolodziej, UW Tacoma and WSU', () => {
    assert.match(SCIENCE[1].fact, /Kolodziej/);
    assert.match(SCIENCE[1].fact, /UW Tacoma/);
    assert.match(SCIENCE[1].fact, /WSU/);
  });
  test('the second slide: salmon streams first, then tire dust and gas; no tires, no money figure, no unsourced safer', () => {
    assert.match(STEPS[1].title, /salmon streams/);
    assert.match(STEPS[1].text ?? '', /tire dust/);
    assert.match(STEPS[1].text ?? '', /gas/);
    const two = [STEPS[1].title, STEPS[1].text ?? ''].join(' ');
    assert.doesNotMatch(two, /\$|a year|a month|tires\b|safer/);
  });
  test('the sample card: streams crossed when there are some, else the stream its rain reaches', () => {
    assert.deepEqual(sampleSalmon({ streams: 3, creek: 'Fennel Creek' }), { n: 3, unit: 'streams', caption: 'crossed' });
    assert.deepEqual(sampleSalmon({ streams: 1, creek: 'Fennel Creek' }), { n: 1, unit: 'stream', caption: 'crossed' });
    assert.deepEqual(sampleSalmon({ streams: 0, creek: 'Fennel Creek' }), { n: 1, unit: 'stream', caption: 'Rain reaches Fennel Creek' });
  });
  test('short: one line each', () => {
    for (const t of [PROBLEM, ...STEPS.flatMap((s) => [s.title, s.text ?? '', ...(s.lines ?? [])])]) assert.ok(t.length <= 70, t);
  });
  test('plain text: no dashes or emoji', () => {
    for (const t of all) assert.doesNotMatch(t, /[–—]|\p{Extended_Pictographic}/u, t);
  });
});
