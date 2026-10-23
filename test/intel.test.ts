/** Rain ahead (NWS grid forecast), coho season, the once-a-day voice line and home's words */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { areaOf, noteFor, startCue } from '../src/intel/index.ts';
import { durationMs, HOME_LL, parseGrid, rainAhead, RAIN_MM, roundLL, spans, unsaidToday, whenOf, type Forecast } from '../src/intel/rain.ts';
import { cohoSeason, inPugetSound, pacific } from '../src/intel/season.ts';
import { RAIN_DO, RAIN_WHY, rainLine, rainTitle, rainVoice, SEASON_LINE, SEASON_SUB, SEASON_WHY, SRC, weekLine } from '../src/intel/words.ts';

// a real api.weather.gov/gridpoints/SEW/120,42 response (Graham, Pierce County), Oct 22 2026, trimmed to the layers we read
const GRID = JSON.parse(readFileSync(new URL('./fixtures/nws-grid-sew-120-42.json', import.meta.url), 'utf8'));
const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;

describe('NWS forecast parsing', () => {
  test('ISO durations', () => {
    assert.equal(durationMs('PT6H'), 6 * H);
    assert.equal(durationMs('PT1H'), H);
    assert.equal(durationMs('P1DT12H'), 36 * H);
    assert.equal(durationMs('PT30M'), 30 * 60_000);
    assert.equal(durationMs('P2D'), 48 * H);
    assert.equal(durationMs('junk'), 0);
  });
  test('the fixture parses: rain in mm per stretch, chance in percent', () => {
    const f = parseGrid(GRID, 1, HOME_LL, 'Graham')!;
    assert.ok(f);
    assert.equal(f.qpf.length, 31);
    assert.deepEqual(f.qpf[0], [at('2026-10-22T12:00:00Z'), 6 * H, 0]);
    assert.ok(f.pop.length > 20);
    assert.equal(f.place, 'Graham');
  });
  test('blanks and broken stretches are left out; no rain layer is no forecast', () => {
    assert.deepEqual(spans({ values: [{ validTime: 'x/PT1H', value: 1 }, { validTime: '2026-10-22T00:00:00+00:00/PT1H', value: null }] }), []);
    assert.equal(parseGrid({ properties: {} }, 1, HOME_LL), null);
    assert.equal(parseGrid(null, 1, HOME_LL), null);
    // inches would be read wrong, so a layer not in mm is refused
    assert.equal(parseGrid({ properties: { quantitativePrecipitation: { uom: 'wmoUnit:in', values: [{ validTime: '2026-10-22T00:00:00+00:00/PT6H', value: 1 }] } } }, 1, HOME_LL), null);
  });
});

describe('rain ahead: 0.1 in or more in the next 24 h, with a 50% chance in some hour', () => {
  const f = parseGrid(GRID, 1, HOME_LL, 'Graham')!;
  test('the dry day the fixture was fetched: nothing', () => {
    assert.equal(rainAhead(f, at('2026-10-22T20:00:00Z')), null);
  });
  test('the fixture\'s weekend rain: 0.17 in, but at most a 48% chance, so nothing', () => {
    assert.equal(rainAhead(f, at('2026-10-25T03:00:00Z')), null);
  });
  test('the same rain at a 70% chance: starts that night', () => {
    const likely = { ...f, pop: f.pop.map(([t, d, p]): [number, number, number] => [t, d, p >= 39 ? 70 : p]) };
    const r = rainAhead(likely, at('2026-10-25T03:00:00Z'))!; // Oct 24, 8 PM in Washington
    assert.ok(r, 'rain ahead');
    assert.ok(r.mm >= RAIN_MM && r.mm < 6, String(r.mm));
    assert.ok(r.pop >= 50);
    assert.equal(r.start, at('2026-10-25T06:00:00Z'));
    assert.equal(r.when, 'tonight');
  });
  const one = (mm: number, pop: number, from = 0): Pick<Forecast, 'qpf' | 'pop'> => ({ qpf: [[from, 6 * H, mm]], pop: [[from, 6 * H, pop]] });
  test('the threshold: just under 0.1 in, or under a 50% chance, is not enough', () => {
    assert.equal(rainAhead(one(2.5, 90), 0), null);
    assert.ok(rainAhead(one(2.6, 90), 0));
    assert.equal(rainAhead(one(10, 40), 0), null);
    assert.ok(rainAhead(one(10, 50), 0));
  });
  test('only the part of a stretch inside the next 24 h counts', () => {
    // 6 mm over 6 h starting 22 h from now: 2 h of it count, 2 mm
    assert.equal(rainAhead(one(6, 90, 22 * H), 0), null);
    assert.ok(rainAhead(one(6, 90, 20 * H), 0));
    // rain that already fell doesn't count
    assert.equal(rainAhead(one(20, 90, -7 * H), 0), null);
  });
});

