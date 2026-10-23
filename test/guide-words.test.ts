/** The first-open guide's words and About's */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ABOUT, beat, mapSay, METHODS, ROAD_SAY, SCIENCE, SEASON_FACTS, STEPS } from '../src/app/screens/guide-words.ts';
import { salmonWords } from '../src/salmon/watch.ts';
import { COHO } from '../src/salmon/species.ts';
import { SALMON } from '../src/salmon/watch.ts';

const main = [...STEPS.flatMap((s) => [s.title, s.text ?? '', ...(s.lines ?? [])]), ROAD_SAY, ABOUT.title, ...ABOUT.rows.flatMap((r) => [r.head, r.line])];
const all = [...main, ...ABOUT.privacy, ...[...SCIENCE, ...SEASON_FACTS].flatMap((f) => [f.fact, f.source]), ...METHODS.flatMap((m) => [m.term, m.line, m.source])];

describe('guide words', () => {
  test('three slides: what it does in the car, then after the drive, then why salmon', () => {
    assert.equal(STEPS.length, 3);
    assert.deepEqual(STEPS.map((s) => s.art), ['road', 'map', 'pics']);
    // no numbered science chain on a main screen
    assert.ok(STEPS.every((s) => !s.lines));
  });
  test('more than salmon: the warnings, the one fix and gas come before the science', () => {
    assert.match(STEPS[0].text ?? '', /salmon creek/);
    assert.match(STEPS[0].text ?? '', /hard-brake spot/);
    assert.match(STEPS[1].title, /one thing to fix/);
    assert.match(STEPS[1].text ?? '', /gas/);
    assert.match(STEPS[2].title, /salmon creeks/);
  });
  test("the voice line is the coach's own words for Clover Creek", () => {
    assert.equal(ROAD_SAY, salmonWords({ sp: COHO, stream: { name: 'Clover Creek' } }));
  });
  test('the map tally', () => {
    assert.deepEqual(mapSay(2, 3), { n: '2 of 3', rest: 'salmon creeks crossed gently' });
    assert.deepEqual(mapSay(1, 1), { n: '1 of 1', rest: 'salmon creek crossed gently' });
  });
  test('main screens: no science numbers, no chemical names, no money', () => {
    for (const t of main) assert.doesNotMatch(t, /\d+(\.\d+)? ?(g|mg|µg)\b|6PPD|\$|¢/, t);
  });
  test('some drains reach creeks, never most: rain "can" wash dust in', () => {
    assert.match(STEPS[2].title, /^Rain can wash/);
    assert.doesNotMatch(all.join(' '), /most drains|all drains/i);
  });
  test('every number carries a source', () => {
    for (const f of [...SCIENCE, ...SEASON_FACTS]) if (/\d/.test(f.fact)) assert.match(f.source, /\d{4}|Association/);
    const longfellow = SCIENCE.find((f) => /Longfellow/.test(f.fact))!, tian = SCIENCE.find((f) => /Kolodziej/.test(f.fact))!;
    assert.match(longfellow.fact, /60 to 100%/);
    assert.match(longfellow.source, /Scholz et al\. 2011/);
    assert.match(tian.source, /Tian et al\. 2021/);
    // the gentle-stop line has its own source
    assert.match(SCIENCE.find((f) => /Gentle stops/.test(f.fact))!.source, /Giechaskiel/);
    for (const f of [...SCIENCE, ...SEASON_FACTS]) if (f.href) assert.match(f.href, /^https:\/\//);
    for (const m of METHODS) assert.ok(m.source.length > 3, m.term);
  });
  test("the gentle rule matches the salmon module's", () => {
    const g = METHODS.find((m) => m.term === 'Crossed gently')!;
    assert.match(g.line, new RegExp(`${SALMON.brakeM} m`));
  });
  test('quick but readable: under 2 s a step, the first held a little longer', () => {
    assert.equal(beat(1), 1800);
    assert.ok(beat(0) > beat(1));
  });
  test('6PPDQ, capital Q, only behind More', () => {
    assert.match([...SCIENCE.map((f) => f.fact)].join(' '), /6PPDQ/);
    assert.doesNotMatch(main.join(' '), /6PPD/);
    assert.doesNotMatch(all.join(' '), /6PPD-|6PPDq|[Qq]uinone/);
  });
  test('names the discovery: Ed Kolodziej, UW Tacoma and WSU', () => {
    const tian = SCIENCE.find((f) => /Kolodziej/.test(f.fact))!;
    assert.match(tian.fact, /UW Tacoma/);
    assert.match(tian.fact, /WSU/);
  });
  test('About: one sentence, three rows (the problem, what it does, the data), the drain count filled in', () => {
    assert.equal(ABOUT.rows.length, 3);
    assert.match(ABOUT.rows[2].line, /\{drains\}/);
    assert.ok(ABOUT.title.endsWith('.') && ABOUT.title.split('. ').length === 1);
  });
  test('short: one line each on a phone', () => {
    for (const t of [...STEPS.flatMap((s) => [s.title, s.text ?? '']), ...ABOUT.rows.map((r) => r.line)]) assert.ok(t.length <= 80, t);
  });
  test('plain text: no dashes or emoji', () => {
    for (const t of all) assert.doesNotMatch(t, /[–—]|\p{Extended_Pictographic}/u, t);
  });
});
