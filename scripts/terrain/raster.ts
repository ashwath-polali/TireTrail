// Burning lines and polygons into a window's cells. Coordinates are fractional cells:
// x = column, y = row; cell (r, c) covers x in [c, c + 1) and y in [r, r + 1).

/**
 * Cells a segment passes through, in order, each sharing a side with the last (4-connected),
 * so an 8-connected path can't slip across the line between two of them.
 */
export function segmentCells(x0: number, y0: number, x1: number, y1: number, visit: (r: number, c: number) => void): void {
  let c = Math.floor(x0);
  let r = Math.floor(y0);
  const c1 = Math.floor(x1);
  const r1 = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sc = dx > 0 ? 1 : -1;
  const sr = dy > 0 ? 1 : -1;
  const tdc = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdr = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tc = dx > 0 ? (c + 1 - x0) / dx : dx < 0 ? (x0 - c) / -dx : Infinity;
  let tr = dy > 0 ? (r + 1 - y0) / dy : dy < 0 ? (y0 - r) / -dy : Infinity;
  visit(r, c);
  let guard = Math.abs(c1 - c) + Math.abs(r1 - r) + 2;
  while ((c !== c1 || r !== r1) && guard-- > 0) {
    if (tc < tr) {
      c += sc;
      tc += tdc;
    } else {
      r += sr;
      tr += tdr;
    }
    visit(r, c);
  }
}

/** In-window cell indices a polyline passes through, in drawing order, without repeats in a row. */
export function lineCells(xs: ArrayLike<number>, ys: ArrayLike<number>, rows: number, cols: number): number[] {
  const out: number[] = [];
  const visit = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return;
    const i = r * cols + c;
    if (out[out.length - 1] !== i) out.push(i);
  };
  if (xs.length === 1) visit(Math.floor(ys[0]), Math.floor(xs[0]));
  for (let k = 1; k < xs.length; k++) segmentCells(xs[k - 1], ys[k - 1], xs[k], ys[k], visit);
  return out;
}

/** Cells whose centers fall inside the rings (even-odd, so holes stay out). */
export function polygonCells(rings: { xs: ArrayLike<number>; ys: ArrayLike<number> }[], rows: number, cols: number, visit: (i: number) => void): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const g of rings) {
    for (let k = 0; k < g.ys.length; k++) {
      if (g.ys[k] < minY) minY = g.ys[k];
      if (g.ys[k] > maxY) maxY = g.ys[k];
    }
  }
  const r0 = Math.max(0, Math.ceil(minY - 0.5));
  const r1 = Math.min(rows - 1, Math.floor(maxY - 0.5));
  if (r0 > r1) return;
  const hits: number[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
  for (const g of rings) {
    const n = g.xs.length;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const ya = g.ys[k];
      const yb = g.ys[k2];
      if (ya === yb) continue;
      const lo = Math.min(ya, yb);
      const hi = Math.max(ya, yb);
      // rows whose center line y = r + 0.5 crosses [lo, hi)
      const ra = Math.max(r0, Math.ceil(lo - 0.5));
      const rb = Math.min(r1, Math.ceil(hi - 0.5) - 1);
      for (let r = ra; r <= rb; r++) {
        const y = r + 0.5;
        hits[r - r0].push(g.xs[k] + ((y - ya) / (yb - ya)) * (g.xs[k2] - g.xs[k]));
      }
    }
  }
  for (let r = r0; r <= r1; r++) {
    const xs = hits[r - r0].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ca = Math.max(0, Math.ceil(xs[k] - 0.5));
      const cb = Math.min(cols - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let c = ca; c <= cb; c++) visit(r * cols + c);
    }
  }
}
