/** My drives: the sky over the week road (light by the clock, weather from the forecast), the road's scale, and one week rule */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { moonPhase, palOf } from '../src/app/screens/history-land.ts';
import { lightAt, roadScale, weatherOf } from '../src/app/screens/history-week.ts';
import {
  creekAnswer, gasSay, hereLine, lostLine, lostSay, smoothAnswer, uncheckedLine, weekWords,
} from '../src/app/screens/history-words.ts';

const HOUR = 3_600_000;
const pt = (s: string) => Date.parse(`${s}-07:00`);

describe('the light by the Washington clock', () => {
  test('October: morning after 7, day, dusk around 6:15 PM, night', () => {
    assert.equal(lightAt(pt('2026-10-22T07:40')), 'morning');
    assert.equal(lightAt(pt('2026-10-22T13:00')), 'day');
    assert.equal(lightAt(pt('2026-10-22T18:00')), 'dusk');
    assert.equal(lightAt(pt('2026-10-22T20:30')), 'night');
    assert.equal(lightAt(pt('2026-10-22T05:30')), 'night');
  });
  test('June stays light late', () => {
    assert.equal(lightAt(Date.parse('2026-06-20T20:00:00-07:00')), 'day');
    assert.equal(lightAt(Date.parse('2026-06-20T21:00:00-07:00')), 'dusk');
  });
});

describe('the weather from the NWS forecast', () => {
  const now = pt('2026-10-22T12:00');
  test('rain now: a wet stretch with a 50% chance', () => {
    assert.equal(weatherOf({ qpf: [[now - HOUR, 6 * HOUR, 3]], pop: [[now - HOUR, 6 * HOUR, 80]] }, now), 'rain');
  });
  test('cloudy when rain is likely within 6 hours, clear when dry', () => {
    assert.equal(weatherOf({ qpf: [[now, 6 * HOUR, 0]], pop: [[now + 3 * HOUR, 3 * HOUR, 40]] }, now), 'cloudy');
    assert.equal(weatherOf({ qpf: [[now, 12 * HOUR, 0]], pop: [[now, 12 * HOUR, 10]] }, now), 'clear');
  });
  test('drizzle under 0.1 mm an hour is not rain; no forecast is cloudy', () => {
    assert.equal(weatherOf({ qpf: [[now - HOUR, 6 * HOUR, 0.3]], pop: [[now - HOUR, 6 * HOUR, 60]] }, now), 'cloudy');
    assert.equal(weatherOf(null, now), 'cloudy');
  });
  test('rain hides the sun and stars', () => {
    assert.equal(palOf('day', 'rain').sun, null);
    assert.equal(palOf('night', 'rain').star, null);
    assert.notEqual(palOf('day', 'clear').sun, null);
  });
  test('the moon: new on Jan 6 2000, full about 15 days on', () => {
    assert.ok(moonPhase(Date.UTC(2000, 0, 6, 18, 14)) < 0.001);
    assert.ok(Math.abs(moonPhase(Date.UTC(2000, 0, 21, 12)) - 0.5) < 0.02);
  });
});

describe('the road scale', () => {
  test('fills the room when the slopes allow', () => {
    assert.equal(roadScale([70, 80, 90], 100, [100, 100], 1), 100 / 20);
  });
  test('a big swing between close neighbors is held to the slope', () => {
    assert.equal(roadScale([69, 100], 132, [34], 0.5), (0.5 * 34) / 31);
  });
  test('flat weeks span 16 points, so small changes stay small', () => {
    assert.equal(roadScale([80, 81], 160, [100], 1), 10);
    assert.equal(roadScale([], 160, [], 1), 0);
  });
});

describe('one week rule everywhere', () => {
  test('this week against last week, that week against the week before', () => {
    assert.equal(weekWords(true).the, 'this week');
    assert.equal(weekWords(false).the, 'that week');
    assert.equal(weekWords(false).Before, 'Week before');
    assert.equal(weekWords(false).drives, "That week's drives");
  });
  test('a past week never says this week', () => {
    const lines = [
      smoothAnswer(84, null, false), smoothAnswer(68, 74, false), smoothAnswer(78, 77, false),
      lostLine(null, 0, 0, false).pre, lostSay(80, { brakes: 12, starts: 5, speed: 3 }, false),
      hereLine(0, 3, false).post, hereLine(1, 1, false).post, gasSay('20¢', '30¢', false),
      creekAnswer({ drives: 2, known: 2, crossed: 0, gentle: 0 }, false),
    ];
    for (const s of lines) assert.doesNotMatch(s, /this week|last week/i, s);
    assert.equal(smoothAnswer(84, null, false), '84 that week');
    assert.equal(smoothAnswer(78, 77, false), 'About the same. 78, the week before 77');
    assert.equal(gasSay('20¢', '30¢', false), 'Extra gas cost: about 20 cents a gallon that week, about 30 cents the week before.');
  });
  test('the current week reads as before', () => {
    assert.equal(smoothAnswer(84, null), '84 this week');
    assert.equal(lostSay(80, { brakes: 12, starts: 5, speed: 3 }), 'Smooth score this week 80. Points lost: hard brakes 12, fast starts 5, speeding 3.');
  });
});

describe('the creek answer never sticks on checking', () => {
  test('checking only while drives are still being checked', () => {
    assert.equal(creekAnswer({ drives: 3, known: 1, crossed: 2, gentle: 2, checking: 2 }), 'Checking your creek crossings');
    assert.equal(creekAnswer({ drives: 3, known: 1, crossed: 2, gentle: 2, checking: 0 }), 'Gentle at all 2 crossings');
  });
  test('with none checkable: says why', () => {
    assert.equal(creekAnswer({ drives: 2, known: 0, crossed: 0, gentle: 0, checking: 0 }, true, 'route'), 'No route saved to check');
    assert.equal(creekAnswer({ drives: 2, known: 0, crossed: 0, gentle: 0, checking: 0 }, true, 'offline'), 'Creek check needs a connection');
    assert.equal(uncheckedLine(1, 'route'), '1 drive had no route saved, so its creeks were not checked.');
    assert.match(uncheckedLine(2, 'offline'), /did not load/);
  });
});
