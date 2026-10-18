/** drives on real Bonney Lake streets (the 5 km test) */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { loadInputs } from '../scripts/lib/inputs.ts';
import { encodeBundle } from '../src/data/encode.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { analyzeDrive } from '../src/drive/analyze.ts';
import { parseGPX, writeGPX } from '../src/drive/gpx.ts';
import { dist, localProjection, type XY } from '../src/geo/geo.ts';
import { analyzeCity } from '../src/trace/city.ts';
import { bonneyLakeRoute, MIXED_PLAN, simulateDrive, type PlannedStop } from './synth.ts';

const P = localProjection();
let data: TireTrailData;
let route: XY[];

before(() => {
  data = new TireTrailData(encodeBundle(analyzeCity(loadInputs()), {}));
  route = bonneyLakeRoute(5000);
});

/** planned stop nearest each reported stop, and its offset */
function match(found: { lngLat: [number, number] }[], planned: PlannedStop[]) {
  return found.map((f) => {
    const xy = P.toXY(f.lngLat);
    const best = planned.reduce((b, p) => (dist(p.xy, xy) < dist(b.xy, xy) ? p : b));
    return { planned: best, offM: dist(best.xy, xy) };
  });
}

function assertHardestAreTheHardStops(report: ReturnType<typeof analyzeDrive>, planned: PlannedStop[], label: string) {
  assert.equal(report.stops.length, 6, `${label}: found ${report.stops.length} stops`);
  assert.equal(report.hardest.length, 3);
  const m = match(report.hardest, planned);
  for (const x of m) {
    assert.ok(x.planned.hard, `${label}: a gentle stop ranked in the top 3`);
    assert.ok(x.offM <= 30, `${label}: ${x.offM.toFixed(1)} m from the planned spot`);
  }
  assert.equal(new Set(m.map((x) => x.planned.s)).size, 3, `${label}: the top 3 are three different stops`);
  assert.ok(report.hardest.every((h) => h.hard));
  assert.equal(report.stops.filter((s) => s.hard).length, 3, `${label}: exactly three stops count as hard`);
}

describe('the 5 km test drive', () => {
  test('the route is about 5 km of real Bonney Lake street', () => {
    const { lengthM } = simulateDrive(route, MIXED_PLAN);
    assert.ok(Math.abs(lengthM - 5000) < 1);
  });

  test('phone recording (GPS speed + 4 m position noise): the top 3 are the hard stops, each within 30 m', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const drive = simulateDrive(route, MIXED_PLAN, { seed });
      assertHardestAreTheHardStops(analyzeDrive(drive.fixes, data), drive.stops, `seed ${seed}`);
    }
  });

  test('hardness is measured, not just ranked: about 3 m/s² hard, about 1 m/s² gentle', () => {
    const drive = simulateDrive(route, MIXED_PLAN, { seed: 1 });
    const r = analyzeDrive(drive.fixes, data);
    for (const s of r.stops) {
      const planned = match([s], drive.stops)[0].planned;
      assert.ok(Math.abs(s.peakDecel - planned.decel) < 0.6, `peak ${s.peakDecel.toFixed(2)} vs planned ${planned.decel}`);
    }
  });

  test('no false stops at constant speed', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const noise of ['white', 'correlated'] as const) {
        for (const withSpeed of [true, false]) {
          const drive = simulateDrive(route, [], { seed, noise, withSpeed });
          assert.equal(analyzeDrive(drive.fixes, data).stops.length, 0, `seed ${seed}, ${noise}, speed ${withSpeed}`);
        }
      }
    }
  });

  test('trip distance is within 2% of the route', () => {
    const r = analyzeDrive(simulateDrive(route, MIXED_PLAN, { seed: 2 }).fixes, data);
    assert.ok(Math.abs(r.distanceKm - 5) / 5 < 0.02, `${r.distanceKm} km`);
  });

  test('each hard stop comes with its nearest drain, the traced path and a tip', () => {
    const r = analyzeDrive(simulateDrive(route, MIXED_PLAN, { seed: 3 }).fixes, data);
    for (const h of r.hardest) {
      assert.ok(h.tip.length > 10);
      if (h.drain) {
        assert.equal(h.cls, h.drain.cls);
        assert.ok(h.drainDistanceM! <= 50);
        assert.equal(h.path!.assets[0], h.drain.id);
        assert.ok(h.path!.coords.length >= 1);
        if (h.cls === 'creek') assert.match(h.tip, /Fennel Creek/);
        else assert.doesNotMatch(h.tip, /Fennel Creek/);
      } else {
        assert.equal(h.cls, 'none');
      }
      assert.match(h.tip, /Brake earlier here\./);
    }
  });
});

