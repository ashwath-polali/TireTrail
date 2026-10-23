/** the gas line: cents a drive's habits add to every gallon (the spec's worked example), and when it hides */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { centsAmount, centsText, gasHow, gasLine, gasPrice, gasWeek, lineFor, per5MphText, priceAgeDays, roundCents, shareOf, weekStart, type GasDrive } from '../src/drive/gas.ts';
import { DEFAULT_MONEY_OPTIONS, driveMoney, GAS_PRICE, NO_PACE, type Pace } from '../src/drive/money.ts';

const P = 5.332;
const pace = (o: Partial<Pace>): Pace => ({ ...NO_PACE, ...o });
// drive A: 8 stop-and-go miles with 4 counted hard starts and stops, 2 smooth highway miles
const A = driveMoney({ gasSteps: 0 }, pace({ cityMi: 8, highwayMi: 2, cityHard: 4 }));
// drive B: 18 highway miles at 5 over a 60 limit, 2 stop-and-go miles with 1
const B = driveMoney({ gasSteps: 18 }, pace({ cityMi: 2, highwayMi: 18, cityHard: 1 }));
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
// Thursday Oct 22 2026, noon here; the week began Monday Oct 19
const NOW = new Date(2026, 9, 22, 12).getTime();
const day = (d: number, h = 9) => new Date(2026, 9, d, h).getTime();
const saved = (m: typeof A, mi: number, at: number, car?: GasDrive['car']): GasDrive => ({ mi, at, gasShare: m.gasShare, ...(car ? { car } : {}) });

describe('the gas line, by the worked example', () => {
  test('the price is EIA\'s Washington regular for the week of Oct 19, 2026', () => {
    assert.equal(GAS_PRICE.usdPerGal, P);
    assert.equal(GAS_PRICE.weekOf, '2026-10-19');
    assert.equal(GAS_PRICE.seriesId, 'EMM_EPMR_PTE_SWA_DPG');
    assert.equal(gasPrice()?.usdPerGal, P);
    // not believable: no price at all
    for (const bad of [1.5, 12, NaN]) assert.equal(gasPrice({ ...GAS_PRICE, usdPerGal: bad }), null);
    assert.equal(priceAgeDays(GAS_PRICE, day(22)), 3);
  });

  test('drive A: hard starts and stops are 5.0% more gas', () => {
    assert.ok(near(A.gasShare.typical, 0.05));
    assert.equal(A.gasShare.speed, 0);
    assert.ok(near(A.gasShare.low, 0.02) && near(A.gasShare.high, 0.08));
  });

  test('drive B: speeding 6.3%, hard starts and stops 0.625%, 6.925% in all', () => {
    assert.ok(near(B.gasShare.speed, 0.063));
    assert.ok(near(B.gasShare.typical, 0.06925));
    assert.ok(near(B.gasShare.low, 0.0655) && near(B.gasShare.high, 0.073));
  });

  test('the week: 6.28% by miles at $5.332 is 33.5¢, shown as about 35¢, 25¢ to 40¢', () => {
    const w = gasWeek([saved(A, 10, day(20)), saved(B, 20, day(21))], NOW)!;
    assert.ok(w);
    assert.ok(near(w.share.typical, (0.05 * 10 + 0.06925 * 20) / 30));
    assert.ok(near(100 * w.share.typical * P, 33.5, 0.05));
    assert.equal(w.cents, 35);
    assert.equal(w.text, 'about 35¢');
    assert.equal(w.words, 'Your fast starts, hard brakes and speeding added about 35¢ to every gallon this week.');
    assert.equal(w.range, 'Range: 25¢ to 40¢ a gallon.');
    assert.equal(w.price, 'Washington regular gas: $5.33 a gallon, week of Oct 19, 2026 (U.S. EIA).');
    // speeding is the bigger part (4.2% of the 6.28%)
    assert.ok(near(w.share.speed, 0.042));
    assert.equal(w.pitch, 'Save gas: each 5 mph over 50 is like about 35¢ more a gallon.');
    assert.equal(w.lastWeek, false);
    assert.equal(w.drives, 2);
    assert.equal(w.miles, 30);
  });

  test('one drive at a time names only the habit that made most of it', () => {
    const a = gasLine(saved(A, 10, day(20)))!, b = gasLine(saved(B, 20, day(21)))!;
    assert.equal(a.words, 'Your fast starts and hard brakes added about 25¢ to every gallon on this drive.');
    assert.equal(a.pitch, 'Save gas: start gently and ease off sooner.');
    assert.equal(a.speed, false);
    assert.equal(b.words, 'Your speeding added about 35¢ to every gallon on this drive.');
    assert.equal(b.hard, false);
  });

  test('cents a gallon x calm gallons = the dollars, so the two never disagree', () => {
    for (const [m, mi] of [[A, 10], [B, 20]] as const) {
      const gal = mi / DEFAULT_MONEY_OPTIONS.mpg.typical;
      assert.ok(near(m.gasShare.typical * P * gal, m.hardGas.typical + m.speedGas.typical));
    }
  });

  test('mpg does not change the cents', () => {
    const o = { ...DEFAULT_MONEY_OPTIONS, mpg: { low: 12, typical: 15, high: 18 } };
    assert.deepEqual(driveMoney({ gasSteps: 18 }, pace({ cityMi: 2, highwayMi: 18, cityHard: 1 }), o).gasShare, B.gasShare);
  });
});

