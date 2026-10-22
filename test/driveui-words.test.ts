/** the Drive screens' words: money, hard brakes, where the dust goes, progress */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { enoughDrive } from '../src/drive/enough.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { hardGasGuess, type Usd } from '../src/drive/money.ts';
import type { StopClass } from '../src/drive/tips.ts';
import type { Fix } from '../src/drive/types.ts';
import {
  brakeDo, brakeWhat, dayWord, dustSummary, endWords, far, gapFeet, gentleLine, monthUsd, moneyRow, needMoreLine, per10Word, rainHead, rainShort,
  lostChip, gentleSalmonLine, rainTag, rainWhy, salmonName, salmonRow, scoreWord, shortRule, shortWhat, spotWords, streakLine, yearFigure, yearParts, yearRange,
  type BrakeView, type MoneyIn, type RainIn,
} from '../src/app/screens/drive-words.ts';

const DASHES = /[–—]/;
const usd = (typical: number, low = typical * 0.5, high = typical * 2): Usd => ({ low, typical, high });
/** hard: gas from hard starts and stops, gas: from speeding */
const money = (gas: number, tires: number, year: number | null, hard = 0): MoneyIn => ({
  hardGas: usd(hard), speedGas: usd(gas), tires: usd(tires), total: usd(hard + gas + tires), year: year === null ? null : { total: usd(year) },
});
const yearly = (gas: number, tires: number, hard = 0) => ({ year: { hardGas: usd(hard), speedGas: usd(gas), tires: usd(tires) } });
const CLASSES: StopClass[] = ['creek', 'ground', 'elsewhere', 'treatment', 'unknown', 'none'];
const RECEIVING = ['', 'Fennel Creek', 'Fennel Creek tributary (unnamed)', 'Debra Jane Lake', 'Lake Bonney Outflow', 'Clover Creek', 'Unnamed coho stream',
  'Lake Tapps', 'Church Lake/Lake Tapps', 'an unnamed stream', 'Puget Sound'];
const CODES = ['', 'infiltration-pond', 'infiltration-pond-overflow', 'drywell', 'perforated-pipe', 'infiltration-vault', 'discharge-point', 'dead-end', 'not-connected'];

const brake = (o: Partial<BrakeView> = {}): BrakeView => ({
  n: 1, stopped: true, mphPerS: 9.2, fromMph: 21, entryMph: 30, brakingFt: 110, soonerS: 2.25, gentleFt: 210, veryHard: false,
  cls: 'creek', receiving: 'Fennel Creek', code: 'pond-to-creek', mapped: true, lengthM: 300, local: true, place: '192nd Ave E', ...o,
});

/** every rain sentence the screens can make */
function rains(): RainIn[] {
  const out: RainIn[] = [];
  for (const cls of CLASSES) for (const receiving of RECEIVING) for (const code of CODES) for (const local of [true, false]) for (const mapped of [true, false]) {
    out.push({ cls, receiving, code, mapped, local, lengthM: code === 'not-connected' ? 4 : 400 });
  }
  return out;
}

