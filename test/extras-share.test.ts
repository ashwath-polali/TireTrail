/** share card words: salmon first, only what the report says */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dustPct, gramsText, headline, salmonLine, shareFacts } from '../src/app/features/share-facts.ts';
import type { DriveReport } from '../src/drive/analyze.ts';

// 2 km from the drive's ends
const FAR: [number, number] = [-122.15, 47.18];
const HOME: [number, number] = [-122.15, 47.2005];
const ENDS: [number, number][] = [[-122.15, 47.2], [-122.15, 47.2]];
const brake = (o: Record<string, unknown> = {}) => ({ rate: 3.5, name: '', salmon: false, receiving: '', cls: 'ground', mapped: true, lngLat: FAR, ...o });
const dust = (f: number, mg = 700) => ({ styleFactor: { low: f, typical: f, high: f }, mg: { low: mg, typical: mg, high: mg } });
const report = (o: Record<string, unknown> = {}) => ({
  dust: dust(0.79), brakes: [], events: [], stops: [{ hard: false }, { hard: false }], ...o,
}) as unknown as DriveReport;

describe('share card words', () => {
  test('the headline: salmon streams first, then tire dust when it was clearly less', () => {
    assert.equal(headline(3, -21), 'I crossed 3 salmon streams and shed 21% less tire dust than a typical drive.');
    assert.equal(headline(1, 12), 'I crossed 1 salmon stream.');
    assert.equal(headline(0, -21), 'I shed 21% less tire dust than a typical drive.');
    assert.equal(headline(null, -3), "I'm tracking my tire dust for the salmon.");
    for (const t of [headline(3, -21), headline(null, 40)]) assert.doesNotMatch(t, /[–—]|6PPD-/);
  });

  test('tire dust vs typical, in grams', () => {
    assert.equal(dustPct(report()), -21);
    assert.equal(dustPct(report({ dust: dust(1.21) })), 21);
    assert.equal(gramsText(666), '0.7 g');
    assert.equal(gramsText(40), 'under 0.1 g');
  });

  test('streams by name, never one crossed near where the drive started or ended', () => {
    const f = shareFacts(report(), 0, ENDS, [{ name: 'Fennel Creek', at: FAR }, { name: 'Home Creek', at: HOME }, { name: '', at: FAR }]);
    assert.equal(f.streams, 3);
    assert.deepEqual(f.creeks, ['Fennel Creek']);
    // ends unknown: no names at all
    assert.deepEqual(shareFacts(report(), 0, [], [{ name: 'Fennel Creek', at: FAR }]).creeks, []);
    assert.equal(shareFacts(report(), 0).streams, null);
  });

  test('hard brakes and fast starts', () => {
    const f = shareFacts(report({ brakes: [brake(), brake()], events: [{ kind: 'start' }, { kind: 'brake' }] }), 0);
    assert.equal(f.hard, 2);
    assert.equal(f.fast, 1);
  });

  test('salmon line from the drains only, no creek near home', () => {
    assert.equal(salmonLine(report()), 'All 2 stops were gentle.');
    assert.equal(salmonLine(report({ brakes: [brake({ salmon: true, cls: 'creek', receiving: 'Fennel Creek' })] }), ENDS), 'Rain from 1 hard brake runs to Fennel Creek.');
    assert.equal(salmonLine(report({ brakes: [brake({ salmon: true, cls: 'creek', receiving: 'Lake Bonney Outflow' }), brake({ salmon: true, cls: 'creek', receiving: 'Fennel Creek' })] }), ENDS),
      'Rain from 2 hard brakes runs toward Fennel Creek.');
    assert.equal(salmonLine(report({ brakes: [brake({ salmon: true, cls: 'creek', receiving: 'Fennel Creek', lngLat: HOME })] }), ENDS), 'Rain from 1 hard brake runs to a salmon stream.');
    assert.equal(salmonLine(report({ stops: [{ hard: true }], brakes: [brake()] })), "These hard brakes don't drain to a salmon stream.");
    assert.equal(salmonLine(report({ stops: [{ hard: true }], brakes: [brake({ cls: 'unknown' })] })), 'Gentle stops shed less tire dust.');
  });

  test('a date, no time', () => {
    assert.equal(shareFacts(report(), new Date(2026, 9, 17, 18, 42).getTime()).date, 'Oct 17, 2026');
  });
});
