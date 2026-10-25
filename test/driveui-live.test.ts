// The live drive screen: the sheet's snap, End drive and Voice always there, the banner holding a spoken line, the creek chip.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LiveCoach } from '../src/drive/coach/live.ts';
import type { Spot } from '../src/drive/spots.ts';
import type { XY } from '../src/geo/geo.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { COHO } from '../src/salmon/species.ts';
import { readTile, type RawTile, type Tile } from '../src/salmon/tiles.ts';
import { SALMON, SalmonWatch } from '../src/salmon/watch.ts';
import { CLEAR_M, crossState, cueView, holdMs, NEAR_M, roadDist, roadLine, SPOKEN_MS } from '../src/app/screens/drive-coach.ts';
import { FLICK, sheetOpen, sheetShows, sheetSnap, TAP_PX, type Snap } from '../src/app/screens/drive-live.ts';
import { drive, MPH, P } from './engine-helpers.ts';

/** crossings at local meters [x, y] (y north) on roads running dir degrees from north */
function tileWith(list: { at: XY; dir: number; name: string }[]): Tile {
  const raw: RawTile = { v: 1, s: [], l: [], c: [], b: [] };
  for (const c of list) {
    const r = toRegion(P.toLngLat(c.at));
    let si = raw.s.findIndex((s) => s[0] === c.name);
    if (si < 0) si = raw.s.push([c.name, COHO, 3]) - 1;
    raw.c.push([Math.round(r[0]), Math.round(r[1]), si, c.dir, COHO]);
    raw.l.push([si, Math.round(r[0]) - 300, Math.round(r[1]), 600, 0]);
  }
  return readTile('0_0', raw)!;
}
const src = (t: Tile) => ({ near: () => [t] });

describe('live sheet: drag and snap', () => {
  const R = 200;
  test('a tap on the handle flips it', () => {
    assert.equal(sheetSnap('slim', 0, 0, R), 'full');
    assert.equal(sheetSnap('full', 2, 0, R), 'slim');
    assert.equal(sheetSnap('full', -(TAP_PX - 1), 0, R), 'slim');
  });

  test('a flick goes its way, however short', () => {
    assert.equal(sheetSnap('full', 20, FLICK + 0.1, R), 'slim');
    assert.equal(sheetSnap('slim', -20, -(FLICK + 0.1), R), 'full');
    // a flick against a long drag still wins
    assert.equal(sheetSnap('slim', -150, FLICK * 2, R), 'slim');
  });

  test('a slow drag settles at the nearer end', () => {
    assert.equal(sheetSnap('full', 90, 0.1, R), 'full');
    assert.equal(sheetSnap('full', 110, 0.1, R), 'slim');
    assert.equal(sheetSnap('slim', -90, -0.1, R), 'slim');
    assert.equal(sheetSnap('slim', -110, -0.1, R), 'full');
    // dragged past either end
    assert.equal(sheetSnap('full', -400, 0, R), 'full');
    assert.equal(sheetSnap('slim', 400, 0, R), 'slim');
  });

  test('how open it is follows the finger and stops at the ends', () => {
    assert.equal(sheetOpen('full', 0, R), 1);
    assert.equal(sheetOpen('full', 50, R), 0.75);
    assert.equal(sheetOpen('slim', -50, R), 0.25);
    assert.equal(sheetOpen('slim', 80, R), 0);
    assert.equal(sheetOpen('full', -80, R), 1);
    // nothing to open yet
    assert.equal(sheetOpen('full', 30, 0), 1);
    assert.equal(sheetOpen('slim', -30, 0), 0);
  });
});

describe('live sheet: what shows', () => {
  test('End drive and Voice show moving or parked, slim or open', () => {
    for (const snap of ['slim', 'full'] as Snap[]) for (const moving of [true, false]) for (const ask of [true, false]) {
      const w = sheetShows({ snap, moving, ask });
      assert.equal(w.end, true, `${snap} moving=${moving} ask=${ask}`);
      assert.equal(w.voice, true, `${snap} moving=${moving} ask=${ask}`);
    }
  });

  test('open shows the big tiles; slim shows the short numbers; the voice ask only parked', () => {
    assert.deepEqual(sheetShows({ snap: 'full', moving: true, ask: false }), { end: true, voice: true, tiles: true, inline: false, ask: false });
    assert.deepEqual(sheetShows({ snap: 'slim', moving: false, ask: true }), { end: true, voice: true, tiles: false, inline: true, ask: true });
    assert.equal(sheetShows({ snap: 'slim', moving: true, ask: true }).ask, false);
  });
});

