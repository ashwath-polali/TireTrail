/** a drive ended on the phone shows up on the laptop (same account) with its route, trimmed; and a clear answer when a route can't come */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { useCloud } from '../src/app/cloud/firebase.ts';
import { driveId, toDoc } from '../src/app/cloud/merge.ts';
import type { Cloud } from '../src/app/cloud/sdk.ts';
import { backupChanged, checkBackup, fetchRoute, routeInCloud, startSync, stopSync, syncView } from '../src/app/cloud/sync.ts';
import { readTrack, trackDoc } from '../src/app/cloud/track.ts';
import { routeWords } from '../src/app/cloud/words.ts';
import { allSummaries, pack, saveDrive, trackOf, unpack } from '../src/app/screens/saved.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { nearEnds, summarize } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { NO_DRAINS, SmallStorage } from './engine-helpers.ts';

const SAMPLE = JSON.parse(readFileSync(new URL('../public/data/sample-drive.json', import.meta.url), 'utf8')) as Fix[];

// the browser bits sync touches
const g = globalThis as Record<string, unknown>;
const events: string[] = [];
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.dispatchEvent = (e: Event) => { events.push(e.type); return true; };
g.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };

/** users/{uid} as Firestore holds it, shared by both devices; every write in order */
class FakeCloud {
  profile_: Record<string, unknown> | null = null;
  drives_: Record<string, Record<string, unknown>> = {};
  tracks_: Record<string, Record<string, unknown>> = {};
  ops: string[] = [];
  fail: Error | null = null;
  async drives() { this.check(); return Object.entries(this.drives_).map(([id, data]) => ({ id, data: structuredClone(data) })); }
  async profile() { this.check(); return this.profile_ ? structuredClone(this.profile_) : null; }
  async track(_u: string, id: string) { this.check(); return this.tracks_[id] ? structuredClone(this.tracks_[id]) : null; }
  async putTrack(_u: string, id: string, data: Record<string, unknown>) {
    this.check();
    if (!this.profile_) throw new Error('no profile');
    this.profile_.tracks = [...new Set([...((this.profile_.tracks as string[]) ?? []), id])];
    this.tracks_[id] = structuredClone(data);
    this.ops.push(`route ${id}`);
  }
  async write(_u: string, put: { id: string; data: Record<string, unknown> }[], del: string[], profile: Record<string, unknown>, create = false) {
    this.check();
    if (!create && !this.profile_) throw new Error('no profile');
    this.profile_ = { ...(this.profile_ ?? {}), ...structuredClone(profile) };
    if (del.length) this.profile_.tracks = ((this.profile_.tracks as string[]) ?? []).filter((x) => !del.includes(x));
    for (const p of put) this.drives_[p.id] = structuredClone(p.data);
    for (const id of del) { delete this.drives_[id]; delete this.tracks_[id]; }
    this.ops.push(`write ${put.map((p) => p.id).join(',') || '-'}`);
  }
  async wipe() { this.profile_ = null; this.drives_ = {}; this.tracks_ = {}; }
  private check() { if (this.fail) throw this.fail; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function idle(): Promise<void> {
  await sleep(5);
  for (let i = 0; i < 400 && syncView().busy; i++) await sleep(5);
  await sleep(5);
}

const phone = new SmallStorage(3_000_000), laptop = new SmallStorage(3_000_000);
const on = (s: SmallStorage) => { g.localStorage = s; };
const hooks = { said: () => {}, wiped: () => {} };

/** the sample drive, recorded at `at`, saved the way the drive screen saves it */
function record(at: number): Fix[] {
  const fixes = SAMPLE.map((f) => ({ ...f, t: f.t - SAMPLE[0].t + at }));
  const r = analyzeDrive(fixes, NO_DRAINS);
  assert.ok(saveDrive({ at, mi: '3 mi', smooth: '', creek: 0, fixes: fixes.map(pack) }, summarize(r, at, { fixes })));
  return fixes;
}

let cloud: FakeCloud;
beforeEach(() => {
  cloud = new FakeCloud();
  useCloud(cloud as unknown as Cloud);
  for (const s of [phone, laptop]) for (const k of [...Array(s.length)].map((_, i) => s.key(i)!)) s.removeItem(k);
  events.length = 0;
});
afterEach(() => stopSync());

describe('phone to laptop, same account', () => {
  test('the drive ended on the phone opens on the laptop with its route, ends trimmed', async () => {
    const at1 = Date.now() - 86_400_000, at2 = Date.now() - 60_000;
    on(phone);
    record(at1);
    startSync('u', hooks, true);
    await idle();
    // later: a drive ends on the phone while signed in
    const fixes = record(at2);
    stopSync();
    startSync('u', hooks, false);
    await idle();
    stopSync();
    const id = driveId(at2);
    assert.ok(cloud.drives_[id] && cloud.tracks_[id], 'summary and route are in the backup');
    // the route went up first, so no device ever sees the summary without it
    assert.ok(cloud.ops.indexOf(`route ${id}`) < cloud.ops.findIndex((o) => o.startsWith('write') && o.includes(id)), cloud.ops.join(' | '));

    on(laptop);
    startSync('u', hooks, false);
    await idle();
    assert.deepEqual(allSummaries().map((s) => s.at), [at2, at1]);
    // its route came down by itself: on the map and checked for creeks without a tap
    const t = trackOf(at2);
    assert.ok(t, 'route fetched');
    assert.ok(events.includes('tt:drives'));
    const back = t.fixes.map(unpack), ends: LngLat[] = [[fixes[0].lon, fixes[0].lat], [fixes[fixes.length - 1].lon, fixes[fixes.length - 1].lat]];
    assert.ok(back.length > 30 && back.length < fixes.length);
    for (const f of back) assert.equal(nearEnds([f.lon, f.lat], ends), false);
    assert.deepEqual(back.map((f) => f.t), readTrack(cloud.tracks_[id], at2)!.map((f) => f.t));
    assert.equal(await fetchRoute(at2), 'ok');
    assert.equal(routeInCloud(at2), false, 'already here');
  });

  test('an open laptop picks up a drive within one look at the backup', async () => {
    on(phone);
    record(Date.now() - 86_400_000);
    startSync('u', hooks, true);
    await idle();
    stopSync();
    on(laptop);
    startSync('u', hooks, false);
    await idle();
    assert.equal(allSummaries().length, 1);
    // nothing new: a look reads one doc and writes nothing
    const writes = cloud.ops.length;
    await checkBackup();
    await idle();
    assert.equal(cloud.ops.length, writes);

    // meanwhile the phone ends a drive: its route, then its summary, as the phone's sync sends them
    const at = Date.now() - 30_000, now = Date.now();
    const fixes = SAMPLE.map((f) => ({ ...f, t: f.t - SAMPLE[0].t + at }));
    await cloud.putTrack('u', driveId(at), { ...trackDoc(at, fixes, now)! });
    await cloud.write('u', [{ id: driveId(at), data: toDoc(summarize(analyzeDrive(fixes, NO_DRAINS), at, { fixes }), now) }], [], { lastSync: now, drives: 2 });
    const before = cloud.ops.length;
    // the laptop, still open, looks once
    await checkBackup();
    await idle();
    assert.equal(allSummaries()[0].at, at);
    assert.ok(trackOf(at), 'its route too');
    // and wrote nothing back, so the phone isn't woken for nothing
    assert.equal(cloud.ops.length, before, cloud.ops.join(' | '));
  });

  test('a look notices a drive and a route from another device', () => {
    const st = { known: { 1: { h: 'a', u: 1 } }, tracks: ['1'], seen: 500 };
    assert.equal(backupChanged(st, { lastSync: 500, tracks: ['1'] }), false);
    assert.equal(backupChanged(st, { lastSync: 900, tracks: ['1'] }), true);
    assert.equal(backupChanged(st, { lastSync: 500, tracks: ['1', '2'] }), true);
    assert.equal(backupChanged(st, null), true, 'deleted on another device');
    assert.equal(backupChanged({ known: {}, tracks: [] }, null), false);
  });
});

describe('when a route cannot come', () => {
  /** the laptop, signed in, with one drive from the backup whose route isn't there */
  async function summaryOnly(updatedAgo: number): Promise<number> {
    const at = Date.now() - 3_600_000;
    on(phone);
    record(at);
    startSync('u', hooks, true);
    await idle();
    stopSync();
    delete cloud.tracks_[driveId(at)];
    cloud.profile_!.tracks = [];
    cloud.drives_[driveId(at)].updated = Date.now() - updatedAgo;
    on(laptop);
    startSync('u', hooks, false);
    await idle();
    return at;
  }

  test('only a summary in the backup: says the route stayed on the phone', async () => {
    const at = await summaryOnly(3_600_000);
    assert.equal(routeInCloud(at), false);
    assert.equal(await fetchRoute(at, 1), 'none');
    assert.match(routeWords('none'), /stayed on the phone that recorded it/);
    assert.equal(trackOf(at), null);
  });

  test("an older phone's route a moment behind its summary still opens", async () => {
    const at = await summaryOnly(5000);
    const doc = trackDoc(at, SAMPLE.map((f) => ({ ...f, t: f.t - SAMPLE[0].t + at })), Date.now())!;
    setTimeout(() => { cloud.tracks_[driveId(at)] = { ...doc }; }, 15);
    assert.equal(await fetchRoute(at, 10), 'ok');
    assert.ok(trackOf(at));
  });

  test('offline, or not this account: each gets its own words', async () => {
    const at = await summaryOnly(3_600_000);
    cloud.fail = new Error('fetch failed');
    assert.equal(await fetchRoute(at, 1), 'offline');
    cloud.fail = Object.assign(new Error('denied'), { code: 'permission-denied' });
    assert.equal(await fetchRoute(at, 1), 'signin');
    cloud.fail = null;
    stopSync();
    assert.equal(await fetchRoute(at, 1), 'signin', 'signed out, and never signed in here');
    for (const r of ['none', 'offline', 'signin', 'damaged'] as const) assert.ok(routeWords(r).length < 100 && !/[–—]/.test(routeWords(r)));
  });

  test('a damaged route is said so, not taken as missing', async () => {
    const at = await summaryOnly(3_600_000);
    cloud.tracks_[driveId(at)] = { v: 1, at, n: 1, f: 'x', updated: 1 };
    assert.equal(await fetchRoute(at, 1), 'damaged');
  });

  test('a route that fits nowhere in storage still opens this visit', async () => {
    const at = await summaryOnly(3_600_000);
    const doc = trackDoc(at, SAMPLE.map((f) => ({ ...f, t: f.t - SAMPLE[0].t + at })), Date.now())!;
    cloud.tracks_[driveId(at)] = { ...doc };
    // the laptop's storage is full
    const full = new SmallStorage(0);
    for (let i = 0; i < laptop.length; i++) { const k = laptop.key(i)!; (full as unknown as { m: Map<string, string> }).m.set(k, laptop.getItem(k)!); }
    on(full);
    assert.equal(await fetchRoute(at, 1), 'ok');
    assert.ok(trackOf(at));
  });
});
