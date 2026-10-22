// lon/lat to the region map's meters (y down), the conic in scripts/lib/lcc.ts, so the phone reads the salmon tiles.
import { localProjection, ORIGIN, type LngLat, type XY } from '../geo/geo.ts';

const P = localProjection();
const phi0 = (ORIGIN[1] * Math.PI) / 180, lam0 = (ORIGIN[0] * Math.PI) / 180;
const n = Math.sin(phi0);
const F = (Math.cos(phi0) * Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n)) / n;
const rho = (phi: number) => F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);
const kx = (P.metersPerDegLon * 180) / Math.PI / Math.cos(phi0), ky = (P.metersPerDegLat * 180) / Math.PI;

export function toRegion([lon, lat]: LngLat): XY {
  const r = rho((lat * Math.PI) / 180), th = n * ((lon * Math.PI) / 180 - lam0);
  return [r * Math.sin(th) * kx, -(rho0 - r * Math.cos(th)) * ky];
}

export function fromRegion([X, Y]: XY): LngLat {
  const x1 = X / kx, c = rho0 + Y / ky, r = Math.hypot(x1, c), th = Math.atan2(x1, c);
  return [((lam0 + th / n) * 180) / Math.PI, ((2 * Math.atan(Math.pow(F / r, 1 / n)) - Math.PI / 2) * 180) / Math.PI];
}
