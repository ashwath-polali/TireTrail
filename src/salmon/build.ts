// Small geometry and naming helpers for scripts/build-salmon.ts, here so tests can reach them.
import type { XY } from '../geo/geo.ts';

/** Where segments ab and cd cross, as t along ab (0 to 1), or -1. */
export function crossT(a: XY, b: XY, c: XY, d: XY): number {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qx = c[0] - a[0], qy = c[1] - a[1], t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance from p to segment ab. */
export function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** A plain stream name from SWIFD's, or '' for its unnamed ones ("Unnamed stream [1225128478056]"). */
export function cleanName(n: string): string {
  const s = n.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^unnamed/i.test(s) || /^(trib|tributary)\b/i.test(s) || /^\d/.test(s)) return '';
  return s;
}