describe('GPX import', () => {
  test('a GPX file gives the same answer as the live recording', () => {
    const drive = simulateDrive(route, MIXED_PLAN, { seed: 4 });
    const direct = analyzeDrive(drive.fixes, data);
    const viaGpx = analyzeDrive(parseGPX(writeGPX(drive.fixes)), data);
    assert.equal(viaGpx.speedSource, 'device');
    assert.deepEqual(
      viaGpx.hardest.map((h) => h.drain?.id),
      direct.hardest.map((h) => h.drain?.id),
    );
    for (let i = 0; i < 3; i++) assert.ok(dist(P.toXY(viaGpx.hardest[i].lngLat), P.toXY(direct.hardest[i].lngLat)) < 1);
  });

  test('a GPX file without speeds still ranks the hard stops first', () => {
    // positions-only speed blurs a 4.5 s hard stop to ~2 m/s²,
    // so check ranking and locations, not the hard flag
    for (const noise of ['white', 'correlated'] as const) {
      for (const seed of [1, 2, 3]) {
        const drive = simulateDrive(route, MIXED_PLAN, { seed, noise });
        const r = analyzeDrive(parseGPX(writeGPX(drive.fixes, 'drive', { speed: false })), data);
        const label = `positions only, ${noise}, seed ${seed}`;
        assert.equal(r.speedSource, 'positions');
        assert.equal(r.stops.length, 6, label);
        assert.ok(r.warnings.some((w) => /speeds come from positions/.test(w)));
        const m = match(r.hardest, drive.stops);
        assert.ok(m.every((x) => x.planned.hard && x.offM <= 30), `${label}: ${m.map((x) => `${x.planned.decel}@${x.offM.toFixed(0)}m`).join(' ')}`);
        assert.equal(new Set(m.map((x) => x.planned.s)).size, 3, label);
      }
    }
  });
});

describe('tire dust', () => {
  test('is a range, and grows with distance and with hard braking', () => {
    const gentle = analyzeDrive(simulateDrive(route, MIXED_PLAN.map((p) => ({ ...p, decel: 1 })), { seed: 5 }).fixes, data).dust;
    const hard = analyzeDrive(simulateDrive(route, MIXED_PLAN.map((p) => ({ ...p, decel: 3 })), { seed: 5 }).fixes, data).dust;
    for (const d of [gentle, hard]) {
      assert.ok(d.mg.low < d.mg.typical && d.mg.typical < d.mg.high);
      assert.ok(d.sixPpdqUg.low < d.sixPpdqUg.high);
    }
    assert.ok(hard.styleFactor.typical > gentle.styleFactor.typical);
    // ~110 mg/km, so ~0.5 g over 5 km
    assert.ok(gentle.mg.typical > 250 && gentle.mg.typical < 1000, `${gentle.mg.typical} mg`);
    const short = analyzeDrive(simulateDrive(bonneyLakeRoute(2500), MIXED_PLAN.map((p) => ({ ...p, decel: 1 })), { seed: 5 }).fixes, data).dust;
    assert.ok(short.mg.typical < gentle.mg.typical);
  });

  test('the hardest stops report their share of the modeled wear', () => {
    const r = analyzeDrive(simulateDrive(route, MIXED_PLAN, { seed: 1 }).fixes, data);
    assert.ok(r.hardestWearShare > 0 && r.hardestWearShare < 1);
    for (const h of r.hardest) assert.ok(h.wearVsGentle > 2 && h.wearVsGentle < 6, `${h.wearVsGentle}`);
  });
});
