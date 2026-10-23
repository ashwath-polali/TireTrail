/** My drives, the week road: the week's score and verdict, lost points, passes by the spot, cents, signs and their words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { roundCents } from '../src/drive/gas.ts';
import type { Spot } from '../src/drive/spots.ts';
import type { BrakePoint } from '../src/drive/summary.ts';
import {
  biggest, blocks, brakesHere, calmRun, centsOf, costliest, crossPick, freeRun, gasWhyNot, scoreEnds, signsOf, speedRoad,
  spotParts, spotPasses, weekLost, weekScore, weekVerdict, worstDrive, WEEK_CHANGE, type SignIn,
} from '../src/app/screens/history-week.ts';
import {
  aheadWord, coachAct, costAnswer, creekAnswer, gasSay, hereLine, lastDriveLine, lostLine, lostSay, passLine, passSay, signSay,
  smoothAnswer, spotAnswer, streakWords, weekHead, weekLabel, weekRange, weekSum,
} from '../src/app/screens/history-words.ts';

const DASHES = /[–—]/;
const at = (d: number, hr = 8) => new Date(2026, 9, 19 + d, hr).getTime();
const SPOT: Spot = { id: 's', lngLat: [-122.43, 47.12], heading: 0, count: 4, drives: 3, veryHard: 0, last: 0, name: 'Pacific Ave S', cls: 'none', salmon: false, example: false };
const brake = (ll: [number, number], heading: number | null = 0): BrakePoint => ({ t: 0, lon: ll[0], lat: ll[1], heading, veryHard: false, cls: 'none', name: 'Pacific Ave S' });
const HERE = brake([-122.43, 47.12]), AWAY = brake([-122.40, 47.10]);
// a path north through the spot, flat [lon, lat, ...]
const PAST = [-122.43, 47.118, -122.43, 47.1195, -122.43, 47.1205, -122.43, 47.122];

describe('the week score and verdict', () => {
  test('the score is the rounded mean of the drives; none with no drives', () => {
    assert.equal(weekScore([{ score: 72 }, { score: 78 }, { score: 81 }, { score: 75 }, { score: 84 }, { score: 88 }]), 80);
    assert.equal(weekScore([{ score: 80 }, { score: 81 }]), 81);
    assert.equal(weekScore([]), null);
  });

  test(`a change of ${WEEK_CHANGE} or more is smoother or rougher`, () => {
    assert.equal(weekVerdict(80, 70), 'up');
    assert.equal(weekVerdict(73, 70), 'up');
    assert.equal(weekVerdict(72, 70), 'same');
    assert.equal(weekVerdict(68, 70), 'same');
    assert.equal(weekVerdict(67, 70), 'down');
    assert.equal(weekVerdict(80, null), 'first');
    assert.equal(weekVerdict(null, 70), 'none');
  });

  test('the headline says it, this week and a past week', () => {
    const t = (x: ReturnType<typeof weekHead>) => `${x.pre}${x.em}${x.post}`;
    assert.equal(t(weekHead('up', 6, true)), 'You got smoother this week.');
    assert.equal(weekHead('up', 6, true).em, 'smoother');
    assert.equal(t(weekHead('same', 6, true)), 'About as smooth as last week.');
    assert.equal(t(weekHead('down', 6, true)), 'This week was rougher than last.');
    assert.equal(t(weekHead('first', 1, true)), '1 drive this week.');
    assert.equal(t(weekHead('first', 3, true)), '3 drives this week.');
    assert.equal(t(weekHead('none', 0, true)), 'No drives yet this week.');
    assert.equal(t(weekHead('up', 6, false)), 'You got smoother that week.');
    assert.equal(t(weekHead('same', 6, false)), 'About as smooth as the week before.');
    assert.equal(t(weekHead('down', 6, false)), 'That week was rougher than the week before.');
  });

  test('row one answers with the numbers', () => {
    assert.equal(smoothAnswer(80, 70), 'Yes. 80, up from 70');
    assert.equal(smoothAnswer(78, 77), 'About the same. 78, last week 77');
    assert.equal(smoothAnswer(68, 74), 'Not this week. 68, down from 74');
    assert.equal(smoothAnswer(80, null), '80 this week');
  });
});

describe('where the points went', () => {
  const drives = [
    { score: 70, lost: { brakes: 20, starts: 6, speed: 4 } },
    { score: 90, lost: { brakes: 4, starts: 4, speed: 2 } },
  ];

  test('the parts add up to 100 minus the week score', () => {
    const l = weekLost(drives)!;
    assert.deepEqual(l, { brakes: 12, starts: 5, speed: 3 });
    assert.equal(l.brakes + l.starts + l.speed, 100 - weekScore(drives)!);
  });

  test('rounding never loses or adds a point', () => {
    for (const ds of [
      [{ score: 87, lost: { brakes: 7, starts: 5, speed: 1 } }, { score: 82, lost: { brakes: 9, starts: 0, speed: 9 } }, { score: 91, lost: { brakes: 3, starts: 3, speed: 3 } }],
      [{ score: 100, lost: { brakes: 0, starts: 0, speed: 0 } }, { score: 99, lost: { brakes: 1, starts: 0, speed: 0 } }],
      [{ score: 33, lost: { brakes: 45, starts: 20, speed: 2 } }],
    ]) {
      const l = weekLost(ds)!, s = weekScore(ds)!;
      assert.equal(l.brakes + l.starts + l.speed, 100 - s);
    }
    assert.equal(weekLost([]), null);
  });

  test('the bar has 25 blocks of 4 points, rounded fairly', () => {
    assert.deepEqual(blocks(80, { brakes: 12, starts: 5, speed: 3 }), { kept: 20, brakes: 3, starts: 1, speed: 1 });
    const b = blocks(63, { brakes: 30, starts: 5, speed: 2 });
    assert.equal(b.kept + b.brakes + b.starts + b.speed, 25);
    assert.deepEqual(blocks(100, { brakes: 0, starts: 0, speed: 0 }), { kept: 25, brakes: 0, starts: 0, speed: 0 });
  });

  test('the biggest part and its sentence', () => {
    assert.equal(biggest({ brakes: 12, starts: 5, speed: 3 }), 'brakes');
    assert.equal(biggest({ brakes: 1, starts: 5, speed: 3 }), 'starts');
    assert.equal(biggest({ brakes: 0, starts: 0, speed: 0 }), null);
    const l = lostLine('brakes', 12, 20);
    assert.equal(`${l.pre}${l.b}${l.post}`, 'Hard brakes cost you the most: 12 of the 20 points you lost.');
    assert.equal(lostLine('speed', 3, 5).pre, 'Speeding cost you the most: ');
    assert.equal(lostLine(null, 0, 0).pre, 'You lost no points this week.');
    assert.equal(lostSay(80, { brakes: 12, starts: 5, speed: 3 }), 'Smooth score this week 80. Points lost: hard brakes 12, fast starts 5, speeding 3.');
  });

  test('the coach names one thing to do, by what cost the most', () => {
    assert.deepEqual(coachAct('brakes', { spot: 'Pacific Ave S', at: '138th St S' }), { text: 'Ease off sooner at Pacific Ave S', say: 'Ease off sooner at Pacific Ave S and 138th St S. Opens the map there.' });
    assert.equal(coachAct('brakes', { spot: '' }).text, 'Ease off sooner at your hard-brake spot');
    assert.equal(coachAct('brakes', {}).text, 'Start slowing sooner');
    assert.equal(coachAct('starts', {}).text, 'Speed up gently when you pull away');
    assert.equal(coachAct('speed', { road: 'SR 410' }).text, 'Keep to the speed limit on SR 410');
    assert.equal(coachAct('speed', {}).text, 'Keep to the speed limit');
  });

  test('the drive to open is the one with the most of it, the latest on a tie', () => {
    const ds = [{ at: 1, hardBrakes: 2, fastStarts: 0 }, { at: 2, hardBrakes: 2, fastStarts: 1 }, { at: 3, hardBrakes: 1, fastStarts: 0 }];
    assert.equal(worstDrive(ds, 'brakes')?.at, 2);
    assert.equal(worstDrive(ds, 'starts')?.at, 2);
    assert.equal(worstDrive(ds, 'speed'), null);
    assert.equal(speedRoad([{ speeds: [{ road: 'SR 410', mi: 1 }, { road: 'Pacific Ave S', mi: 0.4 }] }, { speeds: [{ road: 'Pacific Ave S', mi: 0.8 }] }]), 'Pacific Ave S');
    assert.equal(speedRoad([{}]), '');
  });
});

describe('the spot', () => {
  test('passes by the spot, newest first: a hard brake there, else a drive past it', () => {
    const drives = [
      { at: 1, brakes: [HERE] }, { at: 2, brakes: [HERE] }, { at: 3, brakes: [AWAY], path: PAST },
      { at: 4, brakes: [], path: PAST }, { at: 5, brakes: [] },
    ];
    assert.deepEqual(spotPasses(SPOT, drives, 5), ['calm', 'calm', 'hard', 'hard']);
    assert.deepEqual(spotPasses(SPOT, drives, 3), ['calm', 'calm', 'hard']);
    // a hard brake going the other way is not this spot's
    assert.deepEqual(spotPasses(SPOT, [{ at: 1, brakes: [brake([-122.43, 47.12], 180)] }]), []);
    assert.equal(brakesHere(SPOT, [{ brakes: [HERE, HERE, AWAY] }, { brakes: [HERE] }]), 3);
  });

  test('the line under the pips', () => {
    assert.equal(calmRun(['calm', 'calm', 'hard']), 2);
    assert.equal(calmRun(['hard', 'calm']), -1);
    assert.equal(calmRun([]), 0);
    assert.equal(passLine(2), 'Your last 2 passes were calm.');
    assert.equal(passLine(1), 'Your last pass was calm.');
    assert.equal(passLine(-1), 'You braked hard here on your last pass.');
    assert.equal(passLine(0), null);
    assert.equal(passSay(['calm', 'calm', 'hard', 'hard', 'hard']), 'Your last 5 passes here: hard brake, hard brake, hard brake, calm, calm.');
  });

  test('the spot, its cross street, and the brakes there', () => {
    assert.deepEqual(spotParts('Pacific Ave S at 138th St S'), { street: 'Pacific Ave S', cross: '138th St S' });
    assert.deepEqual(spotParts('SR 410 E near 95th St E'), { street: 'SR 410 E', cross: '' });
    assert.deepEqual(spotParts('Pacific Ave S'), { street: 'Pacific Ave S', cross: '' });
    assert.equal(crossPick('Pacific Ave S', [{ name: 'Pacific Ave S', d: 2 }, { name: '138th St S', d: 18 }, { name: '140th St S', d: 35 }]), '138th St S');
    assert.equal(crossPick('Pacific Ave S', [{ name: '140th St S', d: 55 }]), '');
    assert.equal(spotAnswer({ name: 'Pacific Ave S' }, '138th St S'), 'Pacific Ave S at 138th St S');
    assert.equal(spotAnswer({ name: 'Pacific Ave S' }, ''), 'Pacific Ave S');
    assert.equal(spotAnswer(null, ''), 'No hard-brake spot yet');
    const h = hereLine(3, 4);
    assert.equal(`${h.b}${h.post}`, '3 of your 4 hard brakes were here.');
    assert.equal(hereLine(0, 4).post, 'No hard brakes here this week.');
    assert.equal(streakWords(2, 4), 'No hard brakes on your last 2 drives. Your best run is 4.');
    assert.equal(streakWords(0, 4), 'Your best run with no hard brakes is 4 drives.');
    assert.equal(streakWords(0, 0), null);
  });
});

describe('gas', () => {
  const p = { usdPerGal: 5, weekOf: '2026-10-19', source: 'U.S. EIA', seriesId: 'x' };
  const share = { low: 0.02, typical: 0.05, high: 0.08, speed: 0 };

  test('a drive\'s cents are its typical share of the price, rounded as shown', () => {
    assert.equal(centsOf({ mi: 6, gasShare: share }, p), roundCents(100 * 0.05 * 5));
    assert.equal(centsOf({ mi: 6, gasShare: share }, p), 25);
    assert.equal(centsOf({ mi: 6, gasShare: { ...share, typical: 0 } }, p), 0);
    assert.equal(centsOf({ mi: 6, car: 'ev', gasShare: share }, p), null);
    assert.equal(centsOf({ mi: 1.5, gasShare: share }, p), null);
    assert.equal(centsOf({ mi: 6, gasShare: share }, null), null);
  });

  test('why a week has no gas line, and its answer', () => {
    assert.equal(gasWhyNot([{ mi: 5, car: 'ev' }]), 'ev');
    assert.equal(gasWhyNot([{ mi: 1 }, { mi: 0.5 }]), 'short');
    assert.equal(gasWhyNot([{ mi: 1 }, { mi: 1.2 }]), null);
    assert.equal(costAnswer('20¢', null), 'About 20¢ more a gallon');
    assert.equal(costAnswer(null, null), 'Under 5¢ a gallon');
    assert.equal(costAnswer(null, 'ev'), 'No gas cost for electric cars');
    assert.equal(costAnswer(null, 'short'), 'Drive 2 miles to see this');
    assert.equal(gasSay('20¢', '30¢'), 'Extra gas cost: about 20 cents a gallon this week, about 30 cents last week.');
    assert.equal(gasSay('$1.10', 'Under 5¢'), 'Extra gas cost: about $1.10 a gallon this week, under 5 cents last week.');
  });
});

describe('the signs', () => {
  const d = (day: number, hr: number, score: number, x: Partial<SignIn> = {}): SignIn => ({ at: at(day, hr), mi: 5, score, hardBrakes: 0, cents: 10, crossed: 1, gentle: 1, ...x });

  test('one a drive, oldest first, up to the most that fit', () => {
    const s = signsOf([d(1, 8, 81), d(0, 8, 72), d(0, 17, 78)], 7);
    assert.deepEqual(s.map((x) => x.score), [72, 78, 81]);
    assert.deepEqual(s.map((x) => x.day), [0, 0, 1]);
  });

  test('a full week gets one sign a day: mean score, summed brakes, mile-weighted cents, summed crossings', () => {
    const ds = [
      d(0, 7, 70, { hardBrakes: 2, cents: 50, mi: 2 }), d(0, 12, 80, { hardBrakes: 1, cents: 10, mi: 6 }), d(0, 17, 91, { cents: null }),
      d(1, 8, 88, { crossed: 2, gentle: 1 }), d(1, 17, 84, { crossed: null }), d(2, 8, 75), d(2, 12, 76), d(3, 8, 90),
    ];
    const s = signsOf(ds, 7);
    assert.equal(s.length, 4);
    assert.equal(s[0].score, 80);
    assert.equal(s[0].hardBrakes, 3);
    assert.equal(s[0].cents, roundCents((50 * 2 + 10 * 6) / 8));
    assert.deepEqual(s[0].ats, [ds[0].at, ds[1].at, ds[2].at]);
    // one drive still being checked: the day's crossings aren't known yet
    assert.equal(s[1].crossed, null);
    assert.equal(s[2].crossed, 2);
  });

  test('hardest and best, the costliest, and the latest at no extra cost', () => {
    assert.deepEqual(scoreEnds([{ score: 72 }, { score: 88 }, { score: 81 }, { score: 88 }]), { hard: 0, best: 3 });
    assert.equal(scoreEnds([{ score: 80 }, { score: 80 }]), null);
    assert.equal(scoreEnds([{ score: 80 }]), null);
    assert.equal(costliest([{ cents: 25 }, { cents: 50 }, { cents: null }]), 1);
    assert.equal(costliest([{ cents: 0 }, { cents: null }]), -1);
    assert.equal(freeRun([{ cents: 25 }, { cents: 0 }, { cents: 0 }]), 2);
    assert.equal(freeRun([{ cents: 0 }, { cents: 15 }]), 0);
  });

  test('each sign says what it shows', () => {
    const s = { score: 72, hardBrakes: 2, cents: 50, crossed: 2, gentle: 1 };
    assert.equal(signSay('smooth', s), 'smooth score 72');
    assert.equal(signSay('where', s), '2 hard brakes');
    assert.equal(signSay('where', { ...s, hardBrakes: 1 }), '1 hard brake');
    assert.equal(signSay('cost', s), 'about 50 cents more a gallon');
    assert.equal(signSay('cost', { ...s, cents: 0 }), 'no extra gas cost');
    assert.equal(signSay('salmon', s), 'gentle at 1 of 2 creek crossings');
    assert.equal(signSay('salmon', { ...s, crossed: 0 }), 'no salmon creeks');
  });
});

describe('the week words', () => {
  test('the range, the sum, the days ahead and the empty week', () => {
    assert.equal(weekRange(at(0)), 'Oct 19 to 25');
    assert.equal(weekRange(new Date(2026, 8, 28).getTime()), 'Sep 28 to Oct 4');
    assert.equal(weekLabel(new Date(2026, 9, 5).getTime(), at(3)), 'Oct 5 to 11');
    assert.equal(weekSum(6, 49.6), '6 drives · 50 mi');
    assert.equal(weekSum(1, 3.52), '1 drive · 3.5 mi');
    assert.equal(aheadWord(4, false), 'Fri to Sun');
    assert.equal(aheadWord(4, true), 'Fri');
    assert.equal(aheadWord(6, false), 'Sun');
    assert.equal(aheadWord(7, false), '');
    assert.equal(lastDriveLine(at(3, 8), at(3, 20)), `Your last drive was today, ${new Date(at(3, 8)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`);
  });

  test('creek answers', () => {
    assert.equal(creekAnswer({ drives: 6, known: 6, crossed: 7, gentle: 6 }), 'Gentle at 6 of 7 crossings');
    assert.equal(creekAnswer({ drives: 6, known: 6, crossed: 7, gentle: 7 }), 'Gentle at all 7 crossings');
    assert.equal(creekAnswer({ drives: 6, known: 6, crossed: 0, gentle: 0 }), 'No salmon creeks this week');
    assert.equal(creekAnswer({ drives: 6, known: 4, crossed: 3, gentle: 3 }), 'Checking your creek crossings');
  });

  test('no dashes anywhere', () => {
    const all = [
      smoothAnswer(80, 70), spotAnswer({ name: 'A' }, 'B'), costAnswer('20¢', null), creekAnswer({ drives: 1, known: 1, crossed: 1, gentle: 0 }),
      coachAct('speed', { road: 'x' }).say, streakWords(1, 3)!, passSay(['calm']), gasSay('20¢', null), lastDriveLine(at(0), at(3)),
    ];
    for (const s of all) assert.doesNotMatch(s, DASHES, s);
  });
});
