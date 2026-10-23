/** tire dust in grams: braking, speeding up and turning, by vehicle; and the words around it */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dustVerdict, pctVs, stripRows, vsWord } from '../src/app/screens/drive-words.ts';
import { dustWeek, goalWord } from '../src/app/screens/history-words.ts';
import { DEFAULT_DUST_OPTIONS, estimateDust, gramsText, lateral, microText, sharpTurns, VEHICLES } from '../src/drive/dust.ts';
import { monthMoney, monthText, type MoneyPool } from '../src/drive/money.ts';
import { buildSignals, distanceM } from '../src/drive/signal.ts';
import { readSummary } from '../src/drive/summary.ts';
import type { Fix } from '../src/drive/types.ts';
import { drive, P, T0 } from './engine-helpers.ts';

/** once a second around a circle of radius r at v m/s, after a straight run-in */
function circle(r: number, v: number, secs: number): Fix[] {
  const out: Fix[] = [];
  for (let k = 0; k <= secs; k++) {
    const a = (v * k) / r;
    const [lon, lat] = P.toLngLat([r * Math.sin(a), r - r * Math.cos(a)]);
    out.push({ t: T0 + k * 1000, lat, lon, speed: v, accuracy: 5 });
  }
  return out;
}

const dustOf = (fixes: Fix[], vehicle = DEFAULT_DUST_OPTIONS.vehicle) => {
  const sig = buildSignals(fixes);
  return estimateDust(sig, distanceM(sig), DEFAULT_DUST_OPTIONS, [], null, vehicle);
};

describe('sideways force from the GPS track', () => {
  test('a steady circle reads speed² / radius; a straight road reads none', () => {
    const sig = buildSignals(circle(60, 12, 40));
    const lat = lateral(sig)[0];
    const mid = lat.slice(8, 30);
    for (const x of mid) assert.ok(Math.abs(x - (12 * 12) / 60) < 0.25, `${x}`);
    const straight = lateral(buildSignals(drive(15, [[60, 0]])))[0];
    assert.ok(straight.every((x) => x < 0.05));
  });

  test('a tight fast curve is a sharp turn (0.4 g); a gentle one is not', () => {
    const tight = buildSignals(circle(30, 12, 30)), gentle = buildSignals(circle(120, 12, 30));
    assert.ok(sharpTurns(tight, lateral(tight)).length >= 1);
    assert.equal(sharpTurns(gentle, lateral(gentle)).length, 0);
  });
});

describe('tire dust', () => {
  test('a steady straight drive sheds less than typical driving on the same road', () => {
    const d = dustOf(drive(15, [[300, 0]]));
    assert.ok(d.styleFactor.typical < 0.8, `${d.styleFactor.typical}`);
    assert.ok(d.mg.typical > 0 && d.mg.typical < d.typicalMg.typical);
    assert.ok(d.tireLifeMi > 45_000);
  });

  test('hard starts and stops shed more than gentle ones over the same miles, and more than typical', () => {
    const hard = dustOf(drive(0, [[5, 3.5], [40, 0], [5, -3.5], [3, 0], [5, 3.5], [40, 0], [5, -3.5]]));
    const soft = dustOf(drive(0, [[17.5, 1], [27.5, 0], [17.5, -1], [3, 0], [17.5, 1], [27.5, 0], [17.5, -1]]));
    assert.ok(hard.mg.typical > soft.mg.typical, `${hard.mg.typical} ${soft.mg.typical}`);
    assert.ok(hard.styleFactor.typical > 1, `${hard.styleFactor.typical}`);
  });

  test('the range: low < typical < high, and 6PPDQ is 18 µg a gram (3.5 to 43)', () => {
    const d = dustOf(drive(15, [[200, 0]]));
    assert.ok(d.mg.low < d.mg.typical && d.mg.typical < d.mg.high);
    assert.ok(Math.abs(d.sixPpdqUg.typical - (d.mg.typical / 1000) * 18) < 1e-9);
    assert.ok(Math.abs(d.sixPpdqUg.low - (d.mg.low / 1000) * 3.5) < 1e-9);
    assert.ok(Math.abs(d.sixPpdqUg.high - (d.mg.high / 1000) * 43) < 1e-9);
  });

  test('heavier vehicles shed more in step with weight, EVs 15% more, and the comparison stays', () => {
    const f = drive(15, [[200, 0]]);
    const car = dustOf(f, 'car'), small = dustOf(f, 'small'), ev = dustOf(f, 'ev'), pickup = dustOf(f, 'pickup');
    assert.ok(Math.abs(ev.typicalMg.typical / car.typicalMg.typical - 1.15) < 0.02);
    assert.ok(Math.abs(pickup.typicalMg.typical / car.typicalMg.typical - 1.5) < 0.03);
    assert.ok(small.mg.typical < car.mg.typical && car.mg.typical < pickup.mg.typical);
    assert.ok(Math.abs(pickup.styleFactor.typical - car.styleFactor.typical) < 0.03);
    assert.equal(VEHICLES.car.k, 1);
  });

  test('a typical mile for a typical car is near the fleet mean, under 110 mg/km on a straight road', () => {
    // 68 mg/km/t x 1.6 t on the R117 route; a straight road at a steady speed has less force than that route
    const d = dustOf(drive(15, [[300, 0]]));
    const typPerKm = d.typicalMg.typical / d.distanceKm;
    assert.ok(typPerKm > 40 && typPerKm < 110, `${typPerKm}`);
  });

  test('grams and micrograms, plainly', () => {
    assert.equal(gramsText(344.9), '0.34 g');
    assert.equal(gramsText(1890), '1.9 g');
    assert.equal(gramsText(12_400), '12 g');
    assert.equal(gramsText(64), '60 mg');
    // never 100 mg beside 0.10 g
    assert.equal(gramsText(97), '0.10 g');
    assert.equal(gramsText(0), '0 g');
    assert.equal(microText(6.2), '6.2 µg');
    assert.equal(microText(34.4), '34 µg');
    assert.equal(microText(0.2), 'under 1 µg');
  });
});

