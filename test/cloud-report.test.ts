/** a synced drive's report reads the same on every device: the phone's own creeks, fix, miles and minutes ride along in the backup */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { useCloud } from '../src/app/cloud/firebase.ts';
import { driveId, fromDoc, hashSummary, toDoc } from '../src/app/cloud/merge.ts';
import { carried, noteReport } from '../src/app/cloud/report.ts';
import type { Cloud } from '../src/app/cloud/sdk.ts';
import { startSync, stopSync, syncView } from '../src/app/cloud/sync.ts';
import { driveTitleOf } from '../src/app/screens/drive-names.ts';
import { reportHead } from '../src/app/screens/drive-words.ts';
import { allSummaries, pack, saveDrive, trackOf, unpack } from '../src/app/screens/saved.ts';
import { analyzeDrive, type DriveReport } from '../src/drive/analyze.ts';
import { makeCopy, readCopy, trimCopy } from '../src/drive/report-copy.ts';
import { cloudSummary, nearEnds, readSummary, summarize } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { NO_DRAINS, SmallStorage } from './engine-helpers.ts';

const SAMPLE = JSON.parse(readFileSync(new URL('../public/data/sample-drive.json', import.meta.url), 'utf8')) as Fix[];

// the browser bits sync touches
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.dispatchEvent = () => true;
g.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };

