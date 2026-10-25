/** The live drive's state: End drive sticks, parked GPS jitter draws nothing and names no creek, the drain reminder waits, the banner holds, and the map comes back to the car. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { AutoHold, DRAIN_AFTER_M, DRAIN_AFTER_MS, drainReady, HOLD_GAP_MS, HOLD_PARK_MS, onTrail, REGAIN_MS } from '../src/app/screens/drive-state.ts';
import { NEAR_M, NEAR_OFF_M, roadLine } from '../src/app/screens/drive-coach.ts';
import { headingOf, LiveCoach, TRAIL_ACC_M } from '../src/drive/coach/live.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { CameraCtl } from '../src/app/map/camera.ts';
import type { Cam, Renderer } from '../src/app/map/render.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles } from '../src/salmon/row.ts';
import { SalmonData } from '../src/salmon/tiles.ts';

describe('End drive by hand sticks', () => {
  const go = (h: AutoHold, t0: number, secs: number, v: number, at: XY = [0, 0], dx = 0): number => {
    let t = t0, held = true;
    for (let k = 0; k < secs; k++) { t += 1000; held = h.fix([at[0] + dx * k, at[1]], v, t) && held; }
    return t;
  };

  test('ended at 25 mph and still driving: Start by itself stays off', () => {
    const h = new AutoHold();
    h.ended(0, 1000);
    let t = 1000;
    for (let k = 0; k < 600; k++) { t += 1000; assert.equal(h.fix([k * 11, 0], 11, t), true, `fix ${k}`); }
    // stopping at a red light for 40 s is not parking
    t = go(h, t, 40, 0, [6600, 0]);
    assert.equal(h.held, true);
    t = go(h, t, 30, 11, [6600, 0], 11);
    assert.equal(h.held, true);
  });

  test('parked a full minute: Start by itself is back', () => {
    const h = new AutoHold();
    h.ended(0, 1000);
    let t = go(h, 1000, 30, 12, [0, 0], 12);
    t = go(h, t, 59, 0.3, [400, 0]);
    assert.equal(h.held, true);
    t = go(h, t, 2, 0.3, [400, 0]);
    assert.equal(h.held, false);
    assert.equal(h.fix([400, 0], 12, t + 1000), false);
  });

  test('creeping away from the spot starts the minute over', () => {
    const h = new AutoHold();
    h.ended(0, 0);
    let t = go(h, 0, 50, 0.5, [0, 0]);
    t = go(h, t, 1, 1.5, [100, 0]);
    t = go(h, t, 50, 0.5, [100, 0]);
    assert.equal(h.held, true);
    go(h, t, 15, 0.5, [100, 0]);
    assert.equal(h.held, false);
  });

  test('a quiet GPS never parks the car', () => {
    const h = new AutoHold();
    h.ended(0, 0);
    // one fix every 30 s counts 5 s each
    let t = 0;
    for (let k = 0; k < 6; k++) h.fix([0, 0], 0, (t += 30_000));
    assert.equal(h.held, true);
  });

  test('already parked a minute when End was tapped, or a new app open: no hold', () => {
    const h = new AutoHold();
    h.ended(HOLD_PARK_MS, 0);
    assert.equal(h.fix([0, 0], 12, 1000), false);
    assert.equal(new AutoHold().fix([0, 0], 12, 1000), false);
  });

  test('the app away for 10 minutes counts as the next open', () => {
    const h = new AutoHold();
    h.ended(0, 0);
    assert.equal(h.fix([0, 0], 12, 1000), true);
    assert.equal(h.fix([0, 0], 12, 1000 + HOLD_GAP_MS + 1), false);
  });
});

describe('parked GPS jitter', () => {
  test('a parked fix inside its accuracy is not drawn; moving or past the accuracy it is', () => {
    assert.equal(onTrail(undefined, [0, 0], 0, 30), true);
    assert.equal(onTrail([0, 0], [20, 10], 0, 30), false);
    assert.equal(onTrail([0, 0], [20, 10], 0.5, null), true);
    assert.equal(onTrail([0, 0], [3, 0], 0.5, null), false);
    assert.equal(onTrail([0, 0], [31, 20], 0, 30), false);
    assert.equal(onTrail([0, 0], [61, 0], 0, 30), true);
    assert.equal(onTrail([0, 0], [8, 0], 11, 30), true);
  });

  test('no heading from the trail when parked or from a rough fix; the phone heading needs speed', () => {
    const trail = [{ xy: [0, 0] as XY }, { xy: [0, -30] as XY }];
    const fix = (o: Partial<Fix>): Fix => ({ t: 0, lat: 0, lon: 0, speed: null, heading: null, accuracy: 5, ...o });
    assert.equal(headingOf(fix({}), trail, 0), null);
    assert.equal(headingOf(fix({}), trail, 1.9), null);
    assert.equal(headingOf(fix({ accuracy: TRAIL_ACC_M + 5 }), trail, 11), null);
    assert.equal(headingOf(fix({ heading: 90 }), trail, 1), null);
    assert.equal(headingOf(fix({ heading: 90, accuracy: 40 }), trail, 11), 90);
    assert.notEqual(headingOf(fix({}), trail, 11), null);
  });

  // Sunday's route: a house about 200 m off McCutcheon Rd E (0.3 mi from Fennel Creek), and the road 140 m before the crossing
  const FX = JSON.parse(readFileSync(new URL('./fixtures/sunday-route.json', import.meta.url), 'utf8')) as { fixes: [number, number, number, number, number | null][] };
  const T0 = Date.UTC(2026, 9, 25, 19);
  const salmon = () => new SalmonData(new URL('../public/data/salmon/', import.meta.url).href, async (u) => JSON.parse(readFileSync(new URL(u), 'utf8')));
  const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const M_LAT = 111_320, M_LON = 111_320 * Math.cos((47.15 * Math.PI) / 180);

  /** 90 s parked at lat/lon with jitter j m: the creek chip at each fix */
  async function parked(lat: number, lon: number, j: number, acc: number, speed: number | null): Promise<string[]> {
    const r = rand(7), fixes: Fix[] = [];
    for (let k = 0; k < 90; k++) {
      const a = r() * 2 * Math.PI, d = r() * j;
      fixes.push({ t: T0 + k * 1000, lat: lat + (Math.cos(a) * d) / M_LAT, lon: lon + (Math.sin(a) * d) / M_LON, speed, heading: null, accuracy: acc });
    }
    const data = salmon();
    await data.some(routeTiles(fixes.map((f) => toRegion([f.lon, f.lat]))));
    const coach = new LiveCoach({ salmon: data }), chips: string[] = [];
    for (const f of fixes) {
      assert.equal(coach.update(f, f.t), null);
      const fish = coach.road().fish;
      if (fish) chips.push(`${(f.t - T0) / 1000}s ${fish.c.stream.name} ${Math.round(fish.m)} m`);
    }
    return chips;
  }

  test('parked at the house near Fennel Creek, indoor GPS: the creek chip never lights', async () => {
    const [, lat, lon] = FX.fixes[364];
    assert.deepEqual(await parked(lat + 0.0009, lon + 0.0024, 25, 30, 0), []);
    assert.deepEqual(await parked(lat + 0.0009, lon + 0.0024, 25, 30, null), []);
  });

  test('parked on the road 140 m before the crossing: the chip never lights', async () => {
    // the fix about 140 m before the Fennel Creek crossing at fix 386
    const [, cl, co] = FX.fixes[386];
    let k = 386;
    while (k > 300 && Math.hypot((FX.fixes[k][1] - cl) * M_LAT, (FX.fixes[k][2] - co) * M_LON) < 140) k--;
    const [, lat, lon] = FX.fixes[k];
    assert.deepEqual(await parked(lat, lon, 15, 15, 0), []);
    assert.deepEqual(await parked(lat, lon, 15, 30, null), []);
    assert.deepEqual(await parked(lat, lon, 8, 10, null), []);
  });
});

