/** salmon streams: crossing math, the cue about 10 s ahead (once, fast enough, never over another line), the report row */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';
import { cuesFor, LiveCoach } from '../src/drive/coach/live.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { cleanName, crossT, segDist } from '../src/salmon/build.ts';
import { streamAt, streamLine } from '../src/salmon/hit.ts';
import { fromRegion, toRegion } from '../src/salmon/proj.ts';
import { routeTiles, salmonRowWords, tripOver } from '../src/salmon/row.ts';
import { CHINOOK, COHO, oneFish, speciesIn, speciesList, speciesSVG, STEELHEAD } from '../src/salmon/species.ts';
import { CAT, SALMON as CORAL, SALMON_WATER, swatchSVG } from '../src/app/map/palette.ts';
import { readTile, SalmonData, type RawTile, type Tile } from '../src/salmon/tiles.ts';
import { besideWords, offRoad, SALMON, salmonTrip, salmonWords, secondsAhead, type SalmonTrip } from '../src/salmon/watch.ts';
import { project } from '../scripts/lib/lcc.ts';
import { drive, MPH, P } from './engine-helpers.ts';

/** a crossing at local meters [x, y] (y north) on a road running dir degrees from north */
function tileWith(list: { at: XY; dir: number; name: string; sp: number }[]): Tile {
  const raw: RawTile = { v: 1, s: [], l: [], c: [], b: [] };
  for (const c of list) {
    const r = toRegion(P.toLngLat(c.at));
    let si = raw.s.findIndex((s) => s[0] === c.name);
    if (si < 0) si = raw.s.push([c.name, c.sp, 3]) - 1;
    raw.c.push([Math.round(r[0]), Math.round(r[1]), si, c.dir, c.sp]);
    // the stream runs east-west through the crossing
    raw.l.push([si, Math.round(r[0]) - 300, Math.round(r[1]), 600, 0]);
  }
  return readTile('0_0', raw)!;
}
const src = (t: Tile) => ({ near: () => [t] });
const north = (mph: number, secs: number) => drive(mph * MPH, [[secs, 0]], { heading: 0, start: [0, -600] });
const said = (fixes: Fix[], t: Tile) => cuesFor(fixes, { salmon: src(t) }).filter((c) => c.kind === 'salmon-ahead');
const clover = (at: XY = [0, 0], name = 'Clover Creek', sp = COHO | STEELHEAD) => ({ at, dir: 0, name, sp });

describe('salmon: crossing math', () => {
  test('two segments cross where they should', () => {
    assert.equal(crossT([0, 0], [10, 0], [5, -5], [5, 5]), 0.5);
    assert.equal(crossT([0, 0], [10, 0], [15, -5], [15, 5]), -1);
    assert.equal(crossT([0, 0], [10, 0], [0, 1], [10, 1]), -1);
    assert.equal(segDist([5, 3], [0, 0], [10, 0]), 3);
    assert.equal(segDist([-4, 3], [0, 0], [10, 0]), 5);
  });

  test("the phone's projection is the build's", () => {
    for (const ll of [[-122.18, 47.17], [-124.5, 48.3], [-117.1, 46.1]] as [number, number][]) {
      const a = toRegion(ll), b = project(ll);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01);
      const back = fromRegion(a);
      assert.ok(Math.abs(back[0] - ll[0]) < 1e-9 && Math.abs(back[1] - ll[1]) < 1e-9);
    }
  });

  test('a road direction matches either way along it', () => {
    assert.equal(offRoad(0, 0), 0);
    assert.equal(offRoad(180, 0), 0);
    assert.equal(offRoad(95, 90), 5);
    assert.equal(offRoad(10, 170), 20);
    assert.equal(offRoad(90, 0), 90);
  });

  test('seconds ahead only for a crossing in front, on this road', () => {
    assert.equal(secondsAhead([0, 0], 0, 10, { at: [0, -100], dir: 0 }), 10);
    // behind, off to the side, or on a road across this one
    assert.equal(secondsAhead([0, 0], 0, 10, { at: [0, 100], dir: 0 }), null);
    assert.equal(secondsAhead([0, 0], 0, 10, { at: [60, -100], dir: 0 }), null);
    assert.equal(secondsAhead([0, 0], 0, 10, { at: [0, -100], dir: 90 }), null);
  });

  test('stream names: SWIFD unnamed ones are blank', () => {
    assert.equal(cleanName('Clover Creek'), 'Clover Creek');
    assert.equal(cleanName('Unnamed stream [1225128478056]'), '');
    assert.equal(cleanName('Trib to Clover Creek'), '');
    assert.equal(cleanName(''), '');
  });
});

