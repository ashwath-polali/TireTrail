/** the creek strip's fish places, and the sprite sheets it draws from */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CODE_COHO, COHO, fishRoom, fishSlot, SPARKLE, WATER } from '../src/app/screens/pixel-anim.ts';

/** a PNG's width and height from its header */
const size = (p: string) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

describe('creek strip', () => {
  test('fish spread across the strip, inside it, in lanes between top and bottom', () => {
    const xs = [0, 1, 2, 3].map((i) => fishSlot(i, 4, 300, 0, 10, 64));
    for (const s of xs) assert.ok(s.x >= -8 && s.x <= 300 - 64 + 8, String(s.x));
    assert.deepEqual(xs.map((s) => s.x), [6, 81, 156, 231]);
    assert.deepEqual(xs.map((s) => s.y), [0, 10, 5, 0]);
    assert.ok(xs.every((s, i) => i === 0 || s.x > xs[i - 1].x));
    // a short strip has two lanes
    assert.deepEqual([0, 1, 2].map((i) => fishSlot(i, 3, 200, 2, 6).y), [2, 6, 2]);
  });
  test('only as many fish as fit side by side, at least one', () => {
    assert.equal(fishRoom(195), 3);
    assert.equal(fishRoom(20), 1);
  });
  test('each sheet matches its frames, so a sheet can swap for the code version', () => {
    for (const [file, s] of [['salmon-swim', COHO], ['creek-strip', WATER], ['sparkle', SPARKLE]] as const) assert.deepEqual(size(`public/art/anim/${file}.png`), [s.w * s.n, s.h], file);
    assert.deepEqual([CODE_COHO.w, CODE_COHO.h, CODE_COHO.n], [16, 7, 4]);
  });
});
