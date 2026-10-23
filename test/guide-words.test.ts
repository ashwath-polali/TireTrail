/** The first-open guide's words and About's */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ABOUT, beat, mapSay, METHODS, ROAD_SAY, SCIENCE, STEPS } from '../src/app/screens/guide-words.ts';
import { salmonWords } from '../src/salmon/watch.ts';
import { COHO } from '../src/salmon/species.ts';
import { SALMON } from '../src/salmon/watch.ts';

const main = [...STEPS.flatMap((s) => [s.title, s.text ?? '', ...(s.lines ?? [])]), ROAD_SAY, ABOUT.title, ...ABOUT.rows.flatMap((r) => [r.head, r.line])];
const all = [...main, ...ABOUT.privacy, ...SCIENCE.flatMap((f) => [f.fact, f.source]), ...METHODS.flatMap((m) => [m.term, m.line, m.source])];

describe('guide words', () => {
  test('three slides: the problem as a 4-step chain with a picture each, then the road, then the map', () => {
    assert.equal(STEPS.length, 3);
    assert.equal(STEPS[0].lines?.length, 4);
    assert.equal(STEPS[0].pics?.length, 4);
    assert.deepEqual(STEPS.map((s) => s.art), ['pics', 'road', 'map']);
  });
  test('the road slide says when a salmon creek is ahead and learns hard brakes; the map slide names creeks, one fix and gas', () => {
    assert.match(STEPS[1].text ?? '', /salmon creek is ahead/);
    assert.match(STEPS[1].text ?? '', /brake hard/);
    assert.match(STEPS[2].text ?? '', /creek/);
    assert.match(STEPS[2].text ?? '', /one thing to fix/);
    assert.match(STEPS[2].text ?? '', /gas/);
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
  test('some drains reach creeks, never most', () => {
    assert.match(STEPS[0].lines![2], /^Some drains/);
    assert.doesNotMatch(all.join(' '), /most drains|all drains/i);
  });
  test('every number carries a source', () => {
    for (const f of SCIENCE) if (/\d/.test(f.fact)) assert.match(f.source, /\d{4}|Association/);
    assert.match(SCIENCE[0].fact, /60 to 100%/);
    assert.match(SCIENCE[0].source, /Scholz et al\. 2011/);
    assert.match(SCIENCE[1].source, /Tian et al\. 2021/);
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
    assert.doesNotMatch(all.join(' '), /6PPD-|6PPDq|[Qq]uinone/);
  });
  test('names the discovery: Ed Kolodziej, UW Tacoma and WSU', () => {
    assert.match(SCIENCE[1].fact, /Kolodziej/);
    assert.match(SCIENCE[1].fact, /UW Tacoma/);
    assert.match(SCIENCE[1].fact, /WSU/);
  });
  test('About: one sentence, three rows (the problem, what it does, the data), the drain count filled in', () => {
    assert.equal(ABOUT.rows.length, 3);
    assert.match(ABOUT.rows[2].line, /\{drains\}/);
    assert.ok(ABOUT.title.endsWith('.') && ABOUT.title.split('. ').length === 1);
  });
  test('short: one line each on a phone', () => {
    for (const t of [...STEPS.flatMap((s) => [s.title, s.text ?? '', ...(s.lines ?? [])]), ...ABOUT.rows.map((r) => r.line)]) assert.ok(t.length <= 80, t);
  });
  test('plain text: no dashes or emoji', () => {
    for (const t of all) assert.doesNotMatch(t, /[–—]|\p{Extended_Pictographic}/u, t);
  });
});
