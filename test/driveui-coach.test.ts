/** the coach on the Drive screens: replay lines and colors, taps on the route, cue captions, this week's money */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { cuesFor, replayDrive, type Replay, type Stretch } from '../src/drive/coach/index.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import type { Fix } from '../src/drive/types.ts';
import type { LngLat, XY } from '../src/geo/geo.ts';
import {
  autostartLink, creekCue, cueView, firstSentence, KIND_COLOR, KIND_LABEL, KIND_TOKEN, keyKinds, splitSay, stretchAt, oneFix, stretchFacts,
  stretchHead, stretchLines, stretchMid, stretchSpeed, stretchWhy,
} from '../src/app/screens/drive-coach.ts';

const DASHES = /[–—]/;
const id = (p: LngLat): XY => [p[0], p[1]];

function stretch(o: Partial<Stretch>): Stretch {
  return { kind: 'smooth', from: 0, to: 0, what: '', todo: '', miles: 0.2, seconds: 30, fromMph: 30, toMph: 30, topMph: 35, limitMph: null, road: '', usd: 0, ...o };
}

/** 10 points along x, one stretch per run */
function replay(stretches: Stretch[], breaks: number[] = []): Replay {
  const points: LngLat[] = Array.from({ length: 10 }, (_, i) => [i * 10, 0]);
  return { points, mph: points.map(() => 30), breaks, stretches };
}

