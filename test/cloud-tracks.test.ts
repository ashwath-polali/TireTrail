/** routes in the backup: the 300 m trim, the size cap, packing, deletes from another device, and routes fetched to a new device */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { driveId, fromDoc, hashSummary, mergePlan, planEmpty, toDoc, type CloudDrive, type Known } from '../src/app/cloud/merge.ts';
import { enoughTrack, readTrack, TRACK_MAX, trackDoc, trimTrack } from '../src/app/cloud/track.ts';
import { forgetAllDrives, forgetDrive, keepFetched, pack, saveDrive, savedDrives, trackOf, unpack } from '../src/app/screens/saved.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { enoughDrive } from '../src/drive/enough.ts';
import { HOME_M, nearEnds, type DriveSummary } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { NO_DRAINS, useStorage } from './engine-helpers.ts';

const fixes = JSON.parse(readFileSync(new URL('../public/data/sample-drive.json', import.meta.url), 'utf8')) as Fix[];
const AT = fixes[0].t;
const ends: LngLat[] = [[fixes[0].lon, fixes[0].lat], [fixes[fixes.length - 1].lon, fixes[fixes.length - 1].lat]];
const m = (a: LngLat, b: LngLat) => Math.hypot((b[0] - a[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * 110_540);

describe('the route that leaves the phone', () => {
  test('nothing within 300 m of the start or end', () => {
    const kept = trimTrack(fixes);
    assert.ok(kept.length > 30 && kept.length < fixes.length);
    for (const f of kept) for (const e of ends) assert.ok(m([f.lon, f.lat], e) > HOME_M - 2, `${f.lat},${f.lon}`);
    // and everything else stays
    assert.equal(kept.length, fixes.filter((f) => !nearEnds([f.lon, f.lat], ends)).length);
  });

  test('packs and reads back the same fixes', () => {
    const doc = trackDoc(AT, fixes, 99)!;
    assert.equal(doc.v, 1);
    assert.equal(doc.at, AT);
    assert.equal(doc.updated, 99);
    const back = readTrack(doc, AT)!, kept = trimTrack(fixes);
    assert.equal(back.length, kept.length);
    assert.equal(doc.n, kept.length);
    for (let i = 0; i < kept.length; i++) {
      assert.equal(back[i].t, kept[i].t);
      assert.ok(Math.abs(back[i].lat - kept[i].lat) < 1e-6 && Math.abs(back[i].lon - kept[i].lon) < 1e-6);
      assert.equal(back[i].speed == null, kept[i].speed == null);
      if (kept[i].speed != null) assert.ok(Math.abs(back[i].speed! - kept[i].speed!) < 0.006);
    }
    // a lot smaller than the JSON the phone keeps
    assert.ok(doc.f.length < JSON.stringify(fixes.map(pack)).length / 2, `${doc.f.length}`);
  });

  test('the trimmed route still reads as a drive', () => {
    const back = readTrack(trackDoc(AT, fixes, 0)!, AT)!;
    assert.ok(enoughDrive(analyzeDrive(back, NO_DRAINS)));
  });

  test('a drive too short once its ends are cut sends no route', () => {
    const short = fixes.slice(0, 80);
    assert.equal(enoughTrack(trimTrack(short)), false);
    assert.equal(trackDoc(AT, short, 0), null);
  });

  test('a very long drive is thinned to stay under 900 KB', () => {
    // 15 hours of 1-second fixes on a long loop far from home
    const long: Fix[] = Array.from({ length: 54_000 }, (_, i) => ({ t: AT + i * 1000, lat: 47 + Math.sin(i / 900) * 0.6 + i * 1e-6, lon: -121 + Math.cos(i / 700) * 0.9, speed: 20 + (i % 17) / 10, accuracy: 4 + (i % 9) }));
    const doc = trackDoc(AT, long, 0)!;
    assert.ok(doc, 'still sent');
    assert.ok(doc.f.length <= TRACK_MAX, `${doc.f.length}`);
    assert.ok(JSON.stringify(doc).length < 1_000_000);
    assert.ok(doc.n < long.length && doc.n > long.length / 4, `${doc.n}`);
    assert.equal(readTrack(doc, AT)!.length, doc.n);
  });

  test('a damaged or mismatched route is skipped', () => {
    const doc = trackDoc(AT, fixes, 0)!;
    assert.equal(readTrack(null, AT), null);
    assert.equal(readTrack({ ...doc, at: AT + 1 }, AT), null);
    assert.equal(readTrack({ ...doc, f: 'x,y' }, AT), null);
    assert.equal(readTrack({ ...doc, f: doc.f.replace(/^[^,]+/, '#') }, AT), null);
  });
});

const sum = (at: number, score = 80): DriveSummary => ({
  v: 2, at, mi: 3.1, min: 7.6, score, lost: { brakes: 10, starts: 0, speed: 10 }, hardBrakes: 0, fastStarts: 0, overMi: 0, stops: 6, hardStops: 0,
  gas: { low: 0, typical: 0, high: 0 }, salmon: 0, brakes: [], path: [-122.15, 47.16, -122.12, 47.18],
});
const cloudOf = (s: DriveSummary, u = 1000): CloudDrive => ({ s: fromDoc(toDoc(s, 0))!.s, u });
const knownOf = (list: DriveSummary[], u = 1000): Known => Object.fromEntries(list.map((s) => [driveId(s.at), { h: hashSummary(s), u }]));

describe('deletes across devices', () => {
  test('a drive deleted on another device is deleted here too', () => {
    const list = [sum(1), sum(2), sum(3)];
    const p = mergePlan(list, [cloudOf(sum(1)), cloudOf(sum(3))], knownOf(list), 5000, 100);
    assert.deepEqual(p.forget, ['2']);
    assert.equal(p.upload.length, 0);
    assert.equal('2' in p.known, false);
    assert.equal(planEmpty(p), false);
  });

  test('changed here since the last sync, it goes back up instead', () => {
    const old = sum(2, 70);
    const p = mergePlan([sum(2, 75)], [], knownOf([old]), 5000, 100);
    assert.deepEqual(p.forget, []);
    assert.equal(p.upload.length, 1);
  });

  test("a cloud copy that can't be read isn't taken as deleted", () => {
    const list = [sum(1), sum(2)];
    const p = mergePlan(list, [cloudOf(sum(1))], knownOf(list), 5000, 100, new Set(['1', '2']));
    assert.deepEqual(p.forget, []);
    assert.deepEqual(p.upload.map((s) => s.at), [2]);
  });

  test('never synced here: a drive missing from the cloud goes up, not away', () => {
    const p = mergePlan([sum(4)], [], {}, 5000, 100);
    assert.deepEqual([p.forget.length, p.upload.length], [0, 1]);
  });
});

describe('routes on this device', () => {
  beforeEach(() => useStorage(2_000_000));
  const packed = fixes.map(pack);

  test("a fetched route opens like this phone's own, and never counts as one to send", () => {
    assert.equal(trackOf(5), null);
    assert.ok(keepFetched(5, packed));
    assert.equal(trackOf(5)!.fixes.length, packed.length);
    assert.deepEqual(unpack(trackOf(5)!.fixes[0]), unpack(packed[0]));
    assert.equal(savedDrives().length, 0);
  });

  test("fetched routes never push out this phone's own", () => {
    for (let i = 0; i < 8; i++) saveDrive({ at: 100 + i, mi: '', smooth: '', creek: 0, fixes: packed.slice(0, 10) });
    for (let i = 0; i < 10; i++) keepFetched(10 + i, packed.slice(0, 10));
    assert.equal(savedDrives().length, 8);
    // the newest 8 fetches stay (a week of drives from the other device)
    assert.ok(trackOf(19) && trackOf(12) && !trackOf(11));
  });

  test('deleting a drive deletes its fetched route; deleting all clears them', () => {
    keepFetched(5, packed);
    keepFetched(6, packed);
    forgetDrive(5);
    assert.equal(trackOf(5), null);
    assert.ok(trackOf(6));
    forgetAllDrives();
    assert.equal(trackOf(6), null);
  });
});
