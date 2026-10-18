/** the sample drive through the whole engine, with the real posted limits and drain data */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { exampleSpots } from '../src/drive/spots.ts';
import { summarize } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { MPH, NO_DRAINS } from './engine-helpers.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const fixes = read('sample-drive.json') as Fix[];
const limits = new SpeedLimits(read('majorroads.json'));
const data = new TireTrailData(read('tiretrail.json'));
const r = analyzeDrive(fixes, data, { limits, nameOf: () => 'SR 410' });

describe('the sample drive', () => {
  test('3 hard stops (about 9 mph slower each second) and 3 gentle ones', () => {
    assert.equal(r.stops.length, 6);
    assert.deepEqual(r.stops.map((s) => s.hard), [true, false, true, false, true, false]);
    assert.equal(r.hardStops.length, 3);
    for (const s of r.hardStops) {
      assert.ok(s.drop1s / MPH > 8 && s.drop1s / MPH < 10, `${s.drop1s / MPH}`);
      assert.ok(s.soonerS > 1 && s.soonerS < 4, `${s.soonerS}`);
      assert.ok(s.gentleFt >= 190 && s.gentleFt <= 220);
      assert.ok(s.tiresUsd > 0);
    }
    assert.equal(r.brakes.length, 3);
    assert.ok(r.brakes.every((b, k) => b.stop === r.hardStops[k].index && b.name === 'SR 410'));
    assert.equal(r.events.filter((e) => e.kind === 'start').length, 0);
  });

  test('55 mph in the 45 mph stretch of SR 410', () => {
    assert.equal(r.limitsChecked, true);
    assert.equal(r.speeding.stretches.length, 1);
    const st = r.speeding.stretches[0];
    assert.equal(st.road, 'SR 410');
    assert.equal(st.limitMph, 45);
    assert.ok(Math.abs(st.topMph - 55) < 1.5);
    assert.ok(r.speeding.share > 0.08 && r.speeding.share < 0.15);
  });

  test('money leads with gas, tires are the smaller part, and a year is about $25', () => {
    const m = r.money;
    assert.ok(m.gas.typical > m.tires.typical);
    assert.ok(m.total.typical > 0.005 && m.total.typical < 0.01, `${m.total.typical}`);
    assert.ok(m.year && m.year.total.typical > 20 && m.year.total.typical < 35, `${m.year?.total.typical}`);
    assert.ok(m.year.gas.typical > m.year.tires.typical);
    for (const u of [m.gas, m.tires, m.total, m.year.total]) assert.ok(u.low <= u.typical && u.typical <= u.high);
  });

  test('the hard stops visibly cost points, and braking is the thing to fix', () => {
    assert.ok(r.score.score >= 50 && r.score.score <= 70, `${r.score.score}`);
    assert.ok(r.score.parts.brakes.lost >= 25);
    assert.ok(r.score.parts.speed.lost > 0);
    assert.equal(r.score.fix?.key, 'brakes');
  });

  test('its hard stops become example spots, and the summary is small', () => {
    const spots = exampleSpots(r);
    assert.equal(spots.length, 3);
    assert.ok(spots.every((s) => s.example && s.count === 1 && s.name === 'SR 410' && s.heading != null));
    assert.ok(spots.some((s) => s.salmon), 'one drains to Fennel Creek');
    const sum = summarize(r, fixes[0].t);
    assert.equal(sum.hardBrakes, 3);
    assert.equal(sum.score, r.score.score);
    // with every stop and speeding stretch for the coach
    assert.ok(JSON.stringify(sum).length < 1500);
  });

  test('without posted limits, speeding is not checked and costs nothing', () => {
    const plain = analyzeDrive(fixes, NO_DRAINS);
    assert.equal(plain.limitsChecked, false);
    assert.equal(plain.speeding.overMi, 0);
    assert.equal(plain.money.gas.typical, 0);
    assert.ok(plain.score.score > r.score.score);
    assert.ok(plain.brakes.every((b) => b.cls === 'none' && !b.salmon));
  });
});
