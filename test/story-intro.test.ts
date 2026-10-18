/** The opening zoom: four shots, their words and timing, and reduced motion */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CALM_HOLD, calmScript, script } from '../src/app/screens/intro.ts';

const strip = (html: string) => html.replace(/<[^>]+>/g, '');

describe('opening zoom', () => {
  test('the four captions, word for word', () => {
    assert.deepEqual(script('Tap').map((s) => strip(s.say)), [
      'Coho salmon swim up West Coast streams to spawn.',
      'After a rain, many Puget Sound coho die. A chemical from tire dust is the cause.',
      'TireTrail follows that rain through real storm pipes. The yellow areas are traced so far.',
      'This is Bonney Lake. Tap any street to see where its rain goes.',
    ]);
    assert.equal(strip(script('Click')[3].say), 'This is Bonney Lake. Click any street to see where its rain goes.');
  });

  test('holds and flights as planned, about 12 s in all', () => {
    const s = script('Tap');
    assert.deepEqual(s.map((x) => [x.fly, x.hold]), [[0, 2300], [1500, 2700], [1400, 2700], [1700, 0]]);
    const total = s.reduce((n, x) => n + x.fly + x.hold, 0);
    assert.ok(total <= 12500, `${total} ms`);
  });

  test('reduced motion: the opening view at once; watching again, still cuts', () => {
    const first = calmScript(script('Tap'), false);
    assert.equal(first.length, 1);
    assert.equal(strip(first[0].say), 'This is Bonney Lake. Tap any street to see where its rain goes.');
    assert.deepEqual([first[0].fly, first[0].hold], [0, CALM_HOLD]);
    const again = calmScript(script('Tap'), true);
    assert.equal(again.length, 4);
    assert.ok(again.every((x) => x.fly === 0));
    assert.equal(again[3].hold, CALM_HOLD);
  });

  test('no em or en dashes in what the story and the opening say', () => {
    for (const f of ['src/app/screens/intro.ts', 'src/app/screens/player.ts', 'src/app/map/story.ts']) {
      assert.ok(!/[–—]/.test(readFileSync(f, 'utf8')), f);
    }
  });
});
