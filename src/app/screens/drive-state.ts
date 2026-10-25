// The live drive's state rules, no DOM: when Start by itself may start again after End drive,
// which fixes the drawn line and the follow camera take while parked, and when the drain reminder may speak.
import { PARK_M, PARK_MPS } from '../../drive/recorder.ts';
import type { XY } from '../../geo/geo.ts';

/** after a tap on End drive, Start by itself waits until the car has been parked this long, ms */
export const HOLD_PARK_MS = 60_000;
/** or until the page has had no fix this long (the app was away, so this is the next open), ms */
export const HOLD_GAP_MS = 10 * 60_000;
/** a fix counts this much parked time at most, so a quiet GPS can't park the car, ms */
const HOLD_STEP_MS = 5000;

/** Start by itself after a tap on End drive: held until the car has really parked, so ending at speed never starts a new drive. */
export class AutoHold {
  private on = false;
  private still = 0;
  private at = 0;
  private spot: XY | null = null;

  /** End drive was tapped at now; parkedMs: how long the car had already been parked. */
  ended(parkedMs: number, now: number): void {
    [this.on, this.still, this.at, this.spot] = [parkedMs < HOLD_PARK_MS, parkedMs, now, null];
  }

  /** A fix while home waits to start: p in meters, v m/s, t ms. True while starts are held. */
  fix(p: XY, v: number, t: number): boolean {
    if (!this.on) return false;
    const gap = t - this.at;
    this.at = t;
    if (gap > HOLD_GAP_MS) return (this.on = false);
    // moving, or creeping away from where it stopped, starts the minute over
    if (v > PARK_MPS || (this.spot && Math.hypot(p[0] - this.spot[0], p[1] - this.spot[1]) > PARK_M)) [this.still, this.spot] = [0, [p[0], p[1]]];
    else {
      this.still += Math.min(Math.max(0, gap), HOLD_STEP_MS);
      this.spot ??= [p[0], p[1]];
    }
    if (this.still >= HOLD_PARK_MS) this.on = false;
    return this.on;
  }

  get held(): boolean { return this.on; }
}

/**
 * Whether a fix joins the drawn line and moves the follow camera: always while moving; parked, only once it is
 * farther than twice its accuracy from the last one kept (about a third of fixes land outside the accuracy itself).
 */
export function onTrail(last: XY | undefined, p: XY, v: number, accuracy?: number | null): boolean {
  if (!last || v >= PARK_MPS) return true;
  return Math.hypot(p[0] - last[0], p[1] - last[1]) > Math.max(5, 2 * (accuracy ?? 0));
}

/** the street drain reminder waits until the drive is this old and this long, ms and m (0.3 mi) */
export const DRAIN_AFTER_MS = 60_000, DRAIN_AFTER_M = 483;

/** The drain reminder may speak: never in the first minute or the first 0.3 mi, so it can't sound like a creek right at the start. */
export function drainReady(ageMs: number, meters: number): boolean {
  return ageMs >= DRAIN_AFTER_MS && meters >= DRAIN_AFTER_M;
}

/** the map goes back to following the car this long after the last touch, ms */
export const REGAIN_MS = 6000;
