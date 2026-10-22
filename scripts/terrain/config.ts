// Paths and boxes shared by the terrain scripts.
export const CACHE = (process.env.TT_CACHE ?? '.cache').replace(/\\/g, '/').replace(/\/$/, '');
export const TERRAIN = `${CACHE}/terrain`;
export const DEM_DIR = `${TERRAIN}/dem`;
export const RAW_DIR = `${TERRAIN}/raw`;
export const CONTEXT_DIR = `${CACHE}/sources/context`;

/** lon/lat box around King and Pierce counties */
export const KING_PIERCE_BOX = [-122.86, 46.72, -121.06, 47.79] as const;