describe('when the gas line hides', () => {
  const line = (share: number, extra: Partial<GasDrive> = {}) => gasLine({ mi: 5, gasShare: { low: share / 2, typical: share, high: share * 2, speed: 0 }, ...extra });

  test('electric cars, drives under 2 miles, and under 5¢ a gallon', () => {
    assert.ok(line(0.05));
    assert.equal(line(0.05, { car: 'ev' }), null);
    assert.equal(line(0.05, { mi: 1.9 }), null);
    // 0.9% at $5.33 is 4.8¢
    assert.equal(line(0.009), null);
    assert.ok(line(0.0094));
    assert.equal(line(0), null);
    assert.equal(gasHow('ev'), null);
  });

  test('the week leaves EVs out, and uses last week while this one has under 2 gas miles', () => {
    assert.equal(gasWeek([saved(A, 10, day(20), 'ev')], NOW), null);
    const last = gasWeek([saved(A, 10, day(15)), saved(B, 1.5, day(21))], NOW)!;
    assert.equal(last.lastWeek, true);
    assert.equal(last.miles, 10);
    assert.match(last.words, /every gallon last week\.$/);
    // two weeks back is too old
    assert.equal(gasWeek([saved(A, 10, day(11))], NOW), null);
    assert.equal(gasWeek([], NOW), null);
  });

  test('the week starts Monday at midnight, here', () => {
    assert.equal(weekStart(NOW), new Date(2026, 9, 19).getTime());
    assert.equal(weekStart(new Date(2026, 9, 25, 23).getTime()), new Date(2026, 9, 19).getTime());
    assert.equal(weekStart(new Date(2026, 9, 26, 0, 1).getTime()), new Date(2026, 9, 26).getTime());
    const w = gasWeek([saved(A, 10, new Date(2026, 9, 18, 23, 59).getTime()), saved(B, 20, new Date(2026, 9, 19, 0, 1).getTime())], NOW)!;
    assert.equal(w.drives, 1);
  });

  test('no speed data never says speeding', () => {
    const l = lineFor({ low: 0.03, typical: 0.06, high: 0.1, speed: 0 }, 'drive')!;
    assert.doesNotMatch(l.words, /speeding/);
  });

  test('no price: no line', () => {
    assert.equal(lineFor(B.gasShare, 'drive', null), null);
  });
});

describe('gas words', () => {
  test('nearest 5¢ under $1, nearest 10¢ from there', () => {
    assert.equal(centsText(33.5), 'about 35¢');
    assert.equal(centsText(26.8), 'about 25¢');
    assert.equal(centsText(97.4), 'about 95¢');
    assert.equal(centsText(97.6), 'about $1.00');
    assert.equal(centsText(107), 'about $1.10');
    assert.equal(centsText(213), 'about $2.10');
    assert.equal(centsAmount(40.2), '40¢');
    assert.equal(roundCents(104), 100);
    assert.equal(per5MphText(P), 'about 35¢');
  });

  test('both ends rounding the same shows one value', () => {
    assert.equal(lineFor({ low: 0.075, typical: 0.075, high: 0.0751, speed: 0 }, 'drive')!.range, null);
  });

  test('drives saved before the share was kept still get one', () => {
    // $0.10 of hard gas over 4 mi at 25 mpg and $5.34: 0.1 x 25 / (4 x 5.34) = 11.7%
    const s = shareOf({ mi: 4, at: day(23), hardGas: { low: 0.05, typical: 0.1, high: 0.2 }, speeds: [{ gasSteps: 2 }] })!;
    assert.ok(near(s.speed, (2 * 0.07) / 4));
    assert.ok(near(s.typical, (0.1 * 25) / (4 * 5.34) + s.speed));
    assert.ok(near(s.low, (0.05 * 30) / (4 * 5.34) + s.speed));
    // saved before Oct 22 2026: priced at $5.40
    const old = shareOf({ mi: 4, at: day(18), hardGas: { low: 0.05, typical: 0.1, high: 0.2 } })!;
    assert.ok(near(old.typical, (0.1 * 25) / (4 * 5.4)));
    // only counts: every mile stop-and-go
    assert.ok(near(shareOf({ mi: 4, hardBrakes: 4 })!.typical, 0.25 * 0.5));
    assert.equal(shareOf({ mi: 0 }), null);
  });

  test('plain words: no dashes, no tire money, sources cited', () => {
    const how = gasHow()!;
    const all = [how.heading, ...how.body, gasWeek([saved(A, 10, day(20)), saved(B, 20, day(21))], NOW)!.words, gasLine(saved(A, 10, day(20)))!.pitch];
    for (const t of all) assert.doesNotMatch(t, /[–—]|tire/i, t);
    assert.equal(how.heading, 'How we figure this');
    assert.ok(how.body.some((t) => t.includes('7.5% extra at $5.33 is about 40¢ a gallon')));
    assert.equal(how.sources.length, 5);
    assert.ok(how.sources.some((s) => s.includes('fueleconomy.gov/feg/driveHabits.jsp')));
    assert.ok(how.sources.some((s) => s.includes('EMM_EPMR_PTE_SWA_DPG')));
  });
});
