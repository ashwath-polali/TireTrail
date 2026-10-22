/** recorder against mocked GPS, wake lock, visibility */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DriveRecorder,
  MESSAGES,
  ParkClock,
  readLive,
  RESUME_MS,
  type GeolocationLike,
  type PositionErrorLike,
  type PositionLike,
  type VisibilityLike,
  type WakeLockLike,
  type WakeLockSentinelLike,
} from '../src/drive/recorder.ts';

class FakeGeolocation implements GeolocationLike {
  success?: (p: PositionLike) => void;
  error?: (e: PositionErrorLike) => void;
  options?: PositionOptions;
  cleared: number[] = [];
  private nextId = 1;
  watchPosition(success: (p: PositionLike) => void, error?: (e: PositionErrorLike) => void, options?: PositionOptions): number {
    this.success = success;
    this.error = error;
    this.options = options;
    return this.nextId++;
  }
  clearWatch(id: number): void {
    this.cleared.push(id);
  }
  emit(t: number, speed: number | null = 10) {
    this.success?.({ timestamp: t, coords: { latitude: 47.17 + t * 1e-8, longitude: -122.18, accuracy: 5, speed, heading: 90 } });
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: (() => void)[] = [];
  async release() {
    if (this.released) return;
    this.released = true;
    for (const l of this.listeners) l();
  }
  addEventListener(_: 'release', l: () => void) {
    this.listeners.push(l);
  }
}

class FakeWakeLock implements WakeLockLike {
  sentinels: FakeSentinel[] = [];
  fail = false;
  /** pending until grant() */
  deferred = false;
  private pending: (() => void)[] = [];
  async request(): Promise<WakeLockSentinelLike> {
    if (this.fail) throw new Error('NotAllowedError');
    if (this.deferred) await new Promise<void>((r) => this.pending.push(r));
    const s = new FakeSentinel();
    this.sentinels.push(s);
    return s;
  }
  grant() {
    for (const r of this.pending.splice(0)) r();
  }
  get held() {
    return this.sentinels.filter((s) => !s.released).length;
  }
}

class FakeDocument implements VisibilityLike {
  visibilityState = 'visible';
  private listeners: (() => void)[] = [];
  addEventListener(_: 'visibilitychange', l: () => void) {
    this.listeners.push(l);
  }
  removeEventListener(_: 'visibilitychange', l: () => void) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  set(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    for (const l of [...this.listeners]) l();
  }
  get listening() {
    return this.listeners.length;
  }
}

function setup(opts: { wakeLock?: boolean } = {}) {
  let clock = 1_000_000;
  const geolocation = new FakeGeolocation();
  const wakeLock = new FakeWakeLock();
  const doc = new FakeDocument();
  const states: string[] = [];
  const notices: string[] = [];
  const rec = new DriveRecorder(
    { geolocation, wakeLock: opts.wakeLock === false ? undefined : wakeLock, visibility: doc, now: () => clock },
    { onState: (s) => states.push(s), onNotice: (k) => notices.push(k) },
  );
  return { rec, geolocation, wakeLock, doc, states, notices, tick: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('drive recorder', () => {
  test('records GPS fixes with high accuracy and keeps the screen on', async () => {
    const { rec, geolocation, wakeLock, states } = setup();
    await rec.start();
    assert.deepEqual(geolocation.options, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    assert.equal(wakeLock.held, 1);
    assert.equal(rec.state, 'waiting');
    geolocation.emit(1000);
    geolocation.emit(2000, null);
    geolocation.emit(2000); // repeated reading ignored
    assert.equal(rec.state, 'recording');
    const drive = rec.stop();
    assert.equal(drive.fixes.length, 2);
    assert.equal(drive.fixes[1].speed, null);
    assert.deepEqual(states, ['waiting', 'recording', 'stopped']);
    await flush();
    assert.equal(wakeLock.held, 0, 'the wake lock is released and not retaken after stopping');
    assert.deepEqual(geolocation.cleared, [1]);
  });

  test('handles a denied permission', async () => {
    const { rec, geolocation, wakeLock, states } = setup();
    let message = '';
    const r = new DriveRecorder(
      { geolocation, wakeLock, now: () => 0 },
      { onState: (s, m) => ((message = m ?? message), states.push(s)) },
    );
    await r.start();
    geolocation.error?.({ code: 1, message: 'User denied Geolocation' });
    assert.equal(r.state, 'denied');
    assert.equal(message, MESSAGES.denied);
    assert.deepEqual(geolocation.cleared, [1]);
    await flush();
    assert.equal(wakeLock.held, 0);
    geolocation.emit(5000); // late readings after denial ignored
    assert.equal(r.fixes.length, 0);
    void rec;
  });

  test('reports a browser without GPS', async () => {
    const r = new DriveRecorder({ now: () => 0 });
    assert.equal(await r.start(), 'unsupported');
  });

  test('a hidden page is recorded as a gap, and the wake lock is taken again on return', async () => {
    const { rec, geolocation, wakeLock, doc, tick, notices } = setup();
    await rec.start();
    geolocation.emit(1000);
    tick(1000);
    doc.set('hidden');
    await wakeLock.sentinels[0].release(); // browsers drop the lock on hide
    tick(30_000);
    doc.set('visible');
    await flush();
    assert.equal(wakeLock.held, 1);
    const drive = rec.stop();
    assert.deepEqual(drive.gaps, [{ from: 1_001_000, to: 1_031_000, reason: 'hidden' }]);
    assert.deepEqual(notices, ['paused', 'resumed']);
    assert.equal(doc.listening, 0);
  });

  test('warns when the screen cannot be kept on, and keeps recording', async () => {
    const { rec, geolocation, notices } = setup({ wakeLock: false });
    await rec.start();
    geolocation.emit(1000);
    assert.deepEqual(notices, ['no-wake-lock']);
    assert.equal(rec.state, 'recording');
  });

  test('overlapping wake-lock requests never leave a lock held after stopping', async () => {
    const { rec, wakeLock, doc } = setup();
    wakeLock.deferred = true;
    const started = rec.start();
    // passenger flips away and back while the first request is pending
    doc.set('hidden');
    doc.set('visible');
    wakeLock.grant();
    await started;
    await flush();
    assert.equal(wakeLock.sentinels.length, 1, 'one shared request');
    assert.equal(wakeLock.held, 1);
    rec.stop();
    await flush();
    assert.equal(wakeLock.held, 0);
  });

  test('10 s or more with no reading while on screen is a gap; a hidden stretch is not counted twice', async () => {
    const { rec, geolocation, doc, tick } = setup();
    await rec.start();
    geolocation.emit(1_000_000);
    geolocation.emit(1_001_000);
    geolocation.emit(1_009_000); // 8 s: not a gap
    geolocation.emit(1_025_000); // 16 s with no reading
    assert.deepEqual(rec.gapList, [{ from: 1_009_000, to: 1_025_000, reason: 'signal' }]);
    // hidden for 30 s: one hidden gap, no signal gap on top
    tick(25_000);
    doc.set('hidden');
    tick(30_000);
    doc.set('visible');
    geolocation.emit(1_056_000);
    assert.deepEqual(rec.stop().gaps.map((g) => g.reason), ['signal', 'hidden']);
  });

  test('a wake lock the phone drops is taken again, asked at most every 10 s, and the warning comes once', async () => {
    const { rec, wakeLock, tick, notices } = setup();
    await rec.start();
    wakeLock.fail = true;
    await wakeLock.sentinels[0].release();
    await flush();
    rec.retryLock();
    await flush();
    assert.deepEqual(notices, ['no-wake-lock']);
    tick(4000);
    rec.retryLock();
    await flush();
    wakeLock.fail = false;
    tick(11_000);
    rec.retryLock();
    await flush();
    assert.equal(wakeLock.held, 1);
    assert.deepEqual(notices, ['no-wake-lock']);
    rec.stop();
  });

  test('a lost GPS signal is a notice, not the end of the drive', async () => {
    const { rec, geolocation, notices } = setup();
    await rec.start();
    geolocation.error?.({ code: 2, message: 'unavailable' });
    geolocation.error?.({ code: 3, message: 'timeout' });
    geolocation.emit(1000);
    assert.equal(rec.state, 'recording');
    assert.deepEqual(notices, ['signal-lost', 'gps-timeout']);
  });
});

describe('switching apps mid drive', () => {
  test('10 min behind Maps: the same drive goes on when TireTrail comes back, with the time away as a gap', async () => {
    const { rec, geolocation, doc, tick, states } = setup();
    await rec.start();
    geolocation.emit(1_000_000);
    tick(1000);
    doc.set('hidden');
    tick(600_000);
    doc.set('visible');
    geolocation.emit(1_601_000);
    assert.equal(rec.state, 'recording');
    assert.equal(rec.fixes.length, 2);
    assert.deepEqual(states, ['waiting', 'recording']);
    assert.deepEqual(rec.stop().gaps, [{ from: 1_001_000, to: 1_601_000, reason: 'hidden' }]);
  });

  test('a GPS watch that goes quiet on screen is asked again, every 20 s at most, never while hidden', async () => {
    const { rec, geolocation, doc, tick } = setup();
    await rec.start();
    geolocation.emit(1_000_000);
    tick(15_000);
    rec.check();
    assert.deepEqual(geolocation.cleared, [], 'fixes are recent');
    doc.set('hidden');
    tick(60_000);
    rec.check();
    assert.deepEqual(geolocation.cleared, [], 'no GPS while hidden is expected');
    doc.set('visible');
    tick(10_000);
    rec.check();
    assert.deepEqual(geolocation.cleared, [], 'just came back');
    tick(11_000);
    rec.check();
    assert.deepEqual(geolocation.cleared, [1]);
    tick(5000);
    rec.check();
    assert.deepEqual(geolocation.cleared, [1], 'asked again only after another 20 s');
    geolocation.emit(1_100_000);
    assert.equal(rec.fixes.length, 2, 'the new watch records into the same drive');
    rec.stop();
    assert.deepEqual(geolocation.cleared, [1, 2]);
  });

  test('picks up a drive after a reload: its fixes, start and gaps, plus the time away', async () => {
    const { rec, geolocation } = setup();
    const fixes = [1000, 2000, 3000].map((t) => ({ t: 990_000 + t, lat: 47.17, lon: -122.18, speed: 10, heading: null, accuracy: 5 }));
    await rec.start({ fixes, gaps: [{ from: 1, to: 2, reason: 'signal' }], startedAt: 990_000 });
    geolocation.emit(1_001_000);
    const d = rec.stop();
    assert.equal(d.startedAt, 990_000);
    assert.equal(d.fixes.length, 4);
    assert.deepEqual(d.gaps, [{ from: 1, to: 2, reason: 'signal' }, { from: 993_000, to: 1_000_000, reason: 'hidden' }]);
  });
});

describe('ending by itself once parked', () => {
  test('counts only time on screen: 2 min parked, 10 min behind Maps, back: not 3 min yet', () => {
    const c = new ParkClock();
    let t = 0;
    for (; t <= 120_000; t += 1000) c.tick(t, true);
    assert.equal(c.parked, 120_000);
    // hidden: the page is frozen (no ticks) or ticks once a minute (Android)
    for (; t <= 720_000; t += 60_000) c.tick(t, false);
    c.tick(t, true);
    assert.equal(c.parked, 120_000);
    c.tick(t + 1000, true);
    assert.equal(c.parked, 121_000);
  });

  test('a frozen page that wakes on screen adds at most 5 s, and moving starts it over', () => {
    const c = new ParkClock();
    c.tick(0, true);
    c.tick(600_000, true);
    assert.equal(c.parked, 5000);
    c.moved();
    assert.equal(c.parked, 0);
    c.tick(601_000, true);
    assert.equal(c.parked, 1000);
  });
});

describe('picking up after a reload', () => {
  const lost = { at: 500, fixes: [{ t: 1000, lat: 47, lon: -122, speed: 1, heading: null, accuracy: 5 }] };
  const raw = JSON.stringify({ at: 500, auto: true, ends: true, gaps: [{ from: 1, to: 2, reason: 'hidden' }, { bad: 1 }] });
  test('a matching, recent drive picks up, keeping its good gaps', () => {
    assert.deepEqual(readLive(raw, lost, 1000 + RESUME_MS), { at: 500, auto: true, ends: true, gaps: [{ from: 1, to: 2, reason: 'hidden' }] });
  });
  test('an old, finished, mismatched or broken one does not', () => {
    assert.equal(readLive(raw, lost, 1001 + RESUME_MS), null);
    assert.equal(readLive(null, lost, 2000), null);
    assert.equal(readLive(raw, { ...lost, at: 501 }, 2000), null);
    assert.equal(readLive('{', lost, 2000), null);
    assert.equal(readLive(raw, { at: 500, fixes: [] }, 2000), null);
  });
});
