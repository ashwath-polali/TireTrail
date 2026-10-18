/** a drive's log: pauses, what was said, every event, and the shared file; older drives work from what they kept */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { LiveCoach } from '../src/drive/coach/live.ts';
import { driveFile, driveFileName, everyEvent, gapLine, gapsOf, makeLog, motionOf, readLog, spanWords } from '../src/drive/drivelog.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { MotionTrack } from '../src/drive/motion.ts';
import { MPH, NO_DRAINS, roads, T0 } from './engine-helpers.ts';
import { synth } from './motion-synth.ts';

const warm: [number, number][] = [[3, 1.2], [4, 0], [3, -1.2], [4, 0], [3, 1.2], [6, 0]];

describe('drive log', () => {
  test('pauses: from the log when kept, else from holes in the saved readings', () => {
    const fixes = synth(13, [[60, 0]], { noMotion: true, drop: (k) => k > 20 && k < 40 }).fixes;
    // an older drive: only the readings
    const old = gapsOf(fixes, null);
    assert.equal(old.length, 1);
    assert.equal(old[0].why, 'unknown');
    assert.equal(gapLine(old), 'Not recorded for 20 seconds: the screen may have locked.');
    // a new drive knows it was off screen
    const log = makeLog(T0, [{ from: T0 + 20_000, to: T0 + 40_000, reason: 'hidden' }], [], 'on', [], []);
    assert.equal(gapLine(gapsOf(fixes, log)), "Not recorded for 20 seconds: TireTrail wasn't on screen.");
    assert.equal(gapLine(gapsOf(synth(13, [[30, 0]], { noMotion: true }).fixes, null)), '');
    assert.equal(spanWords(4 * 60_000 + 10_000), '4 min');
  });

  test('every event, in order, with how strong and whether it was said', () => {
    const limits = new SpeedLimits(roads([[30, [-1000, 0], [20000, 0]]]));
    const d = synth(10, [...warm, [2.4, -4], [6, 0], [5, 3.6], [30, 0]]);
    // as recorded: the coach runs live, its lines go in the log
    const m = new MotionTrack(), coach = new LiveCoach({ motion: m, limits });
    let k = 0;
    const cues = [];
    for (const f of d.fixes) {
      while (k < d.samples.length && d.samples[k].t <= f.t + 300) m.add(d.samples[k++]);
      const c = coach.update(f);
      if (c) cues.push(c);
    }
    m.end();
    const events = coach.finish();
    const logged = cues.map((c) => ({ at: c.at, kind: c.kind, say: c.say, said: 'said' as const, ev: c.events?.map((i) => ({ kind: events[i].kind, t: events[i].peakT })) }));
    const log = makeLog(T0, [], logged, 'on', m.seconds, m.windows);
    const back = readLog(JSON.parse(JSON.stringify(log)))!;
    const r = analyzeDrive(d.fixes, NO_DRAINS, { motion: motionOf(back), limits });
    const rows = everyEvent(r, back, () => 'Main St');
    assert.deepEqual(rows.map((x) => x.what).sort(), ['Fast start', 'Hard brake', 'Over the limit']);
    assert.ok(rows.every((x, i) => i === 0 || x.t >= rows[i - 1].t), 'in time order');
    assert.match(rows.find((x) => x.what === 'Hard brake')!.strength, /^(8\.[5-9]|9\.\d) mph in a second$/);
    assert.match(rows.find((x) => x.what === 'Over the limit')!.strength, /^\d+ mph over 30$/);
    assert.ok(rows.every((x) => x.said === 'said'), JSON.stringify(rows));
    // an older drive: the same events, and no claim about what was said
    const plain = everyEvent(analyzeDrive(d.fixes, NO_DRAINS, { limits }), null, () => '');
    assert.deepEqual(plain.map((x) => x.what).sort(), rows.map((x) => x.what).sort());
    assert.ok(plain.every((x) => x.said === null));
  });

  test('a muted drive says so, and an event never said shows as not said', () => {
    const d = synth(13, [...warm, [2.5, -4], [8, 0]], { noMotion: true });
    const r = analyzeDrive(d.fixes, NO_DRAINS);
    const e = r.events[0];
    const muted = makeLog(T0, [], [{ at: e.t + 3000, kind: 'hard-brake', say: 'Hard brake.', said: 'muted', ev: [{ kind: 'brake', t: e.t }] }], 'none', [], []);
    assert.equal(everyEvent(r, muted, () => '')[0].said, 'muted');
    assert.equal(everyEvent(r, makeLog(T0, [], [], 'none', [], []), () => '')[0].said, 'not said');
  });

  test('the shared file has the readings, motion summary, windows, events and the app build', () => {
    const d = synth(13, [...warm, [2.5, -4], [8, 0]]), m = new MotionTrack();
    for (const s of d.samples) { m.add(s); if (s.t === d.fixes[27].t) m.mark(d.fixes[24].t); }
    m.end();
    const log = makeLog(T0, [], [], 'on', m.seconds, m.windows);
    const r = analyzeDrive(d.fixes, NO_DRAINS, { motion: motionOf(log) });
    const f = driveFile({ report: r, fixes: d.fixes, log, at: T0, build: 'abc', device: 'test' }) as Record<string, any>;
    assert.equal(f.build, 'abc');
    assert.equal(f.readings.rows.length, d.fixes.length);
    assert.equal(f.motion.perSecond.rows.length, m.seconds.length);
    assert.equal(f.motion.windows.list.length, 1);
    assert.deepEqual(f.events.map((e: { kind: string; sensor: boolean }) => [e.kind, e.sensor]), [['brake', true]]);
    assert.ok(Math.abs(f.events[0].mphPerS - 4 / MPH) < 0.6);
    // an older drive still gives a file, without motion
    const old = driveFile({ report: analyzeDrive(d.fixes, NO_DRAINS), fixes: d.fixes, log: null, at: T0, build: '', device: 'test' }) as Record<string, any>;
    assert.equal(old.motion, null);
    assert.equal(old.build, 'dev');
    assert.match(driveFileName(T0), /^tiretrail-drive-\d{4}-\d\d-\d\d-\d{4}\.json$/);
  });

  test('a damaged log reads as none', () => {
    assert.equal(readLog(null), null);
    assert.equal(readLog({ v: 2 }), null);
    assert.equal(motionOf(readLog({ v: 1, at: 1, gaps: [], cues: [], sensor: 'on', motion: { sec: { t0: 'x', rows: 5 } } })), null);
  });
});
