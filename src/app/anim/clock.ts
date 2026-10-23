// One frame loop for every pixel animation: 12 frames a second, and it stops when nothing is left to draw.

type Job = (now: number) => boolean;

const jobs = new Set<Job>();
let raf = 0, last = 0;
const STEP = 1000 / 12;

function loop(now: number): void {
  raf = 0;
  if (now - last >= STEP - 2) {
    last = now;
    for (const j of [...jobs]) if (!j(now)) jobs.delete(j);
  }
  if (jobs.size) raf = requestAnimationFrame(loop);
}

/** Runs fn every frame (about 12 a second) until it returns false. Returns a stop. */
export function every(fn: Job): () => void {
  jobs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => { jobs.delete(fn); };
}

/** The reveal's clock: ms since it began. A skip jumps to the end. */
export class Show {
  t0: number;
  /** ms the reveal lasts */
  end: number;
  constructor(end: number, now = performance.now()) {
    this.t0 = now;
    this.end = end;
  }
  at(now = performance.now()): number {
    return now - this.t0;
  }
  get done(): boolean {
    return this.at() >= this.end;
  }
  skip(now = performance.now()): void {
    this.t0 = Math.min(this.t0, now - this.end);
  }
}
