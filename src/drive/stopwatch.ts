// While recording: notices each full stop and whether it was gentle (no hard brake on the way in).

/** moving once this fast, and stopped once this slow, m/s */
const MOVING = 4.5, STOPPED = 0.8;
/** a hard brake this long before the stop makes it a hard one, ms */
const HARD_MS = 20_000;

export class StopWatch {
  private moving = false;
  private hardAt = -Infinity;

  /** The live coach heard a hard brake at t, ms. */
  hard(t: number): void {
    this.hardAt = t;
  }

  /** Each fix's time (ms) and speed (m/s). Returns the stop that just happened, else null. */
  update(t: number, v: number): { gentle: boolean } | null {
    if (v >= MOVING) { this.moving = true; return null; }
    if (!this.moving || v > STOPPED) return null;
    this.moving = false;
    return { gentle: t - this.hardAt > HARD_MS };
  }
}
