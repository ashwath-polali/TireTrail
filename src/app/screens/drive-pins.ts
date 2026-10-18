// A hard brake as the Drive screens use it, and the learned spot at its place.
import { turnBetween } from '../../drive/limits.ts';
import { SPOT_M, type Spot } from '../../drive/spots.ts';
import type { LngLat, XY } from '../../geo/geo.ts';
import type { BrakeView } from './drive-words.ts';

/** A hard brake on the map: words, where it is, and its drain for See it happen. */
export interface BrakePin {
  b: BrakeView;
  at: XY;
  lngLat: LngLat;
  heading: number | null;
  drain: number | null;
}

/** Meters between two lon/lat points (close together). */
export function metersBetween(a: LngLat, b: LngLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 111_320 * k, (a[1] - b[1]) * 110_540);
}

/** The learned spot at a hard brake's place, going the same way, or null. */
export function spotAt(spots: readonly Spot[], ll: LngLat, heading: number | null): Spot | null {
  return spots.find((s) => metersBetween(s.lngLat, ll) <= SPOT_M && (s.heading == null || heading == null || turnBetween(s.heading, heading) <= 45)) ?? null;
}
