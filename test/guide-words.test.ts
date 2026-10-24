/** The first-open guide's words and About's */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ABOUT, beat, METHODS, SAMPLE_CARD, sampleCents, SCIENCE, SEASON_FACTS, STEPS } from '../src/app/screens/guide-words.ts';
import { SALMON } from '../src/salmon/watch.ts';

const main = [...STEPS.flatMap((s) => [s.kicker, s.title, s.text ?? '', ...(s.lines ?? [])]), ABOUT.title, ...ABOUT.rows.flatMap((r) => [r.head, r.line])];
const all = [...main, ...ABOUT.privacy, ...[...SCIENCE, ...SEASON_FACTS].flatMap((f) => [f.fact, f.source]), ...METHODS.flatMap((m) => [m.term, m.line, m.source])];

describe('guide words', () => {
  test('three slides, as on Oct 18; the first keeps its 4-step chain, one picture per line', () => {
    assert.equal(STEPS.length, 3);
    assert.equal(STEPS[0].lines?.length, 4);
    assert.equal(STEPS[0].art.length, 4);
    assert.equal(STEPS[0].title, 'Tire dust is killing coho in city creeks.');
    assert.equal(STEPS[1].title, 'Drive smoother. Help the salmon.');
    assert.equal(STEPS[2].title, "See where your street's rain goes.");
  });
  test('some drains reach creeks, never most; the chemical "can" kill', () => {
    assert.match(STEPS[0].lines![2], /^Some drains flow to creeks/);
    assert.doesNotMatch(all.join(' '), /most drains|all drains|straight to creeks/i);
    assert.match(STEPS[0].lines![3], /^6PPDQ, .* can kill coho/);
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
  test('quick but readable: about 2 s a step, the first held a little longer', () => {
    assert.equal(beat(1), 1800);
    assert.ok(beat(0) > beat(1) && beat(0) <= 2500);
  });
  test('6PPDQ, capital Q, never 6PPD-quinone', () => {
    assert.match([...SCIENCE.map((f) => f.fact)].join(' '), /6PPDQ/);
    assert.doesNotMatch(all.join(' '), /6PPD-|6PPDq|[Qq]uinone/);
  });
  test('the sample card: no yearly money, cents a gallon at the current price', () => {
    assert.deepEqual(Object.keys(SAMPLE_CARD).sort(), ['gasShare', 'score']);
    assert.equal(sampleCents({ usdPerGal: 5, weekOf: '2026-10-19', source: 'U.S. EIA', seriesId: 'x', fetchedAt: '2026-10-22' }), 65);
    assert.equal(sampleCents(null), null);
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
    for (const t of [...STEPS.flatMap((s) => [s.title, s.text ?? '', ...(s.lines ?? [])]), ...ABOUT.rows.map((r) => r.line)]) assert.ok(t.length <= 80, t);
  });
  test('plain text: no dashes or emoji', () => {
    for (const t of all) assert.doesNotMatch(t, /[–—]|\p{Extended_Pictographic}/u, t);
  });
});
