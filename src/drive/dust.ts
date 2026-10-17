// Tire-dust estimate, always a range.
// Wear per km ~ force squared (Pohrt 2019). Severity s = (a + a_res(v))^2 + lambda * sigma_lat^2,
// averaged per meter and compared with the UN R117 reference route (0.45 m/s² along, 0.93 across).
// That ratio scales 110 mg/km (range 25-227, Giechaskiel 2024).
// Turning isn't measured (1 Hz heading is too noisy), so lateral assumes typical cornering.
// lambda is unresolved in the literature (0.2x to 7x), so it's swept for the range.
import type { Signals } from './signal.ts';

export interface DustOptions {
  wearMgPerKm: { low: number; typical: number; high: number };
  lateralWeight: { low: number; central: number; high: number };
  refLongSD: number;
  refLatSD: number;
  refSpeedMps: number;
  rollingResistance: number;
  dragAreaM2: number;
  massKg: number;
  /** 6PPD-quinone in tread, µg/g */
  sixPpdqUgPerG: { low: number; typical: number; high: number };
}

export const DEFAULT_DUST_OPTIONS: DustOptions = {
  wearMgPerKm: { low: 25, typical: 110, high: 227 },
  lateralWeight: { low: 0.2, central: 1, high: 7 },
  refLongSD: 0.45,
  refLatSD: 0.93,
  refSpeedMps: 15,
  rollingResistance: 0.01,
  dragAreaM2: 0.7,
  massKg: 1500,
  sixPpdqUgPerG: { low: 3.5, typical: 18, high: 43 },
};

export interface Range {
  low: number;
  typical: number;
  high: number;
}

export interface DustEstimate {
  distanceKm: number;
  /** tread worn, mg */
  mg: Range;
  /** wear per km vs typical (1 = typical) */
  styleFactor: Range;
  /** µg. Estimate only, never show as measured. */
  sixPpdqUg: Range;
}

const G = 9.81;
const AIR_DENSITY = 1.2;

/** decel from rolling resistance + drag at v (m/s²) */
export function resistance(v: number, o: DustOptions = DEFAULT_DUST_OPTIONS): number {
  return o.rollingResistance * G + (0.5 * AIR_DENSITY * o.dragAreaM2 * v * v) / o.massKg;
}

// per-sample severity (a + a_res)^2 and meters each sample covers
export function severity(sig: Signals, o: DustOptions = DEFAULT_DUST_OPTIONS): { s: number[][]; dm: number[][] } {
  const s: number[][] = [];
  const dm: number[][] = [];
  for (const seg of sig.segments) {
    const n = seg.t.length;
    s.push(seg.v.map((v, i) => (seg.a[i] + resistance(v, o)) ** 2));
    // each reading covers half the gap to each neighbor
    dm.push(seg.v.map((v, i) => (v * ((i + 1 < n ? seg.t[i + 1] : seg.t[i]) - (i > 0 ? seg.t[i - 1] : seg.t[i]))) / 2));
  }
  return { s, dm };
}

export function estimateDust(sig: Signals, distanceM: number, o: DustOptions = DEFAULT_DUST_OPTIONS): DustEstimate {
  const { s, dm } = severity(sig, o);
  let num = 0;
  let den = 0;
  s.forEach((seg, k) => seg.forEach((x, i) => ((num += x * dm[k][i]), (den += dm[k][i]))));
  const tripLong = den > 0 ? num / den : resistance(o.refSpeedMps, o) ** 2;
  const refLong = resistance(o.refSpeedMps, o) ** 2 + o.refLongSD ** 2;
  const lat = o.refLatSD ** 2;
  const factor = (lambda: number) => (tripLong + lambda * lat) / (refLong + lambda * lat);
  const sweep = [o.lateralWeight.low, o.lateralWeight.high].map(factor);
  const styleFactor = { low: Math.min(...sweep), typical: factor(o.lateralWeight.central), high: Math.max(...sweep) };
  const km = distanceM / 1000;
  const mg = {
    low: km * o.wearMgPerKm.low * styleFactor.low,
    typical: km * o.wearMgPerKm.typical * styleFactor.typical,
    high: km * o.wearMgPerKm.high * styleFactor.high,
  };
  return {
    distanceKm: km,
    mg,
    styleFactor,
    sixPpdqUg: {
      low: (mg.low / 1000) * o.sixPpdqUgPerG.low,
      typical: (mg.typical / 1000) * o.sixPpdqUgPerG.typical,
      high: (mg.high / 1000) * o.sixPpdqUgPerG.high,
    },
  };
}

// Rubber shed vs a gentle 1 m/s² stop from the same speed.
// Wear per meter goes with force², but the stop is shorter (v²/2a), so total ~ decel.
export function wearVsGentleStop(decel: number, entrySpeed: number, o: DustOptions = DEFAULT_DUST_OPTIONS): number {
  if (decel <= 0) return 0;
  const r = resistance(entrySpeed, o);
  const gentle = 1;
  const force2PerDecel = (a: number) => Math.max(a - r, 0) ** 2 / a;
  return force2PerDecel(decel) / force2PerDecel(gentle);
}
