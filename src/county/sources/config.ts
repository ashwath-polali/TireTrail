// City sources traced by their keys (scripts/build-sources.ts).
import type { LngLat } from '../../geo/geo.ts';

export interface SourceConfig {
  /** scripts/sources/<key>.ts writes <cache>/sources/<key>/ */
  key: string;
  /** area names start with it, as "Seattle / Aurora Ave N" */
  place: string;
  /** street jurisdiction in the context streets file */
  jurisdiction: string;
  streets: string;
  waters: string;
  origin: LngLat;
  /** "Seattle's" in "Then Seattle's pipe map has a gap." */
  owner: string;
  /** where a combined sewer goes */
  sewer: string;
  credits: readonly string[];
  disclaimer: string;
}

export const SOURCES: readonly SourceConfig[] = [
  {
    key: 'seattle',
    place: 'Seattle',
    jurisdiction: 'Seattle',
    streets: 'streets-king.ndjson',
    waters: 'waters-king.ndjson',
    origin: [-122.33, 47.61],
    owner: "Seattle's",
    // SPU and King County WTD: combined sewers carry street water to West Point and the other county plants
    // (seattle.gov/Documents/Departments/SPU/Services/UtilityDrainage-WastewaterServices.pdf)
    sewer: 'a King County treatment plant',
    credits: [
      'City of Seattle, Seattle Public Utilities drainage and wastewater layers, provided as is, without warranty',
      'King County GIS (streets, streams and lakes)',
      'WDFW SWIFD (coho distribution)',
      'USGS NHD (streams, lakes, wetlands and shoreline, via Washington State Department of Ecology)',
    ],
    disclaimer: 'Independent student project. Not made, reviewed or endorsed by the City of Seattle, King County, UW or WDFW. City data is provided as is, without warranty of any kind. Planning-level estimates.',
  },
];
