/** Home's picture key: the creek by default, the night drive once picked, kept on this device */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keepScene, nextScene, savedScene, SCENE_KEY } from '../src/app/screens/home-scene.ts';

const store = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const blocked = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('home picture', () => {
  test('the creek first, and for anything unknown', () => {
    assert.equal(savedScene(store()), 'creek');
    assert.equal(savedScene(store({ [SCENE_KEY]: 'beach' })), 'creek');
    assert.equal(savedScene(null), 'creek');
  });
  test('a tap swaps them, and two taps come back', () => {
    assert.equal(nextScene('creek'), 'night');
    assert.equal(nextScene(nextScene('creek')), 'creek');
  });
  test('the pick is kept under tt-scene', () => {
    const s = store();
    keepScene(nextScene(savedScene(s)), s);
    assert.equal(s.m.get('tt-scene'), 'night');
    assert.equal(savedScene(s), 'night');
    keepScene(nextScene(savedScene(s)), s);
    assert.equal(savedScene(s), 'creek');
  });
  test('blocked storage shows the creek and never throws', () => {
    assert.equal(savedScene(blocked), 'creek');
    assert.doesNotThrow(() => keepScene('night', blocked));
  });
});
