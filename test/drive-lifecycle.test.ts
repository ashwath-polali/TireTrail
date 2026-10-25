/** A drive never traps the person, location doesn't nag, and parking (not a red light) ends a drive by itself. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DriveRecorder,
  GEO_OFF,
  MESSAGES,
  PARKED_MS,
  ParkClock,
  reopen,
  SharedGeo,
  STALE_MS,
  type GeolocationLike,
  type PositionErrorLike,
  type PositionLike,
  type VisibilityLike,
} from '../src/drive/recorder.ts';

/** A phone GPS that counts how often it was asked. */
class Phone implements GeolocationLike {
  asks = 0;
  live = new Map<number, (p: PositionLike) => void>();
  private n = 0;
  watchPosition(ok: (p: PositionLike) => void, _err?: (e: PositionErrorLike) => void): number {
    this.asks++;
    this.live.set(++this.n, ok);
    return this.n;
  }
  clearWatch(id: number): void { this.live.delete(id); }
  emit(t: number, speed = 12): void {
    for (const ok of [...this.live.values()]) ok({ timestamp: t, coords: { latitude: 47.3 + t * 1e-9, longitude: -122.2, accuracy: 5, speed, heading: 0 } });
  }
}

const shown: VisibilityLike = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

/** Runs a stretch of fixes, one a second, ticking the clock; returns the parked ms at the end. */
function run(c: ParkClock, from: number, secs: number, at: (s: number) => { p: [number, number]; v: number } | null): number {
  let ms = 0;
  for (let s = 0; s < secs; s++) {
    const f = at(s);
    if (f) c.fix(f.p, f.v);
    ms = c.tick(from + s * 1000, true);
  }
  return ms;
}

describe('ending by itself: parked, never a red light', () => {
  test('a long red light (2 1/2 min), GPS wandering 10 m: not parked long enough', () => {
    const c = new ParkClock();
    run(c, 0, 60, (s) => ({ p: [s * 15, 0], v: 15 }));
    const ms = run(c, 60_000, 150, (s) => ({ p: [900 + Math.sin(s) * 10, Math.cos(s) * 10], v: 0.3 }));
    assert.ok(ms < PARKED_MS, `${ms}`);
  });

  test('creeping in a queue under 5 mph for 4 minutes starts it over', () => {
    const c = new ParkClock();
    const ms = run(c, 0, 240, (s) => ({ p: [s * 1.5, 0], v: 1.5 }));
    assert.ok(ms < 60_000, `${ms}`);
  });

  test('GPS gone quiet while moving never counts as parked', () => {
    const c = new ParkClock();
    run(c, 0, 30, (s) => ({ p: [s * 25, 0], v: 25 }));
    const ms = run(c, 30_000, 300, () => null);
    assert.equal(ms, 0);
  });

  test('really parked: past 3 minutes on screen', () => {
    const c = new ParkClock();
    run(c, 0, 60, (s) => ({ p: [s * 15, 0], v: 15 }));
    const ms = run(c, 60_000, 200, (s) => ({ p: [900 + (s % 3), 0], v: 0 }));
    assert.ok(ms > PARKED_MS, `${ms}`);
  });

  test('parked, then a phone that stops sending fixes: still counts', () => {
    const c = new ParkClock();
    run(c, 0, 10, (s) => ({ p: [s * 10, 0], v: 10 }));
    run(c, 10_000, 10, () => ({ p: [100, 0], v: 0 }));
    const ms = run(c, 20_000, 200, () => null);
    assert.ok(ms > PARKED_MS, `${ms}`);
  });
});

describe('opening the app on a drive that never ended', () => {
  test('recent: ask first; over 10 minutes since the last fix: the drive is over', () => {
    assert.equal(reopen(1_000_000, 1_000_000 + 5 * 60_000), 'ask');
    assert.equal(reopen(1_000_000, 1_000_000 + STALE_MS), 'ask');
    assert.equal(reopen(1_000_000, 1_000_000 + STALE_MS + 1000), 'end');
    assert.equal(STALE_MS, 10 * 60_000);
  });
});

describe('location asks once', () => {
  test('hands-free hands its GPS watch to the recording: the phone is asked once', async () => {
    const phone = new Phone(), geo = new SharedGeo(phone, 10);
    let moving = 0;
    const armed = geo.watchPosition(() => { moving++; });
    phone.emit(1000);
    assert.equal(moving, 1);
    // the car is moving: hands-free lets go, the recording takes over in the same tap of the clock
    geo.clearWatch(armed);
    const rec = new DriveRecorder({ geolocation: geo, visibility: shown, now: () => 2000 });
    await rec.start();
    phone.emit(2000);
    assert.equal(phone.asks, 1);
    assert.equal(rec.fixes.length, 1);
    rec.stop();
  });

  test('the shared watch ends a moment after its last listener, and restart asks the GPS again', async () => {
    const phone = new Phone(), geo = new SharedGeo(phone, 20);
    const k = geo.watchPosition(() => {});
    geo.restart();
    assert.equal(phone.asks, 2);
    assert.equal(phone.live.size, 1);
    geo.clearWatch(k);
    assert.equal(phone.live.size, 1, 'lingers');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(phone.live.size, 0);
  });

  test('no second ask while waiting for the first fix (the phone may still be asking about location)', async () => {
    let clock = 0;
    const phone = new Phone(), geo = new SharedGeo(phone, 10);
    const rec = new DriveRecorder({ geolocation: geo, visibility: shown, now: () => clock });
    await rec.start();
    for (; clock <= 120_000; clock += 1000) rec.check();
    assert.equal(phone.asks, 1);
    // once fixes came in and then went quiet, it asks again
    phone.emit(clock);
    clock += 25_000;
    rec.check();
    assert.equal(phone.asks, 2);
    phone.emit(clock);
    assert.equal(rec.fixes.length, 2, 'the new watch records into the same drive');
    rec.stop();
  });

  test('location off: one clear line on turning it on', () => {
    assert.equal(MESSAGES.denied, GEO_OFF);
    for (const w of ['aA', 'Website Settings', 'Location', 'Allow', 'Settings > Apps > Safari > Location', 'Start']) assert.ok(GEO_OFF.includes(w), w);
    assert.ok(!GEO_OFF.includes('\n'));
  });
});
