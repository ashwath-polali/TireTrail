/** Your drives on a street ("Your drives pass here 3 times"), the pixel strip's blocks, and street search words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { XY } from '../src/geo/geo.ts';
import { blocks, densify, driven, mineText, touching } from '../src/app/screens/common.ts';
import { norm, shorten } from '../src/app/screens/streets.ts';

describe('your drives on a street', () => {
  const street: XY[][] = [[[0, 0], [100, 0]], [[100, 0], [100, 80]]];

  test('a drive counts once when any of its points comes close to any stretch', () => {
    const near: XY[] = [[-50, 30], [10, 12], [40, 9], [90, 2]];
    const beside: XY[] = [[0, 40], [50, 40], [130, 50]];
    const across: XY[] = [[300, 300], [120, 40], [60, 200]];
    const far: XY[] = [[400, 400]];
    assert.equal(touching(street, [near, beside, across, far], 25), 2);
    assert.equal(touching(street, [beside], 45), 1);
    assert.equal(touching(street, [], 25), 0);
    assert.equal(touching(street, [[]], 25), 0);
  });

  test('a drive passes a street when it drives along it, not when it only crosses it', () => {
    const road: XY[][] = [[[0, 0], [100, 0]]];
    const along = densify([[-50, 5], [150, 5]], 10);
    const across = densify([[50, -100], [50, 100]], 10);
    const beside = densify([[-50, 35], [150, 35]], 10);
    assert.equal(driven(road, [along, across, beside]), 1);
    // a short street needs most of its own length
    assert.equal(driven([[[0, 0], [30, 0]]], [densify([[-20, 3], [60, 3]], 10)]), 1);
    assert.deepEqual(densify([[0, 0], [25, 0]], 10).map((p) => Math.round(p[0])), [0, 8, 17, 25]);
  });

  test('the words: hard brakes first, then how often you pass', () => {
    assert.equal(mineText({ passes: 0, hard: 0 }), null);
    assert.deepEqual(mineText({ passes: 3, hard: 0 }), { text: 'Your drives pass here 3 times.', tone: 'you', icon: 'route' });
    assert.equal(mineText({ passes: 1, hard: 0 })!.text, 'One of your drives passes here.');
    assert.deepEqual(mineText({ passes: 3, hard: 2 }), { text: 'You braked hard here on 2 drives.', tone: 'warn', icon: 'warn' });
    assert.equal(mineText({ passes: 0, hard: 1 })!.text, 'You braked hard here on 1 drive.');
  });
});

describe('the pixel strip of a whole street', () => {
  test('blocks split by length, every part gets one, and they add up', () => {
    assert.deepEqual(blocks([3, 1], 20), [15, 5]);
    assert.deepEqual(blocks([1000, 1, 1], 20), [18, 1, 1]);
    for (const v of [[5, 4, 3, 2, 1], [1, 1], [7], [0.2, 900, 33]]) {
      const b = blocks(v, 20);
      assert.equal(b.reduce((s, x) => s + x, 0), 20, String(v));
      assert.ok(b.every((x) => x >= 1));
    }
  });
});

describe('street search words', () => {
  test('words people type out in full match the short street names', () => {
    assert.equal(norm('214th Avenue East'), '214 ave e');
    assert.equal(norm('214th Ave E'), '214 ave e');
    assert.equal(norm('S. Prairie Road'), 's prairie rd');
    assert.equal(norm('Sumner Buckley Highway East'), 'sumner buckley hwy e');
    assert.equal(norm('  1st  street  '), '1 st');
    // the county's name list is searched as the data writes names
    assert.equal(shorten('214th Avenue East'), '214th ave e');
    assert.equal(shorten('Canyon Road E.'), 'canyon rd e');
  });
});
