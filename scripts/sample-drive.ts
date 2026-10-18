// Writes public/data/sample-drive.json: a made-up 5 km drive on real Bonney Lake streets (SR 410).
// 3 hard stops (about 9 mph slower each second), 3 gentle ones, then 55 mph in the 45 mph stretch at the end.
import { writeFileSync } from 'node:fs';
import { bonneyLakeRoute, MIXED_PLAN, simulateDrive } from '../test/synth.ts';

const MPH = 0.44704;
const { fixes, stops, lengthM } = simulateDrive(bonneyLakeRoute(5000), MIXED_PLAN, { withSpeed: true, seed: 7, t0: Date.UTC(2026, 9, 12, 16, 0, 0), lastCruiseMps: 55 * MPH });
writeFileSync('public/data/sample-drive.json', JSON.stringify(fixes.map((f) => ({ ...f, lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), speed: f.speed == null ? f.speed : +f.speed.toFixed(2) }))));
console.log(`${fixes.length} fixes, ${Math.round(lengthM)} m, ${stops.length} stops`);
