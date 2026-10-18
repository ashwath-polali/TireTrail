// Records a drive, ~1 Hz GPS. Browser APIs are injected for tests.
// GPS stops when the page is hidden or the screen locks (iOS and Android), so we hold a
// wake lock (taken again whenever it drops) and log hidden time, and 10 s or more with no fix, as gaps.
import type { Drive, Fix, Gap } from './types.ts';

export interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number; speed: number | null; heading: number | null };
  timestamp: number;
}

export interface PositionErrorLike {
  code: number;
  message: string;
}

export interface GeolocationLike {
  watchPosition(success: (p: PositionLike) => void, error?: (e: PositionErrorLike) => void, options?: PositionOptions): number;
  clearWatch(id: number): void;
}

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface RecorderDeps {
  geolocation?: GeolocationLike;
  wakeLock?: WakeLockLike;
  visibility?: VisibilityLike;
  now?: () => number;
}

export type RecorderState = 'idle' | 'waiting' | 'recording' | 'denied' | 'unsupported' | 'stopped';

export type NoticeKind = 'no-wake-lock' | 'signal-lost' | 'gps-timeout' | 'paused' | 'resumed';

export interface RecorderListener {
  onState?(state: RecorderState, message?: string): void;
  onFix?(fix: Fix, count: number): void;
  onNotice?(kind: NoticeKind, message: string): void;
}

export const MESSAGES = {
  unsupported: "This browser can't share its location, so it can't record a drive.",
  denied:
    'Location access is off for TireTrail. Turn it on in your browser settings, then tap Start again. ' +
    '(iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using the App.)',
  noWakeLock: "This phone won't keep the screen on by itself. Keep the screen on, or recording stops.",
  signalLost: "Can't find your location. Still trying.",
  timeout: 'Finding your location…',
  paused: 'Recording paused while TireTrail is hidden or the screen is locked.',
  resumed: 'Recording again.',
} as const;

export function browserDeps(): RecorderDeps {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    geolocation: nav?.geolocation as GeolocationLike | undefined,
    wakeLock: (nav as unknown as { wakeLock?: WakeLockLike } | undefined)?.wakeLock,
    visibility: typeof document === 'undefined' ? undefined : (document as VisibilityLike),
    now: () => Date.now(),
  };
}

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
/** no fix for this long while on screen is a gap, ms */
export const SIGNAL_GAP_MS = 10_000;
/** how often to try for the wake lock again while it's missing, ms */
const RETRY_LOCK_MS = 10_000;

export class DriveRecorder {
  private readonly deps: RecorderDeps;
  private readonly listener: RecorderListener;
  private current: RecorderState = 'idle';
  private watchId: number | null = null;
  private lock: WakeLockSentinelLike | null = null;
  private lockRequest: Promise<void> | null = null;
  private recorded: Fix[] = [];
  private gaps: Gap[] = [];
  private openGap: Gap | null = null;
  private startedAt = 0;
  private lockTriedAt = 0;
  private lockWarned = false;

  constructor(deps: RecorderDeps = browserDeps(), listener: RecorderListener = {}) {
    this.deps = deps;
    this.listener = listener;
  }

  get state(): RecorderState {
    return this.current;
  }

  get fixes(): readonly Fix[] {
    return this.recorded;
  }

  /** the gaps so far, oldest first */
  get gapList(): readonly Gap[] {
    return this.gaps;
  }

  /** The screen lock isn't held (dropped by the phone): try again. Call often; it asks at most every 10 s. */
  retryLock(): void {
    if (!this.active || this.deps.visibility?.visibilityState === 'hidden' || (this.lock && !this.lock.released) || this.lockRequest) return;
    if (this.now() - this.lockTriedAt < RETRY_LOCK_MS) return;
    void this.keepScreenOn();
  }

