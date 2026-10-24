/** Delete drives on this phone while signed out: the next sign-in brings the backup back instead of deleting it */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { detachPhone } from '../src/app/cloud/sync.ts';
import { driveId, fromDoc, hashSummary, mergePlan, toDoc, type Known } from '../src/app/cloud/merge.ts';
import type { DriveSummary } from '../src/drive/summary.ts';
import { useStorage } from './engine-helpers.ts';

const sum = (at: number): DriveSummary => ({
  v: 2, at, mi: 3.1, min: 7.6, score: 80, lost: { brakes: 10, starts: 0, speed: 10 }, hardBrakes: 1, fastStarts: 0, overMi: 0.2, stops: 6, hardStops: 1,
  gas: { low: 0.004, typical: 0.005, high: 0.006 }, salmon: 1, brakes: [], path: [-122.15, 47.16, -122.12, 47.18],
});

// the browser bits stopSync touches
const g = globalThis as Record<string, unknown>;
g.removeEventListener ??= () => {};
g.document ??= { removeEventListener: () => {} };

beforeEach(() => useStorage(100_000));

test('a signed-out wipe forgets every sync record, so the backup comes back down', async () => {
  const drives = [1, 2, 3, 4].map((i) => sum(1_700_000_000_000 + i * 86_400_000));
  const known: Known = Object.fromEntries(drives.map((s) => [driveId(s.at), { h: hashSummary(s), u: 1000 }]));
  localStorage.setItem('tt-cloud-sync:abc', JSON.stringify({ known, last: 1000, tracks: [] }));
  localStorage.setItem('tt-cloud-sync:xyz', JSON.stringify({ known, last: 1000, tracks: [] }));
  await detachPhone();
  assert.equal(localStorage.getItem('tt-cloud-sync:abc'), null);
  assert.equal(localStorage.getItem('tt-cloud-sync:xyz'), null);
  const cloud = drives.map((s) => fromDoc(toDoc(s, 1000))!);
  const plan = mergePlan([], cloud, {}, 5000, 100);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.download.length, 4);
  // with the old record left behind, all four would be deleted from the backup
  assert.equal(mergePlan([], cloud, known, 5000, 100).remove.length, 4);
});
