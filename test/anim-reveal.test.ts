/** the end-of-drive reveal: its timing, the creek scene's layout, the pixel art, the gas line and the words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { creekLayout } from '../src/app/anim/creek.ts';
import { revealPlan } from '../src/app/anim/plan.ts';
import { frameAt, rowsSize } from '../src/app/anim/px.ts';
import { COHO, coinRows, PUFF, SPARKLE, SPRITES, tireRows } from '../src/app/anim/sprites.ts';
import { creekFish, creekWords, crossedWord, dustScale } from '../src/app/screens/drive-words.ts';


describe('revealPlan', () => {
  test('salmon first, then dust, gas, the fix, all in 3 s or less', () => {
    for (const fish of [0, 1, 2, 3, 4, 7]) for (const gas of [true, false]) {
      const p = revealPlan(fish, gas);
      assert.ok(p.end <= 3000, `end ${p.end}`);
      assert.ok(p.fish.length >= 1 && p.fish.length <= 4);
      for (const f of p.fish) assert.ok(f.from < f.at && f.from < p.dust);
      assert.ok(p.dust < p.tick[0] && p.tick[0] < p.tick[1] && p.strip > p.dust);
      if (gas) assert.ok(p.gas && p.gas.in > p.dust && p.gas.tick[1] < p.fix && p.gas.coins.every((c) => c >= p.gas!.in));
      else assert.equal(p.gas, null);
      assert.ok(p.fix < p.rest && p.rest < p.end);
    }
  });
});

describe('creekLayout', () => {
  const fish = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Creek ${i}`, gentle: i % 2 === 0, hard: i % 2 === 1 }));
  test('one fish per stream, up to 4, inside the water, names alternating banks', () => {
    const times = revealPlan(6, false).fish;
    const { spots, more } = creekLayout(120, fish(6), times);
    assert.equal(spots.length, 4);
    assert.equal(more, 2);
    for (const s of spots) assert.ok(s.x >= -2 && s.x + 16 <= 122 && s.y >= 6 && s.y + 7 <= 28);
    assert.deepEqual(spots.map((s) => s.top), [true, false, true, false]);
    assert.ok(spots.every((s, i) => i === 0 || s.x > spots[i - 1].x));
    assert.equal(spots[1].at, times[1].at);
  });
  test('one fish sits in the middle', () => {
    const { spots } = creekLayout(120, fish(1), revealPlan(1, false).fish);
    assert.equal(spots[0].x + 8, 60);
  });
});

describe('pixel art', () => {
  test('frames in a set are all one size', () => {
    for (const set of [COHO, SPARKLE, PUFF]) {
      const [w, h] = rowsSize(set[0]);
      for (const f of set) assert.deepEqual(rowsSize(f), [w, h]);
    }
    for (const k of [0, 0.25, 0.5]) assert.deepEqual(rowsSize(tireRows(14, k)), [14, 14]);
    for (const half of [4, 3, 1]) assert.deepEqual(rowsSize(coinRows(half)), [8, 8]);
    // a tire that turns looks different, and stays round
    assert.notDeepEqual(tireRows(14, 0), tireRows(14, 0.5));
    assert.equal(tireRows(14, 0)[0][0], '.');
  });
  test('sheets match their PixelLab sizes', () => {
    assert.deepEqual([SPRITES.coho.w, SPRITES.coho.h, SPRITES.coho.n, SPRITES.coho.hi], [64, 32, 8, true]);
    assert.deepEqual([SPRITES.pump.w, SPRITES.pump.h], [48, 64]);
    assert.equal(frameAt({ n: 4, fps: 12 }, 1000), 0);
    assert.equal(frameAt({ n: 4, fps: 12 }, 84), 1);
  });
});

describe('creek words', () => {
  test('a count of streams, how gently', () => {
    assert.deepEqual(creekWords({ crossed: 1, gentle: 1, streams: 1 }), { n: '1', k: 'salmon stream crossed', sub: 'No hard brake nearby', tone: 'money' });
    assert.deepEqual(creekWords({ crossed: 3, gentle: 0, streams: 2 }), { n: '2', k: 'salmon streams crossed', sub: 'Hard brakes nearby', tone: 'warn' });
    assert.equal(creekWords({ crossed: 3, gentle: 2, streams: 3 }).sub, '2 of 3 crossings gentle');
    for (const w of [creekWords({ crossed: 2, gentle: 1, streams: 2 })]) assert.ok(!/[–—]/.test(JSON.stringify(w)));
  });
  test('one coho per stream; hard when a hard brake was near', () => {
    const t = { crossed: 2, gentle: 1, streams: [{ name: 'Clover Creek', at: [-122.43, 47.13] as const }, { name: '', at: [-122.2, 47.2] as const }] };
    assert.deepEqual(creekFish(t, [[-122.4301, 47.1301]], null), [{ name: 'Clover Creek', gentle: false, hard: true }, { name: '', gentle: true, hard: false }]);
    assert.ok(creekFish({ ...t, gentle: 2 }, [[-122.4301, 47.1301]], null).every((f) => f.gentle));
    assert.deepEqual(creekFish(null, [], 'Fennel Creek'), [{ name: 'Fennel Creek', gentle: false, hard: true }]);
    assert.deepEqual(creekFish({ ...t, crossed: 0, gentle: 0 }, [], null), [{ name: '', gentle: false, hard: false }]);
  });
  test('the live screens', () => {
    assert.equal(crossedWord(1), 'salmon stream crossed');
    assert.equal(crossedWord(0), 'salmon streams crossed');
    assert.deepEqual([0, 0.2, 0.5, 0.9, 1.4, 7, 140].map(dustScale), [0.5, 0.5, 1, 1, 2, 10, 200]);
  });
});
