// Tire dust: the mass of tread a drive wears off, always an estimate with a range.
//
// Wear per meter grows with the square of the force on the tires, along and across (Pohrt 2019, doi:10.22190/FUME190104013P,
// citing Veith and Scholz; some road surfaces push the exponent to 3). Per reading:
//   S = (a + a_res(v))^2 + lambda * lat^2
// a: speeding up or slowing (GPS speed over about 2 s), a_res: rolling resistance and drag the tires also carry,
// lat: sideways force in turns (motion sensor when steady, else speed^2 x the curve of the GPS track).
// lambda weighs sideways force against lengthwise. JRC (Lubricants 2024, 12:338) used 1; Veith 1973 put it near 7;
// Liu 2022 found braking and speeding up matter more than cornering. So 1 is central and 0.2 to 7 sets the range.
//
// Scale: the UN R117 tire wear test route (Rev 6 Annex 10, in force Jan 2025) asks for force spreads of 0.45 m/s² along
// and 0.93 across, and its reference tire must wear 25 to 75 mg/km per tonne. On-road tests average 68 mg/km per tonne
// (about 300 tests, Giechaskiel 2024, doi:10.3390/su16020522). So a drive like that route wears 68 mg/km/t, 37 to 125.
// Wear grows in a straight line with vehicle weight (Giechaskiel 2024). EVs: +15% (CARB EMFAC2025, 40 test sets).
//
// Typical driving on the same route: same car, miles and turns (sharp ones eased to the cutoff), with the lengthwise
// spread of the matching part of the R117 route (urban-like 0.45 to 0.9 under 60 km/h, highway-like 0.1 to 0.45 at 90
// and up, the whole route between; middles used). Our split by speed is an assumption.
//
// 6PPDQ: 18 µg per g of tread, 3.5 to 43 (passenger and light truck tires, solvent extracts;
// Hu, Kolodziej and others, UW Tacoma report to WA Ecology, Jan 22 2024, p. 31). Most stays in the particle at first.
// Tread a tire loses before it's worn out: 1 to 1.5 kg (EEA guidebook 2023, 1.A.3.b.vi). A set lasts about 45,000 miles
// (NHTSA, 67 FR 38704, 2002). Parking lot turns aren't counted: GPS can't see them well enough.
import { MOTION, secondsIn, type MotionLookup } from './motion.ts';
import type { Segment, Signals } from './signal.ts';

export interface Range {
  low: number;
  typical: number;
  high: number;
}

export type Vehicle = 'small' | 'car' | 'suv' | 'pickup' | 'ev';

/**
 * Wear vs a typical 1.6 t car (the mass Giechaskiel 2024 assumes), in a straight line with weight.
 * Weights are rounded typical curb weights (our estimate). Pickups: about 1,700 lb over the average sedan (EPA Automotive Trends 2025).
 */
export const VEHICLES: Record<Vehicle, { label: string; kg: number; k: number }> = {
  small: { label: 'Small car', kg: 1300, k: 1300 / 1600 },
  car: { label: 'Sedan', kg: 1600, k: 1 },
  suv: { label: 'SUV or minivan', kg: 2000, k: 2000 / 1600 },
  pickup: { label: 'Pickup', kg: 2400, k: 2400 / 1600 },
  // CARB EMFAC2025: +15% tire wear for zero-emission light-duty vehicles
  ev: { label: 'Electric car', kg: 1850, k: 1.15 },
};

export const VEHICLE_ORDER: Vehicle[] = ['small', 'car', 'suv', 'pickup', 'ev'];

export const isVehicle = (x: unknown): x is Vehicle => typeof x === 'string' && x in VEHICLES;

export interface DustOptions {
  /** mg of tread per km per tonne on the R117-like reference drive */
  wearMgPerKmT: Range;
  lateralWeight: { low: number; central: number; high: number };
  /** R117 whole route */
  refLongSD: number;
  refLatSD: number;
  refSpeedMps: number;
  /** R117 lengthwise spreads of its urban-like and highway-like parts, m/s² */
  urbanLongSD: number;
  highwayLongSD: number;
  urbanMps: number;
  highwayMps: number;
  rollingResistance: number;
  dragAreaM2: number;
  /** a typical car, for drag */
  massKg: number;
  vehicle: Vehicle;
  /** 6PPDQ in tread, µg/g */
  sixPpdqUgPerG: Range;
  /** tread one tire loses over its life, g */
  treadGPerTire: Range;
  /** miles a set lasts with typical driving */
  treadLifeMi: number;
  /** sideways force that counts as a sharp turn, m/s² (0.4 g, our cutoff) */
  sharpTurn: number;
  /** more than this sideways is a GPS glitch, m/s² */
  maxLat: number;
}