describe('salmon: words', () => {
  test('the line names the creek and the fish; mixed or unknown is a salmon stream', () => {
    assert.equal(salmonWords({ sp: COHO | STEELHEAD, stream: { name: 'Clover Creek' } }), 'Clover Creek ahead. Coho stream.');
    assert.equal(salmonWords({ sp: CHINOOK | STEELHEAD, stream: { name: 'Puyallup River' } }), 'Puyallup River ahead. Salmon stream.');
    assert.equal(salmonWords({ sp: STEELHEAD, stream: { name: 'Big Creek' } }), 'Big Creek ahead. Steelhead stream.');
    assert.equal(salmonWords({ sp: CHINOOK | STEELHEAD, stream: { name: '' } }), 'Salmon stream ahead.');
    assert.equal(oneFish(0), null);
    assert.equal(speciesList(COHO | CHINOOK | STEELHEAD), 'Coho, chinook, steelhead');
  });

  test('no dashes or emoji in what it says', () => {
    for (const s of [salmonWords({ sp: COHO, stream: { name: 'Clover Creek' } }), streamLine({ name: 'x', sp: COHO, crossings: 14 })]) assert.doesNotMatch(s, /[–—]|\p{Extended_Pictographic}/u);
    assert.equal(streamLine({ name: 'x', sp: COHO | STEELHEAD, crossings: 14 }), 'Coho, steelhead. 14 road crossings.');
    assert.equal(streamLine({ name: 'x', sp: COHO, crossings: 1 }), 'Coho. 1 road crossing.');
  });
});

describe('salmon: the cue on a drive', () => {
  test('about 10 s before a crossing, once, with the creek and the fish', () => {
    const t = tileWith([clover()]), fixes = north(35, 80);
    const coach = new LiveCoach({ salmon: src(t) }), cues = [];
    for (const f of fixes) { const c = coach.update(f); if (c) cues.push(c); }
    const fish = cues.filter((c) => c.kind === 'salmon-ahead');
    assert.equal(fish.length, 1);
    assert.equal(fish[0].say, 'Clover Creek ahead. Coho stream.');
    const f = fixes.find((q) => q.t === fish[0].at)!, s = -P.toXY([f.lon, f.lat])[1] / (35 * MPH);
    assert.ok(s >= SALMON.aheadS[0] && s <= SALMON.aheadS[1], `${s} s ahead`);
    // and the car drove over it
    assert.equal(coach.salmon.passed.length, 1);
    assert.equal(coach.salmon.passed[0].name, 'Clover Creek');
  });

  test('nothing below 15 mph, but the crossing still counts', () => {
    const t = tileWith([clover()]), coach = new LiveCoach({ salmon: src(t) });
    for (const f of north(12, 200)) assert.notEqual(coach.update(f)?.kind, 'salmon-ahead');
    assert.equal(coach.salmon.passed.length, 1);
  });

  test('a creek named in the last 2 minutes is not named again', () => {
    const t = tileWith([clover([0, 0]), clover([0, 500]), clover([0, 1000], 'Spanaway Creek')]);
    const fish = said(north(35, 120), t);
    assert.deepEqual(fish.map((c) => c.say), ['Clover Creek ahead. Coho stream.', 'Spanaway Creek ahead. Coho stream.']);
  });

  test('a crossing on a road across this one says nothing', () => {
    const t = tileWith([{ ...clover(), dir: 90 }]);
    assert.equal(said(north(35, 80), t).length, 0);
  });

  test('never over another line: busy through the window means no salmon line', () => {
    const t = tileWith([clover()]), fixes = north(35, 80), coach = new LiveCoach({ salmon: src(t) });
    // something long said just before the window opens
    const at = fixes.findIndex((f) => -P.toXY([f.lon, f.lat])[1] / (35 * MPH) <= SALMON.aheadS[1] + 1);
    for (const [k, f] of fixes.entries()) {
      if (k === at) coach.spoke('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen', f.t);
      assert.notEqual(coach.update(f)?.kind, 'salmon-ahead');
    }
  });

  test('a hard brake within 150 m of a crossing makes it not gentle', () => {
    const t = tileWith([clover()]);
    // 35 mph, then a hard stop about 100 m past the creek
    const fixes = drive(35 * MPH, [[44, 0], [4, -4]], { heading: 0, start: [0, -600] });
    const coach = new LiveCoach({ salmon: src(t) });
    for (const f of fixes) coach.update(f);
    coach.finish();
    assert.equal(coach.salmon.passed.length, 1);
    assert.ok(coach.brakeAt.length >= 1);
    const trip = salmonTrip(coach.salmon.passed, coach.brakeAt);
    assert.deepEqual([trip.crossed, trip.gentle], [1, 0]);
    assert.deepEqual(salmonTrip(coach.salmon.passed, []).gentle, 1);
  });
});