describe('money words', () => {
  test('one money row, per year and labeled an estimate, never per-drive cents', () => {
    assert.deepEqual(moneyRow(money(0.0049, 0.0026, 378.4, 0.098), 3), { line: 'Could save about $380 a year', sub: 'Estimate · gas and tires' });
    assert.deepEqual(moneyRow(money(0.0049, 0.0026, 26.9), 3), { line: 'Could save about $25 a year', sub: 'Estimate · gas and tires' });
    assert.deepEqual(moneyRow(money(0.3, 0, 172), 1), { line: 'Could save about $170 a year', sub: 'Estimate · gas from speeding' });
    assert.deepEqual(moneyRow(money(0, 0, 240, 0.07), 2), { line: 'Could save about $240 a year', sub: 'Estimate · gas from hard starts and stops' });
    assert.deepEqual(moneyRow(money(0.01, 0, 240, 0.07), 2)?.sub, 'Estimate · gas');
    assert.deepEqual(moneyRow(money(0, 0.001, 2), 1), { line: 'Could save under $5 a year', sub: 'Estimate · tire wear from hard brakes' });
    for (const m of [money(0.0049, 0.0026, 26.9), money(0.002, 0.001, 2), money(0.01, 0, null), money(0, 0, 400, 0.1)]) assert.ok(!/¢|this drive/.test(JSON.stringify(moneyRow(m, 1))));
  });

  test('a drive under 2 miles gets no yearly figure, and a free drive says why', () => {
    assert.deepEqual(moneyRow(money(0.01, 0, null), 1), { line: 'Keeping to the limit saves gas', sub: 'A yearly estimate needs 2 miles' });
    assert.equal(moneyRow(money(0, 0, null, 0.02), 1)?.line, 'Smoother starts and stops save gas');
    assert.equal(moneyRow(money(0, 0.01, null, 0.02), 1)?.line, 'Smoother driving saves gas and tires');
    // tire wear alone: braking softer is never said to save gas
    assert.equal(moneyRow(money(0, 0.01, null), 1)?.line, 'Gentler stops save tire wear');
    assert.equal(moneyRow(money(0, 0, 0), 0)?.line, 'Nothing extra spent on gas or tires');
    assert.equal(moneyRow(money(0, 0, 0), 2), null);
    assert.equal(yearFigure(money(0.01, 0, null)), null);
    assert.equal(yearFigure(money(0.0049, 0.0026, 26.9)), 25);
    assert.equal(yearFigure(money(0.0049, 0.0026, 378.4, 0.098)), 380);
  });

  test('the year in parts for Details: hard starts and stops, speeding, tires; a part that cost nothing left out', () => {
    assert.deepEqual(yearParts(yearly(17.4, 9.4, 351.2)), [['Gas from hard starts and stops', '$350'], ['Gas from speeding', '$15'], ['Tire wear from hard brakes', '$10']]);
    assert.deepEqual(yearParts(yearly(14, 11)), [['Gas from speeding', '$15'], ['Tire wear from hard brakes', '$10']]);
    assert.deepEqual(yearParts(yearly(0, 2)), [['Tire wear from hard brakes', 'under $5']]);
    assert.deepEqual(yearParts({ year: null }), []);
  });

  test('the year as a range for Details, said as likely and never in cents', () => {
    assert.equal(yearRange({ year: { total: { low: 132, typical: 378, high: 770 } } }), 'Likely $130 to $770 a year. It depends on your car.');
    assert.equal(yearRange({ year: { total: { low: 15.3, typical: 26.9, high: 69 } } }), 'Likely $15 to $70 a year. It depends on your car.');
    assert.equal(yearRange({ year: { total: { low: 1, typical: 1.5, high: 2 } } }), null);
    assert.equal(yearRange({ year: { total: { low: 0, typical: 0, high: 0 } } }), null);
    assert.equal(yearRange({ year: null }), null);
  });

  test('money this month counts only drives that started this month, gas from hard starts and stops too', () => {
    const now = new Date(2026, 9, 17, 12).getTime(), day = 86_400_000;
    const d = (at: number, g: number) => ({ at, gas: usd(g), tires: usd(0.01) });
    assert.equal(Math.round(monthUsd([d(now, 0.1), d(now - 5 * day, 0.2), d(new Date(2026, 8, 30).getTime(), 9)], now) * 100) / 100, 0.32);
    const kept = { at: now, gas: usd(0), tires: usd(0), hardGas: usd(0.25) };
    assert.equal(monthUsd([kept], now), 0.25);
    // saved before hard gas was kept: estimated from its counts
    const old = { at: now, mi: 4, hardBrakes: 3, fastStarts: 1, gas: usd(0), tires: usd(0) };
    assert.ok(Math.abs(monthUsd([old], now) - hardGasGuess(4, 4).typical) < 1e-12);
  });
});

describe('too short to score', () => {
  test('says what it was and the one rule it missed', () => {
    assert.equal(shortWhat(0.31, 7), '0.3 mi in 7 sec');
    assert.equal(shortWhat(0.3, 70), '0.3 mi in 1 min');
    // never rounds up to the 2 minutes it missed
    assert.equal(shortWhat(0.7, 115), '0.7 mi in 1 min');
    // nor to the half mile it missed, so it never reads "0.5 mi" over "Drives over half a mile get a score."
    assert.equal(shortWhat(0.46, 70), '0.4 mi in 1 min');
    assert.equal(shortWhat(0.3, 70), '0.3 mi in 1 min');
    assert.equal(shortWhat(0.76, 300), '0.8 mi in 5 min');
    assert.equal(shortRule(0.3, 70), 'Drives over half a mile get a score.');
    assert.equal(shortRule(0.7, 90), 'Drives over 2 minutes get a score.');
    assert.equal(shortRule(0.7, 300), 'The location signal was too weak to score it.');
  });
});

