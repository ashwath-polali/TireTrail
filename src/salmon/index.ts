// Salmon streams statewide: one shared loader for the coach, the map and the report.
import { SalmonData } from './tiles.ts';

export const salmonData = new SalmonData();
export { salmonWords, salmonTrip, SalmonWatch, type SalmonTrip, type Passed } from './watch.ts';
export { toRegion, fromRegion } from './proj.ts';
export { HABITAT_LINKS, SALMON_CREDITS } from './links.ts';
