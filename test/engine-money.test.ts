/** what a drive costs: gas from speeding, tires from hard stops, always about and with a range */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_DUST_OPTIONS, severity } from '../src/drive/dust.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { DEFAULT_MONEY_OPTIONS, driveMoney, gasCost, moneyNote, moneyText, rangeText, tireCost, yearMoney, type Usd } from '../src/drive/money.ts';
import { buildSignals, distanceM } from '../src/drive/signal.ts';
import { findSpeeding, NO_SPEEDING } from '../src/drive/speeding.ts';
import { detectStops } from '../src/drive/stops.ts';
import { drive, MI, MPH, roads } from './engine-helpers.ts';

const ordered = (u: Usd) => u.low <= u.typical + 1e-12 && u.typical <= u.high + 1e-12;
// a north-south road, 20 km long
const road = (mph: number) => new SpeedLimits(roads([[mph, [0, -1000], [0, 20000]]]));
const cruise = (mph: number, miles: number) => drive(mph * MPH, [[(miles * MI) / (mph * MPH), 0]]);
const speeding = (fixes: ReturnType<typeof drive>, mph: number) => {
  const sig = buildSignals(fixes);
  return findSpeeding(sig, road(mph), distanceM(sig));
};

describe('gas from speeding', () => {
  test('10 miles at 65 in a 55: 7% more gas per 5 mph over, at 25 mpg and $5.40', () => {
    const sp = speeding(cruise(65, 10), 55);
    assert.ok(Math.abs(sp.overMi - 10) < 0.2, `${sp.overMi}`);
    assert.ok(sp.share > 0.95);
    // 10 mi / 25 mpg = 0.4 gal; 10 mph over = 14% more: 0.056 gal = 30¢
    const gas = gasCost(sp);
    assert.ok(Math.abs(gas.typical - 0.4 * 0.14 * 5.4) < 0.01, `${gas.typical}`);
    assert.ok(ordered(gas) && gas.low < gas.typical && gas.high > gas.typical);
    assert.equal(sp.stretches.length, 1);
    assert.equal(sp.stretches[0].limitMph, 55);
    assert.ok(Math.abs(sp.stretches[0].topMph - 65) < 0.5);
  });

  test('below 50 mph speeding costs no gas, and over 50 counts from the higher of the limit and 50', () => {
    // 40 in a 30: over the limit, but under 50
    const slow = speeding(cruise(40, 3), 30);
    assert.ok(slow.overMi > 2.9);
    assert.equal(gasCost(slow).typical, 0);
    // 55 in a 45: only the 5 mph above 50 costs gas
    const mid = speeding(cruise(55, 10), 45);
    assert.ok(Math.abs(gasCost(mid).typical - 0.4 * 0.07 * 5.4) < 0.01, `${gasCost(mid).typical}`);
  });

  test('at or just over the limit is not speeding (GPS can read a little high)', () => {
    const sp = speeding(cruise(56.5, 5), 55);
    assert.equal(sp.overMi, 0);
    assert.equal(gasCost(sp).typical, 0);
  });

  test('no limits loaded: nothing is called speeding', () => {
    const sig = buildSignals(cruise(80, 5));
    assert.deepEqual(findSpeeding(sig, null, distanceM(sig)), NO_SPEEDING);
  });
});

describe('tires from hard stops', () => {
  const tires = (decel: number) => {
    const fixes = drive(13.4, [[20, 0], [13.4 / decel, -decel], [10, 0], [9, 1.5], [20, 0], [13.4 / decel, -decel], [10, 0]]);
    const sig = buildSignals(fixes);
    const { s, dm } = severity(sig, DEFAULT_DUST_OPTIONS);
    return tireCost(detectStops(sig), s, dm);
  };

  test('gentle stops add nothing; harder stops add more', () => {
    assert.equal(tires(1).total.typical, 0);
    assert.equal(tires(1.9).total.typical, 0, 'ordinary braking is not hard');
    const hard = tires(4), harder = tires(5);
    assert.ok(hard.total.typical > 0);
    assert.ok(harder.total.typical > hard.total.typical);
    assert.ok(ordered(hard.total));
    assert.equal(hard.perStop.length, 2);
  });

  test('a hard stop from 30 mph costs well under a cent of tire', () => {
    const one = tires(4).perStop[0];
    assert.ok(one > 0.0003 && one < 0.005, `${one}`);
  });
});

describe('a drive and a year', () => {
  test('gentle braking never saves gas: gas only comes from speeding', () => {
    const fixes = drive(13.4, [[20, 0], [13.4 / 4, -4], [10, 0]]);
    const sig = buildSignals(fixes);
    const { s, dm } = severity(sig);
    const m = driveMoney(detectStops(sig), s, dm, distanceM(sig), NO_SPEEDING);
    assert.equal(m.gas.typical, 0);
    assert.ok(m.tires.typical > 0);
    assert.equal(m.total.typical, m.gas.typical + m.tires.typical);
    assert.equal(m.year, null, 'under 2 miles: no yearly figure');
  });

  test('a year is 11,100 miles of driving like the drives given', () => {
    const pool = { mi: 3, gas: { low: 0.01, typical: 0.02, high: 0.03 }, tires: { low: 0, typical: 0.01, high: 0.04 } };
    const y = yearMoney([pool])!;
    assert.ok(Math.abs(y.gas.typical - (0.02 / 3) * 11_100) < 1e-9);
    assert.ok(Math.abs(y.total.typical - (0.03 / 3) * 11_100) < 1e-9);
    assert.equal(y.fromMi, 3);
    // pooled: the miles and the money add up first
    const both = yearMoney([pool, { mi: 7, gas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0, high: 0 } }])!;
    assert.ok(Math.abs(both.total.typical - (0.03 / 10) * 11_100) < 1e-9);
    assert.equal(yearMoney([{ ...pool, mi: 1.5 }]), null);
    assert.equal(yearMoney([]), null);
  });

  test('plain money words: cents for a drive, nearest $5 for a year', () => {
    assert.equal(moneyText(0.042, 'drive'), 'about 4¢');
    assert.equal(moneyText(0.004, 'drive'), 'under 1¢');
    assert.equal(moneyText(1.234, 'drive'), 'about $1.23');
    assert.equal(moneyText(46.9, 'year'), 'about $45');
    assert.equal(moneyText(48, 'year'), 'about $50');
    assert.equal(moneyText(1.2, 'year'), 'under $5');
    assert.equal(moneyText(0, 'year'), '$0');
    assert.equal(rangeText({ low: 15.3, typical: 26.9, high: 69 }, 'year'), '$15 to $70');
    assert.match(moneyNote(), /25 mpg.*\$5\.40 a gallon \(Oct 2026\).*11,100 miles a year/);
    assert.doesNotMatch(moneyNote(), /[–—]/);
  });

  test('the defaults are the agreed ones', () => {
    const o = DEFAULT_MONEY_OPTIONS;
    assert.equal(o.mpg.typical, 25);
    assert.equal(o.gasUsdPerGal, 5.4);
    assert.equal(o.annualMi, 11_100);
    assert.equal(o.lossPer5Mph, 0.07);
    assert.equal(o.gentleDecel, 1.4);
  });
});
