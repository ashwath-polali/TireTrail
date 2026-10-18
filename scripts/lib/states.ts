// The states whose land the map draws (scripts/build-state.ts) and whose towns it names (scripts/build-labels.ts).
// Another state: its lon/lat box and its Geofabrik GeoPackage, and its outline in region.json's detail for a crisp edge.
export interface StateSource { id: string; box: readonly [number, number, number, number]; gpkg: string }

export const STATES: StateSource[] = [
  { id: 'WA', box: [-124.85, 45.54, -116.91, 49.01], gpkg: process.env.OSM_GPKG ?? '.cache/osm/washington.gpkg' },
];
