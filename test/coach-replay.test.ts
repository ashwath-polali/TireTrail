/** replay: the route in colored stretches, each with what happened and what to do, in plain words with real numbers */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { replayDrive, worstStretches, type Replay } from '../src/drive/coach/replay.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import type { Fix } from '../src/drive/types.ts';
import { drive, NO_DRAINS, roads, T0 } from './engine-helpers.ts';

const kinds = (r: Replay) => r.stretches.map((s) => s.kind);
const limit = (mph: number) => new SpeedLimits(roads([[mph, [-1000, 0], [20000, 0]]]));

function covers(r: Replay): void {
  // stretches cover every point once, in order, and never cross a GPS pause
  let next = 0;
  for (const s of r.stretches) {
    assert.equal(s.from, next);
    assert.ok(s.to >= s.from);
    assert.ok(!r.breaks.some((b) => b > s.from && b <= s.to), 'crosses a pause');
    next = s.to + 1;
  }
  assert.equal(next, r.points.length);
  assert.equal(r.mph.length, r.points.length);
}

describe('replay on the sample drive', () => {
  const read = (n: string) => JSON.parse(readFileSync(new URL(`../public/data/${n}`, import.meta.url), 'utf8'));
  const fixes = read('sample-drive.json') as Fix[];
  const limits = new SpeedLimits(read('majorroads.json'));
  const report = analyzeDrive(fixes, NO_DRAINS, { limits });
  const r = replayDrive(fixes, { limits, nameOf: () => 'SR 410' });

  test('smooth stretches, its 3 hard stops, and the speeding at the end', () => {
    covers(r);
    assert.deepEqual(kinds(r), ['smooth', 'hard', 'smooth', 'hard', 'smooth', 'hard', 'smooth', 'speeding']);
    assert.equal(r.stretches.filter((s) => s.kind === 'hard').length, report.brakes.length);
    // each hard stretch holds its hard brake
    for (const b of report.brakes) assert.ok(r.stretches.some((s) => s.kind === 'hard' && s.from <= b.i && s.to >= b.i));
  });

  test('plain words with real numbers', () => {
    const hard = r.stretches[1];
    assert.match(hard.what, /^You braked hard to a stop from \d+ mph on SR 410, losing \d mph in one second\.$/);
    assert.match(hard.todo, /^Start slowing about \d seconds? sooner here\. A gentle stop wears your tires less\.$/);
    assert.ok(hard.usd > 0);
    const sp = r.stretches[r.stretches.length - 1];
    assert.equal(sp.limitMph, 45);
    assert.match(sp.what, /^You went 5\d in a 45 on SR 410 for 0\.\d miles\.$/);
    assert.equal(sp.todo, 'Easing off to 45 here saves gas.');
    // no per-drive cents: they look broken
    for (const s of r.stretches) assert.ok(!/¢/.test(s.todo), s.todo);
    assert.equal(r.stretches[0].todo, 'Nothing to change here.');
    for (const s of r.stretches) assert.ok(!/[–—]/.test(s.what + s.todo));
  });

  test('worst stretches first: hard stops, then speeding', () => {
    assert.deepEqual(worstStretches(r, 4).map((s) => s.kind), ['hard', 'hard', 'hard', 'speeding']);
  });
});

describe('replay on made-up drives', () => {
  test('firm braking (about 5 mph a second) is firm, not hard', () => {
    const r = replayDrive(drive(15, [[10, 0], [6.8, -2.2], [5, 0]], { heading: 90 }));
    covers(r);
    assert.deepEqual(kinds(r), ['smooth', 'firm', 'smooth']);
    assert.match(r.stretches[1].what, /^Firm stop from 3\d mph, about 5 mph slower each second\.$/);
    assert.equal(r.stretches[1].usd, 0);
  });

  test('a gentle stop stays smooth', () => {
    assert.deepEqual(kinds(replayDrive(drive(15, [[10, 0], [10, -1.5], [5, 0]], { heading: 90 }))), ['smooth']);
  });

  test('a fast start, with no money claimed', () => {
    const r = replayDrive(drive(0, [[5, 0], [5, 3.6], [10, 0]], { heading: 90 }));
    assert.deepEqual(kinds(r), ['smooth', 'fast-start', 'smooth']);
    const s = r.stretches[1];
    assert.match(s.what, /^You sped up fast from \d+ to \d+ mph, gaining 8 mph in one second\.$/);
    assert.equal(s.todo, 'Press the gas more slowly as you pull away.');
    assert.equal(s.usd, 0);
  });

  test('speeding counts only more than 5 mph over, and only says gas above 50 mph', () => {
    // 29 mph in a 25: not counted
    assert.deepEqual(kinds(replayDrive(drive(13, [[60, 0]], { heading: 90 }), { limits: limit(25) })), ['smooth']);
    // 34 mph in a 25: speeding, no gas cost
    const slow = replayDrive(drive(15, [[60, 0]], { heading: 90 }), { limits: limit(25) });
    assert.deepEqual(kinds(slow), ['speeding']);
    assert.equal(slow.stretches[0].usd, 0);
    assert.equal(slow.stretches[0].todo, 'Ease off to 25 here.');
    assert.match(slow.stretches[0].what, /^You went 34 in a 25 on SR 1 for 0\.6 miles\.$/);
    // 58 mph in a 45: costs gas
    const fast = replayDrive(drive(26, [[60, 0]], { heading: 90 }), { limits: limit(45) });
    assert.ok(fast.stretches[0].usd > 0);
    assert.equal(fast.stretches[0].todo, 'Easing off to 45 here saves gas.');
    // no limits known: never speeding
    assert.deepEqual(kinds(replayDrive(drive(26, [[60, 0]], { heading: 90 }))), ['smooth']);
  });

  test('a GPS pause splits the stretches', () => {
    const a = drive(15, [[30, 0]], { heading: 90 });
    const b = drive(15, [[30, 0]], { heading: 90, t0: T0 + 60_000, start: [900, 0] });
    const r = replayDrive([...a, ...b]);
    covers(r);
    assert.deepEqual(r.breaks, [a.length]);
    assert.equal(r.stretches.length, 2);
  });

  test('no fixes, no stretches', () => {
    assert.deepEqual(replayDrive([]), { points: [], mph: [], breaks: [], stretches: [] });
  });
});