describe('when, in Washington time', () => {
  const pdt = (d: string, hr: number) => at(`2026-10-${d}T${String(hr).padStart(2, '0')}:00:00-07:00`);
  test('today until 5 PM, tonight until 6 AM, then tomorrow', () => {
    assert.equal(whenOf(pdt('22', 14), pdt('22', 9)), 'today');
    assert.equal(whenOf(pdt('22', 19), pdt('22', 9)), 'tonight');
    assert.equal(whenOf(pdt('23', 3), pdt('22', 21)), 'tonight');
    assert.equal(whenOf(pdt('23', 10), pdt('22', 21)), 'tomorrow');
    assert.equal(whenOf(pdt('22', 2), pdt('22', 1)), 'today');
  });
  test('the date and hour come from Washington, not the computer', () => {
    assert.deepEqual(pacific(at('2026-10-23T02:30:00Z')), { day: '2026-10-22', month: 10, hour: 19 });
    assert.equal(pacific(at('2026-01-01T07:59:00Z')).day, '2025-12-31');
  });
});

describe('coho season', () => {
  const mid = (m: number) => at(`2026-${String(m).padStart(2, '0')}-15T12:00:00-07:00`);
  test('returning in October and November, spawning December to February, nothing else', () => {
    assert.equal(cohoSeason(mid(10)), 'returning');
    assert.equal(cohoSeason(mid(11)), 'returning');
    assert.equal(cohoSeason(mid(12)), 'spawning');
    assert.equal(cohoSeason(mid(1)), 'spawning');
    assert.equal(cohoSeason(mid(2)), 'spawning');
    for (const m of [3, 4, 5, 6, 7, 8, 9]) assert.equal(cohoSeason(mid(m)), null, String(m));
  });
  test('the edges, in Washington time', () => {
    assert.equal(cohoSeason(at('2026-09-30T23:59:00-07:00')), null);
    assert.equal(cohoSeason(at('2026-10-01T00:00:00-07:00')), 'returning');
    // Mar 1 at 2 AM UTC is still Feb 28 in Washington
    assert.equal(cohoSeason(at('2026-03-01T02:00:00Z')), 'spawning');
    assert.equal(cohoSeason(at('2026-03-01T00:30:00-08:00')), null);
  });
  test('the Puget Sound line only for drives in Puget Sound', () => {
    assert.ok(inPugetSound({ lat: 47.12, lon: -122.43 }));
    assert.ok(inPugetSound({ lat: 47.61, lon: -122.33 }));
    // Spokane, Yakima and the coast
    for (const ll of [{ lat: 47.66, lon: -117.43 }, { lat: 46.6, lon: -120.51 }, { lat: 46.98, lon: -123.82 }]) assert.ok(!inPugetSound(ll), JSON.stringify(ll));
    assert.equal(noteFor(null, at('2026-11-02T16:00:00Z'), { lat: 47.66, lon: -117.43 }), null);
  });
  test('home: rain beats the season; the season shows on a dry day in season only', () => {
    const wet: Forecast = { at: 0, lat: 47.05, lon: -122.3, place: 'Graham', qpf: [[at('2026-11-02T18:00:00Z'), 6 * H, 8]], pop: [[at('2026-11-02T18:00:00Z'), 6 * H, 80]] };
    assert.equal(noteFor(wet, at('2026-11-02T16:00:00Z'))?.kind, 'rain');
    assert.deepEqual(noteFor(null, at('2026-11-02T16:00:00Z')), { kind: 'season', season: 'returning' });
    assert.equal(noteFor(null, at('2026-06-02T16:00:00Z')), null);
  });
});

