/** My drives home: creeks, crossing places, the month, drive names and the hero's words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { creekPlaces, creeksFrom, monthStart, monthStats, type Crossing } from '../src/drive/creeks.ts';
import { weekStart } from '../src/drive/gas.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { changeLine, COHO_KEY, creekTimes, driveCreeks, driveWhat, heroLine, monthLine, roadsLine, shareHead, watchWords, weekGist, weekMore, whenName, HABITAT } from '../src/app/screens/history-words.ts';
import { streamKind } from '../src/app/screens/creek.ts';

const DASHES = /[–—]/;
const CLOVER: LngLat = [-122.43, 47.12], MOREY: LngLat = [-122.45, 47.11];
const at = (y: number, m: number, d: number, hr = 8) => new Date(y, m, d, hr).getTime();
const cross = (name: string, ll: LngLat, gentle: boolean, sp = 0): Crossing => ({ name, ll, gentle, sp });

describe('creeks and their pages', () => {
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

  test('the hero line names the week and counts times crossed, never creeks', () => {
    assert.equal(heroLine({ drives: 3, known: 3, crossed: 9, gentle: 8 }, mon, now), 'This week: gentle 8 of 9 times you crossed a salmon creek.');
    assert.equal(heroLine({ drives: 3, known: 3, crossed: 9, gentle: 9 }, mon, now), 'This week: gentle all 9 times you crossed a salmon creek.');
    assert.equal(heroLine({ drives: 1, known: 1, crossed: 1, gentle: 1 }, mon, now), 'This week: you crossed a salmon creek once, gently.');
    assert.equal(heroLine({ drives: 1, known: 1, crossed: 1, gentle: 0 }, mon, now), 'This week: a hard brake near the one salmon creek you crossed.');
    assert.equal(heroLine({ drives: 0, known: 0, crossed: 0, gentle: 0 }, mon, now), 'No drives yet this week.');
    assert.equal(heroLine({ drives: 2, known: 0, crossed: 0, gentle: 0 }, mon, now), 'Finding the salmon creeks on your drives.');
    assert.equal(heroLine({ drives: 2, known: 2, crossed: 0, gentle: 0 }, mon, now), 'This week: no salmon creeks on your drives.');
    assert.match(heroLine({ drives: 2, known: 2, crossed: 3, gentle: 1 }, mon - 7 * 86_400_000, now), /^Last week: /);
    // 3 creeks crossed 3 times each is 9 crossings: never "9 salmon creeks"
    for (let n = 2; n < 20; n++) for (const g of [0, 1, n]) {
      const line = heroLine({ drives: 3, known: 3, crossed: n, gentle: g }, mon, now);
      assert.doesNotMatch(line, /\d+ salmon creeks/, line);
      assert.match(line, /times you crossed/, line);
    }
    assert.equal(COHO_KEY, 'Each coho is one gentle crossing.');
    assert.equal(weekGist({ drives: 1, known: 1, crossed: 0, gentle: 0 }), null);
  });

  test('the share card says the same as the hero, with no street', () => {
    assert.equal(shareHead({ drives: 3, known: 3, crossed: 9, gentle: 9 }), 'Gentle all 9 times you crossed a salmon creek.');
    assert.equal(shareHead({ drives: 1, known: 1, crossed: 1, gentle: 1 }), 'You crossed a salmon creek once, gently.');
  });

  test('the week beyond salmon: fewer hard brakes first, then gas, then none at all', () => {
    const gas = { text: 'about 20¢', hard: true, speed: false };
    assert.equal(weekMore({ drives: 3, hardBrakes: 0, gas }, { drives: 2, hardBrakes: 4 }), 'Hard brakes: 0 this week, down from 4.');
    assert.equal(weekMore({ drives: 3, hardBrakes: 2, gas }, { drives: 2, hardBrakes: 1 }), 'This week, about 20¢ of each gallon went to hard brakes and fast starts.');
    assert.equal(weekMore({ drives: 1, hardBrakes: 0, gas: null }, null), 'No hard brakes this week.');
    assert.equal(weekMore({ drives: 1, hardBrakes: 2, gas: null }, null), null);
    assert.equal(weekMore({ drives: 0, hardBrakes: 0, gas: null }, null), null);
  });

  test('next time: the spot as one thing to do', () => {
    assert.deepEqual(watchWords({ name: '138th St S at Pacific Ave S', count: 3 }), {
      line: 'Next time, ease off at 138th St S at Pacific Ave S.',
      sub: 'You braked hard there 3 times. The voice warns you before you get there.',
    });
    assert.equal(watchWords({ name: '', count: 1 }).sub, 'You braked hard there once. The voice warns you before you get there.');
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

  test('drive names: when and which trip, so no two read the same', () => {
    const tue = at(2026, 9, 20, 13) + 59 * 60_000;
    assert.equal(whenName(tue, now), 'Tuesday, 1:59 PM');
    assert.equal(whenName(at(2026, 9, 22, 9), now), 'Today, 9:00 AM');
    assert.equal(whenName(at(2026, 9, 21, 16), now), 'Yesterday, 4:00 PM');
    assert.equal(whenName(at(2026, 9, 2, 8), now), 'Oct 2, 8:00 AM');
    assert.equal(whenName(at(2025, 9, 2, 8), now), 'Oct 2, 2025, 8:00 AM');
    assert.equal(driveWhat({ mi: 3.5, ways: ['Pacific Ave S'] }, 'Your 138th St S trip'), 'Your 138th St S trip');
    assert.equal(driveWhat({ mi: 3.5, ways: ['Pacific Ave S'] }, null), 'On Pacific Ave S');
    assert.equal(driveWhat({ mi: 3.5 }, null), 'A 3.5 mi drive');
  });

  test("a drive's creeks count by creek, as the report does", () => {
    const c = (name: string, gentle: boolean, ll: LngLat = CLOVER) => ({ name, ll, gentle });
    assert.deepEqual(driveCreeks([c('Clover Creek', true), c('Clover Creek', true, MOREY), c('Morey Creek', true, MOREY)]), { text: 'Gentle at all 2 salmon creeks', gentle: true });
    assert.deepEqual(driveCreeks([c('Clover Creek', true), c('Spanaway Creek', false), c('Morey Creek', true)]), { text: 'Gentle at 2 of 3 salmon creeks', gentle: false });
    assert.deepEqual(driveCreeks([c('Clover Creek', false)]), { text: 'Hard brake near a salmon creek', gentle: false });
    assert.deepEqual(driveCreeks([]), { text: 'No salmon creeks', gentle: true });
    assert.equal(driveCreeks(null), null);
  });

  test('the creek page in one line', () => {
    assert.equal(streamKind(1), 'Coho stream');
    assert.equal(streamKind(1 | 2 | 32), 'Coho, chinook and steelhead stream');
    assert.equal(streamKind(0), 'Salmon stream');
    assert.equal(creekTimes({ times: 6, gentle: 5 }), 'You crossed it 6 times. 5 were gentle.');
    assert.equal(creekTimes({ times: 1, gentle: 1 }), 'You crossed it once, gently.');
    assert.equal(roadsLine(1400), 'Roads cross it in 1,400 places in Washington.');
    assert.equal(roadsLine(1), null);
    for (const s of [HABITAT, creekTimes({ times: 2, gentle: 0 }), heroLine({ drives: 1, known: 1, crossed: 2, gentle: 1 }, mon, now)]) assert.doesNotMatch(s, DASHES);
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
