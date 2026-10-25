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
import { creekBannerHTML, EASY_OFF_M, EASY_ON_M, easyLatch, FLICK, HOLD_MS, sheetOpen, sheetShows, sheetSnap, SteadyCreek, TAP_PX, type Snap } from '../src/app/screens/drive-live.ts';
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

  test('a bend before the creek: its road runs straight at the car, so the chip finds it 12 degrees off; 45 off it does not', () => {
    const car = toRegion(P.toLngLat([0, 0]));
    const t = tileWith([{ at: [0, 300], dir: 0, name: 'Clover Creek' }]);
    assert.equal(new SalmonWatch().next(src(t), car, 12)?.c.stream.name, 'Clover Creek');
    assert.equal(new SalmonWatch().next(src(t), car, 45), null);
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

describe('live sheet: a glance from the dash', () => {
  test('a quick tap on the handle flips the sheet; a resting thumb leaves it', () => {
    assert.equal(sheetSnap('slim', 2, 0, 200, 120), 'full');
    assert.equal(sheetSnap('full', -3, 0, 200, 200), 'slim');
    assert.equal(sheetSnap('slim', 2, 0, 200, HOLD_MS), 'slim');
    assert.equal(sheetSnap('full', 0, 0, 200, HOLD_MS + 400), 'full');
    // a real drag still settles by distance, however long it took
    assert.equal(sheetSnap('slim', -150, 0, 200, 2000), 'full');
  });

  test('the brake line comes up close to the creek and holds until well past the line', () => {
    assert.equal(easyLatch(false, EASY_ON_M + 1), false);
    assert.equal(easyLatch(false, EASY_ON_M), true);
    // a distance wobbling around the line doesn't flicker it
    let on = easyLatch(false, 150);
    for (const m of [153, 151, 155, 160, 152]) on = easyLatch(on, m);
    assert.equal(on, true);
    assert.equal(easyLatch(true, EASY_OFF_M + 1), false);
  });

  test('the creek banner names the creek once for screen readers; the distance and brake line are for the eyes', () => {
    const far = creekBannerHTML('Fennel <Creek>', '0.3 mi', false), near = creekBannerHTML('Fennel Creek', '500 ft', true);
    const has = (html: string, part: string) => assert.ok(html.includes(part), `${part} in ${html}`);
    has(far, 'Fennel &#60;Creek&#62;');
    has(far, '<span class="sr"> ahead.</span>');
    has(far, 'class="dv-dist" aria-hidden="true">0.3 mi<');
    has(far, 'class="dv-ahead-do" aria-hidden="true" hidden>');
    has(near, 'class="dv-ahead-do" aria-hidden="true">Easy on the brakes.');
    has(near, 'data-tone="salmon"');
  });

  const fennel = (m: number) => ({ name: 'Fennel Creek', m });
  test('parked GPS jitter never puts a creek in the banner', () => {
    const s = new SteadyCreek();
    // a jitter heading lights the creek for one fix now and then, at 0 mph
    for (let k = 0; k < 60; k++) assert.equal(s.update(k % 25 === 4 || k % 25 === 5 ? fennel(480) : null, false), null);
  });

  test('a creek needs two fixes in a row while moving, then counts down, and goes after two fixes without it', () => {
    const s = new SteadyCreek();
    assert.equal(s.update(fennel(440), true), null);
    assert.deepEqual(s.update(fennel(420), true), fennel(420));
    // parked at a light: the shown creek stays and updates
    assert.deepEqual(s.update(fennel(400), false), fennel(400));
    // one missed fix doesn't blink it out; two do
    assert.deepEqual(s.update(null, true), fennel(400));
    assert.deepEqual(s.update(fennel(380), true), fennel(380));
    assert.deepEqual(s.update(null, true), fennel(380));
    assert.equal(s.update(null, true), null);
    // a one-fix blip of another creek doesn't show
    assert.equal(s.update({ name: 'Canyonfalls Creek', m: 300 }, true), null);
    assert.equal(s.update(null, true), null);
  });
});