/** users/{uid} as Firestore holds it, shared by both devices */
class FakeCloud {
  profile_: Record<string, unknown> | null = null;
  drives_: Record<string, Record<string, unknown>> = {};
  tracks_: Record<string, Record<string, unknown>> = {};
  async drives() { return Object.entries(this.drives_).map(([id, data]) => ({ id, data: structuredClone(data) })); }
  async profile() { return this.profile_ ? structuredClone(this.profile_) : null; }
  async track(_u: string, id: string) { return this.tracks_[id] ? structuredClone(this.tracks_[id]) : null; }
  async putTrack(_u: string, id: string, data: Record<string, unknown>) {
    this.profile_!.tracks = [...new Set([...((this.profile_!.tracks as string[]) ?? []), id])];
    this.tracks_[id] = structuredClone(data);
  }
  async write(_u: string, put: { id: string; data: Record<string, unknown> }[], del: string[], profile: Record<string, unknown>) {
    this.profile_ = { ...(this.profile_ ?? {}), ...structuredClone(profile) };
    for (const p of put) this.drives_[p.id] = structuredClone(p.data);
    for (const id of del) { delete this.drives_[id]; delete this.tracks_[id]; }
  }
  async wipe() { this.profile_ = null; this.drives_ = {}; this.tracks_ = {}; }
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
const ll = (f: Fix): LngLat => [f.lon, f.lat];

/** the sample drive, recorded at `at`, saved the way the drive screen saves it */
function record(at: number): { fixes: Fix[]; r: DriveReport } {
  const fixes = SAMPLE.map((f) => ({ ...f, t: f.t - SAMPLE[0].t + at }));
  const r = analyzeDrive(fixes, NO_DRAINS);
  assert.ok(saveDrive({ at, mi: '3 mi', smooth: '', creek: 0, fixes: fixes.map(pack) }, summarize(r, at, { fixes })));
  return { fixes, r };
}

/** one full sync on this device */
async function sync(first = false): Promise<void> {
  startSync('u', hooks, first);
  await idle();
  stopSync();
}

let cloud: FakeCloud;
beforeEach(() => {
  cloud = new FakeCloud();
  useCloud(cloud as unknown as Cloud);
  for (const s of [phone, laptop]) for (const k of [...Array(s.length)].map((_, i) => s.key(i)!)) s.removeItem(k);
});
afterEach(() => stopSync());

describe('the report copy', () => {
  test('reads back as kept; a damaged or missing one reads as none, and the rest of the summary still reads', () => {
    const c = makeCopy([{ name: 'Clover Creek', gentle: true, at: [-122.4512345678, 47.1012345678] }, { name: '', gentle: false, at: null }], 'Brake earlier on Pacific Ave S.', [-122.45, 47.1], 4.2649, 659);
    assert.deepEqual(c, {
      creeks: [{ name: 'Clover Creek', gentle: true, ll: [-122.45123, 47.10123] }, { name: '', gentle: false }],
      fix: 'Brake earlier on Pacific Ave S.', fixLl: [-122.45, 47.1], mi: 4.3, min: 11,
    });
    assert.deepEqual(readCopy(JSON.parse(JSON.stringify(c))), c);
    for (const bad of [null, 'x', {}, { creeks: 'x', mi: 1, min: 1 }, { creeks: [], mi: -1, min: 1 }, { creeks: [], mi: 1 }]) assert.equal(readCopy(bad), undefined, JSON.stringify(bad));
    // a damaged creek is dropped, a long name capped
    assert.deepEqual(readCopy({ creeks: [null, { name: 'x'.repeat(500), gentle: true }, { gentle: 'yes' }], mi: 1, min: 2 })!.creeks, [{ name: 'x'.repeat(80), gentle: true }]);
    const base = { at: 1, mi: 2, score: 90, brakes: [] };
    assert.equal(readSummary(base)!.rep, undefined, 'older drives have none');
    const damaged = readSummary({ ...base, rep: { creeks: 7 } })!;
    assert.equal(damaged.rep, undefined);
    assert.equal(damaged.mi, 2);
  });

  test('the backup copy: a creek near the start or end keeps only whether it was gentle; a fix there, or on a street there, stays home', () => {
    const home: LngLat = [-122.18, 47.15], far: LngLat = [-122.22, 47.14], near = (p: LngLat) => nearEnds(p, [home]);
    const nearHome: LngLat = [home[0] + 0.001, home[1]];
    const c = makeCopy([{ name: 'Home Creek', gentle: true, at: nearHome }, { name: 'Clover Creek', gentle: false, at: far }], 'Brake earlier on Main St.', far, 3, 600);
    const t = trimCopy(c, near, new Set());
    assert.deepEqual(t.creeks, [{ name: '', gentle: true }, { name: 'Clover Creek', gentle: false, ll: [far[0], far[1]] }]);
    assert.equal(t.fix, 'Brake earlier on Main St.');
    assert.equal('fixLl' in t, false, "the fix's place never leaves");
    assert.equal(trimCopy(c, near, new Set(['Main St'])).fix, undefined, 'names a street near home');
    assert.equal(trimCopy({ ...c, fixLl: nearHome }, near, new Set()).fix, undefined, 'near home');
    assert.equal(trimCopy({ ...c, fixLl: undefined }, near, new Set()).fix, undefined, 'no place to check');
    assert.equal(trimCopy({ ...c, fix: '' }, near, new Set()).fix, '', 'nothing to fix says nothing about a place');
  });

  test('cloudSummary trims it with the rest; without its route the drive keeps no creek names or fix', () => {
    const fixes = SAMPLE.map((f) => ({ ...f }));
    const s = summarize(analyzeDrive(fixes, NO_DRAINS), 1, { fixes }), mid = ll(fixes[Math.floor(fixes.length / 2)]);
    const rep = makeCopy([{ name: 'Start Creek', gentle: true, at: ll(fixes[1]) }, { name: 'Mid Creek', gentle: true, at: mid }], 'Ease off sooner on Mid St.', mid, s.mi, s.min * 60);
    const out = cloudSummary({ ...s, rep });
    assert.deepEqual(out.rep!.creeks.map((c) => c.name), ['', 'Mid Creek']);
    assert.equal(out.rep!.fix, 'Ease off sooner on Mid St.');
    const { path: _, ...noRoute } = s;
    const bare = cloudSummary({ ...noRoute, rep });
    assert.deepEqual(bare.rep!.creeks, [{ name: '', gentle: true }, { name: '', gentle: true }]);
    assert.equal(bare.rep!.fix, undefined);
    // already trimmed: left as it is
    assert.deepEqual(cloudSummary(out).rep, out.rep);
  });
});

describe('phone to laptop, same account', () => {
  test('saved on the phone, opened on the laptop: the same headline, title, miles, minutes, creek list and fix', async () => {
    const at = Date.now() - 60_000;
    on(phone);
    const { fixes, r } = record(at);
    // the summary goes up when the drive ends; the report's creeks come a moment later
    await sync(true);
    const creeks = [
      { name: 'Clover Creek', gentle: true, at: ll(fixes[Math.floor(fixes.length / 3)]) },
      { name: 'Spanaway Creek', gentle: false, at: ll(fixes[Math.floor((fixes.length * 2) / 3)]) },
    ];
    const fix = 'Brake earlier on Pacific Ave S at 138th St S.', fixLl = ll(fixes[Math.floor(fixes.length / 2)]);
    assert.ok(noteReport(at, { creeks, fix, fixLl, miles: r.miles, sec: r.durationS }));
    assert.equal(noteReport(at, { creeks, fix, fixLl, miles: r.miles, sec: r.durationS }), false, 'unchanged: no new write');
    await sync();
    const a = allSummaries().find((s) => s.at === at)!;
    const phoneSaw = {
      head: reportHead(creeks, r.brakes.length, r.events.filter((e) => e.kind === 'start').length),
      title: driveTitleOf(a, allSummaries()),
      mi: r.miles.toFixed(1),
      min: Math.max(1, Math.round(r.durationS / 60)),
      creeks: creeks.map((c) => [c.name, c.gentle]),
      fix,
    };
    assert.equal(phoneSaw.head, 'Gentle at 1 of 2 salmon creeks');
    assert.equal(phoneSaw.title, 'The Clover Creek drive');
    const doc = cloud.drives_[driveId(at)];
    assert.ok(doc.rep, 'the backup carries the report');
    assert.equal('fixLl' in (doc.rep as object), false);

    on(laptop);
    await sync();
    const b = allSummaries().find((s) => s.at === at)!, c = carried(b);
    assert.deepEqual({
      head: c.head, title: driveTitleOf(b, allSummaries()), mi: c.mi.toFixed(1), min: c.min, creeks: c.creeks!.map((k) => [k.name, k.gentle]), fix: c.fix,
    }, phoneSaw);
    // the map still draws the trimmed route, which on its own reads shorter
    const route = trackOf(at)!.fixes.map(unpack);
    assert.ok(route.length < fixes.length);
    assert.notEqual(analyzeDrive(route, NO_DRAINS).miles.toFixed(1), phoneSaw.mi);
    // both devices agree it's the same drive, so neither sends it again
    assert.equal(hashSummary(b), hashSummary(a));
    assert.equal(hashSummary(fromDoc(toDoc(a, 1))!.s), hashSummary(a));
  });

  test('an older backup without the copy still opens, with the miles and minutes its phone measured', async () => {
    const at = Date.now() - 120_000;
    on(phone);
    const { r } = record(at);
    await sync(true);
    on(laptop);
    await sync();
    const b = allSummaries().find((s) => s.at === at)!, c = carried(b);
    assert.equal(b.rep, undefined);
    assert.equal(c.head, null, 'the laptop reads its own route for the rest, as before');
    assert.equal(c.creeks, null);
    assert.equal(c.mi.toFixed(1), r.miles.toFixed(1));
    assert.equal(c.min, Math.max(1, Math.round(b.min)));
    assert.equal(typeof driveTitleOf(b, allSummaries()), 'string');
  });
});
