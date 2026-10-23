/** saved summaries: what progress and spots need, kept for 100 drives, old drives filled in without crashing */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { allSummaries, driveSummaries, fillSummaries, forgetDrive, MAX_SUMMARIES, pack, saveDrive, savedDrives, saveSummary, unsummarized, type SavedDrive } from '../src/app/screens/saved.ts';
import { readSummary, type DriveSummary } from '../src/drive/summary.ts';
import { useStorage } from './engine-helpers.ts';

const full = (at: number, points = 5): SavedDrive => ({
  at, mi: '1.0 mi', smooth: '1 smooth stop', creek: 0,
  fixes: Array.from({ length: points }, (_, i) => pack({ t: at + i * 1000, lat: 47.18 + i * 1e-5, lon: -122.17, speed: 10, accuracy: 5 })),
});
const sum = (at: number): DriveSummary => ({
  v: 2, at, mi: 3.1, min: 7.6, score: 58, lost: { brakes: 30, starts: 0, speed: 13 }, hardBrakes: 1, fastStarts: 0, overMi: 0.36, stops: 6, hardStops: 1,
  gas: { low: 0.004, typical: 0.005, high: 0.006 }, gasShare: { low: 0.02, typical: 0.05, high: 0.08, speed: 0.01 }, salmon: 1,
  brakes: [{ t: at + 60_000, lat: 47.16722, lon: -122.13952, heading: 96, veryHard: false, cls: 'creek', name: 'SR 410' }],
});

describe('saved summaries', () => {
  beforeEach(() => useStorage(200_000));

  test('a drive saves with its summary; forgetting it drops both', () => {
    assert.equal(saveDrive(full(1), sum(1)), true);
    assert.equal(saveDrive(full(2), sum(2)), true);
    assert.deepEqual(driveSummaries().map((s) => s.at), [2, 1]);
    assert.deepEqual(driveSummaries()[0], sum(2));
    forgetDrive(2);
    assert.deepEqual(savedDrives().map((d) => d.at), [1]);
    assert.deepEqual(driveSummaries().map((s) => s.at), [1]);
  });

  test('full tracks for the last 8 drives, summaries for up to 100', () => {
    for (let k = 1; k <= 120; k++) saveDrive(full(k), sum(k));
    assert.equal(savedDrives().length, 8);
    const sums = driveSummaries();
    assert.equal(sums.length, MAX_SUMMARIES);
    assert.equal(sums[0].at, 120);
    assert.equal(sums[sums.length - 1].at, 21);
  });

  test('old drives without a summary are filled in, and a broken one is skipped without crashing', () => {
    // saved by the old app: no summary
    saveDrive(full(1));
    saveDrive(full(2));
    saveDrive({ ...full(3), fixes: [[null, null]] as unknown as (number | null)[][] });
    assert.deepEqual(unsummarized().map((d) => d.at), [3, 2, 1]);
    const n = fillSummaries((fixes, d) => {
      if (!Number.isFinite(fixes[0].t)) throw new Error('broken');
      return sum(d.at);
    });
    assert.equal(n, 2);
    assert.deepEqual(driveSummaries().map((s) => s.at), [2, 1]);
    assert.deepEqual(unsummarized().map((d) => d.at), [3]);
  });

  test('damaged or older stored summaries are cleaned up or skipped', () => {
    localStorage.setItem('tt-sums', JSON.stringify([{ at: 5, mi: 2, score: 90 }, { at: 'x' }, null, 7, { ...sum(4), brakes: [{ lat: 1 }, sum(4).brakes[0]], cls: 'weird' }]));
    const list = allSummaries();
    assert.deepEqual(list.map((s) => s.at), [5, 4]);
    assert.deepEqual(list[0].gas, { low: 0, typical: 0, high: 0 });
    assert.deepEqual(list[0].brakes, []);
    assert.equal(list[1].brakes.length, 1);
    assert.equal(readSummary({ ...sum(1), brakes: [{ ...sum(1).brakes[0], cls: 'lava' }] })?.brakes[0].cls, 'unknown');
    localStorage.setItem('tt-sums', '{not json');
    assert.deepEqual(driveSummaries(), []);
    assert.equal(saveSummary(sum(9)), true);
    assert.deepEqual(driveSummaries().map((s) => s.at), [9]);
  });

  test('a full phone keeps the newest summaries it can', () => {
    useStorage(20_000);
    for (let k = 1; k <= 60; k++) saveSummary(sum(k));
    const list = allSummaries();
    assert.ok(list.length > 5 && list.length < 60, `${list.length}`);
    assert.equal(list[0].at, 60);
  });
});