export const DEFAULT_DUST_OPTIONS: DustOptions = {
  wearMgPerKmT: { low: 37, typical: 68, high: 125 },
  lateralWeight: { low: 0.2, central: 1, high: 7 },
  refLongSD: 0.45,
  refLatSD: 0.93,
  refSpeedMps: 15,
  urbanLongSD: 0.675,
  highwayLongSD: 0.275,
  urbanMps: 60 / 3.6,
  highwayMps: 90 / 3.6,
  rollingResistance: 0.01,
  dragAreaM2: 0.7,
  massKg: 1600,
  vehicle: 'car',
  sixPpdqUgPerG: { low: 3.5, typical: 18, high: 43 },
  treadGPerTire: { low: 1000, typical: 1250, high: 1500 },
  treadLifeMi: 45_000,
  sharpTurn: 0.4 * 9.81,
  maxLat: 8,
};

export type DustKind = 'brakes' | 'starts' | 'turns';

/** a sharp turn */
export interface SharpTurn {
  /** ms */
  t: number;
  segment: number;
  i: number;
  /** m/s², peak sideways */
  lat: number;
  mps: number;
}

export interface DustEstimate {
  distanceKm: number;
  vehicle: Vehicle;
  /** tread worn, mg */
  mg: Range;
  /** typical driving on the same route, same car, mg */
  typicalMg: Range;
  /** mg vs typical (1 = typical), low and high from the cornering weight */
  styleFactor: Range;
  /** mg a mile, typical estimate */
  mgPerMi: number;
  /** µg. Estimate only, never show as measured. */
  sixPpdqUg: Range;
  /** share of this drive's dust shed in each kind of hard moment, 0 to 1 */
  share: Record<DustKind, number>;
  turns: SharpTurn[];
  /** miles a set would last if every mile were like this one, rounded to 1,000 */
  tireLifeMi: number;
}

const G = 9.81;
const AIR_DENSITY = 1.2;
const M_PER_MI = 1609.344;

/** decel from rolling resistance + drag at v (m/s²) */
export function resistance(v: number, o: DustOptions = DEFAULT_DUST_OPTIONS, kg = o.massKg): number {
  return o.rollingResistance * G + (0.5 * AIR_DENSITY * o.dragAreaM2 * v * v) / kg;
}

/** meters reading i covers: half the gap to each neighbor */
const metersAt = (seg: Segment, i: number) => {
  const n = seg.t.length;
  return (seg.v[i] * ((i + 1 < n ? seg.t[i + 1] : seg.t[i]) - (i > 0 ? seg.t[i - 1] : seg.t[i]))) / 2;
};

// lengthwise severity (a + a_res)^2 per reading and the meters each covers (money.ts and the replay use it)
export function severity(sig: Signals, o: DustOptions = DEFAULT_DUST_OPTIONS): { s: number[][]; dm: number[][] } {
  return {
    s: sig.segments.map((seg) => seg.v.map((v, i) => (seg.a[i] + resistance(v, o)) ** 2)),
    dm: sig.segments.map((seg) => seg.v.map((_, i) => metersAt(seg, i))),
  };
}

/** speeding up or slowing over about 2 s (the readings either side), m/s² */
function along(seg: Segment, i: number): number {
  const a = Math.max(i - 1, 0), b = Math.min(i + 1, seg.t.length - 1), dt = seg.t[b] - seg.t[a];
  if (!(dt > 0) || dt > 4) return seg.a[i];
  const x = (seg.v[b] - seg.v[a]) / dt;
  return Math.abs(x) <= 10 ? x : seg.a[i];
}

/** The curve at reading i from points at least `arm` m either side (3-point circle), 1/m, or 0. */
function curveAt(seg: Segment, i: number, arm: number, maxS = 6): number {
  const d = (p: number[], q: number[]) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  let k = i - 1, j = i + 1;
  while (k >= 0 && d(seg.xy[k], seg.xy[i]) < arm && seg.t[i] - seg.t[k] <= maxS) k--;
  while (j < seg.t.length && d(seg.xy[i], seg.xy[j]) < arm && seg.t[j] - seg.t[i] <= maxS) j++;
  if (k < 0 || j >= seg.t.length || seg.t[i] - seg.t[k] > maxS || seg.t[j] - seg.t[i] > maxS) return 0;
  const A = seg.xy[k], B = seg.xy[i], C = seg.xy[j];
  const ab = d(A, B), bc = d(B, C), ca = d(C, A);
  if (!(ab > 0 && bc > 0 && ca > 0)) return 0;
  const area2 = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
  return (2 * area2) / (ab * bc * ca);
}

