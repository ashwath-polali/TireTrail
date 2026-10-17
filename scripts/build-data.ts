// npm run build:data: writes public/data/tiretrail.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { encodeBundle } from '../src/data/encode.ts';
import { analyzeCity } from '../src/trace/city.ts';
import { loadInputs, sourceHashes } from './lib/inputs.ts';
import { printNetworkStats } from './lib/report.ts';

const started = performance.now();
const city = analyzeCity(loadInputs());
printNetworkStats(city);

const bundle = encodeBundle(city, sourceHashes());
const json = JSON.stringify(bundle);
const out = new URL('../public/data/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('tiretrail.json', out), json);

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
console.log(`\nWrote public/data/tiretrail.json: ${kb(json.length)} (${kb(gzipSync(json).length)} gzipped)`);
console.log(`  ${bundle.drains.asset.length} drains, ${bundle.endings.length} distinct endings, ${Object.keys(bundle.drains.explicitPaths).length} explicit paths`);
console.log(`  ${bundle.streets.runs.piece.length} street runs on ${bundle.streets.pieces.length} pieces, ${bundle.waters.length} waters`);
console.log(`  built in ${Math.round(performance.now() - started)} ms`);
