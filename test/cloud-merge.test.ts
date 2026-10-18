/** cloud backup: which drives go up, come down or get deleted, with no network */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { driveId, evicted, fromDoc, hashSummary, localPlan, mergePlan, planEmpty, stableJson, toDoc, type CloudDrive, type Known } from '../src/app/cloud/merge.ts';
import type { DriveSummary } from '../src/drive/summary.ts';

const CAP = 100;
const sum = (at: number, score = 80): DriveSummary => ({
  v: 2, at, mi: 3.1, min: 7.6, score, lost: { brakes: 10, starts: 0, speed: 10 }, hardBrakes: 1, fastStarts: 0, overMi: 0.2, stops: 6, hardStops: 1,
  gas: { low: 0.004, typical: 0.005, high: 0.006 }, tires: { low: 0, typical: 0.003, high: 0.013 }, salmon: 1,
  brakes: [{ t: at + 60_000, lat: 47.16722, lon: -122.13952, heading: 96, veryHard: false, cls: 'creek', name: 'SR 410' }],
});
const cloudOf = (s: DriveSummary, u = 1000): CloudDrive => ({ s, u });
const knownOf = (list: DriveSummary[], u = 1000): Known => Object.fromEntries(list.map((s) => [driveId(s.at), { h: hashSummary(s), u }]));
const ats = (xs: DriveSummary[]) => xs.map((s) => s.at).sort((a, b) => a - b);
const NOW = 5000;

describe('cloud documents', () => {
  test('a drive document is the summary plus when it was written, and reads back the same', () => {
    const s = sum(1);
    const d = toDoc(s, 1234);
    assert.equal(d.updated, 1234);
    assert.equal('fixes' in d, false);
    const back = fromDoc(d)!;
    assert.deepEqual(back.s, s);
    assert.equal(back.u, 1234);
  });

  test('a damaged document is skipped', () => {
    assert.equal(fromDoc({ at: 'x' }), null);
    assert.equal(fromDoc(null), null);
  });

  test('the hash ignores key order, so a Firestore copy matches the one on the phone', () => {
    const s = sum(7);
    const shuffled = JSON.parse(stableJson(s)) as DriveSummary;
    const reordered = { ...shuffled, gas: { high: s.gas.high, typical: s.gas.typical, low: s.gas.low } };
    assert.equal(hashSummary(reordered), hashSummary(s));
    assert.notEqual(hashSummary(sum(7, 81)), hashSummary(s));
  });
});

