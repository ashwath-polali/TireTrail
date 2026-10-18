/** live coach: one cue at a time, from learned spots, usual stops, posted limits and the car's own speed changes */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { cuesFor, eventWords, LIVE, LiveCoach, sayMs, speedingWords, type Cue } from '../src/drive/coach/live.ts';
import { exampleStopSpots, type StopSpot } from '../src/drive/coach/stopspots.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { exampleSpots, type Spot } from '../src/drive/spots.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { drive, MPH, NO_DRAINS, P, roads, T0 } from './engine-helpers.ts';

const spot = (xy: XY, heading: number | null = 90, id = 'b1'): Spot => ({
  id, lngLat: P.toLngLat(xy), heading, count: 2, drives: 2, veryHard: 0, last: T0, name: '', cls: 'ground', salmon: false, example: false,
});
const stop = (xy: XY, heading: number | null = 90, id = 's1'): StopSpot => ({ id, lngLat: P.toLngLat(xy), heading, count: 3, drives: 2, hard: 0, last: T0, name: '', example: false });
/** meters along the drive (east from the origin) at a fix */
const x = (f: Fix) => P.toXY([f.lon, f.lat])[0];
const spoken = (cs: Cue[]) => cs.filter((c) => c.say);
const east = (v: number, secs: number, o: Parameters<typeof drive>[2] = {}) => drive(v, [[secs, 0]], { heading: 90, ...o });

describe('live coach: spots and stops ahead', () => {
  test('a hard-brake spot is called out about 10 s before the car gets there', () => {
    const fixes = east(15, 40);
    const cues = cuesFor(fixes, { spots: [spot([400, 0])] });
    assert.equal(cues.length, 1);
    const c = cues[0];
    assert.equal(c.kind, 'spot-ahead');
    assert.equal(c.say, 'Hard-brake spot ahead. Ease off.');
    assert.equal(c.tone, 'alert');
    const f = fixes.find((q) => q.t === c.at)!;
    const s = (400 - x(f)) / 15;
    assert.ok(s > 9 && s <= 10.5, `${s} s ahead`);
  });

  test('a usual stop gets "Stop ahead. Coast." 8 to 12 s before, only above 25 mph', () => {
    const fixes = east(15, 40);
    const cues = cuesFor(fixes, { stopSpots: [stop([400, 0])] });
    assert.deepEqual(cues.map((c) => c.kind), ['coast']);
    assert.equal(cues[0].say, 'Stop ahead. Coast.');
    const s = (400 - x(fixes.find((q) => q.t === cues[0].at)!)) / 15;
    assert.ok(s >= 8 && s <= 12, `${s} s ahead`);
    // 22 mph: no coast cue
    assert.equal(cuesFor(east(10, 40), { stopSpots: [stop([300, 0])] }).length, 0);
  });

  test('nothing is said below 15 mph, or for a spot the other way or off to the side', () => {
    assert.equal(cuesFor(east(6, 60), { spots: [spot([200, 0])] }).length, 0);
    assert.equal(cuesFor(east(15, 40), { spots: [spot([400, 0], 270)] }).length, 0);
    assert.equal(cuesFor(east(15, 40), { spots: [spot([400, 200])] }).length, 0);
    // behind the car
    assert.equal(cuesFor(east(15, 20, { start: [500, 0] }), { spots: [spot([300, 0])] }).length, 0);
  });

  test('a stop spot that is also a hard-brake spot gets only the spot cue', () => {
    const cues = cuesFor(east(15, 40), { spots: [spot([400, 0])], stopSpots: [stop([420, 0])] });
    assert.deepEqual(cues.map((c) => c.kind), ['spot-ahead']);
  });

  test('a spot is said once per pass, and again on a later pass', () => {
    const coach = new LiveCoach({ spots: [spot([400, 0])] });
    const run = (fixes: Fix[]) => fixes.flatMap((f) => coach.update(f) ?? []);
    assert.equal(run(east(15, 40)).length, 1);
    // the car comes back from far away a few minutes later
    assert.equal(run(east(15, 40, { t0: T0 + 300_000, start: [-200, 0] })).length, 1);
  });
});