describe('live banner', () => {
  test('a spoken line holds the banner at least 6 s; a silent one keeps its own time', () => {
    assert.equal(SPOKEN_MS, 6000);
    const hb = cueView({ kind: 'hard-brake', say: 'Hard brake.' });
    assert.equal(holdMs(hb.ms, true), 6000);
    assert.equal(holdMs(hb.ms, false), hb.ms);
    for (const kind of ['spot-ahead', 'coast', 'speeding', 'hard-brake', 'fast-start', 'salmon-ahead'] as const) {
      assert.ok(holdMs(cueView({ kind, say: 'Clover Creek ahead. Coho stream.' }).ms, true) >= 6000, kind);
    }
  });

  test('without a cue: a hard-brake spot, then a salmon creek close, else the status; a creek further off is only the chip', () => {
    const status = 'Recording. Drive as usual.';
    assert.deepEqual(roadLine({ status }), { text: status, tone: 'plain' });
    assert.deepEqual(roadLine({ fish: { m: 140 }, status }), { text: 'Easy on the brakes.', tone: 'salmon' });
    assert.deepEqual(roadLine({ fish: { m: 400 }, status }), { text: status, tone: 'plain' });
    assert.equal(roadLine({ fish: { m: 140 }, spot: { m: 200 }, status }).text, 'Your hard-brake spot. Ease off early.');
    assert.equal(roadLine({ spot: { m: 900 }, status }).text, status);
  });

  test('the chip reads short distances', () => {
    assert.equal(roadDist(644), '0.4 mi');
    assert.equal(roadDist(NEAR_M), '500 ft');
    assert.equal(roadDist(30), '100 ft');
  });
});

describe('the creek chip: only what the coach sees ahead', () => {
  test('a creek on this road shows from the voice look-ahead in, comes closer, and goes once driven over', () => {
    const t = tileWith([{ at: [0, 0], dir: 0, name: 'Clover Creek' }]), coach = new LiveCoach({ salmon: src(t) });
    const seen: number[] = [];
    let named = -1;
    for (const f of drive(35 * MPH, [[90, 0]], { heading: 0, start: [0, -1200] })) {
      const cue = coach.update(f);
      const r = coach.road();
      if (cue?.kind === 'salmon-ahead') named = seen.length;
      if (r.fish) { assert.equal(r.fish.c.stream.name, 'Clover Creek'); seen.push(r.fish.m); }
    }
    assert.ok(seen.length > 10, `seen ${seen.length}`);
    assert.ok(seen[0] <= SALMON.lookM && seen.at(-1)! < 60, `${seen[0]} ${seen.at(-1)}`);
    for (let k = 1; k < seen.length; k++) assert.ok(seen[k] <= seen[k - 1] + 1);
    // the voice named it while the chip was up
    assert.ok(named > 0, 'named while the chip showed');
    assert.equal(coach.salmon.passed.length, 1);
    assert.equal(coach.road().fish, null);
  });

  test('no chip for a creek under a cross street, behind, or past the look-ahead', () => {
    const w = new SalmonWatch(), car = toRegion(P.toLngLat([0, 0]));
    const t = tileWith([{ at: [0, SALMON.lookM + 150], dir: 0, name: 'Far Creek' }, { at: [0, 300], dir: 90, name: 'Cross Creek' }, { at: [0, -200], dir: 0, name: 'Back Creek' }]);
    assert.equal(w.next(src(t), car, 0), null);
  });

  test('a creek well off to the side is not ahead, even when the heading points near it', () => {
    const w = new SalmonWatch(), car = toRegion(P.toLngLat([0, 0]));
    const t = tileWith([{ at: [0, 300], dir: 0, name: 'Clover Creek' }]);
    assert.equal(w.next(src(t), car, 0)?.c.stream.name, 'Clover Creek');
    // turned off onto a cross street: gone at once, no loose cone keeps it
    assert.equal(w.next(src(t), car, 90), null);
  });

  test('stopped at a light (no heading), the chip keeps its creek', () => {
    const w = new SalmonWatch(), car = toRegion(P.toLngLat([0, 0]));
    const t = tileWith([{ at: [0, 300], dir: 0, name: 'Clover Creek' }]);
    assert.equal(w.next(src(t), car, 0)?.c.stream.name, 'Clover Creek');
    const held = w.next(src(t), car, null);
    assert.equal(held?.c.stream.name, 'Clover Creek');
    assert.ok(Math.abs(held!.m - 300) < 5);
  });

  test('a learned spot ahead on this road shows within 400 m', () => {
    const spot = (y: number, heading: number | null = 0): Spot => ({ id: `s${y}`, lngLat: P.toLngLat([0, y]), heading, count: 3, drives: 2, veryHard: 0, last: 0 } as unknown as Spot);
    const coach = new LiveCoach({ spots: [spot(900), spot(380), spot(200, 180)] });
    for (const f of drive(30 * MPH, [[3, 0]], { heading: 0, start: [0, -40] })) coach.update(f);
    const r = coach.road();
    assert.equal(r.spot?.spot.id, 's380');
    assert.ok(r.spot!.m > 350 && r.spot!.m < 400);
  });

  test('a creek reads gentle only once the car is well past it with no hard brake', () => {
    const at: [number, number] = [0, 0];
    assert.equal(crossState(at, [], [20, 0]), 'wait');
    assert.equal(crossState(at, [], [CLEAR_M + 1, 0]), 'gentle');
    assert.equal(crossState(at, [[100, 0]], [CLEAR_M + 1, 0]), 'hard');
    assert.equal(crossState(at, [[400, 0]], [CLEAR_M + 1, 0]), 'gentle');
  });
});