describe('the salmon row', () => {
  const b = (o: Partial<RainIn> = {}): RainIn => ({ cls: 'creek', receiving: 'Fennel Creek', code: '', mapped: true, lengthM: 400, local: true, ...o });

  test('names the creek rain carries a hard brake\'s dust to', () => {
    assert.deepEqual(salmonRow([b(), b({ cls: 'ground' }), b({ cls: 'elsewhere' })], 0), { line: 'Rain carries dust from 1 hard brake to Fennel Creek', sub: 'Coho salmon spawn downstream' });
    assert.deepEqual(salmonRow([b({ local: false, receiving: 'Clover Creek' })], 0), { line: 'Rain carries dust from 1 hard brake to Clover Creek', sub: 'The state records coho salmon there' });
    assert.equal(salmonRow([b(), b({ local: false, receiving: 'Clover Creek' })], 0)?.line, 'Rain carries dust from 2 hard brakes to salmon streams');
    // never says a brake itself drains
    assert.doesNotMatch(salmonRow([b()], 0)?.line ?? '', /brakes? drains?/);
  });

  test('score chips say the count and the points, with a minus sign, never a dash', () => {
    assert.equal(lostChip('brakes', 3, 30), '3 hard brakes −30 pts');
    assert.equal(lostChip('brakes', 1, 9), '1 hard brake −9 pts');
    assert.equal(lostChip('starts', 2, 8), '2 fast starts −8 pts');
    assert.equal(lostChip('speed', 0.36, 13), 'Over the limit −13 pts');
    for (const k of ['brakes', 'starts', 'speed'] as const) assert.doesNotMatch(lostChip(k, 2, 5), DASHES);
  });

  test('gentle stops that reach salmon, said the way the tracer backs it', () => {
    assert.equal(gentleSalmonLine(1), '1 gentle stop where rain flows to a salmon stream');
    assert.equal(gentleSalmonLine(4), '4 gentle stops where rain flows to salmon streams');
    assert.doesNotMatch(gentleSalmonLine(2), /above|stops? drains?/);
  });

  test('without a creek brake: gentle stops where rain flows to salmon streams, or something short and true', () => {
    assert.deepEqual(salmonRow([b({ cls: 'ground' })], 3), { line: '3 gentle stops where rain flows to salmon streams', sub: 'Gentle stops leave less tire dust' });
    assert.equal(salmonRow([], 0)?.line, 'No hard brakes, so less tire dust for the salmon');
    assert.deepEqual(salmonRow([b({ cls: 'ground', code: '' })], 0), { line: "Your hard brake doesn't drain to a salmon stream", sub: 'Soaks into the ground.' });
    // where the map can't say, it claims nothing
    assert.equal(salmonRow([b({ cls: 'unknown' })], 0), null);
    assert.equal(salmonRow([b({ cls: 'none', mapped: false })], 0), null);
  });

  test('every line is short, plain and has no dashes', () => {
    for (const r of rains()) {
      const row = salmonRow([r], 0);
      if (row) assert.ok(row.line.length <= 90 && !DASHES.test(row.line + row.sub), row.line);
      assert.ok(!DASHES.test(salmonName(r.receiving, r.local)));
    }
    assert.equal(salmonName('Fennel Creek tributary (unnamed)', true), 'a stream that feeds Fennel Creek');
    assert.equal(salmonName('Unnamed coho stream', false), 'a salmon stream');
  });
});

