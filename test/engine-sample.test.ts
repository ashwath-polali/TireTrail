/** the sample drive through the whole engine, with the real posted limits and salmon streams */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { gasLine } from '../src/drive/gas.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { exampleSpots } from '../src/drive/spots.ts';
import { pctVs } from '../src/app/screens/drive-words.ts';
import { SAMPLE_CARD } from '../src/app/screens/guide-words.ts';
import { summarize } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles, tripOver } from '../src/salmon/row.ts';
import { readTile } from '../src/salmon/tiles.ts';
import { MPH, NO_DRAINS } from './engine-helpers.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
const fixes = read('sample-drive.json') as Fix[];
const limits = new SpeedLimits(read('majorroads.json'));
const data = new TireTrailData(read('tiretrail.json'));
const r = analyzeDrive(fixes, data, { limits, nameOf: () => '138th St' });
const tiles = [...routeTiles(fixes.map((f) => toRegion([f.lon, f.lat])))].map((k) => readTile(k, read(`salmon/t/${k}.json`))!);
const trip = tripOver(tiles, fixes, r.brakes.map((b) => b.lngLat));

describe('the sample drive', () => {
  test('about 3.5 miles in 7 minutes in Spanaway, 1 Hz with GPS speed, nowhere near Bonney Lake', () => {
    assert.ok(r.miles > 3.4 && r.miles < 3.7, `${r.miles}`);
    assert.ok(r.durationS > 6 * 60 && r.durationS < 8 * 60, `${r.durationS}`);
    assert.ok(fixes.every((f, i) => typeof f.speed === 'number' && (i === 0 || f.t - fixes[i - 1].t === 1000)));
    // Bonney Lake is east of -122.2
    assert.ok(fixes.every((f) => f.lon < -122.4 && f.lat > 47.11 && f.lat < 47.14));
  });

  test('it crosses 3 salmon streams: Clover Creek, Spanaway Creek and Morey Creek', () => {
    assert.equal(trip.crossed, 3);
    assert.deepEqual(trip.names, ['Clover Creek', 'Spanaway Creek', 'Morey Creek']);
    // the hard brake at Spanaway Loop Rd is just past Spanaway Creek
    assert.equal(trip.gentle, 2);
  });

  test('2 hard brakes (about 10 mph slower each second), 1 fast start, 2 gentle stops', () => {
    assert.equal(r.stops.length, 4);
    assert.deepEqual(r.stops.map((s) => s.hard), [false, true, true, false]);
    for (const s of r.hardStops) {
      assert.ok(s.drop1s / MPH > 9 && s.drop1s / MPH < 11.5, `${s.drop1s / MPH}`);
      assert.ok(s.soonerS > 1 && s.soonerS < 4, `${s.soonerS}`);
    }
    assert.equal(r.brakes.length, 2);
    assert.ok(r.brakes.every((b, k) => b.stop === r.hardStops[k].index));
    const starts = r.events.filter((e) => e.kind === 'start');
    assert.equal(starts.length, 1);
    assert.ok(starts[0].mphPerS > 8 && starts[0].mphPerS < 11, `${starts[0].mphPerS}`);
  });

  test('no speeding: it keeps to the posted limits it has', () => {
    assert.equal(r.limitsChecked, true);
    assert.equal(r.speeding.overMi, 0);
    assert.equal(r.money.speedGas.typical, 0);
  });

  test('gas: its hard brakes and fast start add about 70¢ to every gallon', () => {
    const m = r.money;
    // 2 hard brakes and a fast start, each counted a little over 1, in 3.5 stop-and-go miles: about half as aggressive as the study
    assert.ok(m.hardShare > 0.11 && m.hardShare < 0.15, `${m.hardShare}`);
    assert.equal(m.gasShare.speed, 0);
    const g = gasLine(r)!;
    assert.equal(g.words, 'Your fast starts and hard brakes added about 70¢ to every gallon on this drive.');
    assert.equal(g.pitch, 'Save gas: start gently and ease off sooner.');
    assert.ok(g.range);
    // an EV gets none
    assert.equal(gasLine(analyzeDrive(fixes, data, { limits, vehicle: 'ev' })), null);
    // each hard brake carries its share of the gas
    assert.ok(r.brakes.every((b) => b.gasUsd > 0));
  });

  test("the first-open guide's sample card shows this drive's real tire dust and salmon streams", () => {
    assert.equal(SAMPLE_CARD.grams, Math.round(r.dust.mg.typical / 10) / 100);
    assert.equal(SAMPLE_CARD.overPct, pctVs(r.dust.mg.typical, r.dust.typicalMg.typical));
    assert.equal(SAMPLE_CARD.streams, trip.crossed);
    assert.equal(SAMPLE_CARD.creek, trip.names[0]);
  });

  test('tire dust: about a quarter gram, more than typical, its hard brakes a quarter of it', () => {
    const d = r.dust;
    assert.ok(d.mg.typical > 200 && d.mg.typical < 350, `${d.mg.typical}`);
    assert.ok(d.mg.low < d.mg.typical && d.mg.typical < d.mg.high);
    assert.ok(d.styleFactor.typical > 1.08 && d.styleFactor.typical < 1.2, `${d.styleFactor.typical}`);
    assert.ok(d.share.brakes > 0.2 && d.share.brakes < 0.35, `${d.share.brakes}`);
    assert.ok(d.share.starts > 0.05 && d.share.starts < 0.2, `${d.share.starts}`);
    assert.equal(d.turns.length, 0);
    // 18 µg of 6PPDQ per g of tread
    assert.ok(Math.abs(d.sixPpdqUg.typical - (d.mg.typical / 1000) * 18) < 1e-9);
    // a pickup sheds half again as much on the same drive; the comparison stays the same
    const p = analyzeDrive(fixes, data, { limits, vehicle: 'pickup' }).dust;
    assert.ok(Math.abs(p.mg.typical / d.mg.typical - 1.5) < 0.03, `${p.mg.typical / d.mg.typical}`);
    assert.ok(Math.abs(p.styleFactor.typical - d.styleFactor.typical) < 0.02);
  });

  test('the hard brakes visibly cost points, and braking is the thing to fix', () => {
    assert.ok(r.score.score >= 60 && r.score.score <= 75, `${r.score.score}`);
    assert.ok(r.score.parts.brakes.lost >= 20);
    assert.ok(r.score.parts.starts.lost > 0);
    assert.equal(r.score.parts.speed.lost, 0);
    assert.equal(r.score.fix?.key, 'brakes');
  });

  test('its hard brakes become example spots, and the summary is small', () => {
    const spots = exampleSpots(r);
    assert.equal(spots.length, 2);
    assert.ok(spots.every((s) => s.example && s.count === 1 && s.name === '138th St' && s.heading != null));
    const sum = summarize(r, fixes[0].t);
    assert.equal(sum.hardBrakes, 2);
    assert.equal(sum.fastStarts, 1);
    assert.equal(sum.score, r.score.score);
    assert.ok(sum.gasShare && Math.abs(sum.gasShare.typical - r.money.gasShare.typical) < 1e-4);
    assert.ok(JSON.stringify(sum).length < 1600);
  });

  test('without posted limits, speeding is not checked; the hard brakes still waste gas', () => {
    const plain = analyzeDrive(fixes, NO_DRAINS);
    assert.equal(plain.limitsChecked, false);
    assert.equal(plain.speeding.overMi, 0);
    assert.ok(plain.money.hardGas.typical > 0);
    assert.ok(plain.brakes.every((b) => b.cls === 'none' && !b.salmon));
  });
});