describe('replay lines', () => {
  test('each stretch joins the one before, except where GPS paused, and short events draw last', () => {
    const r = replay([stretch({ kind: 'smooth', from: 0, to: 3 }), stretch({ kind: 'hard', from: 4, to: 5 }), stretch({ kind: 'smooth', from: 6, to: 9 })], [6]);
    const lines = stretchLines(r, id);
    assert.deepEqual(lines.map((l) => l.i), [0, 2, 1]);
    const hard = lines.find((l) => l.kind === 'hard')!;
    assert.deepEqual(hard.path, [[30, 0], [40, 0], [50, 0]]);
    // GPS picked up again at 6: no line back into it
    assert.deepEqual(lines.find((l) => l.i === 2)!.path[0], [60, 0]);
    assert.deepEqual(lines.find((l) => l.i === 0)!.path[0], [0, 0]);
  });

  test('the key lists only the kinds a drive has, calm first, each with a label and a token color', () => {
    const r = replay([stretch({ kind: 'speeding' }), stretch({ kind: 'hard' }), stretch({ kind: 'smooth' })]);
    assert.deepEqual(keyKinds(r), ['smooth', 'hard', 'speeding']);
    for (const k of ['smooth', 'firm', 'hard', 'fast-start', 'speeding'] as const) {
      assert.match(KIND_TOKEN[k], /^--[a-z]+$/);
      assert.match(KIND_COLOR[k], /^#[0-9a-f]{6}$/);
      assert.ok(KIND_LABEL[k] && !DASHES.test(KIND_LABEL[k]));
    }
    assert.equal(new Set(Object.values(KIND_COLOR)).size, 5, 'five different colors');
  });

  test('a tap picks the nearest event first, then smooth road under it, else nothing', () => {
    const r = replay([stretch({ kind: 'smooth', from: 0, to: 4 }), stretch({ kind: 'hard', from: 5, to: 6 }), stretch({ kind: 'smooth', from: 7, to: 9 })]);
    const lines = stretchLines(r, id);
    // mpp 1, 3 CSS px per pixel: 5 m off the route is 15 px
    assert.equal(stretchAt(lines, [55, 5], 1), 1);
    // an event a little farther than smooth road still wins, up to 18 px
    assert.equal(stretchAt(lines, [62, 5], 1), 1);
    assert.equal(stretchAt(lines, [90, 3], 1), 2);
    assert.equal(stretchAt(lines, [90, 30], 1), -1);
    assert.equal(stretchAt([], [0, 0], 1), -1);
  });

  test('the middle of a stretch', () => {
    const r = replay([stretch({ from: 2, to: 6 })]);
    assert.deepEqual(stretchMid(r, r.stretches[0]), [40, 0]);
  });
});

describe('stretch words', () => {
  test('the one fix: a few words and the place', () => {
    const road = 'SR 410 E near 95th St E';
    assert.deepEqual(oneFix(stretch({ kind: 'hard', todo: 'Start slowing about 3 seconds sooner here. A gentle stop wears your tires less.', road })), { title: 'Start slowing about 3 seconds sooner', where: road });
    assert.equal(oneFix(stretch({ kind: 'hard', todo: 'Leave more room ahead and ease off sooner here.' })).title, 'Leave more room ahead and ease off sooner');
    assert.equal(oneFix(stretch({ kind: 'speeding', limitMph: 45 })).title, 'Keep to 45 mph');
    assert.equal(oneFix(stretch({ kind: 'fast-start' })).title, 'Press the gas more slowly');
    assert.equal(oneFix(stretch({ kind: 'firm' })).title, 'Lift off the gas a little sooner');
    // no money in it, and short enough for one line on a phone
    for (const k of ['hard', 'speeding', 'fast-start', 'firm'] as const) {
      const f = oneFix(stretch({ kind: k, limitMph: 45, todo: 'Start slowing about 3 seconds sooner here.' }));
      assert.ok(f.title.length <= 45 && !/[¢$]/.test(f.title), f.title);
    }
  });

  test('facts fit a third of a phone and say speed in mph', () => {
    assert.deepEqual(stretchFacts(stretch({ kind: 'hard', fromMph: 30.4, miles: 0.013 })), [['Braked from', '30 mph'], ['Distance', '70 feet']]);
    assert.deepEqual(stretchFacts(stretch({ kind: 'speeding', limitMph: 45, topMph: 55.2 })), [['Speed limit', '45 mph'], ['Your speed', '55 mph']]);
    assert.deepEqual(stretchFacts(stretch({ kind: 'fast-start', toMph: 36, miles: 0.05 })), [['Sped up to', '36 mph'], ['Distance', '260 feet']]);
    for (const k of ['smooth', 'firm', 'hard', 'fast-start', 'speeding'] as const) for (const [, v] of stretchFacts(stretch({ kind: k, limitMph: 45 }))) assert.ok(v.length <= 10, v);
    assert.equal(stretchSpeed(stretch({ kind: 'speeding', limitMph: 45, topMph: 55 })), '55 in a 45');
    assert.equal(stretchSpeed(stretch({ kind: 'hard', fromMph: 30, toMph: 0 })), '30 to 0 mph');
  });

  test('why it matters: tires for hard stops, gas only for speed, and only above 50 mph', () => {
    assert.match(stretchWhy(stretch({ kind: 'hard' })), /tires/);
    assert.doesNotMatch(stretchWhy(stretch({ kind: 'hard' })), /gas/);
    assert.doesNotMatch(stretchWhy(stretch({ kind: 'firm' })), /gas/);
    assert.match(stretchWhy(stretch({ kind: 'speeding', topMph: 62 })), /7% more gas/);
    assert.doesNotMatch(stretchWhy(stretch({ kind: 'speeding', topMph: 41 })), /gas/);
    assert.equal(stretchWhy(stretch({ kind: 'smooth' })), '');
  });

  test('heads and first sentences', () => {
    assert.deepEqual(stretchHead(stretch({ kind: 'hard', road: 'SR 410 E' })), { eyebrow: 'HARD BRAKE', title: 'On SR 410 E' });
    assert.deepEqual(stretchHead(stretch({ kind: 'firm' })), { eyebrow: 'FIRM BRAKING', title: 'On your drive' });
    assert.equal(firstSentence('Start slowing about 3 seconds sooner here. A gentle stop saves under 1¢.'), 'Start slowing about 3 seconds sooner here.');
    assert.equal(firstSentence('No period'), 'No period');
  });
});

describe('live cue captions', () => {
  test('spoken cues show the same words, split in two; an event line adds what to do next time', () => {
    assert.deepEqual(cueView({ kind: 'spot-ahead', say: 'Hard-brake spot ahead. Ease off.' }), { head: 'Hard-brake spot ahead.', todo: 'Ease off.', tone: 'warn', ms: 7000 });
    assert.deepEqual(cueView({ kind: 'coast', say: 'Stop ahead. Coast.' }), { head: 'Stop ahead.', todo: 'Coast.', tone: 'you', ms: 7000 });
    assert.deepEqual(cueView({ kind: 'speeding', say: 'Limit 45. Easing off saves gas.' }).head, 'Limit 45.');
    const hb = cueView({ kind: 'hard-brake', say: 'Two hard brakes.' });
    assert.deepEqual([hb.head, hb.todo], ['Two hard brakes.', 'Ease off sooner next time.']);
    assert.equal(hb.ms, 5000);
    assert.doesNotMatch(`${hb.head} ${hb.todo}`, /gas/);
    assert.equal(cueView({ kind: 'fast-start', say: 'Fast start.' }).head, 'Fast start.');
    assert.deepEqual(splitSay('One.'), ['One.', '']);
  });

  test('every cue the sample drive gives has words to show, and none say braking saves gas', () => {
    const fixes = JSON.parse(readFileSync(new URL('../public/data/sample-drive.json', import.meta.url), 'utf8')) as Fix[];
    const limits = new SpeedLimits(JSON.parse(readFileSync(new URL('../public/data/majorroads.json', import.meta.url), 'utf8')));
    const cues = cuesFor(fixes, { limits });
    assert.ok(cues.length > 0);
    for (const c of cues) {
      const v = cueView(c);
      assert.ok(v.head, c.kind);
      assert.ok(!DASHES.test(v.head + v.todo));
      if (c.kind === 'hard-brake') assert.doesNotMatch(v.head + v.todo, /gas/);
    }
  });

  test('the salmon-stream reminder says and shows the same thing', () => {
    const s = creekCue(true), c = creekCue(false);
    assert.equal(s.say, `${s.view.head} ${s.view.todo}`);
    assert.match(s.say, /salmon stream/);
    assert.match(c.say, /creek/);
    assert.doesNotMatch(s.say + c.say, /gas/);
  });
});

describe('home and the link', () => {
  test('the start-by-itself link is this page with #autostart', () => {
    assert.equal(autostartLink('https://tiretrail.app', '/'), 'https://tiretrail.app/#autostart');
    assert.equal(autostartLink('https://ashwath.github.io', '/tiretrail/'), 'https://ashwath.github.io/tiretrail/#autostart');
  });

  test('the sample drive replays as one line per stretch that covers every point', () => {
    const fixes = JSON.parse(readFileSync(new URL('../public/data/sample-drive.json', import.meta.url), 'utf8')) as Fix[];
    const r = replayDrive(fixes);
    const lines = stretchLines(r, id);
    assert.equal(lines.length, r.stretches.length);
    const seen = new Set<string>();
    for (const l of lines) for (const p of l.path) seen.add(p.join());
    assert.equal(seen.size, new Set(r.points.map((p) => p.join())).size);
    for (const s of r.stretches) assert.ok(!DASHES.test(s.what + s.todo + KIND_LABEL[s.kind]));
  });
});