/**
 * Sideways force per reading, m/s². The motion sensor's steady sideways part when it has a clean second and the car
 * isn't braking or speeding up much (then GPS lag would leak in); otherwise speed^2 x the GPS curve, over 2 readings.
 */
export function lateral(sig: Signals, o: DustOptions = DEFAULT_DUST_OPTIONS, motion: MotionLookup | null = null): number[][] {
  return sig.segments.map((seg) => {
    const raw = seg.v.map((v, i) => {
      if (v < 3) return 0;
      if (motion?.seconds.length) {
        const sec = secondsIn(motion.seconds, sig.t0 + seg.t[i] * 1000 - 500, sig.t0 + seg.t[i] * 1000 + 500)[0];
        const a = along(seg, i);
        if (sec && !sec.bad && sec.n >= MOTION.minN && Math.abs(a) < 1) {
          const m2 = sec.m[0] ** 2 + sec.m[1] ** 2 + sec.m[2] ** 2;
          return Math.min(Math.sqrt(Math.max(m2 - a * a, 0)), o.maxLat);
        }
      }
      // long arms: a few meters of GPS wobble on short ones reads as a turn
      const x = v * v * curveAt(seg, i, Math.max(25, 4 * v), 8);
      return x > o.maxLat ? 0 : x;
    });
    return raw.map((_, i) => (raw[Math.max(i - 1, 0)] + raw[i] + raw[Math.min(i + 1, raw.length - 1)]) / 3);
  });
}

/** R117 lengthwise spread for typical driving at speed v */
function bandAt(v: number, o: DustOptions): number {
  return v < o.urbanMps ? o.urbanLongSD : v >= o.highwayMps ? o.highwayLongSD : o.refLongSD;
}

/** Sharp turns: sideways force at or over o.sharpTurn, one per run (readings within 2 s join). */
export function sharpTurns(sig: Signals, lat: number[][], o: DustOptions = DEFAULT_DUST_OPTIONS): SharpTurn[] {
  const out: SharpTurn[] = [];
  sig.segments.forEach((seg, k) => {
    let best = -1, lastT = -Infinity;
    const flush = () => {
      if (best >= 0) out.push({ t: sig.t0 + seg.t[best] * 1000, segment: k, i: best, lat: lat[k][best], mps: seg.v[best] });
      best = -1;
    };
    for (let i = 0; i < seg.t.length; i++) {
      if (lat[k][i] < o.sharpTurn || seg.v[i] < 3) continue;
      if (seg.t[i] - lastT > 2) flush();
      if (best < 0 || lat[k][i] > lat[k][best]) best = i;
      lastT = seg.t[i];
    }
    flush();
  });
  return out;
}

/** a hard brake or fast start, where it peaked */
export interface Moment {
  kind: 'brake' | 'start';
  segment: number;
  i: number;
}

const MI_ROUND = 1000;

/**
 * The drive's tire dust. moments: its hard brakes and fast starts (events.ts), so their share can be told.
 * vehicle: what the driver said they drive (default: a typical car).
 */