describe('live coach: speeding', () => {
  const limits = (mph: number) => new SpeedLimits(roads([[mph, [-1000, 0], [20000, 0]]]));

  test('after 10 s more than 5 mph over, at most once per 2 minutes on a road', () => {
    // 33.5 mph in a 25, for 4 minutes
    const fixes = east(15, 240);
    const cues = cuesFor(fixes, { limits: limits(25) });
    assert.deepEqual(cues.map((c) => c.kind), ['speeding', 'speeding']);
    assert.equal(cues[0].say, 'Limit 25. Ease off.');
    assert.equal(cues[0].ref, 'SR 1');
    assert.ok(cues[0].at - T0 >= 10_000 && cues[0].at - T0 <= 12_000, `${cues[0].at - T0}`);
    assert.ok(cues[1].at - cues[0].at >= 120_000 && cues[1].at - cues[0].at <= 122_000);
  });

  test('says gas only above 50 mph, where it counts', () => {
    const cues = cuesFor(east(26, 30), { limits: limits(45) });
    assert.equal(cues[0].say, 'Limit 45. Easing off saves gas.');
    assert.equal(speedingWords(35, 44), 'Limit 35. Ease off.');
  });

  test('5 mph over or less, or less than 10 s over, says nothing', () => {
    assert.equal(cuesFor(east(30 * MPH, 120), { limits: limits(25) }).length, 0);
    assert.equal(cuesFor(drive(15, [[8, 0], [3, -2], [20, 0]], { heading: 90 }), { limits: limits(30) }).length, 0);
    assert.equal(cuesFor(east(15, 60)).length, 0);
  });

  test('a spot beats speeding, and nothing else is said for 20 s', () => {
    const fixes = east(15, 60);
    const cues = cuesFor(fixes, { limits: limits(25), spots: [spot([15 * 20, 0])] });
    assert.equal(cues[0].kind, 'spot-ahead');
    const sp = cues.find((c) => c.kind === 'speeding')!;
    assert.ok(sp.at - cues[0].at >= 20_000, `${sp.at - cues[0].at}`);
    const s = spoken(cues);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].at - s[i - 1].at >= 20_000);
  });

  test('the clock can be passed in', () => {
    const coach = new LiveCoach({ limits: limits(25) });
    const fixes = east(15, 30);
    const out = fixes.map((f, i) => coach.update(f, 5_000_000 + i * 1000)).filter(Boolean) as Cue[];
    assert.equal(out.length, 1);
    assert.equal(out[0].at, 5_000_000 + 10_000);
  });
});