describe('the drain reminder waits for the drive to get going', () => {
  test('not in the first minute, not in the first 0.3 mi', () => {
    assert.equal(drainReady(2000, 30), false);
    assert.equal(drainReady(DRAIN_AFTER_MS - 1, 5000), false);
    assert.equal(drainReady(5 * 60_000, DRAIN_AFTER_M - 1), false);
    assert.equal(drainReady(DRAIN_AFTER_MS, DRAIN_AFTER_M), true);
    assert.ok(DRAIN_AFTER_M >= 0.3 * 1609.344 - 1);
  });
});

describe('"Easy on the brakes." holds', () => {
  test('on at 500 ft, off only past about 600 ft, so a distance near 500 ft never flickers', () => {
    const shown: string[] = [];
    let held = false;
    for (const m of [200, 160, 152, 155, 151, 158, 170, 150, 184, 186, 160, 152]) {
      const l = roadLine({ fish: { m }, status: 'Recording. Drive as usual.' }, held);
      held = l.tone === 'salmon';
      shown.push(held ? 'E' : '-');
    }
    assert.equal(shown.join(''), '--EEEEEEE--E');
    assert.ok(NEAR_OFF_M > NEAR_M + 25);
  });

  test('a learned spot still comes first, and no creek means the status', () => {
    assert.equal(roadLine({ fish: { m: 100 }, spot: { m: 100 }, status: 's' }, true).tone, 'warn');
    assert.deepEqual(roadLine({ fish: null, status: 's' }, true), { text: 's', tone: 'plain' });
  });
});

