// The region map's projection: a conformal conic touching the earth at the origin's latitude,
// scaled to match the town map there.
import { localProjection, ORIGIN, type LngLat, type XY } from '../../src/geo/geo.ts';

const P = localProjection();
const phi0 = (ORIGIN[1] * Math.PI) / 180, lam0 = (ORIGIN[0] * Math.PI) / 180;
const n = Math.sin(phi0);
const F = (Math.cos(phi0) * Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n)) / n;
const rho = (phi: number) => F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);
const kx = (P.metersPerDegLon * 180) / Math.PI / Math.cos(phi0), ky = (P.metersPerDegLat * 180) / Math.PI;

/** lon/lat to app coordinates (meters, y down) */
export function project([lon, lat]: LngLat): XY {
  const r = rho((lat * Math.PI) / 180), th = n * ((lon * Math.PI) / 180 - lam0);
  return [r * Math.sin(th) * kx, -(rho0 - r * Math.cos(th)) * ky];
}

/** app coordinates back to lon/lat */
export function unproject([X, Y]: XY): LngLat {
  const x1 = X / kx, c = rho0 + Y / ky, r = Math.hypot(x1, c), th = Math.atan2(x1, c);
  const lat = 2 * Math.atan(Math.pow(F / r, 1 / n)) - Math.PI / 2, lon = lam0 + th / n;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
