/** community totals: what a drive adds, the REST reader, the scoreboard words, and the rules' limits */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DriveReport } from '../src/drive/analyze.ts';
import { driveAdd, MAX_ADD, scoreboardLine, totalsFromRest } from '../src/drive/community.ts';

const stop = (hard: boolean, lon = 0) => ({ hard, lngLat: [lon, 47] });
const report = (o: Record<string, unknown> = {}) => ({ usedFixes: 300, miles: 4.237, stops: [stop(false, 1), stop(false, 2), stop(true, 3), stop(false, 4)], hardest: [], ...o }) as unknown as DriveReport;

describe('what one drive adds', () => {
  test('gentle stops, the ones above salmon streams, and miles', () => {
    const a = driveAdd(report(), (p) => (p[0] === 2 || p[0] === 3 ? 'creek' : 'ground'));
    assert.deepEqual(a, { smoothStops: 3, salmonSmoothStops: 1, miles: 4.24 });
  });

  test('without a drain lookup, only the hardest gentle stops count for salmon', () => {
    const a = driveAdd(report({ hardest: [{ hard: false, cls: 'creek' }, { hard: true, cls: 'creek' }] }));
    assert.equal(a?.salmonSmoothStops, 1);
  });

  test('capped at what the rules allow', () => {
    const many = Array.from({ length: 90 }, () => stop(false));
    const a = driveAdd(report({ stops: many, miles: 512 }), () => 'creek')!;
    assert.deepEqual(a, { smoothStops: MAX_ADD.smoothStops, salmonSmoothStops: MAX_ADD.salmonSmoothStops, miles: MAX_ADD.miles });
  });

  test('a drive too short to analyze adds nothing', () => {
    assert.equal(driveAdd(report({ usedFixes: 4 })), null);
    assert.equal(driveAdd(report({ miles: 0 })), null);
  });
});

describe('scoreboard', () => {
  test('reads a Firestore REST document', () => {
    const t = totalsFromRest({ fields: { drives: { integerValue: '1240' }, smoothStops: { integerValue: '9000' }, salmonSmoothStops: { integerValue: '3812' }, miles: { doubleValue: 5021.5 }, updated: { timestampValue: '2026-10-17T18:00:00Z' } } });
    assert.deepEqual(t, { drives: 1240, smoothStops: 9000, salmonSmoothStops: 3812, miles: 5021.5, updated: Date.UTC(2026, 9, 17, 18) });
    assert.equal(totalsFromRest({ error: 'x' }), null);
    assert.equal(totalsFromRest({ fields: { drives: { integerValue: '-3' } } })?.drives, 0);
  });

  test('the line', () => {
    const t = { drives: 1240, smoothStops: 9000, salmonSmoothStops: 3812, miles: 1, updated: null };
    assert.equal(scoreboardLine(t), 'TireTrail drivers so far: 1,240 drives, 3,812 smooth stops above salmon streams');
    assert.equal(scoreboardLine({ ...t, drives: 1, salmonSmoothStops: 0, smoothStops: 1 }), 'TireTrail drivers so far: 1 drive, 1 smooth stop');
    assert.equal(scoreboardLine({ ...t, drives: 0 }), null);
    assert.equal(scoreboardLine(null), null);
  });
});

describe('firestore.rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  test('keeps the owner-only backup rule', () => {
    assert.match(rules, /match \/users\/\{uid\}\/\{document=\*\*\}[\s\S]*request\.auth\.uid == uid/);
  });
  test('uses the same limits as the app', () => {
    assert.match(rules, new RegExp(`upBy\\('smoothStops', ${MAX_ADD.smoothStops}\\)`));
    assert.match(rules, new RegExp(`upBy\\('salmonSmoothStops', ${MAX_ADD.salmonSmoothStops}\\)`));
    assert.match(rules, new RegExp(`upBy\\('miles', ${MAX_ADD.miles}\\)`));
    assert.match(rules, /drives == resource\.data\.drives \+ 1/);
  });
});