describe('the report words', () => {
  test('percent vs typical, and the verdict', () => {
    assert.equal(pctVs(345, 309), 12);
    assert.equal(vsWord(-21), '21% less');
    assert.equal(vsWord(12), '12% more');
    assert.equal(vsWord(2), 'About typical');
    assert.equal(dustVerdict(-20), 'Very smooth drive');
    assert.equal(dustVerdict(-5), 'Smooth drive');
    assert.equal(dustVerdict(4), 'About typical');
    assert.equal(dustVerdict(11), 'Room to improve');
  });

  test('the smoothness strip: counts, and a share only where there were some', () => {
    const rows = stripRows({ brakes: 3, starts: 0, turns: 1 }, { brakes: 0.228, starts: 0, turns: 0.004 });
    assert.deepEqual(rows.map((r) => [r.label, r.n, r.pct]), [['Hard brakes', 3, 23], ['Fast starts', 0, 0], ['Sharp turns', 1, 1]]);
  });
});

describe('a month, and this week', () => {
  const pool = (mi: number, usd: number): MoneyPool => ({ mi, hardGas: { low: usd / 2, typical: usd, high: usd * 2 }, speedGas: { low: 0, typical: 0, high: 0 }, tires: { low: 0, typical: 0.01, high: 0.02 } });

  test('a monthly figure needs 3 drives and 10 miles, then scales to 925 miles', () => {
    assert.equal(monthMoney([pool(20, 1), pool(20, 1)]), null);
    assert.equal(monthMoney([pool(2, 1), pool(2, 1), pool(2, 1)]), null);
    const m = monthMoney([pool(5, 0.1), pool(5, 0.1), pool(5, 0.1)])!;
    assert.ok(Math.abs(m.total.typical - (0.33 / 15) * 925) < 1e-9);
    assert.equal(m.drives, 3);
    assert.equal(monthText(m.total.typical), 'about $20 a month');
    assert.equal(monthText(0.3), 'under $1 a month');
    assert.equal(monthText(8.6), 'about $9 a month');
  });

  test('this week: tire dust against typical, the goal, and the best and roughest drive', () => {
    const now = T0, day = 86_400_000;
    const sums = [
      { at: now - day, dustMg: 300, typMg: 400 },
      { at: now - 2 * day, dustMg: 500, typMg: 400 },
      { at: now - 9 * day, dustMg: 900, typMg: 400 },
      { at: now - 3 * day },
    ];
    const w = dustWeek(sums, now)!;
    assert.equal(w.drives, 2);
    assert.equal(w.mg, 800);
    assert.equal(w.pct, 0);
    assert.deepEqual([w.best?.pct, w.worst?.pct], [-25, 25]);
    assert.equal(dustWeek([{ at: now - 9 * day, dustMg: 1, typMg: 1 }], now), null);
    assert.deepEqual(goalWord(-12), { text: 'Goal met', met: true });
    assert.deepEqual(goalWord(-4), { text: 'Goal: 10% less', met: false });
  });

  test('a saved drive keeps its tire dust, vehicle and sharp turns; bad ones are dropped', () => {
    const base = { at: T0, mi: 3, score: 80, brakes: [] };
    const s = readSummary({ ...base, dustMg: 345, typMg: 309, turns: 2, car: 'pickup' })!;
    assert.deepEqual([s.dustMg, s.typMg, s.turns, s.car], [345, 309, 2, 'pickup']);
    const bad = readSummary({ ...base, dustMg: -1, typMg: 0, turns: 'x', car: 'tank' })!;
    assert.deepEqual([bad.dustMg, bad.typMg, bad.turns, bad.car], [undefined, undefined, undefined, undefined]);
    // salmon stream crossings, once known
    assert.equal(readSummary({ ...base, streams: 3 })!.streams, 3);
    assert.equal(readSummary({ ...base, streams: -1 })!.streams, undefined);
    assert.equal(readSummary(base)!.streams, undefined);
  });
});
