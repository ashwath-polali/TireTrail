// npm run fetch:county: downloads the Pierce County layers into .cache/county/, and the extra waters
// (Puget Sound, NHD) when the shared context file isn't there
import { fetchCounty, readExtraWaters } from './lib/county-fetch.ts';

await fetchCounty();
await readExtraWaters();
