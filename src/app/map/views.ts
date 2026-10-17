// Where the map opens, and how far it lets you wander up close.
import type { LngLat } from '../../geo/geo.ts';

/** the Bonney Lake town point, at street-color zoom */
export const OPEN_VIEW: { lngLat: LngLat; mppLaptop: number; mppPhone: number } = { lngLat: [-122.1702, 47.1870], mppLaptop: 6, mppPhone: 7 };

/** west, south, east, north: the lon/lat box panning stays in at mpp <= 24 (Pierce, King and around) */
export const WANDER: [number, number, number, number] = [-123.1, 46.55, -120.8, 47.95];
