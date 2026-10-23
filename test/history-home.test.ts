/** My drives home: creek cards, crossing places, the month, and the hero's words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { creekPlaces, creekShelf, creeksFrom, monthStart, monthStats, type Crossing } from '../src/drive/creeks.ts';
import { weekStart } from '../src/drive/gas.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { changeLine, creekCardLine, creekTimes, driveTitle, heroLine, monthLine, roadsLine, HABITAT } from '../src/app/screens/history-words.ts';
import { routeThumb, spotThumb } from '../src/app/screens/history-scene.ts';

const DASHES = /[–—]/;
const CLOVER: LngLat = [-122.43, 47.12], MOREY: LngLat = [-122.45, 47.11];
const at = (y: number, m: number, d: number, hr = 8) => new Date(y, m, d, hr).getTime();
const cross = (name: string, ll: LngLat, gentle: boolean, sp = 0): Crossing => ({ name, ll, gentle, sp });

describe('creek cards and pages', () => {
  const by: Record<number, Crossing[]> = {
    [at(2026, 9, 13)]: [cross('Morey Creek', MOREY, true, 1)],
    [at(2026, 9, 19)]: [cross('Clover Creek', CLOVER, false, 1), cross('Morey Creek', MOREY, true, 32)],
    [at(2026, 9, 20)]: [cross('Clover Creek', [CLOVER[0] + 0.003, CLOVER[1]], true, 3)],
  };
  const of = (t: number) => by[t] ?? null;
  const drives = Object.keys(by).map((t) => ({ at: +t }));

  test('each creek keeps its crossings in order and the species seen', () => {
    const cs = creeksFrom(drives, of), clover = cs.find((c) => c.name === 'Clover Creek')!, morey = cs.find((c) => c.name === 'Morey Creek')!;
    assert.deepEqual(clover.marks.map((m) => m.gentle), [false, true]);
    assert.equal(clover.sp, 3);
    assert.equal(morey.sp, 33);
    // the shelf: most recent crossing first
    assert.deepEqual(creekShelf(cs).map((c) => c.name), ['Clover Creek', 'Morey Creek']);
  });

  test('one creek crossed in two places shows two flags', () => {
    const clover = creeksFrom(drives, of).find((c) => c.name === 'Clover Creek')!;
    assert.deepEqual(creekPlaces(clover).map((p) => [p.times, p.gentle]), [[1, 0], [1, 1]]);
  });

  test('a month counts drives and crossings from its first day', () => {
    const m = monthStats(drives, monthStart(at(2026, 9, 22)), of);
    assert.deepEqual([m.drives, m.crossed, m.gentle], [3, 4, 3]);
    assert.equal(monthStats(drives, monthStart(at(2026, 8, 10)), of).drives, 0);
    assert.equal(new Date(monthStart(at(2026, 9, 22))).getDate(), 1);
  });
});

describe('home words', () => {
  const now = at(2026, 9, 22, 12), mon = weekStart(now);

  test('the hero line names the week and counts creeks', () => {
    assert.equal(heroLine({ drives: 3, known: 3, crossed: 7, gentle: 6 }, mon, now), 'This week: gentle at 6 of 7 salmon creeks.');
    assert.equal(heroLine({ drives: 3, known: 3, crossed: 7, gentle: 7 }, mon, now), 'This week: gentle at all 7 salmon creeks.');
    assert.equal(heroLine({ drives: 1, known: 1, crossed: 1, gentle: 1 }, mon, now), 'This week: gentle at your one salmon creek.');
    assert.equal(heroLine({ drives: 0, known: 0, crossed: 0, gentle: 0 }, mon, now), 'No drives yet this week.');
    assert.equal(heroLine({ drives: 2, known: 0, crossed: 0, gentle: 0 }, mon, now), 'Finding the salmon creeks on your drives.');
    assert.equal(heroLine({ drives: 2, known: 2, crossed: 0, gentle: 0 }, mon, now), 'This week: no salmon creeks on your drives.');
    assert.match(heroLine({ drives: 2, known: 2, crossed: 3, gentle: 1 }, mon - 7 * 86_400_000, now), /^Last week: /);
  });

  test('the change only when it went up', () => {
    assert.equal(changeLine(6, 4, mon, now), '2 more than last week.');
    assert.equal(changeLine(4, 6, mon, now), null);
    assert.equal(changeLine(4, 4, mon, now), null);
    assert.equal(changeLine(4, null, mon, now), null);
  });

  test('the month, with last month when there was one', () => {
    assert.equal(monthLine({ start: at(2026, 9, 1), gentle: 32, crossed: 35 }, { start: at(2026, 8, 1), gentle: 24, crossed: 30 }), 'October: 32 gentle creek crossings. September: 24.');
    assert.equal(monthLine({ start: at(2026, 9, 1), gentle: 1, crossed: 1 }, null), 'October: 1 gentle creek crossing.');
    assert.equal(monthLine({ start: at(2026, 9, 1), gentle: 0, crossed: 0 }, null), null);
  });

  test('drive titles, creek cards and the creek page', () => {
    assert.equal(driveTitle({ mi: 3.5 }, [{ name: '' }, { name: 'Clover Creek' }]), 'The Clover Creek drive');
    assert.equal(driveTitle({ mi: 3.5, ways: ['Pacific Ave S'] }, []), 'The Pacific Ave S drive');
    assert.equal(driveTitle({ mi: 3.5 }, null), 'A 3.5 mi drive');
    assert.equal(creekCardLine({ times: 7, gentle: 6 }), 'Gentle 6 of 7');
    assert.equal(creekCardLine({ times: 7, gentle: 7 }), 'Gentle all 7 times');
    assert.equal(creekCardLine({ times: 1, gentle: 0 }), 'Hard brake near');
    assert.equal(creekTimes({ times: 6, gentle: 5 }), 'You crossed it 6 times. 5 were gentle.');
    assert.equal(creekTimes({ times: 1, gentle: 1 }), 'You crossed it once, gently.');
    assert.equal(roadsLine(1400), 'Roads cross it in 1,400 places in Washington.');
    assert.equal(roadsLine(1), null);
    for (const s of [HABITAT, creekTimes({ times: 2, gentle: 0 }), heroLine({ drives: 1, known: 1, crossed: 2, gentle: 1 }, mon, now)]) assert.doesNotMatch(s, DASHES);
  });
});

describe('little maps', () => {
  test('a route draws on whole pixels with a square at each creek', () => {
    const svg = routeThumb([CLOVER, MOREY, [-122.46, 47.1]], [{ ll: CLOVER, gentle: true }, { ll: MOREY, gentle: false }]);
    assert.match(svg, /^<svg class="my-thumb"/);
    assert.equal((svg.match(/fill="#8fe38a"/g) ?? []).length, 1);
    assert.equal((svg.match(/fill="#ffb547"/g) ?? []).length, 1);
    assert.doesNotMatch(svg, /\d\.\d/);
    // no route: just the dots
    assert.doesNotMatch(routeThumb([], []), /<path/);
  });

  test('the spot sits in the middle of its map', () => {
    const svg = spotThumb(CLOVER, [[[CLOVER[0] - 0.01, CLOVER[1]], [CLOVER[0] + 0.01, CLOVER[1]]]], [], 120, 88);
    assert.match(svg, /<rect x="47" y="31" width="26" height="26"/);
    assert.match(svg, /<path d="M/);
  });
});

describe('PixelLab art', () => {
  test('the drives and home pictures ship in public/art', async () => {
    const { existsSync } = await import('node:fs');
    const files = ['drives/creek-scene.png', 'drives/creek-card.png', 'home/icon-rain.png', 'home/icon-heavy-rain.png', 'home/icon-spawning.png',
      ...['coho', 'chinook', 'chum', 'pink', 'sockeye', 'steelhead'].map((f) => `drives/fish-${f}.png`)];
    for (const f of files) assert.ok(existsSync(new URL(`../public/art/${f}`, import.meta.url)), f);
  });
});
