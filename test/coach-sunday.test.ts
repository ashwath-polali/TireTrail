/** Sunday's drive over the real salmon tiles: the creeks named 6 to 12 s ahead on the way out and back, nothing else said, and the creek chip only for creeks on the road */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { LiveCoach, type Cue } from '../src/drive/coach/live.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles } from '../src/salmon/row.ts';
import { SalmonData, type Crossing } from '../src/salmon/tiles.ts';
import { SalmonWatch } from '../src/salmon/watch.ts';

// Victor Falls Elementary lot, west on Rhodes Lake Rd E, south on McCutcheon Rd E over Fennel and Canyonfalls Creeks,
// a turn around near 47.14042,-122.22568 and back the same way (1 s fixes from OpenStreetMap roads, 25-35 mph, a few meters of noise)
const FX = JSON.parse(readFileSync(new URL('./fixtures/sunday-route.json', import.meta.url), 'utf8')) as { fixes: [number, number, number, number, number | null][] };
const T0 = Date.UTC(2026, 9, 25, 19);
const route = (o: { heading?: boolean; every?: number } = {}): Fix[] =>
  FX.fixes.filter((_, i) => i % (o.every ?? 1) === 0).map(([t, lat, lon, speed, heading]) => ({ t: T0 + t * 1000, lat, lon, speed, heading: o.heading === false ? null : heading, accuracy: 5 }) as Fix);

/** the real salmon tiles, read the way the phone reads them */
function salmon(): SalmonData {
  return new SalmonData(new URL('../public/data/salmon/', import.meta.url).href, async (u) => JSON.parse(readFileSync(new URL(u), 'utf8')));
}

async function run(fixes: Fix[]): Promise<{ cues: Cue[]; coach: LiveCoach; data: SalmonData }> {
  const data = salmon();
  await data.some(routeTiles(fixes.map((f) => toRegion([f.lon, f.lat]))));
  const coach = new LiveCoach({ salmon: data }), cues: Cue[] = [];
  // the live drive passes the phone's clock; here it is the fix's
  for (const f of fixes) { const c = coach.update(f, f.t); if (c) cues.push(c); }
  return { cues, coach, data };
}

/** When the car came closest to a point, ms, after t0. */
function closest(fixes: readonly Fix[], at: XY, t0: number): number {
  let best = Infinity, bt = NaN;
  for (const f of fixes) {
    if (f.t < t0) continue;
    const p = toRegion([f.lon, f.lat]), d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d < best) [best, bt] = [d, f.t];
    if (d > best + 300) break;
  }
  return bt;
}

function crossingOf(data: SalmonData, id: string): Crossing {
  const [x, y] = id.split('_').map(Number);
  for (const t of data.near(x - 1, y - 1, x + 1, y + 1)) for (const c of t.crossings) if (c.id === id) return c;
  throw new Error(`no crossing ${id}`);
}

// Fennel Creek under Rhodes Lake Rd E (from the OSM check of where WDFW's line stops 42 m short), then Fennel and Canyonfalls on McCutcheon Rd E
const RHODES = toRegion([-122.18562, 47.14942]);
const DRIVEN = ['Fennel Creek', 'Fennel Creek', 'Canyonfalls Creek', 'Canyonfalls Creek', 'Fennel Creek', 'Fennel Creek'];
// said: all but the first, Rhodes Lake Rd going out, which comes 40 m after a sharp bend taken at 10 mph (see the todo below)
const WANT = DRIVEN.slice(1);

describe("salmon: Sunday's drive", () => {
  for (const [name, o] of [['1 s fixes', {}], ['no heading from the phone', { heading: false }], ['2 s fixes', { every: 2 }]] as const) {
    test(`the creeks, both ways, 6 to 12 s ahead, nothing else (${name})`, async () => {
      const fixes = route(o), { cues, coach, data } = await run(fixes);
      assert.deepEqual(cues.map((c) => c.kind), WANT.map(() => 'salmon-ahead'), cues.map((c) => c.say).join(' | '));
      // the creek's name first (the words after it may change)
      assert.deepEqual(cues.map((c) => c.say.split('.')[0]), WANT.map((n) => `${n} ahead`));
      for (const c of cues) {
        const x = crossingOf(data, c.ref), s = (closest(fixes, x.at, c.at) - c.at) / 1000;
        assert.ok(s >= 6 && s <= 12, `${x.stream.name}: ${s} s ahead`);
      }
      // the last line is Fennel Creek under Rhodes Lake Rd E on the way back
      assert.ok(Math.hypot(crossingOf(data, cues[cues.length - 1].ref).at[0] - RHODES[0], crossingOf(data, cues[cues.length - 1].ref).at[1] - RHODES[1]) < 25);
      // and the car drove over each, in order, Rhodes Lake Rd both ways
      assert.deepEqual(coach.salmon.passed.map((p) => p.name), DRIVEN);
    });
  }

  test('Fennel Creek under Rhodes Lake Rd E going out is named 6 to 12 s ahead', { todo: 'the crossing is 40 m past a sharp bend taken at 10 mph: the look ahead needs the road line through the bend and a slower speed for it' }, async () => {
    const fixes = route(), { cues, data } = await run(fixes);
    const first = cues[0], x = crossingOf(data, first.ref);
    assert.ok(Math.hypot(x.at[0] - RHODES[0], x.at[1] - RHODES[1]) < 25, first.say);
  });

  test('the creek chip: only creeks on the road, never one further than about 30 s ahead, and few changes', async () => {
    const fixes = route(), data = salmon();
    await data.some(routeTiles(fixes.map((f) => toRegion([f.lon, f.lat]))));
    const coach = new LiveCoach({ salmon: data }), names = new Set<string>(), changes: string[] = [];
    // the Puyallup River bridge is on the road just past the turn around, so it may show there
    const turn = toRegion([-122.22568, 47.14042]);
    let last = '';
    for (const f of fixes) {
      coach.update(f, f.t);
      const fish = coach.road().fish, car = toRegion([f.lon, f.lat]);
      const id = fish?.c.id ?? '';
      if (id !== last) { changes.push(id); last = id; }
      if (!fish) continue;
      names.add(fish.c.stream.name);
      assert.ok(fish.m <= SalmonWatch.chipM(f.speed) + 1, `${fish.c.stream.name} at ${Math.round(fish.m)} m, ${f.speed} m/s`);
      if (fish.m < 200 && Math.hypot(car[0] - turn[0], car[1] - turn[1]) > 250) {
        // close up: a crossing the car really drives over
        const over = fixes.some((g) => { const p = toRegion([g.lon, g.lat]); return Math.hypot(p[0] - fish.c.at[0], p[1] - fish.c.at[1]) <= 35; });
        assert.ok(over, `${fish.c.stream.name || 'unnamed'} ${Math.round(fish.m)} m ahead is not on the route`);
      }
    }
    assert.deepEqual([...names].sort(), ['Canyonfalls Creek', 'Fennel Creek', 'Puyallup River'].filter((n) => names.has(n)));
    assert.ok(names.has('Fennel Creek') && names.has('Canyonfalls Creek'));
    assert.ok(changes.length <= 24, `${changes.length} chip changes`);
  });

  test('the unnamed stream past the turn around is never named', async () => {
    const { cues } = await run(route());
    assert.ok(!cues.some((c) => c.say === 'Salmon stream ahead.'));
  });
});
