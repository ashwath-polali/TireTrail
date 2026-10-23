/** My drives: creeks across drives, one week against the week before, and the words for them */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { creeksFrom, creekTone, weekAfter, weekBefore, weeksOf, weekStats, type Crossing } from '../src/drive/creeks.ts';
import { weekStart } from '../src/drive/gas.ts';
import type { LngLat } from '../src/geo/geo.ts';
import { creekLine, driveName, moreLines, salmonLine, signedOutLine, weekLabel, weekSentence } from '../src/app/screens/history-words.ts';
import { crossingsOver } from '../src/app/screens/history-creeks.ts';
import { toRegion } from '../src/salmon/proj.ts';
import type { Tile } from '../src/salmon/tiles.ts';

const DASHES = /[–—]/;
const CLOVER: LngLat = [-122.43, 47.12], MOREY: LngLat = [-122.45, 47.11];
const at = (y: number, m: number, d: number, hr = 8) => new Date(y, m, d, hr).getTime();
const cross = (name: string, ll: LngLat, gentle: boolean): Crossing => ({ name, ll, gentle });

describe('creeks across drives', () => {
  const by: Record<number, Crossing[]> = {
    [at(2026, 9, 19)]: [cross('Clover Creek', CLOVER, true), cross('Morey Creek', MOREY, false)],
    // the same creek 100 m on is the same place
    [at(2026, 9, 20)]: [cross('Clover Creek', [CLOVER[0] + 0.001, CLOVER[1]], true)],
    [at(2026, 9, 13)]: [cross('Morey Creek', MOREY, true), cross('', [-122.5, 47.2], true)],
  };
  const of = (t: number) => by[t] ?? null;
  const drives = Object.keys(by).map((t) => ({ at: +t }));

  test('grouped by place, most crossed first, gentle counted', () => {
    const cs = creeksFrom(drives, of);
    assert.deepEqual(cs.map((c) => [c.name, c.times, c.gentle]), [['Clover Creek', 2, 2], ['Morey Creek', 2, 1], ['', 1, 1]]);
    assert.deepEqual(cs.map(creekTone), ['gentle', 'mixed', 'gentle']);
  });

  test('weeks: this one, then each earlier week with a drive', () => {
    const now = at(2026, 9, 22, 12), mon = weekStart(now);
    assert.deepEqual(weeksOf(drives, now), [mon, weekBefore(mon)]);
    // with no drive this week, this week still comes first
    assert.deepEqual(weeksOf(drives, at(2026, 9, 29)), [weekAfter(mon), mon, weekBefore(mon)]);
    assert.equal(weekAfter(weekBefore(mon)), mon);
    // a week that falls over the time change still starts on Monday at midnight
    const nov = weekBefore(weekStart(at(2026, 10, 3)));
    assert.equal(new Date(nov).getDay(), 1);
    assert.equal(new Date(nov).getHours(), 0);
  });

  test('a week: its drives, crossings and hard brakes; drives without crossings yet do not count as none', () => {
    const sums = [
      { at: at(2026, 9, 19), mi: 3, hardBrakes: 2, fastStarts: 1, dustMg: 300, typMg: 400 },
      { at: at(2026, 9, 20), mi: 2, hardBrakes: 0, dustMg: 100, typMg: 100 },
      { at: at(2026, 9, 21), mi: 1, hardBrakes: 1 },
    ];
    const w = weekStats(sums, weekStart(at(2026, 9, 19)), of);
    assert.equal(w.drives.length, 3);
    assert.deepEqual([w.known, w.crossed, w.gentle, w.hardBrakes, w.fastStarts], [2, 3, 2, 3, 1]);
    assert.deepEqual(w.dust, { mg: 400, typMg: 500 });
    assert.equal(w.drives[0].at, at(2026, 9, 21));
  });
});

describe('a drive over a salmon crossing', () => {
  const c = toRegion(CLOVER);
  const tile: Tile = { key: 't', lines: [], beside: [], crossings: [{ id: 'c1', at: c, dir: 90, sp: 1, stream: { name: 'Clover Creek', sp: 1, crossings: 1 } }] };
  // west to east over the crossing, a fix every 10 m
  const route = Array.from({ length: 41 }, (_, i) => ({ ll: [CLOVER[0] - 0.0027 + i * 0.000135, CLOVER[1]] as LngLat, t: i * 1000 }));
  test('crossed gently without a hard brake near', () => {
    const [x] = crossingsOver([tile], route, []);
    assert.equal(x.name, 'Clover Creek');
    assert.equal(x.gentle, true);
  });
  test('a hard brake within 150 m makes it not gentle; farther does not', () => {
    assert.equal(crossingsOver([tile], route, [[CLOVER[0] + 0.001, CLOVER[1]]])[0].gentle, false);
    assert.equal(crossingsOver([tile], route, [[CLOVER[0] + 0.004, CLOVER[1]]])[0].gentle, true);
  });
});