describe('merge on sign-in', () => {
  test('a new phone gets every cloud drive; nothing goes up', () => {
    const cloud = [cloudOf(sum(1)), cloudOf(sum(2))];
    const p = mergePlan([], cloud, {}, NOW, CAP);
    assert.deepEqual(ats(p.download), [1, 2]);
    assert.equal(p.upload.length, 0);
    assert.equal(p.remove.length, 0);
    assert.deepEqual(Object.keys(p.known).sort(), ['1', '2']);
    assert.equal(p.known['1'].u, 1000);
  });

  test('a first sign-in with drives on the phone sends them all up', () => {
    const p = mergePlan([sum(1), sum(2)], [], {}, NOW, CAP);
    assert.deepEqual(ats(p.upload), [1, 2]);
    assert.equal(p.known['2'].u, NOW);
  });

  test('both ways at once, by drive id', () => {
    const p = mergePlan([sum(1), sum(3)], [cloudOf(sum(2)), cloudOf(sum(3))], {}, NOW, CAP);
    assert.deepEqual(ats(p.upload), [1]);
    assert.deepEqual(ats(p.download), [2]);
    assert.deepEqual(Object.keys(p.known).sort(), ['1', '2', '3']);
  });

  test('in step already: nothing to do', () => {
    const list = [sum(1), sum(2)];
    const p = mergePlan(list, list.map((s) => cloudOf(s)), knownOf(list), NOW, CAP);
    assert.ok(planEmpty(p));
  });

  test('a drive changed on this phone since the last sync goes up', () => {
    const old = sum(1, 70), mine = sum(1, 75);
    const p = mergePlan([mine], [cloudOf(old, 1000)], knownOf([old], 1000), NOW, CAP);
    assert.deepEqual(p.upload, [mine]);
    assert.equal(p.known['1'].h, hashSummary(mine));
  });

  test('a drive changed elsewhere (and not here) comes down', () => {
    const old = sum(1, 70), theirs = sum(1, 90);
    const p = mergePlan([old], [cloudOf(theirs, 3000)], knownOf([old], 1000), NOW, CAP);
    assert.deepEqual(p.download, [theirs]);
    assert.equal(p.upload.length, 0);
    assert.equal(p.known['1'].u, 3000);
  });

  test('changed on both sides: the newer write wins', () => {
    const base = sum(1, 70), mine = sum(1, 75), theirs = sum(1, 90);
    // changed here now (5000) beats a cloud write at 3000
    assert.deepEqual(mergePlan([mine], [cloudOf(theirs, 3000)], knownOf([base]), NOW, CAP).upload, [mine]);
    // a cloud write from a clock ahead of ours wins
    assert.deepEqual(mergePlan([mine], [cloudOf(theirs, 9000)], knownOf([base]), NOW, CAP).download, [theirs]);
  });

  test('a drive deleted on this phone (even while signed out) is deleted in the cloud, not brought back', () => {
    const list = [sum(1), sum(2), sum(3)];
    const p = mergePlan([sum(1), sum(3)], list.map((s) => cloudOf(s)), knownOf(list), NOW, CAP);
    assert.deepEqual(p.remove, ['2']);
    assert.equal(p.download.length, 0);
    assert.equal('2' in p.known, false);
  });

  test('a drive missing from the cloud goes back up', () => {
    const list = [sum(1), sum(2)];
    const p = mergePlan(list, [cloudOf(sum(1))], knownOf(list), NOW, CAP);
    assert.deepEqual(ats(p.upload), [2]);
  });

  test("downloads stop at the phone's cap, keeping the newest", () => {
    const local = Array.from({ length: 95 }, (_, i) => sum(1000 + i));
    const cloud = Array.from({ length: 10 }, (_, i) => cloudOf(sum(900 + i)));
    const p = mergePlan(local, cloud, {}, NOW, CAP);
    assert.deepEqual(ats(p.download), [905, 906, 907, 908, 909]);
    assert.equal(Object.keys(p.known).length, CAP);
  });

  test('an old drive the phone dropped to stay under 100 stays in the cloud', () => {
    const local = Array.from({ length: CAP }, (_, i) => sum(100 + i));
    const gone = sum(5);
    const p = mergePlan(local, [...local, gone].map((s) => cloudOf(s)), knownOf([...local, gone]), NOW, CAP);
    assert.deepEqual(p.remove, []);
    assert.equal(p.download.length, 0);
    assert.equal('5' in p.known, false);
  });
});

describe('between full syncs', () => {
  test('a new drive goes up; one already backed up does not', () => {
    const a = sum(1), b = sum(2);
    const p = localPlan([b, a], knownOf([a]), NOW, CAP);
    assert.deepEqual(p.upload, [b]);
    assert.equal(p.remove.length, 0);
    assert.deepEqual(Object.keys(p.known).sort(), ['1', '2']);
  });

  test('a deleted drive is deleted in the cloud', () => {
    const a = sum(1), b = sum(2);
    const p = localPlan([b], knownOf([a, b]), NOW, CAP);
    assert.deepEqual(p.remove, ['1']);
    assert.deepEqual(Object.keys(p.known), ['2']);
  });

  test('nothing changed: an empty plan', () => {
    const list = [sum(1), sum(2)];
    assert.ok(planEmpty(localPlan(list, knownOf(list), NOW, CAP)));
  });

  test('the oldest drive pushed out by the cap is not deleted in the cloud', () => {
    const local = Array.from({ length: CAP }, (_, i) => sum(10 + i));
    const p = localPlan(local, knownOf([sum(1), ...local]), NOW, CAP);
    assert.deepEqual(p.remove, []);
    assert.equal('1' in p.known, false);
  });

  test('eviction only counts the oldest drive on a full phone', () => {
    const full = Array.from({ length: CAP }, (_, i) => sum(10 + i));
    assert.equal(evicted(5, full, CAP), true);
    assert.equal(evicted(50, full, CAP), false);
    assert.equal(evicted(5, full.slice(0, 20), CAP), false);
  });
});