describe('hard brake words', () => {
  test('what happened, and what to do there', () => {
    assert.equal(brakeWhat(brake()), '30 mph to a stop in 110 ft.');
    assert.equal(brakeWhat(brake({ stopped: false, fromMph: 42 })), 'Hard brake at 42 mph.');
    assert.equal(brakeDo(brake()), 'Start slowing about 2 seconds sooner here.');
    assert.equal(brakeDo(brake({ soonerS: 0.9 })), 'Start slowing about 1 second sooner here.');
    assert.equal(brakeDo(brake({ soonerS: 0.2 })), 'Ease off a little sooner and brake more gently here.');
    assert.match(brakeDo(brake({ stopped: false })), /^Ease off sooner here/);
    assert.equal(gentleLine(brake()), 'A gentle stop from 30 mph takes about 210 ft.');
    assert.equal(gentleLine(brake({ stopped: false })), null);
  });

  test('the end of See it happen says where, why and what to do', () => {
    const e = endWords(brake());
    assert.equal(e.title, 'This is where tire dust from your stop on 192nd Ave E ends up.');
    assert.match(e.why, /coho salmon within hours/);
    assert.equal(e.todo, 'Next time, start slowing about 2 seconds sooner here.');
    assert.equal(endWords(brake({ cls: 'unknown', code: 'dead-end', lengthM: 300 })).title, 'TireTrail followed rain from your stop on 192nd Ave E for 980 ft.');
    assert.match(endWords(brake({ cls: 'unknown', code: 'not-connected', lengthM: 2 })).title, /isn't connected to any pipe on the map/);
  });
});

describe('where the dust goes', () => {
  test('Fennel Creek flows down to where coho salmon spawn; county streams are where the state records coho', () => {
    const r = (o: Partial<RainIn>) => rainHead({ cls: 'creek', receiving: 'Fennel Creek', code: '', mapped: true, lengthM: 300, local: true, ...o });
    assert.equal(r({}), 'Its rain drains to Fennel Creek, which flows down to where coho salmon spawn.');
    assert.equal(r({ receiving: 'Fennel Creek tributary (unnamed)' }), 'Its rain drains to a stream that feeds Fennel Creek, which flows down to where coho salmon spawn.');
    assert.equal(r({ receiving: 'Debra Jane Lake' }), 'Its rain drains to Debra Jane Lake, which flows on to Fennel Creek and down to where coho salmon spawn.');
    assert.equal(r({ receiving: 'Clover Creek', local: false }), 'Its rain drains to Clover Creek, where the state records coho salmon.');
    assert.equal(rainShort({ cls: 'creek', receiving: 'Fennel Creek', code: '', mapped: true, lengthM: 0, local: true }), 'Drains to Fennel Creek.');
  });

  test('soak-in answers say what the facility is, and never "safe" or "instead of a creek"', () => {
    const g = (code: string) => ({ cls: 'ground' as StopClass, receiving: '', code, mapped: true, lengthM: 300, local: true });
    assert.equal(rainHead(g('infiltration-pond')), 'Its rain drains to a pond built to soak it into the ground.');
    assert.equal(rainHead(g('drywell')), 'Its rain drains to a dry well, a pit that lets it soak into the ground.');
    assert.equal(rainHead(g('')), 'Its rain soaks into the ground.');
    assert.equal(rainWhy(g('infiltration-pond')), 'Soaking through soil removes most of the tire chemical that harms salmon.');
    assert.match(rainWhy(g('infiltration-pond-overflow')), /In very big storms this pond can overflow\.$/);
  });

  test('a map gap or no mapped drain is said as a map fact, not a fact about the street', () => {
    const base = { receiving: '', code: 'dead-end', lengthM: 300, local: true };
    assert.equal(rainHead({ ...base, cls: 'unknown', mapped: true }), 'TireTrail can follow its rain for 980 ft. Then the pipe map has a gap.');
    assert.equal(rainHead({ ...base, cls: 'unknown', code: 'not-connected', mapped: true }), "This storm drain isn't connected to any pipe on the map.");
    assert.equal(rainHead({ ...base, cls: 'none', mapped: true }), 'No storm drain is mapped near this stop.');
    assert.equal(rainHead({ ...base, cls: 'none', mapped: false }), "TireTrail doesn't have pipe maps here yet.");
    assert.equal(rainTag({ cls: 'none', mapped: false }), 'No pipe map yet');
  });

  test('the drive line counts salmon streams and is honest about what it could not follow', () => {
    const b = (cls: StopClass, receiving = '', mapped = true) => ({ cls, receiving, code: '', mapped, lengthM: 300, local: true });
    assert.equal(dustSummary([]), 'No hard brakes this drive. Gentle stops leave the least tire dust.');
    assert.equal(dustSummary([b('unknown'), b('ground'), b('creek', 'Fennel Creek')]), '1 of your 3 hard brakes drains to Fennel Creek, which flows down to where coho salmon spawn.');
    assert.equal(dustSummary([b('creek', 'Fennel Creek')]), 'Your hard brake drains to Fennel Creek, which flows down to where coho salmon spawn.');
    assert.equal(dustSummary([b('creek', 'Fennel Creek'), b('creek', 'Fennel Creek')]), 'Both of your hard brakes drain to Fennel Creek, which flows down to where coho salmon spawn.');
    assert.equal(dustSummary([b('ground'), b('elsewhere', 'Lake Tapps')]), 'None of your 2 hard brakes drain to a salmon stream.');
    // C10: some answers unknown, so it can't say "none"
    assert.equal(dustSummary([b('ground'), b('ground'), b('unknown')]), "2 of your hard brakes don't drain to a salmon stream. TireTrail couldn't follow the other 1.");
    assert.equal(dustSummary([b('none', '', false)]), "TireTrail doesn't have pipe maps where you braked yet.");
  });

  test('no dashes, no "safe", no "where coho salmon live", no multipliers, no turning', () => {
    const all: string[] = [];
    for (const r of rains()) all.push(rainHead(r), rainWhy(r), rainShort(r), rainTag(r));
    for (const r of rains().slice(0, 300)) {
      const b = brake({ ...r });
      const e = endWords(b);
      all.push(e.title, e.why, e.todo, brakeWhat(b), brakeDo(b));
    }
    for (let n = 0; n <= 4; n++) for (let k = 0; k <= n; k++) {
      const bs = Array.from({ length: n }, (_, i) => ({ cls: (i < k ? 'creek' : 'unknown') as StopClass, receiving: 'Fennel Creek', code: '', mapped: true, lengthM: 300, local: true }));
      all.push(dustSummary(bs));
    }
    for (const s of all) {
      assert.doesNotMatch(s, DASHES, s);
      assert.doesNotMatch(s, /\bsafe\b/i, s);
      assert.doesNotMatch(s, /where coho salmon live/, s);
      assert.doesNotMatch(s, /\d\s?(x|×)\b/, s);
      assert.doesNotMatch(s, /turn/i, s);
      assert.match(s, /[.!]$|^[A-Z][a-z]+( [a-z]+)*$/, s);
    }
  });
});

describe('progress words', () => {
  test('days, scores and streaks read plainly', () => {
    const now = new Date(2026, 9, 17, 18).getTime();
    assert.equal(dayWord(now - 3_600_000, now), 'Today');
    assert.equal(dayWord(now - 86_400_000, now), 'Yesterday');
    assert.equal(dayWord(new Date(2026, 9, 14, 9).getTime(), now), 'Wed, Oct 14');
    assert.equal(dayWord(new Date(2025, 11, 30).getTime(), now), 'Dec 30, 2025');
    assert.equal(scoreWord(95), 'Very smooth drive');
    assert.equal(scoreWord(80), 'Smooth drive');
    assert.equal(scoreWord(60), 'Pretty good drive');
    assert.equal(scoreWord(58), 'Room to improve');
    assert.equal(streakLine(0), 'Drive with no hard brakes to start a streak.');
    assert.equal(streakLine(1), '1 drive with no hard brakes. Keep it going.');
    assert.equal(streakLine(4), '4 drives in a row with no hard brakes.');
    assert.equal(needMoreLine(1), 'Record 1 more drive to see your trend.');
    assert.equal(needMoreLine(3), 'Record 3 more drives to see your trend.');
    assert.equal(per10Word(1.44), '1.4');
    assert.equal(per10Word(12.4), '12');
  });

  test('a learned spot says where, how often, and that it will tell you', () => {
    assert.deepEqual(spotWords({ name: '192nd Ave E', count: 3, drives: 2, veryHard: 0, salmon: true }), {
      title: 'You brake hard at 192nd Ave E.',
      body: "3 hard brakes here on 2 drives. Rain here drains to a salmon stream. We'll tell you before you get there.",
    });
    assert.equal(spotWords({ name: '', count: 1, drives: 1, veryHard: 1, salmon: false }).body, "One very hard brake here. We'll tell you before you get there.");
  });

  test('fix list gaps and short distances are in feet', () => {
    assert.equal(gapFeet('catch basin DS-M8-11974 → pipe ML-M8-19992 (4.19 m gap)'), 'catch basin DS-M8-11974 → pipe ML-M8-19992 (about 14 ft)');
    assert.equal(far(63), '210 ft');
    assert.equal(far(1179), '0.7 mi');
  });
});

describe('the sample drive, through the engine and the words', () => {
  test('the report says what the decisions say it should', () => {
    const fixes = JSON.parse(readFileSync('public/data/sample-drive.json', 'utf8')) as Fix[];
    const limits = new SpeedLimits(JSON.parse(readFileSync('public/data/majorroads.json', 'utf8')));
    const r = analyzeDrive(fixes, { nearestDrain: () => null, path: () => ({ drain: 0, assets: [], coords: [], lengthM: 0 }) }, { limits });
    assert.equal(r.brakes.length, 3);
    assert.ok(enoughDrive(r), 'the sample is long enough to score');
    assert.equal(moneyRow(r.money, r.brakes.length + 1)?.line, 'Could save about $370 a year');
    assert.deepEqual(yearParts(r.money).map((p) => p[0]), ['Gas from hard starts and stops', 'Gas from speeding', 'Tire wear from hard brakes']);
    assert.equal(yearRange(r.money), 'Likely $130 to $760 a year. It depends on your car.');
    assert.equal(scoreWord(r.score.score), 'Room to improve');
    assert.equal(r.score.fix?.key, 'brakes');
  });
});