describe('salmon: quiet near a crossing, and roads beside a stream', () => {
  /** a beside stretch for the road north from y0 to y1 (local meters) */
  const besideTile = (y0: number, y1: number, name = 'Clover Creek'): Tile => {
    const raw: RawTile = { v: 1, s: [[name, COHO | STEELHEAD, 2]], l: [], c: [], b: [] };
    const a = toRegion(P.toLngLat([0, y0])), b = toRegion(P.toLngLat([0, y1]));
    raw.b.push([0, Math.round(a[0]), Math.round(a[1]), Math.round(b[0] - a[0]), Math.round(b[1] - a[1])]);
    return readTile('0_0', raw)!;
  };
  const banners = (t: Tile, fixes: Fix[]) => {
    const coach = new LiveCoach({ salmon: src(t) }), out: { say: string; y: number }[] = [];
    for (const f of fixes) {
      const c = coach.update(f);
      assert.ok(!c || c.kind === 'salmon-ahead');
      const w = coach.takeBeside(f.t);
      if (w) out.push({ say: w, y: P.toXY([f.lon, f.lat])[1] });
    }
    return out;
  };

  test('the street drain reminder waits with a crossing about 300 m ahead', () => {
    const t = tileWith([clover()]), coach = new LiveCoach({ salmon: src(t) }), near: number[] = [];
    for (const f of north(35, 80)) { coach.update(f); if (coach.salmonNear()) near.push(P.toXY([f.lon, f.lat])[1]); }
    assert.ok(near.length > 0);
    // only before the creek, and not from far off
    assert.ok(Math.min(...near) >= -SALMON.lookM - 20 && Math.min(...near) < -SALMON.pipeQuietM && Math.max(...near) < 0, `${Math.min(...near)} to ${Math.max(...near)}`);
    // a crossing on a road across this one doesn't count
    const across = new LiveCoach({ salmon: src(tileWith([{ ...clover(), dir: 90 }])) });
    for (const f of north(35, 80)) { across.update(f); assert.equal(across.salmonNear(), false); }
  });

  test('beside a stream: one quiet banner after 200 m of it, never spoken', () => {
    const got = banners(besideTile(-400, 600), north(30, 90));
    assert.deepEqual(got.map((b) => b.say), ['Beside Clover Creek. Coho stream.']);
    assert.ok(got[0].y >= -400 - SALMON.besideM + SALMON.besideShowM - 10, `${got[0].y}`);
  });

  test('a short stretch beside a stream shows nothing', () => {
    assert.equal(banners(besideTile(0, 100), north(30, 90)).length, 0);
  });

  test('beside words', () => {
    assert.equal(besideWords({ name: 'Clover Creek', sp: COHO | STEELHEAD }), 'Beside Clover Creek. Coho stream.');
    assert.equal(besideWords({ name: '', sp: STEELHEAD }), 'Beside a steelhead stream.');
    assert.equal(besideWords({ name: 'Puyallup River', sp: CHINOOK | STEELHEAD }), 'Beside Puyallup River. Salmon stream.');
    assert.doesNotMatch(besideWords({ name: '', sp: 0 }), /[–—]/);
  });
});