describe('the map comes back to the car', () => {
  let now = 0;
  mock.method(performance, 'now', () => now);
  function rig() {
    const on = new Map<string, (e: unknown) => void>();
    const el = { addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f), setPointerCapture: () => {} } as unknown as HTMLElement;
    const canvas = { offsetWidth: 300, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 600 }) };
    const r = { AW: 100, AH: 200, canvas, toWorld: (c: Cam, x: number, y: number): XY => [c.x + (x / 3 - 50) * c.mpp, c.y + (y / 3 - 100) * c.mpp] } as unknown as Renderer;
    const cam = new CameraCtl(el, r, { x: 0, y: 0, mpp: 2 }, () => {}, () => now);
    cam.instant = true;
    const ev = (type: string, x: number, y: number) => on.get(type)!({ type, clientX: x, clientY: y, pointerType: 'touch', pointerId: 1, preventDefault() {} });
    return { cam, ev };
  }

  test('a drag hands the camera back 6 s after the finger lifts', () => {
    const { cam, ev } = rig();
    now = 1000;
    assert.equal(cam.regain(REGAIN_MS), false);
    ev('pointerdown', 100, 100);
    now = 1100;
    ev('pointermove', 160, 100);
    ev('pointerup', 160, 100);
    assert.equal(cam.userMoved, true);
    now = 1100 + REGAIN_MS - 1;
    assert.equal(cam.regain(REGAIN_MS), false);
    now = 1100 + REGAIN_MS;
    assert.equal(cam.regain(REGAIN_MS), true);
    assert.equal(cam.userMoved, false);
  });

  test('a finger still on the map keeps it, and each touch starts the 6 s over', () => {
    const { cam, ev } = rig();
    now = 0;
    ev('pointerdown', 100, 100);
    now = 100;
    ev('pointermove', 160, 100);
    now = 100 + REGAIN_MS + 1000;
    assert.equal(cam.regain(REGAIN_MS), false);
    ev('pointermove', 170, 100);
    ev('pointerup', 170, 100);
    now += REGAIN_MS - 1;
    assert.equal(cam.regain(REGAIN_MS), false);
    now += 1;
    assert.equal(cam.regain(REGAIN_MS), true);
  });

  test('Zoom and Home take the camera for 6 s, then the car again', () => {
    const { cam } = rig();
    now = 5000;
    cam.zoomBy(2);
    assert.equal(cam.userMoved, true);
    now = 5000 + REGAIN_MS;
    assert.equal(cam.regain(REGAIN_MS), true);
    cam.instant = false;
    cam.goTo({ x: 9, y: 9, mpp: 4 }, 900);
    // still flying home: wait for it to land
    now += REGAIN_MS + 500;
    assert.equal(cam.regain(REGAIN_MS), false);
    cam.tick(now);
    assert.equal(cam.regain(REGAIN_MS), true);
  });
});
