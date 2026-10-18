/** the coach's API in one place */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as coach from '../src/drive/coach/index.ts';

test('every part of the coach is exported from index.ts', () => {
  for (const name of ['LiveCoach', 'cuesFor', 'speak', 'tone', 'playCue', 'setMuted', 'isMuted', 'unlockAudio', 'stopSpotsFrom', 'replayDrive', 'routesFrom', 'leaksFrom', 'monthText']) {
    assert.equal(typeof (coach as Record<string, unknown>)[name], 'function', name);
  }
  assert.equal(coach.LIVE.quietMs, 20_000);
});
