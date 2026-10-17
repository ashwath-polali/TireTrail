// Depression filling (priority-flood), D8 flow directions with flats resolved, and the filled
// depressions, on one window of the DEM. Cells are row by row; NaN means no data.

/** Neighbor k is (row + DR[k], col + DC[k]); the reverse of k is 7 - k. */
export const DR = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
export const DC = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
/** Flows off the window, into an outlet cell or into no data. */
export const EXIT = 8;
export const NONE = 255;

/** Binary min-heap of cell indices keyed by elevation. */
class MinHeap {
  private keys: Float32Array;
  private vals: Int32Array;
  size = 0;

  constructor(cap: number) {
    this.keys = new Float32Array(cap);
    this.vals = new Int32Array(cap);
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float32Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    const { keys, vals } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): number {
    const { keys, vals } = this;
    const top = vals[0];
    const n = --this.size;
    const key = keys[n];
    const val = vals[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = key;
    vals[i] = val;
    return top;
  }
}

/**
 * Fills every depression up to its spill level (Barnes et al. 2014, improved priority-flood).
 * Water leaves at the window edge, at outlet cells and at no-data cells.
 */
export function fill(z: Float32Array, rows: number, cols: number, outlet?: Uint8Array): Float32Array {
  const n = rows * cols;
  const f = new Float32Array(z);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, 4 * (rows + cols)));
  const pit = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if ((outlet && outlet[i]) || Number.isNaN(f[i])) closed[i] = 1;
  const seed = (i: number) => {
    if (closed[i]) return;
    closed[i] = 1;
    heap.push(f[i], i);
  };
  for (let c = 0; c < cols; c++) {
    seed(c);
    seed((rows - 1) * cols + c);
  }
  for (let r = 0; r < rows; r++) {
    seed(r * cols);
    seed(r * cols + cols - 1);
  }
  // land next to outlets and gaps drains into them
  for (let i = 0; i < n; i++) {
    if (!((outlet && outlet[i]) || Number.isNaN(z[i]))) continue;
    const r = (i / cols) | 0;
    const c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) seed(rr * cols + cc);
    }
  }
  while (heap.size > 0 || head < tail) {
    const i = head < tail ? pit[head++] : heap.pop();
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const fi = f[i];
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (closed[j]) continue;
      closed[j] = 1;
      if (f[j] <= fi) {
        f[j] = fi;
        pit[tail++] = j;
      } else heap.push(f[j], j);
    }
  }
  return f;
}

/** Meters to neighbor k for cells dx wide and dy tall. */
export function stepLengths(dx: number, dy: number): number[] {
  const d = Math.hypot(dx, dy);
  return [d, dy, d, dx, dx, d, dy, d];
}

/**
 * D8 directions on a filled surface: steepest descent, and across flats toward the nearest way out.
 * Edge cells with nothing lower inside, outlets and no-data cells get EXIT.
 */
export function flowDirections(f: Float32Array, rows: number, cols: number, dx: number, dy: number, outlet?: Uint8Array): Uint8Array {
  const n = rows * cols;
  const len = stepLengths(dx, dy);
  const dir = new Uint8Array(n).fill(NONE);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const fi = f[i];
      if ((outlet && outlet[i]) || Number.isNaN(fi)) {
        dir[i] = EXIT;
        continue;
      }
      let best = 0;
      let bk = -1;
      let gap = false;
      for (let k = 0; k < 8; k++) {
        const rr = r + DR[k];
        const cc = c + DC[k];
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const fj = f[rr * cols + cc];
        if (Number.isNaN(fj)) {
          gap = true;
          continue;
        }
        const s = (fi - fj) / len[k];
        if (s > best) {
          best = s;
          bk = k;
        }
      }
      if (bk >= 0) dir[i] = bk;
      else if (gap || r === 0 || c === 0 || r === rows - 1 || c === cols - 1) dir[i] = EXIT;
    }
  }
  // flats: breadth-first from the cells that already drain, through cells of the same level
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (dir[i] === NONE) continue;
    const r = (i / cols) | 0;
    const c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (dir[j] === NONE && f[j] === f[i]) {
        queue[tail++] = i;
        break;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const r = (i / cols) | 0;
    const c = i - r * cols;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      const cc = c + DC[k];
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (dir[j] !== NONE || f[j] !== f[i]) continue;
      dir[j] = 7 - k;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < n; i++) if (dir[i] === NONE) dir[i] = EXIT;
  return dir;
}

/** One filled depression. */
export interface Depression {
  cells: number;
  /** deepest fill, m */
  depth: number;
  /** lowest cell */
  pit: number;
  /** spill level, m */
  spill: number;
  /** touches the window edge, so its size isn't known */
  edge: boolean;
  /** its cells are members[start .. start + cells) */
  start: number;
}

export interface Depressions {
  /** depression of each cell, -1 if not filled */
  label: Int32Array;
  list: Depression[];
  members: Int32Array;
}

/** Groups filled cells (deeper than minDepth) into depressions. */
export function depressions(z: Float32Array, f: Float32Array, rows: number, cols: number, minDepth = 0.01): Depressions {
  const n = rows * cols;
  const label = new Int32Array(n).fill(-1);
  const list: Depression[] = [];
  const members: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (label[s] >= 0 || !(f[s] - z[s] > minDepth)) continue;
    const id = list.length;
    const d: Depression = { cells: 0, depth: 0, pit: s, spill: f[s], edge: false, start: members.length };
    list.push(d);
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = id;
    while (head < tail) {
      const i = queue[head++];
      members.push(i);
      d.cells++;
      const depth = f[i] - z[i];
      if (depth > d.depth) {
        d.depth = depth;
        d.pit = i;
      }
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) d.edge = true;
      for (let k = 0; k < 8; k++) {
        const rr = r + DR[k];
        const cc = c + DC[k];
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (label[j] >= 0 || !(f[j] - z[j] > minDepth)) continue;
        label[j] = id;
        queue[tail++] = j;
      }
    }
  }
  return { label, list, members: Int32Array.from(members) };
}

/**
 * Connected groups of cells where keep(i), with at least minCells cells.
 * Used to tell open water (big low areas at sea level) from small low spots.
 */
export function bigPatches(keep: (i: number) => boolean, rows: number, cols: number, minCells: number): Uint8Array {
  const n = rows * cols;
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || !keep(s)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (let k = 0; k < 8; k++) {
        const rr = r + DR[k];
        const cc = c + DC[k];
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (seen[j] || !keep(j)) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    if (tail >= minCells) for (let k = 0; k < tail; k++) out[queue[k]] = 1;
  }
  return out;
}
