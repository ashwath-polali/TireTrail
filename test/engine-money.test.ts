/** what a drive costs: gas from hard starts and stops and from speeding, tires from hard stops, always about and with a range */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_DUST_OPTIONS, severity } from '../src/drive/dust.ts';
import { SpeedLimits } from '../src/drive/limits.ts';
import { aggressiveness, DEFAULT_MONEY_OPTIONS, driveMoney, gasCost, hardGasCost, hardGasGuess, hardWeight, moneyNote, moneyText, NO_PACE, paceOf, rangeText, roundYear, tireCost, yearMoney, type Pace, type Usd } from '../src/drive/money.ts';
import { buildSignals, distanceM } from '../src/drive/signal.ts';
import { findSpeeding, NO_SPEEDING } from '../src/drive/speeding.ts';
import { speedEvents } from '../src/drive/events.ts';
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


const pace = (o: Partial<Pace>): Pace => ({ ...NO_PACE, ...o });
// the gas for some miles at 30, 25 and 20 mpg and $5.40: the low, central and high ends
const gasUsd = (mi: number): Usd => ({ low: (mi / 30) * 5.4, typical: (mi / 25) * 5.4, high: (mi / 20) * 5.4 });
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const KEYS = ['low', 'typical', 'high'] as const;
const money = (fixes: ReturnType<typeof drive>, limits?: SpeedLimits) => {
  const sig = buildSignals(fixes), meters = distanceM(sig);
  const { s, dm } = severity(sig);
  const sp = limits ? findSpeeding(sig, limits, meters) : NO_SPEEDING;
  return driveMoney(detectStops(sig), s, dm, meters, sp, paceOf(sig, speedEvents(sig)));
};