export function estimateDust(sig: Signals, distanceM: number, o: DustOptions = DEFAULT_DUST_OPTIONS, moments: readonly Moment[] = [], motion: MotionLookup | null = null, vehicle: Vehicle = o.vehicle): DustEstimate {
  const car = VEHICLES[vehicle] ?? VEHICLES.car;
  const lat = lateral(sig, o, motion);
  const turns = sharpTurns(sig, lat, o);
  const sRef = resistance(o.refSpeedMps, o) ** 2 + o.refLongSD ** 2;
  const latRef = o.refLatSD ** 2;
  // per lambda: severity-meters of the drive and of typical driving
  const sum = (L: number) => {
    let mine = 0, typ = 0;
    sig.segments.forEach((seg, k) => seg.v.forEach((v, i) => {
      const dm = metersAt(seg, i), res = resistance(v, o, car.kg), sd = bandAt(v, o), y = lat[k][i];
      mine += ((along(seg, i) + res) ** 2 + L * y * y) * dm;
      typ += (res * res + sd * sd + L * Math.min(y, o.sharpTurn) ** 2) * dm;
    }));
    return { mine, typ, ref: sRef + L * latRef };
  };
  const km = distanceM / 1000;
  const L = o.lateralWeight;
  const [lo, mid, hi] = [L.low, L.central, L.high].map(sum);
  // severity-meters -> mg: the reference route's severity wears wearMgPerKmT per km per tonne
  const mgOf = (x: { ref: number }, sev: number, w: number) => (sev / x.ref / 1000) * w * 1.6 * car.k;
  const both = [lo, hi].map((x) => ({ m: mgOf(x, x.mine, 1), t: mgOf(x, x.typ, 1) }));
  const ratio = (x: { m: number; t: number }) => (x.t > 0 ? x.m / x.t : 1);
  const ratios = both.map(ratio);
  const midM = mgOf(mid, mid.mine, 1), midT = mgOf(mid, mid.typ, 1);
  // with no meters at all, fall back to distance x the typical rate
  const has = mid.mine > 0 && mid.typ > 0;
  const per = (w: number, x: { ref: number; mine: number; typ: number }, which: 'mine' | 'typ') => (has ? mgOf(x, x[which], w) : km * w * 1.6 * car.k);
  const mg = { low: Math.min(per(o.wearMgPerKmT.low, lo, 'mine'), per(o.wearMgPerKmT.low, hi, 'mine')), typical: per(o.wearMgPerKmT.typical, mid, 'mine'), high: Math.max(per(o.wearMgPerKmT.high, lo, 'mine'), per(o.wearMgPerKmT.high, hi, 'mine')) };
  const typicalMg = { low: per(o.wearMgPerKmT.low, mid, 'typ'), typical: per(o.wearMgPerKmT.typical, mid, 'typ'), high: per(o.wearMgPerKmT.high, mid, 'typ') };
  const styleFactor = has ? { low: Math.min(...ratios), typical: midT > 0 ? midM / midT : 1, high: Math.max(...ratios) } : { low: 1, typical: 1, high: 1 };

  // each hard moment's share: severity-meters within 2 readings of its peak (central lambda)
  const share = { brakes: 0, starts: 0, turns: 0 };
  if (mid.mine > 0) {
    const taken = sig.segments.map((s) => new Uint8Array(s.t.length));
    const take = (kind: DustKind, k: number, i: number) => {
      const seg = sig.segments[k];
      for (let j = Math.max(i - 2, 0); j <= Math.min(i + 2, seg.t.length - 1); j++) {
        if (taken[k][j]) continue;
        taken[k][j] = 1;
        const res = resistance(seg.v[j], o, car.kg);
        share[kind] += ((along(seg, j) + res) ** 2 + L.central * lat[k][j] ** 2) * metersAt(seg, j);
      }
    };
    for (const m of moments) if (sig.segments[m.segment]) take(m.kind === 'brake' ? 'brakes' : 'starts', m.segment, m.i);
    for (const t of turns) take('turns', t.segment, t.i);
    for (const k of ['brakes', 'starts', 'turns'] as const) share[k] = Math.min(share[k] / mid.mine, 1);
  }

  const mi = distanceM / M_PER_MI;
  const life = styleFactor.typical > 0 ? o.treadLifeMi / styleFactor.typical : o.treadLifeMi;
  const six = (k: keyof Range) => (mg[k] / 1000) * o.sixPpdqUgPerG[k];
  return {
    distanceKm: km,
    vehicle,
    mg,
    typicalMg,
    styleFactor,
    mgPerMi: mi > 0 ? mg.typical / mi : 0,
    sixPpdqUg: { low: six('low'), typical: six('typical'), high: six('high') },
    share,
    turns,
    tireLifeMi: Math.round(life / MI_ROUND) * MI_ROUND,
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

/** Grams, plainly: "0.34 g", "1.9 g", "12 g". Under 0.1 g reads in mg: "60 mg". */
export function gramsText(mg: number): string {
  if (!(mg > 0)) return '0 g';
  if (mg < 95) return `${Math.max(10, Math.round(mg / 10) * 10)} mg`;
  const g = mg / 1000;
  return g < 0.995 ? `${g.toFixed(2)} g` : g < 9.95 ? `${g.toFixed(1)} g` : `${Math.round(g)} g`;
}

/** µg, plainly: "34 µg", "under 1 µg" */
export const microText = (ug: number): string => (!(ug >= 0.5) ? 'under 1 µg' : `${ug < 10 ? ug.toFixed(1).replace(/\.0$/, '') : Math.round(ug)} µg`);

/** -21 for 21% less than typical, 12 for 12% more, whole percent */
export const vsTypicalPct = (d: Pick<DustEstimate, 'styleFactor'>): number => Math.round((d.styleFactor.typical - 1) * 100);
