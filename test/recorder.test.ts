/** recorder against mocked GPS, wake lock, visibility */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DriveRecorder,
  MESSAGES,
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