describe('gas from hard starts and stops', () => {
  test('one counts its mph per second / 8, at most 2', () => {
    assert.equal(hardWeight(8), 1);
    assert.equal(hardWeight(7), 0.875);
    assert.equal(hardWeight(10), 1.25);
    assert.equal(hardWeight(30), 2);
    assert.equal(hardWeight(0), 0);
    assert.equal(hardWeight(NaN), 0);
  });

  test("how aggressive: none is 0, 2 a mile is 1 (ORNL's aggressive city test), a straight line between, never past 1", () => {
    assert.equal(aggressiveness(0, 5), 0);
    assert.equal(aggressiveness(5, 5), 0.5);
    assert.equal(aggressiveness(10, 5), 1);
    assert.equal(aggressiveness(40, 5), 1);
    assert.equal(aggressiveness(3, 0), 0);
    let last = -1;
    for (let n = 0; n <= 30; n++) {
      const a = aggressiveness(n, 5);
      assert.ok(a >= last);
      last = a;
    }
  });

  test('stop-and-go: fully aggressive wastes 10%, 25%, 40% of the gas (fueleconomy.gov); half as aggressive, half that', () => {
    const full = hardGasCost(pace({ cityMi: 10, cityHard: 20 })), g = gasUsd(10);
    for (const [k, x] of [['low', 0.1], ['typical', 0.25], ['high', 0.4]] as const) assert.ok(near(full.usd[k], g[k] * x), k);
    assert.ok(near(full.share, 0.25));
    // more aggressive than the study still counts as the study
    assert.deepEqual(hardGasCost(pace({ cityMi: 10, cityHard: 90 })).usd, full.usd);
    const half = hardGasCost(pace({ cityMi: 10, cityHard: 10 }));
    assert.ok(near(half.usd.typical, full.usd.typical / 2));
    assert.ok(ordered(half.usd));
    // a smooth drive wastes none
    assert.deepEqual(hardGasCost(pace({ cityMi: 10 })).usd, { low: 0, typical: 0, high: 0 });
  });

  test('highway: hard starts alone 5%, 8.5%, 12% (Thomas 2017); with speeding never past 30% (fueleconomy.gov)', () => {
    const g = gasUsd(10);
    const calm = hardGasCost(pace({ highwayMi: 10, highwayHard: 20 }));
    for (const [k, x] of [['low', 0.05], ['typical', 0.085], ['high', 0.12]] as const) assert.ok(near(calm.usd[k], g[k] * x), k);
    // speeding is already 25% of the highway gas: hard starts get the last 5%
    const steps = (0.25 * 10) / 0.07, fast = hardGasCost(pace({ highwayMi: 10, highwayHard: 20 }), steps);
    for (const k of KEYS) {
      assert.ok(near(fast.usd[k], g[k] * 0.05), k);
      assert.ok(gasCost({ gasSteps: steps })[k] + fast.usd[k] <= g[k] * 0.3 + 1e-9, k);
    }
    // a little speeding leaves the hard starts alone
    assert.deepEqual(hardGasCost(pace({ highwayMi: 10, highwayHard: 20 }), 5).usd, calm.usd);
  });

  test('each hard start or stop gets its share of its road, by how hard it was', () => {
    const p = pace({ cityMi: 4, cityHard: 2.25, highwayMi: 6, highwayHard: 1, each: [{ w: 1, highway: false }, { w: 1.25, highway: false }, { w: 1, highway: true }] });
    const r = hardGasCost(p);
    assert.equal(r.perEvent.length, 3);
    assert.ok(near(r.perEvent[1] / r.perEvent[0], 1.25));
    assert.ok(near(r.perEvent.reduce((a, b) => a + b, 0), r.usd.typical));
  });

  test('a drive saved before this was counted: all stop-and-go, each one counted once', () => {
    assert.deepEqual(hardGasGuess(10, 0), { low: 0, typical: 0, high: 0 });
    assert.deepEqual(hardGasGuess(0, 3), { low: 0, typical: 0, high: 0 });
    assert.deepEqual(hardGasGuess(10, 5), hardGasCost(pace({ cityMi: 10, cityHard: 5 })).usd);
  });

  test('a drive: miles under and over 50 mph, its hard starts and stops counted by how hard, and their gas', () => {
    // a mile at 30 mph, a hard stop (4 m/s², about 9 mph a second), a hard start (3.6 m/s²), 2 miles at 60 mph
    const fixes = drive(30 * MPH, [[120, 0], [(30 * MPH) / 4, -4], [5, 0], [(60 * MPH) / 3.6, 3.6], [120, 0]]);
    const sig = buildSignals(fixes), events = speedEvents(sig), p = paceOf(sig, events);
    assert.deepEqual(events.map((e) => e.kind), ['brake', 'start']);
    assert.ok(p.cityMi > 1 && p.cityMi < 1.15, `${p.cityMi}`);
    assert.ok(p.highwayMi > 1.95 && p.highwayMi < 2.1, `${p.highwayMi}`);
    assert.deepEqual(p.each.map((e) => e.highway), [false, false]);
    assert.ok(p.cityHard > 1.9 && p.cityHard < 2.4, `${p.cityHard}`);
    const m = money(fixes);
    // about fully aggressive for its stop-and-go mile: about 25% of that mile's gas, so about 8% of the drive's
    assert.ok(m.hardShare > 0.06 && m.hardShare < 0.1, `${m.hardShare}`);
    assert.ok(near(m.perEvent.reduce((a, b) => a + b, 0), m.hardGas.typical));
    assert.ok(ordered(m.hardGas) && m.hardGas.high / m.hardGas.low > 5);
  });

  test('a smooth drive wastes no gas: gentle stops and starts count for nothing', () => {
    const m = money(drive(13.4, [[60, 0], [13.4 / 1.2, -1.2], [10, 0], [13.4 / 1.5, 1.5], [60, 0], [13.4 / 1.2, -1.2], [5, 0]]));
    assert.deepEqual(m.hardGas, { low: 0, typical: 0, high: 0 });
    assert.equal(m.hardShare, 0);
    assert.equal(m.total.typical, 0);
  });
});

