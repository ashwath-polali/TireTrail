/** drives saved on the device: a full device drops the oldest, never the new one silently (B51) */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { dropRecording, forgetDrive, keepRecording, lostRecording, pack, saveDrive, savedDrives, type SavedDrive } from '../src/app/screens/saved.ts';

/** localStorage with a size limit, like a phone's */
class SmallStorage {
  private readonly m = new Map<string, string>();
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void {
    let used = 0;
    for (const [key, val] of this.m) if (key !== k) used += key.length + val.length;
    if (used + k.length + v.length > this.limit) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string): void { this.m.delete(k); }
}

const drive = (at: number, points: number): SavedDrive => ({
  at, mi: '1.0 mi', smooth: '1 smooth stop', creek: 0,
  fixes: Array.from({ length: points }, (_, i) => pack({ t: at + i * 1000, lat: 47.18 + i * 1e-5, lon: -122.17, speed: 10, accuracy: 5 })),
});
const store = (limit: number) => { (globalThis as { localStorage?: unknown }).localStorage = new SmallStorage(limit); };

describe('saved drives', () => {
  beforeEach(() => store(60_000));

  test('newest first, at most 8', () => {
    for (let k = 0; k < 10; k++) assert.equal(saveDrive(drive(k, 5)), true);
    const list = savedDrives();
    assert.equal(list.length, 8);
    assert.deepEqual(list.map((d) => d.at), [9, 8, 7, 6, 5, 4, 3, 2]);
    forgetDrive(5);
    assert.equal(savedDrives().length, 7);
  });

  test('a full device drops the oldest drives until the new one fits', () => {
    store(40_000);
    for (let k = 0; k < 4; k++) assert.equal(saveDrive(drive(k, 300)), true);
    const before = savedDrives().length;
    assert.equal(saveDrive(drive(99, 600)), true);
    const after = savedDrives();
    assert.equal(after[0].at, 99);
    assert.ok(after.length < before + 1, `${before} before, ${after.length} after`);
    // the ones kept are the newest
    assert.deepEqual(after.slice(1).map((d) => d.at), [3, 2, 1, 0].slice(0, after.length - 1));
  });

  test('a drive too big for the device is refused, and the old drives stay', () => {
    saveDrive(drive(1, 50));
    saveDrive(drive(2, 50));
    assert.equal(saveDrive(drive(3, 5000)), false);
    assert.deepEqual(savedDrives().map((d) => d.at), [2, 1]);
  });

  test('blocked storage: nothing saved, no throw', () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(saveDrive(drive(1, 5)), false);
    assert.deepEqual(savedDrives(), []);
    assert.equal(lostRecording(), null);
    keepRecording(1, []);
    dropRecording();
  });
});

describe('the drive being recorded', () => {
  beforeEach(() => store(60_000));

  test('survives a reload until it is finished or dropped (B1)', () => {
    assert.equal(lostRecording(), null);
    const fixes = drive(1000, 30).fixes;
    keepRecording(1000, fixes);
    const lost = lostRecording();
    assert.equal(lost?.at, 1000);
    assert.equal(lost?.fixes.length, 30);
    assert.deepEqual(lost?.fixes[3], { t: 4000, lat: 47.18003, lon: -122.17, speed: 10, accuracy: 5 });
    dropRecording();
    assert.equal(lostRecording(), null);
  });
});