describe('live coach: says each hard brake and fast start', () => {
  test('a hard brake (4 m/s², about 9 mph a second) is said once, right after', () => {
    const fixes = drive(15, [[10, 0], [3.75, -4], [5, 0]], { heading: 90 });
    const cues = cuesFor(fixes);
    assert.deepEqual(cues.map((c) => [c.kind, c.say, c.tone]), [['hard-brake', 'Hard brake.', 'alert']]);
    const dt = (cues[0].at - T0) / 1000 - 10;
    assert.ok(dt >= 0 && dt <= 5, `${dt} s after braking began`);
  });

  test('a gentle stop gives nothing; a fast start is said even at low speed', () => {
    assert.equal(cuesFor(drive(15, [[10, 0], [10, -1.5], [5, 0]], { heading: 90 })).length, 0);
    const cues = cuesFor(drive(0, [[5, 0], [5, 3.6], [5, 0]], { heading: 90 }));
    assert.deepEqual(cues.map((c) => [c.kind, c.say, c.tone]), [['fast-start', 'Fast start.', 'soft']]);
  });

  test('a very hard brake says so', () => {
    const cues = cuesFor(drive(20, [[10, 0], [3, -5], [5, 0]], { heading: 90 }));
    assert.deepEqual(cues.map((c) => c.say), ['Very hard brake.']);
  });

  test('events close together are said once, together, and never dropped', () => {
    assert.equal(eventWords([{ kind: 'brake', veryHard: false }]), 'Hard brake.');
    assert.equal(eventWords([{ kind: 'brake', veryHard: false }, { kind: 'brake', veryHard: true }]), 'Two hard brakes.');
    assert.equal(eventWords([{ kind: 'brake', veryHard: false }, { kind: 'start', veryHard: false }]), 'Hard brake and a fast start.');
    assert.equal(eventWords([{ kind: 'start', veryHard: false }, { kind: 'start', veryHard: false }]), 'Two fast starts.');
    // a spot warning is talking when a hard brake and then a fast start happen
    const coach = new LiveCoach({ spots: [spot([15 * 13, 0])] });
    const fixes = drive(15, [[3, 0], [2, -4], [3, 0], [2, 4], [20, 0]], { heading: 90 });
    const cues = fixes.flatMap((f) => coach.update(f) ?? []);
    coach.finish();
    assert.equal(coach.events.length, 2);
    // every event was said, by a cue after the one before had finished
    assert.ok(coach.events.every((e) => e.cue >= 0));
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i].at >= cues[i - 1].at + sayMs(cues[i - 1].say), `${cues[i].at - cues[i - 1].at} ms`);
    // while something else is being said, a brake and a fast start wait and are said as one line
    const busy = new LiveCoach();
    busy.spoke('A long line that takes a good while to say out loud here.', T0 + 5000);
    const said = drive(15, [[5, 0], [2, -4], [1, 0], [2, 4], [12, 0]], { heading: 90 }).flatMap((f) => busy.update(f) ?? []);
    assert.deepEqual(said.map((c) => c.say), ['Hard brake and a fast start.']);
    assert.deepEqual(said[0].events, [0, 1]);
  });

  test('lines never overlap, and the ahead cues stay 20 s apart', () => {
    const fixes = drive(15, [[25, 0], [3, -4], [6, 3.5], [3, -4], [6, 3.5], [30, 0]], { heading: 90 });
    const coach = new LiveCoach({ spots: [spot([15 * 30, 0])] });
    const cues = fixes.flatMap((f) => coach.update(f) ?? []);
    for (let i = 1; i < cues.length; i++) assert.ok(cues[i].at - cues[i - 1].at >= sayMs(cues[i - 1].say) + LIVE.gapMs);
    const ahead = cues.filter((c) => c.kind === 'spot-ahead' || c.kind === 'coast' || c.kind === 'speeding');
    for (let i = 1; i < ahead.length; i++) assert.ok(ahead[i].at - ahead[i - 1].at >= 20_000);
    assert.equal(coach.events.filter((e) => e.cue < 0).length, 0);
  });

  test('one bad speed reading is not a hard brake', () => {
    const fixes = east(15, 30, { noise: (k) => (k === 12 ? -9 : 0) });
    assert.equal(cuesFor(fixes).length, 0);
  });

  test('the same fixes always give the same cues', () => {
    const fixes = drive(15, [[10, 0], [3.75, -4], [5, 0], [5, 3.6]], { heading: 90 });
    assert.deepEqual(cuesFor(fixes, { spots: [spot([300, 0])] }), cuesFor(fixes, { spots: [spot([300, 0])] }));
  });

  test('bad fixes are ignored', () => {
    const coach = new LiveCoach();
    assert.equal(coach.update({ t: T0, lat: NaN, lon: 0 }), null);
    assert.equal(coach.update({ t: T0, lat: 47.17, lon: -122.18 }), null);
    assert.equal(coach.update({ t: T0 - 1000, lat: 47.17, lon: -122.18 }), null);
  });
});

describe('live coach on the sample drive', () => {
  const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
  const fixes = read('sample-drive.json') as Fix[];
  const limits = new SpeedLimits(read('majorroads.json'));
  const r = analyzeDrive(fixes, NO_DRAINS, { limits });
  const cues = cuesFor(fixes, { spots: exampleSpots(r), stopSpots: exampleStopSpots(r), limits });

  test('warns before each of its 3 hard-brake spots, says each hard brake, coast for the 3 gentle stops, and once for speeding', () => {
    const n = (k: string) => cues.filter((c) => c.kind === k).length;
    assert.equal(n('spot-ahead'), 3);
    assert.equal(n('hard-brake'), 3);
    assert.equal(n('coast'), 3);
    assert.equal(n('speeding'), 1);
    assert.equal(n('fast-start'), 0);
    // each warning comes before its hard brake
    for (const b of r.brakes) assert.ok(cues.some((c) => c.kind === 'spot-ahead' && b.t - c.at >= 5000 && b.t - c.at <= 15000), `brake at ${b.t - T0}`);
    // each hard brake is said within a few seconds of it
    for (const b of r.brakes) assert.ok(cues.some((c) => c.kind === 'hard-brake' && c.at - b.t >= 0 && c.at - b.t <= 5000), `brake at ${b.t - T0}`);
    const ahead = spoken(cues).filter((c) => c.kind !== 'hard-brake' && c.kind !== 'fast-start');
    for (let i = 1; i < ahead.length; i++) assert.ok(ahead[i].at - ahead[i - 1].at >= 20_000);
  });

  test('no cue words use dashes for pauses', () => {
    for (const c of cues) assert.ok(!/[–—]/.test(c.say));
  });
});
