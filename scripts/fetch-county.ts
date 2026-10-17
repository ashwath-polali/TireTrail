// npm run fetch:county: downloads the Pierce County layers into .cache/county/
import { fetchCounty } from './lib/county-fetch.ts';

await fetchCounty();