describe('My drives words, by week', () => {
  test('the week names', () => {
    const now = at(2026, 9, 22, 12), mon = weekStart(now);
    assert.equal(weekLabel(mon, now), 'This week');
    assert.equal(weekLabel(weekBefore(mon), now), 'Last week');
    assert.equal(weekLabel(weekBefore(weekBefore(mon)), now), 'Oct 5 to 11');
    assert.equal(weekLabel(weekStart(at(2026, 8, 30)), now), 'Sep 28 to Oct 4');
  });

  test('one sentence for the week', () => {
    assert.equal(weekSentence({ drives: 4, known: 4, crossed: 7, gentle: 6 }, true), 'Gentle at 6 of 7 creek crossings.');
    assert.equal(weekSentence({ drives: 4, known: 4, crossed: 7, gentle: 7 }, true), 'Gentle at all 7 creek crossings.');
    assert.equal(weekSentence({ drives: 1, known: 1, crossed: 1, gentle: 1 }, true), 'Gentle at your one creek crossing.');
    assert.equal(weekSentence({ drives: 2, known: 2, crossed: 0, gentle: 0 }, true), 'No salmon creeks on these drives.');
    assert.equal(weekSentence({ drives: 2, known: 0, crossed: 0, gentle: 0 }, true), 'Finding the salmon creeks on your drives.');
    assert.equal(weekSentence({ drives: 0, known: 0, crossed: 0, gentle: 0 }, true), 'No drives yet this week.');
    assert.equal(weekSentence({ drives: 0, known: 0, crossed: 0, gentle: 0 }, false), 'No drives that week.');
  });

  test('creeks, the spot, drive names and the signed-out line', () => {
    assert.equal(creekLine({ name: 'Clover Creek', times: 6, gentle: 6 }), 'Clover Creek: gentle all 6 times');
    assert.equal(creekLine({ name: 'Spanaway Creek', times: 6, gentle: 3 }), 'Spanaway Creek: gentle 3 of 6 times');
    assert.equal(creekLine({ name: '', times: 1, gentle: 0 }), 'A salmon stream: a hard brake near it');
    assert.equal(driveName({ mi: 3.5, ways: ['176th St E'] }, [{ name: '' }, { name: 'Clover Creek' }]), 'Clover Creek');
    assert.equal(driveName({ mi: 3.5, ways: ['176th St E'] }, []), '176th St E');
    assert.equal(driveName({ mi: 3.5 }, null), '3.5 mi drive');
    assert.equal(signedOutLine(3), '3 drives on this phone. Sign in to see them on the map.');
    assert.equal(signedOutLine(0), 'Sign in to see your drives on the map.');
    assert.equal(salmonLine({ gentle: 5, water: 'North Fork Clover Creek', local: false }), 'You stopped gently 5 times on streets that drain to North Fork Clover Creek.');
    assert.equal(salmonLine({ gentle: 1, water: null, local: false }), 'You stopped gently once on streets that drain to a salmon creek.');
  });

  test('More: plain lines, the week before, estimates in words', () => {
    const gas = { text: 'about 20¢', amount: '20¢', habits: 'Fast starts and hard brakes' };
    const m = moreLines({ hardBrakes: 4, fastStarts: 1, dust: { mg: 700, typMg: 1000 }, gas }, { hardBrakes: 9, gas: { amount: '45¢' } });
    assert.equal(m.brakes, '4 hard brakes, 1 fast start. The week before: 9.');
    assert.equal(m.gas, 'Fast starts and hard brakes added about 20¢ a gallon. The week before: 45¢.');
    assert.equal(m.dust, 'Tire dust: about 0.70 g. 30% less than typical on the same roads.');
    const alone = moreLines({ hardBrakes: 1, fastStarts: 0, dust: null, gas: null }, null);
    assert.deepEqual(alone, { brakes: '1 hard brake.', gas: null, dust: null });
    for (const s of [...Object.values(m), weekSentence({ drives: 1, known: 1, crossed: 2, gentle: 1 }, true)]) assert.ok(!DASHES.test(s ?? ''));
  });
});