describe('salmon: the report row and the map', () => {
  test('the report replays a drive over its crossings', () => {
    const t = tileWith([clover([0, 0]), clover([0, 400], 'Spanaway Creek', CHINOOK)]);
    const trip = tripOver([t], north(30, 90), []);
    const { streams, ...rest } = trip;
    assert.deepEqual(rest, { crossed: 2, gentle: 2, names: ['Clover Creek', 'Spanaway Creek'], sp: COHO | STEELHEAD | CHINOOK, besideMi: 0 });
    // one per stream, for the share card
    assert.deepEqual(streams.map((c) => c.name), ['Clover Creek', 'Spanaway Creek']);
    assert.deepEqual(salmonRowWords(trip), { line: 'Crossed salmon streams 2 times, all gently', sub: 'Clover Creek and Spanaway Creek' });
    assert.ok(routeTiles([[0, 0]]).has('0_0'));
  });

  test('row words for one crossing, gentle or not, and none', () => {
    const t = (o: Partial<SalmonTrip>): SalmonTrip => ({ crossed: 0, gentle: 0, names: [], sp: COHO, besideMi: 0, streams: [], ...o });
    assert.deepEqual(salmonRowWords(t({ crossed: 1, gentle: 1, names: ['Clover Creek'] })), { line: 'Crossed Clover Creek gently', sub: 'Coho' });
    assert.deepEqual(salmonRowWords(t({ crossed: 1 })), { line: 'Hard brake near a coho stream', sub: 'Coho. Ease off sooner there.' });
    assert.equal(salmonRowWords(t({ sp: 0 })), null);
    assert.equal(salmonRowWords(t({ crossed: 4, gentle: 3, names: ['A Creek', 'B Creek', 'C Creek'] }))!.sub, 'A Creek, B Creek and 1 more');
    assert.deepEqual(salmonRowWords(t({ besideMi: 0.64, names: ['Clover Creek'] })), { line: 'Drove 0.6 mi beside salmon streams', sub: 'Clover Creek' });
  });

  test('miles on a road beside a stream count', () => {
    const raw: RawTile = { v: 1, s: [['Clover Creek', COHO, 2]], l: [], c: [], b: [] };
    const a = toRegion(P.toLngLat([0, -600])), b = toRegion(P.toLngLat([0, 600]));
    raw.b.push([0, Math.round(a[0]), Math.round(a[1]), Math.round(b[0] - a[0]), Math.round(b[1] - a[1])]);
    const trip = tripOver([readTile('0_0', raw)!], north(30, 90), []);
    assert.equal(trip.crossed, 0);
    assert.ok(Math.abs(trip.besideMi - 1200 / 1609.344) < 0.05, `${trip.besideMi}`);
    assert.deepEqual(trip.names, ['Clover Creek']);
  });

  test('the map draws a salmon stream as bright water with coral flecks, not the street coral', () => {
    const sw = swatchSVG('salmon', 'region');
    assert.ok(sw.includes(`fill="${SALMON_WATER}"`) && sw.includes(`fill="${CORAL}"`));
    assert.notEqual(SALMON_WATER, CAT.creek);
    assert.equal(swatchSVG('creek', 'region').includes(SALMON_WATER), false);
  });

  test('the stream card: one pixel fish per species, in order', () => {
    assert.deepEqual(speciesIn(STEELHEAD | COHO | CHINOOK).map((s) => s.word), ['coho', 'chinook', 'steelhead']);
    const a = speciesSVG(COHO), b = speciesSVG(STEELHEAD);
    assert.match(a, /shape-rendering="crispEdges"/);
    assert.notEqual(a, b);
  });

  test('a tap finds the stream under it', () => {
    const t = tileWith([clover()]), c = t.crossings[0].at;
    assert.equal(streamAt([t], [c[0] + 100, c[1] + 8], 10)?.name, 'Clover Creek');
    assert.equal(streamAt([t], [c[0] + 100, c[1] + 30], 10), null);
  });

  test('tiles load by area, and a bad file is skipped', async () => {
    const files: Record<string, unknown> = { 'x/index.json': { v: 1, tile: 25600, tiles: ['0_0', '1_0'], streams: 1, crossings: 1, miles: 1, source: '', built: '' }, 'x/t/0_0.json': { v: 1, s: [['A', 1, 1]], l: [[0, 0, 0, 10, 0]], c: [[5, 0, 0, 0, 1]], b: [] }, 'x/t/1_0.json': { v: 2 } };
    const d = new SalmonData('x/', async (u) => { if (!(u in files)) throw new Error('404'); return files[u]; });
    const got = await d.some(['0_0', '1_0', '9_9']);
    assert.equal(got.length, 1);
    assert.equal(got[0].crossings[0].stream.name, 'A');
    assert.equal(d.near(0, 0, 10, 10).length, 1);
  });
});

describe('salmon: the built files', { skip: !existsSync('public/data/salmon/index.json') }, () => {
  test('small enough, statewide, with names', () => {
    const idx = JSON.parse(readFileSync('public/data/salmon/index.json', 'utf8'));
    let bytes = statSync('public/data/salmon/index.json').size + statSync('public/data/salmon/far.json').size + statSync('public/data/salmon/mid.json').size;
    for (const f of readdirSync('public/data/salmon/t')) bytes += statSync(`public/data/salmon/t/${f}`).size;
    assert.ok(bytes < 6e6, `${bytes} bytes`);
    assert.equal(idx.tiles.length, readdirSync('public/data/salmon/t').length);
    assert.ok(idx.crossings > 5000 && idx.streams > 3000);
    // Clover Creek, Pierce County: a WDFW coho stream that roads cross
    const k = idx.tiles.find((key: string) => { const [x, y] = key.split('_').map(Number), p = toRegion([-122.43, 47.13]); return Math.floor(p[0] / 25600) === x && Math.floor(p[1] / 25600) === y; });
    const t = readTile(k, JSON.parse(readFileSync(`public/data/salmon/t/${k}.json`, 'utf8')))!;
    const clover = t.crossings.filter((c) => c.stream.name === 'Clover Creek');
    assert.ok(clover.length >= 3 && clover.every((c) => c.stream.sp & COHO));
  });
});
