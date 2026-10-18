/** stop spots learned across drives, and the saved summary fields the coach needs (old drives still load) */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { driveSummaries, forgetDrive, saveSummary } from '../src/app/screens/saved.ts';
import { toDoc } from '../src/app/cloud/merge.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { exampleStopSpots, stopSpotsFrom } from '../src/drive/coach/stopspots.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { pathPoints, readSummary, summarize, type DriveSummary, type StopPoint } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { NO_DRAINS, P, T0, useStorage } from './engine-helpers.ts';

const day = (n: number) => T0 + n * 86_400_000;
const pt = (xy: XY, heading: number | null, o: Partial<StopPoint> = {}): StopPoint => {
  const [lon, lat] = P.toLngLat(xy);
  return { t: T0, lat, lon, heading, hard: false, usd: 0, name: '', ...o };
};

describe('stop spots', () => {
  test('2 stops on 2 drives within 40 m, going the same way, make a spot (gentle stops count too)', () => {
    const spots = stopSpotsFrom([
      { at: day(0), stopPts: [pt([0, 0], 90, { t: day(0) })] },
      { at: day(1), stopPts: [pt([25, 10], 80, { t: day(1), hard: true, name: '192nd Ave E' })] },
    ]);
    assert.equal(spots.length, 1);
    const s = spots[0];
    assert.deepEqual([s.count, s.drives, s.hard, s.name, s.last, s.example], [2, 2, 1, '192nd Ave E', day(1), false]);
    assert.ok(s.heading! > 80 && s.heading! < 90);
    assert.ok(s.id.startsWith('stop:'));
  });

  test('one drive, 60 m apart, or the other way is not a spot', () => {
    assert.equal(stopSpotsFrom([{ at: day(0), stopPts: [pt([0, 0], 90), pt([5, 0], 90)] }]).length, 0);
    assert.equal(stopSpotsFrom([{ at: day(0), stopPts: [pt([0, 0], 90)] }, { at: day(1), stopPts: [pt([60, 0], 90)] }]).length, 0);
    assert.equal(stopSpotsFrom([{ at: day(0), stopPts: [pt([0, 0], 90)] }, { at: day(1), stopPts: [pt([5, 0], 270)] }]).length, 0);
  });

  test('drives saved before the coach have no stops and add nothing', () => {
    assert.deepEqual(stopSpotsFrom([{ at: day(0) }, { at: day(1), stopPts: [] }]), []);
  });

  test('most used first', () => {
    const drives = [0, 1, 2].map((k) => ({ at: day(k), stopPts: [pt([0, 0], 90, { t: day(k) }), ...(k ? [pt([500, 0], 90, { t: day(k) })] : [])] }));
    assert.deepEqual(stopSpotsFrom(drives).map((s) => s.count), [3, 2]);
  });
});

describe('saved summary: what the coach keeps', () => {
  const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
  const fixes = read('sample-drive.json') as Fix[];
  const limits = new SpeedLimits(read('majorroads.json'));
  const r = analyzeDrive(fixes, NO_DRAINS, { limits, nameOf: () => 'SR 410' });
  const sum = summarize(r, 7, { fixes, nameOf: () => 'SR 410' });

  beforeEach(() => useStorage(300_000));

  test('every stop with its heading, the speeding stretches, street names and a coarse route', () => {
    assert.equal(sum.stopPts!.length, 6);
    assert.deepEqual(sum.stopPts!.map((s) => s.hard), [true, false, true, false, true, false]);
    assert.ok(sum.stopPts!.every((s) => s.heading != null && s.name === 'SR 410'));
    assert.ok(sum.stopPts!.filter((s) => s.hard).every((s) => s.usd > 0));
    assert.equal(sum.speeds!.length, 1);
    assert.deepEqual([sum.speeds![0].road, sum.speeds![0].limitMph], ['SR 410', 45]);
    assert.deepEqual(sum.ways, ['SR 410']);
    const path = pathPoints(sum.path);
    assert.ok(path.length >= 20 && path.length <= 62, `${path.length}`);
    assert.ok(JSON.stringify(sum).length < 6000, `${JSON.stringify(sum).length} bytes`);
  });

  test('the sample drive as example stop spots: its 6 stops', () => {
    assert.equal(exampleStopSpots(r).length, 6);
  });

  test('without fixes or names, the summary still has stops', () => {
    const s = summarize(r, 7);
    assert.equal(s.stopPts!.length, 6);
    assert.equal(s.path, undefined);
  });

  test('older summaries load without the new fields; damaged ones are cleaned', () => {
    const old = { ...sum } as Partial<DriveSummary>;
    delete old.stopPts; delete old.speeds; delete old.ways; delete old.path;
    const back = readSummary(old)!;
    assert.equal(back.stopPts, undefined);
    assert.equal(back.speeds, undefined);
    const bad = readSummary({ ...sum, stopPts: [null, { lat: 1 }, sum.stopPts![0], { ...sum.stopPts![1], heading: 'x', usd: -3 }], speeds: [{}, sum.speeds![0]], ways: [3, 'A'] })!;
    assert.equal(bad.stopPts!.length, 2);
    assert.equal(bad.stopPts![1].heading, null);
    assert.equal(bad.stopPts![1].usd, 0);
    assert.equal(bad.speeds!.length, 1);
    assert.deepEqual(bad.ways, ['A']);
  });

  test('the route stays on this phone: saved and read back here, never in the cloud copy', () => {
    assert.equal(saveSummary(sum), true);
    const back = driveSummaries()[0];
    assert.deepEqual(back.path, sum.path);
    assert.deepEqual(back.stopPts, sum.stopPts);
    assert.equal(readSummary(sum)!.path, undefined);
    assert.equal('path' in toDoc(back, 1), false);
    assert.equal(localStorage.getItem('tt-sums')!.includes('"path"'), false);
    forgetDrive(7);
    assert.deepEqual(driveSummaries(), []);
    assert.equal(localStorage.getItem('tt-paths'), '{}');
  });
});
