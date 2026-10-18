// The phone's motion sensor in the browser. iPhone asks once, and only from a tap: call askMotion() first thing in the
// tap handler, before any await. Android Chrome needs no ask. Without a sensor or permission, drives use GPS alone.
import type { MotionSample, MotionTrack } from './motion.ts';

export type MotionState = 'unknown' | 'asking' | 'on' | 'denied' | 'none';

interface DME { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> }
interface Ev {
  timeStamp: number;
  acceleration: { x: number | null; y: number | null; z: number | null } | null;
  accelerationIncludingGravity: { x: number | null; y: number | null; z: number | null } | null;
  rotationRate: { alpha: number | null; beta: number | null; gamma: number | null } | null;
}

let state: MotionState = 'unknown';

/** Where the sensor stands: on, denied, none (no sensor here), or not asked yet. */
export function motionState(): MotionState {
  return state;
}

/** Asks for the motion sensor. Must run inside a tap on iPhone, before any await. Never throws. */
export function askMotion(): Promise<MotionState> {
  const D = (globalThis as { DeviceMotionEvent?: DME }).DeviceMotionEvent;
  if (!D || typeof addEventListener !== 'function') return Promise.resolve((state = 'none'));
  if (state === 'on' || state === 'denied') return Promise.resolve(state);
  if (typeof D.requestPermission !== 'function') {
    // no ask (Android, desktop): whether readings come shows in the sensor itself
    if (state === 'unknown') state = 'on';
    return Promise.resolve(state);
  }
  state = 'asking';
  try {
    return D.requestPermission().then((r) => (state = r === 'granted' ? 'on' : 'denied'), () => (state = 'unknown'));
  } catch {
    // not from a tap: ask again on the next one
    state = 'unknown';
    return Promise.resolve(state);
  }
}

const v3 = (a: Ev['acceleration']): [number, number, number] | null =>
  a && typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number' ? [a.x, a.y, a.z] : null;

/** Feeds devicemotion into a track while a drive records. */
export class MotionSensor {
  private readonly track: MotionTrack;
  private on = false;
  private first = 0;

  constructor(track: MotionTrack) {
    this.track = track;
  }

  /** samples have come in */
  get live(): boolean {
    return this.track.count > 0;
  }

  start(): void {
    if (this.on || typeof addEventListener !== 'function') return;
    this.on = true;
    this.first = Date.now();
    addEventListener('devicemotion', this.onMotion, { passive: true });
  }

  /** Listens again (after the iPhone said yes), keeping what came so far. */
  restart(): void {
    if (!this.on || typeof addEventListener !== 'function') return;
    removeEventListener('devicemotion', this.onMotion);
    addEventListener('devicemotion', this.onMotion, { passive: true });
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    removeEventListener('devicemotion', this.onMotion);
    this.track.end();
  }

  /** started a while ago and nothing came: no sensor here, or not allowed */
  get silent(): boolean {
    return this.on && !this.live && Date.now() - this.first > 3000;
  }

  private readonly onMotion = (ev: Event): void => {
    const e = ev as unknown as Ev;
    const origin = typeof performance !== 'undefined' ? performance.timeOrigin : 0;
    // some browsers give epoch ms here, most ms since the page opened
    const t = e.timeStamp > 1e12 ? Math.round(e.timeStamp) : origin && e.timeStamp > 0 ? Math.round(origin + e.timeStamp) : Date.now();
    const r = e.rotationRate, rot = r && typeof r.alpha === 'number' ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : null;
    const s: MotionSample = { t, lin: v3(e.acceleration), raw: v3(e.accelerationIncludingGravity), rot };
    this.track.add(s);
    if (state === 'unknown') state = 'on';
  };
}
