// Records a drive, ~1 Hz GPS. Browser APIs are injected for tests.
// GPS stops when the page is hidden or the screen locks (iOS and Android), so we hold a
// wake lock (taken again whenever it drops) and log hidden time, and 10 s or more with no fix, as gaps.
// WebKit and Blink both stop GPS for a hidden page (WebKit GeolocationController::activityStateDidChange,
// "Toggle GPS based on page visibility"; Chromium codereview 2379253002), so a hidden stretch is a gap, never the end.
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

/** Location is off for the site: one line on turning it on, never another ask. */
export const GEO_OFF = 'Location is off for TireTrail. On iPhone, tap aA in the address bar, then Website Settings > Location > Allow (or Settings > Apps > Safari > Location), then tap Start.';

export const MESSAGES = {
  unsupported: "This browser can't share its location, so it can't record a drive.",
  denied: GEO_OFF,
  noWakeLock: "This phone won't keep the screen on by itself. Keep the screen on, or recording stops.",
  signalLost: "Can't find your location. Still trying.",
  timeout: 'Finding your location…',
  paused: 'Recording paused while TireTrail is hidden or the screen is locked.',
  resumed: 'Recording again.',
} as const;

/**
 * One GPS watch for the page: hands-free's and the recorder's share it, so a drive asks the phone once.
 * The watch outlives its last listener for a few seconds, so hands-free hands it straight to the recorder.
 */
export class SharedGeo implements GeolocationLike {
  private readonly geo: GeolocationLike;
  private readonly lingerMs: number;
  private id: number | null = null;
  private opts: PositionOptions | undefined;
  private readonly subs = new Map<number, { ok: (p: PositionLike) => void; err?: (e: PositionErrorLike) => void }>();
  private n = 0;
  private stopT: ReturnType<typeof setTimeout> | null = null;
  constructor(geo: GeolocationLike, lingerMs = 5000) { this.geo = geo; this.lingerMs = lingerMs; }

  /** real watches asked of the phone so far */
  asked = 0;

  watchPosition(ok: (p: PositionLike) => void, err?: (e: PositionErrorLike) => void, opts?: PositionOptions): number {
    const k = ++this.n;
    this.subs.set(k, { ok, err });
    if (this.stopT !== null) { clearTimeout(this.stopT); this.stopT = null; }
    if (this.id === null) this.begin(opts);
    return k;
  }

  clearWatch(k: number): void {
    if (!this.subs.delete(k) || this.subs.size || this.id === null || this.stopT !== null) return;
    this.stopT = setTimeout(() => { this.stopT = null; if (!this.subs.size) this.end(); }, this.lingerMs);
  }

  /** Asks the GPS again: a watch can go quiet after an app switch. */
  restart(): void {
    if (this.id === null) return;
    this.end();
    this.begin(this.opts);
  }

  private begin(opts?: PositionOptions): void {
    this.opts = opts;
    this.asked++;
    this.id = this.geo.watchPosition(
      (p) => { for (const s of [...this.subs.values()]) s.ok(p); },
      (e) => { for (const s of [...this.subs.values()]) s.err?.(e); },
      opts);
  }

  private end(): void {
    if (this.id !== null) this.geo.clearWatch(this.id);
    this.id = null;
  }
}

let shared: SharedGeo | null = null;
/** The page's one GPS watch, or undefined where there's no GPS. */
export function pageGeo(): SharedGeo | undefined {
  const g = typeof navigator === 'undefined' ? undefined : (navigator.geolocation as GeolocationLike | undefined);
  if (!g) return undefined;
  return (shared ??= new SharedGeo(g));
}