describe('a drive and a year', () => {
  test('a hard stop costs gas and tire wear; the same stop made gently costs nothing', () => {
    const hard = money(drive(13.4, [[20, 0], [13.4 / 4, -4], [10, 0]]));
    assert.ok(hard.hardGas.typical > 0);
    assert.ok(hard.tires.typical > 0);
    assert.equal(hard.speedGas.typical, 0);
    assert.ok(near(hard.total.typical, hard.hardGas.typical + hard.speedGas.typical + hard.tires.typical));
    assert.equal(hard.year, null, 'under 2 miles: no yearly figure');
    const gentle = money(drive(13.4, [[20, 0], [13.4 / 1.2, -1.2], [10, 0]]));
    assert.equal(gentle.total.typical, 0);
    // without its hard starts and stops given, nothing is guessed
    const sig = buildSignals(drive(13.4, [[20, 0], [13.4 / 4, -4], [10, 0]])), { s, dm } = severity(sig);
    assert.equal(driveMoney(detectStops(sig), s, dm, distanceM(sig), NO_SPEEDING).hardGas.typical, 0);
  });

  test('speeding alone never takes highway gas past 30%: 10 miles at 85 in a 55', () => {
    const m = money(cruise(85, 10), road(55));
    // 6 steps over 50 x 7% would be 42%
    assert.ok(m.speedKept > 0.7 && m.speedKept < 0.73, `${m.speedKept}`);
    const g = gasUsd(10);
    for (const k of KEYS) assert.ok(near(m.speedGas[k], g[k] * 0.3, g[k] * 0.01), k);
    assert.equal(m.hardGas.typical, 0);
  });

  test('a year is 11,100 miles of driving like the drives given', () => {
    const u = (typical: number): Usd => ({ low: typical / 2, typical, high: typical * 2 });
    const pool = { mi: 3, hardGas: u(0.1), speedGas: u(0.02), tires: u(0.01) };
    const y = yearMoney([pool])!;
    assert.ok(near(y.hardGas.typical, (0.1 / 3) * 11_100));
    assert.ok(near(y.speedGas.typical, (0.02 / 3) * 11_100));
    assert.ok(near(y.total.typical, (0.13 / 3) * 11_100));
    assert.equal(y.fromMi, 3);
    // pooled: the miles and the money add up first
    const both = yearMoney([pool, { mi: 7, hardGas: u(0), speedGas: u(0), tires: u(0) }])!;
    assert.ok(near(both.total.typical, (0.13 / 10) * 11_100));
    assert.equal(yearMoney([{ ...pool, mi: 1.5 }]), null);
    assert.equal(yearMoney([]), null);
  });

  test('plain money words: cents for a drive, nearest $5 for a year, nearest $10 from $100', () => {
    assert.equal(moneyText(0.042, 'drive'), 'about 4¢');
    assert.equal(moneyText(0.004, 'drive'), 'under 1¢');
    assert.equal(moneyText(1.234, 'drive'), 'about $1.23');
    assert.equal(moneyText(46.9, 'year'), 'about $45');
    assert.equal(moneyText(48, 'year'), 'about $50');
    assert.equal(moneyText(96, 'year'), 'about $95');
    assert.equal(moneyText(378.4, 'year'), 'about $380');
    assert.equal(moneyText(1234, 'year'), 'about $1,230');
    assert.equal(moneyText(1.2, 'year'), 'under $5');
    assert.equal(moneyText(0, 'year'), '$0');
    assert.equal(roundYear(97.5), 100);
    assert.equal(rangeText({ low: 15.3, typical: 26.9, high: 69 }, 'year'), '$15 to $70');
    assert.equal(rangeText({ low: 132, typical: 378, high: 770 }, 'year'), '$130 to $770');
    assert.match(moneyNote(), /25 mpg.*\$5\.40 a gallon \(Oct 2026\).*11,100 miles a year/);
    assert.doesNotMatch(moneyNote(), /[–—]/);
  });

  test('the defaults are the agreed ones, and the sourced ones', () => {
    const o = DEFAULT_MONEY_OPTIONS;
    assert.equal(o.mpg.typical, 25);
    assert.equal(o.gasUsdPerGal, 5.4);
    assert.equal(o.annualMi, 11_100);
    assert.equal(o.lossPer5Mph, 0.07);
    assert.equal(o.gentleDecel, 1.4);
    // fueleconomy.gov: 10% to 40% in stop-and-go, 15% to 30% at highway speeds; Thomas 2017: 5% to 14% more fuel from hard acceleration alone
    assert.deepEqual(o.cityLoss, { low: 0.1, typical: 0.25, high: 0.4 });
    assert.deepEqual(o.highwayLoss, { low: 0.05, typical: 0.085, high: 0.12 });
    assert.equal(o.highwayMax, 0.3);
    assert.equal(o.highwayMph, 50);
    assert.equal(o.aggressivePerMi, 2);
    assert.equal(o.hardMphPerS, 8);
  });
});
