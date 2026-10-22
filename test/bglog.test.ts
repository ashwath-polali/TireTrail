/** #bgtest's log: what came in while TireTrail was behind another app */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addEntry, aways, BG_MAX, readLog, span, verdict, type BgEntry } from '../src/drive/bglog.ts';

const e = (t: number, k: BgEntry['k'], more: Partial<BgEntry> = {}): BgEntry => ({ t, k, ...more });

describe('the background test log', () => {
  test('counts what arrived while away, and fixes taken while away that came in late', () => {
    const log = [
      e(0, 'start'), e(1000, 'fix', { g: 1000 }), e(2000, 'hidden'),
      e(3000, 'fix', { g: 3000 }), e(4000, 'motion', { n: 60 }),
      e(90_000, 'visible'), e(90_500, 'fix', { g: 50_000 }), e(91_000, 'fix', { g: 91_000 }),
    ];
    assert.deepEqual(aways(log), [{ from: 2000, to: 90_000, fixes: 1, gpsFixes: 2, motion: 60, reloaded: false }]);
  });

  test('a page the phone reloaded while away says so, and a stretch still away has no end', () => {
    const a = aways([e(0, 'pagehide'), e(5000, 'boot'), e(5001, 'visible'), e(9000, 'hidden')]);
    assert.equal(a[0].reloaded, true);
    assert.equal(a[1].to, null);
  });

  test('the answer, in a few words', () => {
    assert.match(verdict(undefined), /another app/);
    assert.match(verdict({ from: 0, to: 5000, fixes: 0, gpsFixes: 0, motion: 0, reloaded: false }), /longer/);
    assert.equal(verdict({ from: 0, to: 120_000, fixes: 0, gpsFixes: 0, motion: 0, reloaded: false }), 'Nothing came in while away.');
    assert.equal(verdict({ from: 0, to: 120_000, fixes: 3, gpsFixes: 3, motion: 0, reloaded: false }), 'GPS kept coming while away.');
    assert.equal(verdict({ from: 0, to: 120_000, fixes: 0, gpsFixes: 0, motion: 9, reloaded: false }), 'Motion kept coming, GPS did not.');
  });

  test('stays under its cap, reads back only good entries, and says times as m:ss', () => {
    const log: BgEntry[] = [];
    for (let i = 0; i < BG_MAX + 5; i++) addEntry(log, e(i, 'fix'));
    assert.equal(log.length, BG_MAX);
    assert.equal(log[0].t, 5);
    assert.deepEqual(readLog('[{"t":1,"k":"fix"},{"k":"x"},null]'), [{ t: 1, k: 'fix' }]);
    assert.deepEqual(readLog('{'), []);
    assert.equal(span(125_400), '2:05');
  });
});
