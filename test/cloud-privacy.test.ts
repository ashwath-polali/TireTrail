/** the backup never shows where a drive starts or ends; the phone keeps everything */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { cloudCopy, fromDoc, hashSummary, toDoc } from '../src/app/cloud/merge.ts';
import { allSummaries, forgetAllDrives, saveDrive, saveSummary, savedDrives } from '../src/app/screens/saved.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { HOME_M, nearEnds, pathPoints, summarize, type DriveSummary } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { NO_DRAINS, useStorage } from './engine-helpers.ts';

const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
const fixes = read('sample-drive.json') as Fix[];
const start: LngLat = [fixes[0].lon, fixes[0].lat], end: LngLat = [fixes[fixes.length - 1].lon, fixes[fixes.length - 1].lat];
const m = (a: LngLat, b: LngLat) => Math.hypot((b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110_540);
// the street at home, then the highway
const nameOf = (p: LngLat) => (m(p, start) < 250 || m(p, end) < 250 ? 'Home St' : 'SR 410');
const r = analyzeDrive(fixes, NO_DRAINS, { limits: new SpeedLimits(read('majorroads.json')), nameOf });
const made = summarize(r, 7, { fixes, nameOf });
// plus a stop 60 m from the start and a hard brake 100 m from the end
const full: DriveSummary = {
  ...made,
  stopPts: [{ t: 1, lat: start[1] + 60 / 110_540, lon: start[0], heading: 0, hard: false, usd: 0, name: 'Home St' }, ...made.stopPts!],
  brakes: [...made.brakes, { t: 2, lat: end[1] - 100 / 110_540, lon: end[0], heading: 180, veryHard: false, cls: 'ground', name: 'Home St' }],
};
const near = (lat: number, lon: number) => nearEnds([lon, lat], [start, end]);

describe('backup privacy', () => {
  beforeEach(() => useStorage(300_000));

  test('the phone keeps every point, its route and the streets near the ends', () => {
    assert.ok(full.stopPts!.some((s) => near(s.lat, s.lon)), 'the sample drive has a stop near an end');
    assert.ok(pathPoints(full.path).length > 2);
    assert.deepEqual(full.near, ['Home St']);
    assert.ok(full.ways!.includes('Home St'));
  });

  test('the backup drops every point and street within 300 m of the start or end', () => {
    const doc = toDoc(full, 1);
    for (const k of ['path', 'near']) assert.equal(k in doc, false, k);
    const s = fromDoc(doc)!.s;
    assert.equal(s.trim, true);
    for (const p of [...s.brakes, ...s.stopPts!, ...s.speeds!]) assert.ok(!near(p.lat, p.lon), `${p.lat},${p.lon}`);
    assert.equal(s.stopPts!.length, full.stopPts!.length - 1);
    assert.equal(s.brakes.length, full.brakes.length - 1);
    assert.equal(s.ways!.includes('Home St'), false);
    assert.ok(!JSON.stringify(doc).includes('Home St'));
    // counts and money stay whole
    for (const k of ['score', 'mi', 'hardBrakes', 'stops', 'hardStops', 'salmon'] as const) assert.equal(s[k], full[k], k);
  });

  test('a point just past 300 m stays', () => {
    const lat = start[1] + (HOME_M + 40) / 110_540;
    assert.equal(nearEnds([start[0], lat], [start]), false);
    assert.equal(nearEnds([start[0], start[1] + (HOME_M - 40) / 110_540], [start]), true);
  });

  test('a drive without its route keeps no places in the backup', () => {
    const { path: _, ...bare } = full;
    const s = cloudCopy(bare as DriveSummary);
    assert.deepEqual([s.brakes.length, s.stopPts!.length, s.speeds!.length, s.ways!.length], [0, 0, 0, 0]);
    assert.equal(s.hardStops, full.hardStops);
  });

  test('a trimmed copy brought back to a phone matches the cloud, so it is not sent again', () => {
    const back = fromDoc(toDoc(full, 1))!.s;
    assert.deepEqual(cloudCopy(back), back);
    assert.equal(hashSummary(back), hashSummary(full));
  });

  test('saved on the phone, the full summary comes back with its route', () => {
    saveSummary(full);
    const [s] = allSummaries();
    assert.deepEqual(s.stopPts, full.stopPts);
    assert.deepEqual(s.near, full.near);
    assert.deepEqual(s.path, full.path);
  });

  test('deleting drives on this phone clears tracks, summaries and routes', () => {
    saveDrive({ at: 7, mi: '1', smooth: '', creek: 0, fixes: [] }, full);
    assert.equal(allSummaries().length, 1);
    forgetAllDrives();
    assert.deepEqual([savedDrives().length, allSummaries().length], [0, 0]);
  });
});
