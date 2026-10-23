/** the sample drive through the whole engine, with the real posted limits and drain data */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles, tripOver } from '../src/salmon/row.ts';
import { readTile } from '../src/salmon/tiles.ts';
import { describe, test } from 'node:test';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { exampleSpots } from '../src/drive/spots.ts';
import { pctVs } from '../src/app/screens/drive-words.ts';
import { SAMPLE_CARD } from '../src/app/screens/guide-words.ts';
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
      assert.ok(s.drop1s / MPH > 8 && s.drop1s / MPH < 10.5, `${s.drop1s / MPH}`);
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

  test('money: gas from its 3 hard stops leads, then speeding, then tires; a year is about $380 ($130 to $770)', () => {
    const m = r.money;
    // about 1.2 counted hard stops a mile under 50 mph: about 0.66 as aggressive as the study, so about 16% of that gas
    assert.ok(m.hardShare > 0.12 && m.hardShare < 0.17, `${m.hardShare}`);
    assert.ok(m.hardGas.typical > m.speedGas.typical && m.speedGas.typical > m.tires.typical);
    assert.equal(m.speedKept, 1);
    assert.ok(m.year && m.year.total.typical > 340 && m.year.total.typical < 420, `${m.year?.total.typical}`);
    assert.ok(m.year.total.low > 100 && m.year.total.high < 900, `${m.year.total.low} ${m.year.total.high}`);
    assert.ok(m.year.speedGas.typical > 10 && m.year.speedGas.typical < 25, `${m.year.speedGas.typical}`);
    assert.ok(m.year.tires.typical < 15);
    // never more than the published 40% of stop-and-go gas, even at the high end
    assert.ok(m.year.hardGas.high <= (11_100 / 20) * 5.34 * 0.4);
    for (const u of [m.hardGas, m.speedGas, m.tires, m.total, m.year.total]) assert.ok(u.low <= u.typical && u.typical <= u.high);
    // each hard brake carries its share of the gas
    assert.ok(Math.abs(r.brakes.reduce((t, b) => t + b.gasUsd, 0) - m.hardGas.typical) < 1e-9);
  });

  test("the first-open guide's sample card shows this drive's real tire dust and salmon stream", () => {
    assert.equal(SAMPLE_CARD.grams, Math.round(r.dust.mg.typical / 10) / 100);
    assert.equal(SAMPLE_CARD.overPct, pctVs(r.dust.mg.typical, r.dust.typicalMg.typical));
    assert.deepEqual([...new Set(r.brakes.filter((b) => b.salmon).map((b) => b.receiving))], [SAMPLE_CARD.creek]);
    // and its salmon stream crossings, from the statewide tiles
    const keys = routeTiles(fixes.map((f) => toRegion([f.lon, f.lat])));
    const tiles = [...keys].flatMap((k) => {
      const p = new URL(`../public/data/salmon/t/${k}.json`, import.meta.url);
      return existsSync(p) ? [readTile(k, JSON.parse(readFileSync(p, 'utf8')))!] : [];
    });
    assert.equal(tripOver(tiles, fixes, []).crossed, SAMPLE_CARD.streams);
  });

  test('tire dust: about a third of a gram, a little over typical, its hard brakes a fifth of it', () => {
    const d = r.dust;
    assert.ok(d.mg.typical > 250 && d.mg.typical < 450, `${d.mg.typical}`);
    assert.ok(d.mg.low < d.mg.typical && d.mg.typical < d.mg.high);
    assert.ok(d.styleFactor.typical > 1.05 && d.styleFactor.typical < 1.2, `${d.styleFactor.typical}`);
    assert.ok(d.share.brakes > 0.15 && d.share.brakes < 0.3, `${d.share.brakes}`);
    assert.equal(d.share.starts, 0);
    // 18 µg of 6PPDQ per g of tread
    assert.ok(Math.abs(d.sixPpdqUg.typical - (d.mg.typical / 1000) * 18) < 1e-9);
    assert.ok(d.tireLifeMi > 35_000 && d.tireLifeMi < 45_000, `${d.tireLifeMi}`);
    // a pickup sheds half again as much on the same drive; the comparison stays the same
    const p = analyzeDrive(fixes, data, { limits, vehicle: 'pickup' }).dust;
    assert.ok(Math.abs(p.mg.typical / d.mg.typical - 1.5) < 0.03, `${p.mg.typical / d.mg.typical}`);
    assert.ok(Math.abs(p.styleFactor.typical - d.styleFactor.typical) < 0.02);
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
    assert.ok(JSON.stringify(sum).length < 1600);
  });

  test('without posted limits, speeding is not checked and costs nothing', () => {
    const plain = analyzeDrive(fixes, NO_DRAINS);
    assert.equal(plain.limitsChecked, false);
    assert.equal(plain.speeding.overMi, 0);
    assert.equal(plain.money.speedGas.typical, 0);
    // its hard stops still waste gas
    assert.ok(plain.money.hardGas.typical > 0);
    assert.ok(plain.score.score > r.score.score);
    assert.ok(plain.brakes.every((b) => b.cls === 'none' && !b.salmon));
  });
});
