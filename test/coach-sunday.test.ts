/** Sunday's drive over the real salmon tiles: both creeks named 6 to 12 s ahead on the way out and back, nothing else said */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { LiveCoach, type Cue } from '../src/drive/coach/live.ts';
import type { Fix } from '../src/drive/types.ts';
import type { XY } from '../src/geo/geo.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles } from '../src/salmon/row.ts';
import { SalmonData, type Crossing } from '../src/salmon/tiles.ts';

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

const WANT = ['Fennel Creek', 'Canyonfalls Creek', 'Canyonfalls Creek', 'Fennel Creek'];

describe("salmon: Sunday's drive", () => {
  for (const [name, o] of [['1 s fixes', {}], ['no heading from the phone', { heading: false }], ['2 s fixes', { every: 2 }]] as const) {
    test(`both creeks, both ways, 6 to 12 s ahead, nothing else (${name})`, async () => {
      const fixes = route(o), { cues, coach, data } = await run(fixes);
      assert.deepEqual(cues.map((c) => c.kind), ['salmon-ahead', 'salmon-ahead', 'salmon-ahead', 'salmon-ahead'], cues.map((c) => c.say).join(' | '));
      assert.deepEqual(cues.map((c) => c.say), WANT.map((n) => `${n} ahead. Coho stream.`));
      for (const c of cues) {
        const x = crossingOf(data, c.ref), s = (closest(fixes, x.at, c.at) - c.at) / 1000;
        assert.ok(s >= 6 && s <= 12, `${x.stream.name}: ${s} s ahead`);
      }
      // and the car drove over each, in order
      assert.deepEqual(coach.salmon.passed.map((p) => p.name), WANT);
    });
  }

  test('the unnamed stream past the turn around is never named', async () => {
    const { cues } = await run(route());
    assert.ok(!cues.some((c) => c.say === 'Salmon stream ahead.'));
  });
});
