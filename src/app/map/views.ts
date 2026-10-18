// How far the opening view zooms out, the built-in town's point, and how far the map lets you wander up close.
import type { LngLat } from '../../geo/geo.ts';

/** Bonney Lake's town point, where its town label sits */
export const TOWN_POINT: LngLat = [-122.1702, 47.1870];

/** street-color zoom for one place up close, as the home key's "my area" uses it */
export const PLACE_MPP = { laptop: 6, phone: 7 };

/** the opening view of everything traced zooms out no farther: under OV_MPP (render.ts), so its colored streets still draw */
export const OVERVIEW_MPP = 100;

/** west, south, east, north: the lon/lat box panning stays in at mpp <= 24 (Pierce, King and around) */
export const WANDER: [number, number, number, number] = [-123.1, 46.55, -120.8, 47.95];