  private get active(): boolean {
    return this.current === 'waiting' || this.current === 'recording';
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setState(state: RecorderState, message?: string): void {
    this.current = state;
    this.listener.onState?.(state, message);
  }

  /** call from a tap: wake lock needs a user gesture */
  async start(): Promise<RecorderState> {
    if (this.active) return this.current;
    const geo = this.deps.geolocation;
    if (!geo) {
      this.setState('unsupported', MESSAGES.unsupported);
      return this.current;
    }
    this.recorded = [];
    this.gaps = [];
    this.openGap = null;
    this.lockWarned = false;
    this.startedAt = this.now();
    this.setState('waiting', MESSAGES.timeout);
    this.deps.visibility?.addEventListener('visibilitychange', this.onVisibility);
    this.watchId = geo.watchPosition(this.onPosition, this.onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    if (this.active) await this.keepScreenOn();
    return this.current;
  }

  stop(): Drive {
    if (this.watchId !== null) this.deps.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
    this.deps.visibility?.removeEventListener('visibilitychange', this.onVisibility);
    if (this.openGap) {
      this.openGap.to = this.now();
      this.gaps.push(this.openGap);
      this.openGap = null;
    }
    // leave active state first so the release handler doesn't retake the lock
    if (this.current !== 'denied' && this.current !== 'unsupported') this.setState('stopped');
    void this.releaseLock();
    return { fixes: [...this.recorded], gaps: [...this.gaps], startedAt: this.startedAt, endedAt: this.now() };
  }

  private readonly onPosition = (p: PositionLike): void => {
    if (!this.active) return;
    const c = p.coords;
    const last = this.recorded[this.recorded.length - 1];
    if (last && p.timestamp <= last.t) return; // repeated reading
    const ok = (x: number | null) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
    const fix: Fix = { t: p.timestamp, lat: c.latitude, lon: c.longitude, speed: ok(c.speed), heading: ok(c.heading), accuracy: ok(c.accuracy) };
    // a long wait for a fix while on screen: no signal (a hidden page is its own gap)
    if (last && fix.t - last.t >= SIGNAL_GAP_MS && !this.openGap && !this.gaps.some((g) => g.reason === 'hidden' && g.to > last.t && g.from < fix.t)) {
      this.gaps.push({ from: last.t, to: fix.t, reason: 'signal' });
    }
    this.recorded.push(fix);
    if (this.current === 'waiting') this.setState('recording');
    this.listener.onFix?.(fix, this.recorded.length);
  };

  private readonly onError = (e: PositionErrorLike): void => {
    if (!this.active) return;
    if (e.code === PERMISSION_DENIED) {
      if (this.watchId !== null) this.deps.geolocation?.clearWatch(this.watchId);
      this.watchId = null;
      this.setState('denied', MESSAGES.denied);
      void this.releaseLock();
    } else if (e.code === POSITION_UNAVAILABLE) {
      this.listener.onNotice?.('signal-lost', MESSAGES.signalLost);
    } else {
      this.listener.onNotice?.('gps-timeout', MESSAGES.timeout);
    }
  };

  private readonly onVisibility = (): void => {
    if (!this.active) return;
    if (this.deps.visibility?.visibilityState === 'hidden') {
      this.openGap ??= { from: this.now(), to: this.now(), reason: 'hidden' };
      this.listener.onNotice?.('paused', MESSAGES.paused);
    } else {
      if (this.openGap) {
        this.openGap.to = this.now();
        this.gaps.push(this.openGap);
        this.openGap = null;
      }
      this.listener.onNotice?.('resumed', MESSAGES.resumed);
      // browser drops the lock when hidden
      void this.keepScreenOn();
    }
  };

  // overlapping calls share one request
  private keepScreenOn(): Promise<void> {
    if (this.lock && !this.lock.released) return Promise.resolve();
    this.lockRequest ??= this.requestLock().finally(() => {
      this.lockRequest = null;
    });
    return this.lockRequest;
  }

  private async requestLock(): Promise<void> {
    this.lockTriedAt = this.now();
    const wl = this.deps.wakeLock;
    if (!wl) {
      this.warnLock();
      return;
    }
    try {
      const lock = await wl.request('screen');
      if (!this.active || (this.lock && !this.lock.released)) {
        // stopped while pending, or already holding one
        await lock.release().catch(() => undefined);
        return;
      }
      this.lock = lock;
      lock.addEventListener('release', () => {
        // system released it (battery saver, hidden): retake if still recording
        if (this.lock === lock) this.lock = null;
        if (this.active && this.deps.visibility?.visibilityState !== 'hidden') { this.lockTriedAt = 0; void this.keepScreenOn(); }
      });
    } catch {
      this.warnLock();
    }
  }

  // once a drive: retries stay quiet
  private warnLock(): void {
    if (this.lockWarned) return;
    this.lockWarned = true;
    this.listener.onNotice?.('no-wake-lock', MESSAGES.noWakeLock);
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock && !lock.released) await lock.release().catch(() => undefined);
  }
}
