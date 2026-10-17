// Writes public/data/sample-drive.json: a made-up 5 km drive on real Bonney Lake streets.
import { writeFileSync } from 'node:fs';
import { bonneyLakeRoute, MIXED_PLAN, simulateDrive } from '../test/synth.ts';

const { fixes, stops, lengthM } = simulateDrive(bonneyLakeRoute(5000), MIXED_PLAN, { withSpeed: true, seed: 7, t0: Date.UTC(2026, 9, 12, 16, 0, 0) });
writeFileSync('public/data/sample-drive.json', JSON.stringify(fixes.map((f) => ({ ...f, lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), speed: f.speed == null ? f.speed : +f.speed.toFixed(2) }))));
console.log(`${fixes.length} fixes, ${Math.round(lengthM)} m, ${stops.length} stops`);
