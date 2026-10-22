// Terrain estimates past Pierce's unknown outfalls and discharge points, plus a calibration
// against endings the tracer matched to mapped water (Pierce and Bonney Lake).
// Usage: node scripts/terrain/build.ts [--box minLon,minLat,maxLon,maxLat] [--out file] [--cal file] [--nhd]
//   [--set pitDepthM=1,pitAreaM2=2000] [--ground-every n]
// Writes <cache>/terrain/pierce-unknown-outfalls.json and <cache>/terrain/calibration.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Bundle } from '../../src/data/bundle.ts';
import { DEM_DIR, KING_PIERCE_BOX, TERRAIN } from './config.ts';
import { Dem, ensureTiles, tilesFor } from './dem.ts';
import { bundleExits, GROUND_CODES, readAreaBundles, UNKNOWN_OUTLET_CODES, WATER_CODES, type Exit } from './endings.ts';
import { Estimator, type Estimate } from './estimate.ts';
import { estimateClass, labelFor, outcome, OUTCOMES, reasonFor, Table } from './report.ts';
import { loadWaters } from './waters.ts';

const AREAS = 'public/data/areas';
const BONNEY = 'public/data/tiretrail.json';
const CLASS_NAMES = ['creek', 'ground', 'elsewhere', 'unknown'];

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const box = opt('--box')?.split(',').map(Number) as [number, number, number, number] | undefined;
const outFile = opt('--out') ?? `${TERRAIN}/pierce-unknown-outfalls.json`;
const calFile = opt('--cal') ?? `${TERRAIN}/calibration.json`;
const groundEvery = Number(opt('--ground-every') ?? 1);
const overrides = Object.fromEntries((opt('--set') ?? '').split(',').filter(Boolean).map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])]));
const t0 = Date.now();
const log = (s: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`);
const inBox = (x: Exit) => !box || (x.at[0] >= box[0] && x.at[1] >= box[1] && x.at[0] <= box[2] && x.at[1] <= box[3]);

log('Reading the area bundles');
const pierce = bundleExits(readAreaBundles(AREAS));
const bonney = bundleExits([{ name: 'bonney-lake', bundle: JSON.parse(readFileSync(BONNEY, 'utf8')) as Bundle }]);
const unknown = [...pierce.values()].filter((x) => x.cls === 3 && UNKNOWN_OUTLET_CODES.has(x.code) && inBox(x));
const calPierce = [...pierce.values()].filter((x) => WATER_CODES.has(x.code) && x.receiving && inBox(x));
const calBonney = [...bonney.values()].filter((x) => WATER_CODES.has(x.code) && x.receiving && inBox(x));
const calGround = [...pierce.values()].filter((x) => GROUND_CODES.has(x.code) && inBox(x)).filter((_, i) => i % groundEvery === 0);
log(
  `${unknown.length} unknown outfalls and discharge points (${unknown.reduce((s, x) => s + x.drains.length, 0)} drains); ` +
    `calibration: ${calPierce.length} Pierce and ${calBonney.length} Bonney Lake exits on mapped water, ${calGround.length} Pierce exits that soak in`,
);

const points = [...unknown, ...calPierce, ...calBonney, ...calGround];
const lons = points.map((p) => p.at[0]);
const lats = points.map((p) => p.at[1]);
const pad = 0.3;
const waterBox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad] as const;

await ensureTiles(tilesFor(KING_PIERCE_BOX), DEM_DIR, log);
const dem = await Dem.open(tilesFor(KING_PIERCE_BOX), DEM_DIR);
log('Loading waters');
const waters = await loadWaters(waterBox, { useContext: !args.includes('--nhd'), log });
for (const n of waters.notes) log(`  ${n}`);
const est = new Estimator(dem, waters, overrides);
if (Object.keys(overrides).length) log(`Options: ${JSON.stringify(overrides)}`);
log(`Walking downhill from ${points.length} points`);
const results = await est.estimateAll(
  points.map((p) => ({ lon: p.at[0], lat: p.at[1] })),
  log,
);
log(`Done walking; ${dem.blocksRead} DEM blocks read, windows per level ${est.built.join('/')}`);
const estimateOf = new Map<Exit, Estimate>(points.map((p, i) => [p, results[i]]));

// what the app gets
const counts: Record<string, Record<string, number>> = {};
const bump = (group: string, key: string, n: number) => {
  counts[group] ??= {};
  counts[group][key] = (counts[group][key] ?? 0) + n;
};
for (const x of unknown) {
  const e = estimateOf.get(x)!;
  const n = x.drains.length;
  for (const g of [x.code, 'all']) {
    bump(`${g} exits`, e.kind, 1);
    bump(`${g} drains`, e.kind, n);
    bump(`${g} drains`, 'total', n);
    const water = e.kind === 'stream' || e.kind === 'lake' || e.kind === 'sound';
    for (const lim of [100, 300]) {
      if (e.kind === 'stream' && e.distanceM <= lim) bump(`${g} drains near water`, `stream within ${lim} m`, n);
      if (water && e.distanceM <= lim) bump(`${g} drains near water`, `any water within ${lim} m`, n);
      if (e.kind === 'stream' && e.coho !== 'no' && e.distanceM <= lim) bump(`${g} drains near water`, `coho or possible coho stream within ${lim} m`, n);
      if (e.kind === 'depression' && e.distanceM <= lim) bump(`${g} drains near water`, `low spot within ${lim} m`, n);
    }
  }
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const out = {
  generatedAt: new Date().toISOString(),
  about:
    'Terrain estimates for Pierce County endings where the map stops at an outfall or a discharge point (outfall-unknown, discharge-unknown in public/data/areas). ' +
    'Each walks downhill on USGS 3DEP 1/3 arc-second ground (streams burned in, depressions filled) until it meets a stream or lake, Puget Sound, ' +
    'or a closed low spot. Show these as estimates only: never high confidence, never in the fix list or headline numbers.',
  credits: ['Elevation: USGS 3DEP (public domain)', 'Coho distribution: WDFW SWIFD', 'Streams and lakes: Pierce County GIS, King County GIS, Washington Department of Ecology NHD'],
  sources: waters.notes,
  options: est.opts,
  counts,
  outfalls: unknown
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((x) => {
      const e = estimateOf.get(x)!;
      return {
        key: x.key,
        code: x.code,
        at: [round6(x.at[0]), round6(x.at[1])],
        drains: x.drains.length,
        drainKeys: x.drains,
        estimate: e,
        label: labelFor(e),
        reason: reasonFor(e),
      };
    }),
};
mkdirSync(TERRAIN, { recursive: true });
writeFileSync(outFile, JSON.stringify(out));
log(`Wrote ${outFile} (${out.outfalls.length} exits)`);

// calibration
function calibrate(name: string, list: Exit[], byName = true) {
  const named = new Table(OUTCOMES);
  const cls = new Table(['creek', 'creek?', 'elsewhere', 'ground', 'unknown']);
  const dist: number[] = [];
  for (const x of list) {
    const e = estimateOf.get(x)!;
    const truthCls = CLASS_NAMES[x.cls];
    const unnamed = /unnamed/i.test(x.receiving);
    named.add(`${truthCls}, ${unnamed ? 'unnamed' : 'named'}`, outcome(e, x.receiving));
    cls.add(byName ? truthCls : `${truthCls} (${x.code})`, estimateClass(e));
    if (e.kind !== 'unknown' && e.kind !== 'depression') dist.push(e.distanceM);
  }
  dist.sort((a, b) => a - b);
  const q = (f: number) => (dist.length ? dist[Math.min(dist.length - 1, Math.floor(f * dist.length))] : 0);
  const sameNamed = named.rows.filter((r) => r.endsWith(', named')).reduce((s, r) => s + named.get(r, 'same water'), 0);
  const allNamed = named.rows.filter((r) => r.endsWith(', named')).reduce((s, r) => s + OUTCOMES.reduce((t, c) => t + named.get(r, c), 0), 0);
  console.log(`\n== ${name}: ${list.length} exits`);
  if (byName) console.log(named.text('traced water'));
  console.log(cls.text('traced class'));
  if (byName) console.log(`named traced water, estimate names the same: ${sameNamed} of ${allNamed} (${allNamed ? ((100 * sameNamed) / allNamed).toFixed(1) : '0'}%)`);
  console.log(`walk to water, m: median ${q(0.5)}, 75% ${q(0.75)}, 90% ${q(0.9)}`);
  return { exits: list.length, byName: byName ? named.toJSON() : undefined, byClass: cls.toJSON(), sameNamed, allNamed, walkM: { median: q(0.5), p75: q(0.75), p90: q(0.9) } };
}
const cal = {
  generatedAt: out.generatedAt,
  pierce: calibrate('Pierce endings the tracer matched to mapped water', calPierce),
  pierceOutfalls: calibrate('Pierce outfalls only (outfall-creek, outfall-elsewhere)', calPierce.filter((x) => x.code.startsWith('outfall-'))),
  bonney: calibrate('Bonney Lake endings matched to mapped water', calBonney),
  ground: calibrate('Pierce endings traced to the ground at the surface', calGround, false),
  unknown: counts,
  points: [...calPierce, ...calBonney, ...calGround].map((x) => ({ key: x.key, area: x.area, code: x.code, receiving: x.receiving, at: x.at, estimate: estimateOf.get(x)! })),
};
writeFileSync(calFile, JSON.stringify(cal));
console.log('\n== Unknown outfalls and discharge points (drains)');
for (const [g, v] of Object.entries(counts)) console.log(g.padEnd(40), JSON.stringify(v));
log(`Memory: ${Math.round(process.memoryUsage().rss / 1e6)} MB rss`);
await dem.close();