describe('the voice says it once a day', () => {
  const wet: Forecast = { at: 0, lat: 47.05, lon: -122.3, place: '', qpf: [[at('2026-10-23T02:00:00Z'), 6 * H, 8]], pop: [[at('2026-10-23T02:00:00Z'), 6 * H, 80]] };
  const now = at('2026-10-22T16:00:00Z'); // 9 AM in Washington
  test('says the short line when it has not been said today', () => {
    const said: string[] = [];
    assert.equal(startCue((l) => { said.push(l); return true; }, now, wet, null), 'Rain tonight. Easy near the creeks.');
    assert.deepEqual(said, ['Rain tonight. Easy near the creeks.']);
  });
  test('quiet once said today, again tomorrow', () => {
    assert.equal(unsaidToday(now, '2026-10-22'), false);
    assert.equal(startCue(() => true, now, wet, '2026-10-22'), null);
    assert.equal(unsaidToday(now, '2026-10-21'), true);
    // 11 PM in Washington is still the same day there, though it is tomorrow in UTC
    assert.equal(unsaidToday(at('2026-10-23T06:00:00Z'), '2026-10-22'), false);
  });
  test('muted or no speech: nothing counts as said', () => {
    assert.equal(startCue(() => false, now, wet, null), null);
  });
  test('no forecast or a dry one: nothing', () => {
    assert.equal(startCue(() => true, now, null, null), null);
    assert.equal(startCue(() => true, now, { ...wet, qpf: [[now, 24 * H, 0]] }, null), null);
  });
});

describe('where the forecast is for', () => {
  test('the last drive, rounded to about 3 miles; else Pierce County', () => {
    assert.deepEqual(areaOf([]), HOME_LL);
    const old = { at: 1, path: [-122.2, 47.2] }, last = { at: 2, path: [-122.41454, 47.13313] };
    assert.deepEqual(areaOf([old, last]), { lat: 47.13313, lon: -122.41454 });
    assert.deepEqual(roundLL(areaOf([last, old])), { lat: 47.15, lon: -122.4 });
    assert.deepEqual(areaOf([{ at: 3, stopPts: [{ lat: 47.3, lon: -122.2 }] }]), { lat: 47.3, lon: -122.2 });
  });
});

describe('words', () => {
  const all = [
    RAIN_DO, ...(['today', 'tonight', 'tomorrow'] as const).flatMap((w) => [rainTitle(w), rainVoice(w)]),
    rainLine({ place: 'Graham' }, { mm: 10 }), ...RAIN_WHY, ...Object.values(SEASON_LINE), SEASON_SUB, ...SEASON_WHY, ...Object.values(SRC).map((s) => s.label),
    weekLine(3, true)!, weekLine(0, true)!,
  ];
  test('short and plain: no dashes, emoji, 6PPDQ or numbers of science', () => {
    for (const s of all) {
      assert.doesNotMatch(s, /[–—]|\p{Extended_Pictographic}|6PPD|grams|\bmg\b/u, s);
      assert.ok(s.length <= 120, s);
    }
  });
  test('the rain lines', () => {
    assert.equal(rainTitle('tonight'), 'Rain tonight.');
    assert.equal(`${rainTitle('tonight')} ${RAIN_DO}`, 'Rain tonight. Brake gently today.');
    assert.equal(rainVoice('tonight'), 'Rain tonight. Easy near the creeks.');
    // inches spelled out, never "0.4 in near"
    assert.equal(rainLine({ place: 'Graham' }, { mm: 10 }), 'About 0.4 inches near Graham by this time tomorrow.');
    assert.equal(rainLine({ place: '' }, { mm: 1 }), 'About 0.1 inches near you by this time tomorrow.');
  });
  test('sources link to the papers', () => {
    assert.match(SRC.scholz.href, /10\.1371\/journal\.pone\.0028013$/);
    assert.match(SRC.tian.href, /10\.1126\/science\.abd6951$/);
  });
  test('home says how many drives, never the My drives line', () => {
    assert.equal(weekLine(3, true), '3 drives this week. See them on the map.');
    assert.equal(weekLine(1, true), '1 drive this week. See it on the map.');
    assert.equal(weekLine(0, true), 'No drives yet this week. See past drives on the map.');
    assert.equal(weekLine(0, false), null);
    for (const n of [0, 1, 5]) assert.doesNotMatch(weekLine(n, true)!, /gentle|creek/);
  });
});
