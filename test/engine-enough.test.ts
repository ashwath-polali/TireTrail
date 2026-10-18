/** the shortest drive that scores, where the rule is used, and the live gentle-stop watch */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { driveSummaries, allSummaries, saveDrive, pack, type SavedDrive } from '../src/app/screens/saved.ts';
import { analyzeDrive, type DriveReport } from '../src/drive/analyze.ts';
import { driveAdd } from '../src/drive/community.ts';
import { countsSummary, enoughDrive, MIN_DRIVE } from '../src/drive/enough.ts';
import { progressOf } from '../src/drive/progress.ts';
import { StopWatch } from '../src/drive/stopwatch.ts';
import { readSummary, type DriveSummary } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { useStorage } from './engine-helpers.ts';

const none = { nearestDrain: () => null, path: () => ({ drain: 0, assets: [], coords: [], lengthM: 0 }) };
const fixes = JSON.parse(readFileSync('public/data/sample-drive.json', 'utf8')) as Fix[];

describe('the minimum drive', () => {
  test('half a mile, 2 minutes and 30 GPS readings, all three', () => {
    assert.deepEqual(MIN_DRIVE, { mi: 0.5, s: 120, fixes: 30 });
    assert.equal(enoughDrive({ miles: 0.5, durationS: 120, usedFixes: 30 }), true);
    assert.equal(enoughDrive({ miles: 0.3, durationS: 7, usedFixes: 7 }), false);
    assert.equal(enoughDrive({ miles: 0.49, durationS: 600, usedFixes: 600 }), false);
    assert.equal(enoughDrive({ miles: 3, durationS: 119, usedFixes: 119 }), false);
    assert.equal(enoughDrive({ miles: 3, durationS: 600, usedFixes: 29 }), false);
  });

  test('the sample drive (3.1 mi, 8 min) scores; its first few seconds do not', () => {
    const r = analyzeDrive(fixes, none);
    assert.ok(r.miles > 3 && r.durationS > 400, `${r.miles} mi, ${r.durationS} s`);
    assert.equal(enoughDrive(r), true);
    // the old rule scored a 7 second test drive "Very smooth drive, 100"
    const bit = analyzeDrive(fixes.slice(0, 40), none);
    assert.equal(enoughDrive(bit), false);
  });

  test('a short drive adds nothing to the community total', () => {
    const r = analyzeDrive(fixes, none);
    assert.ok(driveAdd(r));
    assert.equal(driveAdd({ ...r, durationS: 60 } as DriveReport), null);
    assert.equal(driveAdd({ ...r, miles: 0.3 } as DriveReport), null);
    assert.equal(driveAdd(analyzeDrive(fixes.slice(0, 40), none)), null);
  });

  test('old summaries count by miles and minutes', () => {
    assert.equal(countsSummary({ mi: 3.1, min: 7.6 }), true);
    assert.equal(countsSummary({ mi: 0.3, min: 0.1 }), false);
    assert.equal(countsSummary({ mi: 0.8, min: 1.5 }), false);
  });
});

describe('old short drives', () => {
  beforeEach(() => useStorage(200_000));
  const full = (at: number): SavedDrive => ({ at, mi: '1 mi', smooth: '', creek: 0, fixes: [pack({ t: at, lat: 47.18, lon: -122.17, speed: 10, accuracy: 5 })] });
  const sum = (at: number, mi: number, min: number, score: number): DriveSummary => readSummary({ at, mi, min, score, hardBrakes: score < 100 ? 2 : 0, brakes: [] })!;

  test('are kept but left out of progress, streaks and averages', () => {
    saveDrive(full(1), sum(1, 3.1, 8, 60));
    saveDrive(full(2), sum(2, 4, 9, 70));
    // a 7 second test that the old rule saved as a perfect drive
    saveDrive(full(3), sum(3, 0.3, 0.1, 100));
    assert.deepEqual(allSummaries().map((s) => s.at), [3, 2, 1]);
    assert.deepEqual(driveSummaries().map((s) => s.at), [2, 1]);
    const p = progressOf(driveSummaries());
    assert.equal(p.drives, 2);
    assert.equal(p.streak, 0);
    assert.equal(p.avgScore, 65);
  });

  test('saving a new drive keeps the old short one in storage', () => {
    saveDrive(full(3), sum(3, 0.3, 0.1, 100));
    saveDrive(full(4), sum(4, 3, 8, 80));
    assert.deepEqual(allSummaries().map((s) => s.at), [4, 3]);
  });
});

describe('gentle stops while recording', () => {
  test('a stop after moving is gentle unless a hard brake came just before', () => {
    const w = new StopWatch();
    assert.equal(w.update(0, 0), null, 'parked at the start is not a stop');
    assert.equal(w.update(1000, 12), null);
    assert.deepEqual(w.update(20_000, 0.2), { gentle: true });
    assert.equal(w.update(21_000, 0), null, 'one stop, counted once');
    w.update(30_000, 15);
    w.hard(40_000);
    assert.deepEqual(w.update(45_000, 0), { gentle: false });
    w.update(50_000, 10);
    assert.deepEqual(w.update(90_000, 0.5), { gentle: true });
  });
});
