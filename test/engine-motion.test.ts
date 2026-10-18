/** hard brakes and fast starts from GPS plus the motion sensor, on synthetic traces; live and the report must agree */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MotionTrack, packSeconds, unpackSeconds } from '../src/drive/motion.ts';
import { median5 } from '../src/drive/rate.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { NO_DRAINS } from './engine-helpers.ts';
import { live, report, synth, type Phase } from './motion-synth.ts';

// a few gentle speed changes first, so the phone learns which way is forward
const warm: Phase[] = [[3, 1.2], [4, 0], [3, -1.2], [4, 0], [3, 1.2], [6, 0]];
const brakes = (es: { kind: string }[]) => es.filter((e) => e.kind === 'brake').length;

/** report with the sensor, report without, and live, for one trace */
function all(d: ReturnType<typeof synth>) {
  const withSensor = report(d), gps = report(d, false), l = live(d).events;
  // live always matches the report, event for event
  assert.deepEqual(l, withSensor);
  return { withSensor, gps };
}

describe('hard brakes with the motion sensor', () => {
  test('a clean hard brake (0.4 g for 2.5 s) counts once, checked by the sensor', () => {
    const { withSensor, gps } = all(synth(13, [...warm, [2.5, -4], [8, 0]]));
    assert.equal(brakes(withSensor), 1);
    assert.equal(withSensor[0].sensor, true);
    assert.ok(Math.abs(withSensor[0].mph - 9) < 0.6, `${withSensor[0].mph}`);
    assert.equal(brakes(gps), 1);
  });

  test('a sharp 1 s brake counts, with or without the sensor', () => {
    const { withSensor, gps } = all(synth(13, [...warm, [1, -4.2], [8, 0]]));
    assert.equal(brakes(withSensor), 1);
    assert.equal(brakes(gps), 1);
  });

  test('a very hard brake (0.5 g) reads over 10 mph a second', () => {
    const { withSensor } = all(synth(15, [...warm, [2, -5], [8, 0]]));
    assert.equal(brakes(withSensor), 1);
    assert.ok(withSensor[0].mph >= 10, `${withSensor[0].mph}`);
  });

  test('iPhone-style smoothed speed hides a short brake from GPS, and the sensor still finds it', () => {
    const d = synth(13, [...warm, [1.2, -4], [8, 0]], { smoothS: 1.5 });
    const { withSensor, gps } = all(d);
    assert.equal(brakes(gps), 0);
    assert.equal(brakes(withSensor), 1);
    assert.equal(withSensor[0].sensor, true);
  });

  test('a slow, gentle stop is not a hard brake', () => {
    const { withSensor, gps } = all(synth(13, [...warm, [9, -1.45], [8, 0]]));
    assert.equal(withSensor.length + gps.length, 0);
  });

  test('a pothole (big up and down jolts) with a bad GPS reading is not a hard brake', () => {
    const { withSensor } = all(synth(13, [...warm, [10, 0]], { bumps: [[22, 20, 4], [22.5, -15, -3]], glitch: (k) => (k === 23 ? -3.5 : 0) }));
    assert.equal(withSensor.length, 0);
  });

  test('picking the phone up is not a hard brake, even with a GPS dip then, and forward is learned again after', () => {
    const d = synth(13, [...warm, [10, 0], [3, 1.2], [6, 0], [3, -1.2], [6, 0], [3, 1.2], [6, 0], [2.5, -4], [6, 0]], {
      pickup: 24, glitch: (k) => (k === 25 || k === 26 ? -4 : 0),
    });
    const { withSensor } = all(d);
    // only the real hard brake near the end, with the phone turned another way in the mount
    assert.equal(withSensor.length, 1);
    assert.equal(withSensor[0].kind, 'brake');
    assert.equal(withSensor[0].sensor, true);
  });

  test('a turn (0.4 g sideways at a steady speed) is not a hard brake', () => {
    const { withSensor } = all(synth(13, [...warm, [4, 0, 4], [8, 0]]));
    assert.equal(withSensor.length, 0);
  });

  test('the phone sliding in its mount (force but no change in speed) is not a hard brake', () => {
    const { withSensor } = all(synth(13, [...warm, [10, 0]], { bumps: [[22, 0, 4], [22.12, 0, 4], [22.24, 0, 4], [22.36, 0, 4], [22.48, 0, 4], [22.6, 0, 4]] }));
    assert.equal(withSensor.length, 0);
  });

  test('normal GPS speed noise makes no events, with or without the sensor', () => {
    const { withSensor, gps } = all(synth(13, [...warm, [60, 0], [9, -1.45], [5, 0], [8, 1.6], [30, 0]], { noise: 0.3 }));
    assert.equal(withSensor.length + gps.length, 0);
  });

  test('a GPS dip of 2 readings with no force behind it is not a hard brake', () => {
    const d = synth(13, [...warm, [12, 0]], { glitch: (k) => (k === 25 || k === 26 ? -4 : 0) });
    const { withSensor, gps } = all(d);
    assert.equal(withSensor.length + gps.length, 0);
  });

  test('missing readings, or one every 2 seconds, still catch the hard brake', () => {
    assert.equal(brakes(all(synth(13, [...warm, [2.5, -4], [8, 0]], { drop: (k) => k === 25 || k === 26 })).withSensor), 1);
    assert.equal(brakes(all(synth(13, [...warm, [3, -4], [8, 0]], { every: 2 })).withSensor), 1);
  });

  test('a fast start (8 mph a second) counts, a gentle one does not', () => {
    const { withSensor } = all(synth(0, [[5, 0], [3, 3.6], [8, 0]]));
    assert.deepEqual(withSensor.map((e) => e.kind), ['start']);
    assert.equal(all(synth(0, [[5, 0], [8, 2], [8, 0]])).withSensor.length, 0);
  });

  test('the sensor going quiet mid-drive never holds up live, and live still matches the saved drive', () => {
    const d = synth(13, [...warm, [2.5, -4], [8, 0]]);
    d.samples = d.samples.filter((s) => s.t - d.fixes[0].t < 21_500 || s.t - d.fixes[0].t > 27_000);
    const l = live(d);
    assert.deepEqual(l.events.map((e) => e.kind), ['brake']);
    assert.ok(l.coach.events[0].cue >= 0, 'said out loud');
    const again = analyzeDrive(d.fixes, NO_DRAINS, { motion: l.track });
    assert.deepEqual(again.events.map((e) => [e.kind, e.t, e.sensor]), l.events.map((e) => [e.kind, e.t, e.sensor]));
  });

  test('without a sensor (or permission), it falls back to GPS', () => {
    const d = synth(13, [...warm, [2.5, -4], [8, 0]], { noMotion: true });
    assert.deepEqual(report(d).map((e) => [e.kind, e.sensor]), [['brake', false]]);
  });
});