export function browserDeps(): RecorderDeps {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    geolocation: pageGeo(),
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
/** no fix this long while on screen: ask the GPS again (a watch can go quiet after an app switch), ms */
export const REWATCH_MS = 20_000;

/** A recording picked up again after the page reloaded: what it had, and when it began. */
export interface Resume {
  fixes: readonly Fix[];
  gaps?: readonly Gap[];
  startedAt: number;
}

/** What a drive needs to pick up again after a reload, kept beside its fixes. */
export interface Live {
  at: number;
  /** it had started by itself */
  auto: boolean;
  /** it ends by itself once parked */
  ends: boolean;
  gaps: Gap[];
}

/** a page reloaded within this long of the drive's last fix picks the drive up again, ms */
export const RESUME_MS = 20 * 60_000;

/** The kept drive's live record, if it matches and its last fix is recent; else null. */
export function readLive(raw: string | null, lost: { at: number; fixes: readonly Fix[] } | null, now: number): Live | null {
  const last = lost?.fixes.at(-1);
  if (!raw || !lost || !last || now - last.t > RESUME_MS || last.t > now + 60_000) return null;
  try {
    const v = JSON.parse(raw) as Partial<Live> | null;
    if (!v || v.at !== lost.at) return null;
    const gaps = (Array.isArray(v.gaps) ? v.gaps : []).filter((g): g is Gap => !!g && typeof g.from === 'number' && typeof g.to === 'number' && (g.reason === 'hidden' || g.reason === 'signal'));
    return { at: v.at, auto: v.auto === true, ends: v.ends === true, gaps };
  } catch { return null; }
}

/**
 * Parked time that counts toward ending a drive by itself: only time on screen.
 * Each tick adds at most maxStep, so a page frozen behind another app adds nothing.
 */
export class ParkClock {
  private ms = 0;
  private at: number | null = null;
  private readonly maxStep: number;
  /** where the car stopped, in meters; and whether the last fix was still */
  private spot: readonly [number, number] | null = null;
  private still = true;
  constructor(maxStep = 5000) { this.maxStep = maxStep; }
  /** the car moved: start over */
  moved(): void { this.ms = 0; }
  /**
   * A fix, at p in meters with speed v in m/s. Over 2 m/s, or 40 m from where it stopped (creeping in a queue), starts over.
   * GPS that goes quiet while moving never counts as parked.
   */
  fix(p: readonly [number, number], v: number): void {
    this.still = v <= PARK_MPS;
    if (!this.still || !this.spot || Math.hypot(p[0] - this.spot[0], p[1] - this.spot[1]) > PARK_M) { this.ms = 0; this.spot = [p[0], p[1]]; }
  }
  /** call about once a second; returns the parked ms so far */
  tick(now: number, visible: boolean): number {
    const counts = visible && this.still;
    if (counts && this.at !== null) this.ms += Math.min(Math.max(0, now - this.at), this.maxStep);
    this.at = counts ? now : null;
    return this.ms;
  }
  get parked(): number { return this.ms; }
}

/** parked: under this speed, m/s, and within this far of where the car stopped, m */
export const PARK_MPS = 2, PARK_M = 40;
/** parked this long on screen ends a drive that ends by itself; a red light is shorter, ms */
export const PARKED_MS = 3 * 60_000;

/** The drive's last fix is this old when the app opens again: the drive is over, ms */
export const STALE_MS = 10 * 60_000;

/** Opening the app on a drive that never ended: ask (keep recording or end), or end it when it's old. */
export function reopen(lastFixT: number, now: number): 'ask' | 'end' {
  return now - lastFixT > STALE_MS ? 'end' : 'ask';
}

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
  /** on our clock: the last fix, back on screen, and the last time the GPS was asked */
  private fixAt = 0;
  private shownAt = 0;
  private watchedAt = 0;

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

  /** Call about once a second while recording: retakes the screen lock, and asks again for a GPS that went quiet on screen. */
  check(): void {
    this.retryLock();
    // not before the first fix: the phone may still be asking about location, and a second ask stacks on it
    if (!this.active || this.watchId === null || !this.fixAt || this.deps.visibility?.visibilityState === 'hidden') return;
    if (this.now() - Math.max(this.fixAt, this.shownAt, this.watchedAt) < REWATCH_MS) return;
    const g = this.deps.geolocation as (GeolocationLike & { restart?(): void }) | undefined;
    if (g?.restart) { this.watchedAt = this.now(); g.restart(); return; }
    g?.clearWatch(this.watchId);
    this.watch();
  }

  private watch(): void {
    this.watchedAt = this.now();
    this.watchId = this.deps.geolocation!.watchPosition(this.onPosition, this.onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
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

  /** Call from a tap: wake lock needs a user gesture. resume: the same drive again after a reload; the time away is a gap. */
  async start(resume?: Resume): Promise<RecorderState> {
    if (this.active) return this.current;
    if (!this.deps.geolocation) {
      this.setState('unsupported', MESSAGES.unsupported);
      return this.current;
    }
    this.recorded = [...(resume?.fixes ?? [])];
    this.gaps = [...(resume?.gaps ?? [])];
    this.openGap = null;
    this.lockWarned = false;
    this.startedAt = resume?.startedAt ?? this.now();
    const last = this.recorded.at(-1);
    if (last && this.now() > last.t) this.gaps.push({ from: last.t, to: this.now(), reason: 'hidden' });
    [this.fixAt, this.shownAt] = [0, this.now()];
    this.setState('waiting', MESSAGES.timeout);
    this.deps.visibility?.addEventListener('visibilitychange', this.onVisibility);
    this.watch();
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
    this.fixAt = this.now();
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
      this.shownAt = this.now();
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