describe('the motion track', () => {
  test('one summary a second, kept compact and read back the same', () => {
    const d = synth(13, [...warm, [2.5, -4], [8, 0]]), m = new MotionTrack();
    // marked about 3 s after the event, as live finds it
    for (const s of d.samples) { m.add(s); if (s.t === d.fixes[27].t) m.mark(d.fixes[24].t); }
    m.end();
    // 33.5 s of driving
    assert.ok(Math.abs(m.seconds.length - 34) <= 1, `${m.seconds.length}`);
    assert.deepEqual(unpackSeconds(JSON.parse(JSON.stringify(packSeconds(m.seconds)))), m.seconds);
    // one full-rate window around the event, not the whole stream
    assert.equal(m.windows.length, 1);
    assert.ok(m.windows[0].s.length > 300 && m.windows[0].s.length < 400, `${m.windows[0].s.length}`);
  });

  test('a second where the phone was picked up is marked bad', () => {
    const m = new MotionTrack();
    for (const s of synth(13, [[10, 0]], { pickup: 4 }).samples) m.add(s);
    m.end();
    assert.ok(m.seconds.some((s) => s.bad));
    assert.ok(!m.seconds.slice(0, 3).some((s) => s.bad));
  });

  test('a median of 5 keeps a sharp step and drops a 2-reading spike', () => {
    assert.deepEqual(median5([13, 13, 13, 9, 9, 9, 9]), [13, 13, 13, 9, 9, 9, 9]);
    assert.deepEqual(median5([13, 13, 13, 9, 9, 13, 13, 13]), [13, 13, 13, 13, 13, 13, 13, 13]);
  });
});
