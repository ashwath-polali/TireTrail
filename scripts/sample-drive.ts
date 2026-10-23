// Writes public/data/sample-drive.json: a made-up 3.5 mile drive on real Spanaway streets (Pierce County) over 3 salmon streams.
// Golden Given Rd E, 138th St E over Clover Creek, a red light at Pacific Ave S, 138th St S over Spanaway Creek, a stop at
// Spanaway Loop Rd S, then south over Morey Creek (WDFW SWIFD coho streams, public/data/salmon). 2 hard brakes (the light, and the
// stop just past Spanaway Creek) and 1 fast start (away from the light). 1 Hz fixes with GPS speed.
// Route: OpenStreetMap ways 727033771, 12227483, 715620717, 1063179576, 1290156214, 1353294071, 1190255125, 91997066 (ODbL).
import { writeFileSync } from 'node:fs';
import { localProjection, nearestOnPolyline, pointAlong, polylineLength, type LngLat, type XY } from '../src/geo/geo.ts';
import type { Fix } from '../src/drive/types.ts';

const SAMPLE_ROUTE: LngLat[] = [
  [-122.414580, 47.133163], [-122.414733, 47.133031], [-122.414907, 47.132891], [-122.415016, 47.132791], [-122.415072, 47.132709], [-122.415138, 47.132623],
  [-122.415211, 47.132471], [-122.415237, 47.132394], [-122.415253, 47.132315], [-122.415265, 47.132201], [-122.415274, 47.131635], [-122.415279, 47.131458],
  [-122.415296, 47.131412], [-122.415314, 47.131390], [-122.415332, 47.131377], [-122.415425, 47.131357], [-122.415604, 47.131343], [-122.415844, 47.131317],
  [-122.415969, 47.131314], [-122.417436, 47.131332], [-122.417936, 47.131332], [-122.418233, 47.131336], [-122.418838, 47.131344], [-122.419724, 47.131352],
  [-122.421052, 47.131365], [-122.421642, 47.131370], [-122.422168, 47.131375], [-122.422572, 47.131378], [-122.422753, 47.131380], [-122.423676, 47.131389],
  [-122.424039, 47.131395], [-122.424679, 47.131406], [-122.425314, 47.131413], [-122.425765, 47.131417], [-122.426223, 47.131425], [-122.426499, 47.131429],
  [-122.427186, 47.131420], [-122.427815, 47.131431], [-122.428757, 47.131434], [-122.429046, 47.131438], [-122.430518, 47.131451], [-122.430933, 47.131459],
  [-122.431497, 47.131464], [-122.431867, 47.131471], [-122.431999, 47.131473], [-122.432610, 47.131480], [-122.432728, 47.131481], [-122.433193, 47.131487],
  [-122.433385, 47.131489], [-122.433853, 47.131496], [-122.433997, 47.131498], [-122.434513, 47.131504], [-122.434629, 47.131506], [-122.434763, 47.131501],
  [-122.434889, 47.131504], [-122.435336, 47.131516], [-122.435387, 47.131516], [-122.435425, 47.131515], [-122.435451, 47.131514], [-122.435494, 47.131509],
  [-122.435536, 47.131499], [-122.435586, 47.131481], [-122.435638, 47.131458], [-122.435753, 47.131401], [-122.435787, 47.131386], [-122.435819, 47.131375],
  [-122.435855, 47.131365], [-122.435896, 47.131358], [-122.435942, 47.131354], [-122.436010, 47.131353], [-122.436256, 47.131356], [-122.436623, 47.131360],
  [-122.436737, 47.131361], [-122.437118, 47.131366], [-122.437361, 47.131364], [-122.439982, 47.131393], [-122.440622, 47.131400], [-122.442644, 47.131422],
  [-122.443488, 47.131432], [-122.445288, 47.131450], [-122.447968, 47.131473], [-122.449264, 47.131493], [-122.449646, 47.131495], [-122.450350, 47.131507],
  [-122.450608, 47.131506], [-122.451296, 47.131514], [-122.452045, 47.131522], [-122.453032, 47.131534], [-122.453265, 47.131537], [-122.454257, 47.131540],
  [-122.454915, 47.131548], [-122.455381, 47.131553], [-122.456432, 47.131566], [-122.456914, 47.131568], [-122.457523, 47.131570], [-122.458684, 47.131583],
  [-122.458809, 47.131585], [-122.458757, 47.130261], [-122.458739, 47.129679], [-122.458727, 47.129346], [-122.458715, 47.129051], [-122.458709, 47.128879],
  [-122.458664, 47.127673], [-122.458631, 47.126777], [-122.458625, 47.126600], [-122.458598, 47.125884], [-122.458574, 47.124952], [-122.458558, 47.124335],
  [-122.458553, 47.124140], [-122.458551, 47.123963], [-122.458548, 47.123691], [-122.458540, 47.123094], [-122.458534, 47.122572], [-122.458533, 47.121708],
  [-122.458527, 47.119796], [-122.458529, 47.119599], [-122.458528, 47.119375], [-122.458528, 47.119068], [-122.458529, 47.118485], [-122.458537, 47.117810],
  [-122.458531, 47.117535], [-122.458531, 47.117196], [-122.458531, 47.116844], [-122.458531, 47.116210], [-122.458531, 47.115939], [-122.458532, 47.115890],
  [-122.458534, 47.115698], [-122.458535, 47.115516], [-122.458537, 47.115344], [-122.458537, 47.114818], [-122.458530, 47.114437], [-122.458529, 47.114357],
  [-122.458523, 47.114009], [-122.458524, 47.113940], [-122.458539, 47.112805], [-122.458540, 47.112007],
];

const MPH = 0.44704;
const P = localProjection();
const route: XY[] = SAMPLE_ROUTE.map((p) => P.toXY(p));
const L = polylineLength(route);
const at = (p: LngLat) => nearestOnPolyline(P.toXY(p), route).along;

interface Phase { t0: number; t1: number; s0: number; v0: number; a: number }
const phases: Phase[] = [];
let t = 0, s = 0, v = 0;
const push = (dur: number, a: number) => {
  if (!(dur > 0)) return;
  phases.push({ t0: t, t1: t + dur, s0: s, v0: v, a });
  s += v * dur + 0.5 * a * dur * dur;
  v = Math.max(0, v + a * dur);
  t += dur;
};
const hold = (dur: number) => push(dur, 0);
const speedTo = (to: number, a: number) => push(Math.abs(to - v) / a, Math.sign(to - v) * a);
const cruiseTo = (toS: number) => push((toS - s) / v, 0);
/** ease off for easeS at ease m/s², then brake at a to stop at stopS */
function stopAt(stopS: number, a: number, ease = 0, easeS = 0) {
  const v1 = v - ease * easeS, d = v * easeS - 0.5 * ease * easeS * easeS + (v1 * v1) / (2 * a);
  cruiseTo(stopS - d);
  push(easeS, -ease);
  push(v1 / a, -a);
  s = stopS;
  v = 0;
}
/** slow to vTo at a and back up, centered near midS */
function slowAround(midS: number, vTo: number, a: number) {
  const vBack = v, d = (v * v - vTo * vTo) / (2 * a);
  cruiseTo(midS - d);
  speedTo(vTo, a);
  speedTo(vBack, a * 0.8);
}

const stopSign = at([-122.415332, 47.131377]) - 6;
const light = at([-122.434629, 47.131506]) - 14;
const loopStop = at([-122.458809, 47.131585]) - 8;

hold(4);
speedTo(25 * MPH, 1.3);
stopAt(stopSign, 1.4);
hold(3);
// right onto 138th St E, over Clover Creek
speedTo(8 * MPH, 1.2);
speedTo(35 * MPH, 1.5);
// a hard brake for the red light at Pacific Ave S
stopAt(light, 4.6, 1.2, 1.5);
hold(24);
// a fast start when it turns green
push(3, 4);
speedTo(35 * MPH, 1.4);
slowAround(at([-122.446, 47.13154]), 29 * MPH, 0.9);
// over Spanaway Creek, then a hard brake for the stop at Spanaway Loop Rd S
stopAt(loopStop, 4.4, 1, 1);
hold(6);
// left, south over Morey Creek
speedTo(14 * MPH, 1.2);
speedTo(38 * MPH, 1.6);
stopAt(L - 3, 1.3);
hold(3);

// mulberry32 and Box-Muller
let seed = 2026;
const uniform = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());

// a real foot on the gas: cruising drifts a few mph either way (eased in and out over 3 s)
const waves = phases.map(() => [0, 1, 2].map((i) => ({ A: (0.5 + uniform() * 0.35) * MPH * 2, w: (2 * Math.PI) / (7 + i * 6 + uniform() * 4), f: uniform() * 6.3 })));
const wobble = (k: number, x: number) => {
  const ph = phases[k];
  if (ph.a !== 0 || ph.v0 < 5) return 0;
  const u = x - ph.t0, env = Math.min(1, u / 3, (ph.t1 - x) / 3);
  return env <= 0 ? 0 : Math.sin((env * Math.PI) / 2) ** 2 * waves[k].reduce((sum, q) => sum + q.A * Math.sin(q.w * u + q.f), 0);
};
// speed and distance every 0.1 s
const DT = 0.1, vs: number[] = [], ss: number[] = [];
let k = 0, dist = 0;
for (let i = 0; i * DT <= t + 1e-9; i++) {
  const x = i * DT;
  while (k < phases.length - 1 && x > phases[k].t1 + 1e-9) k++;
  const ph = phases[k], dt = Math.min(x, ph.t1) - ph.t0;
  const vk = Math.max(0, ph.v0 + ph.a * dt + wobble(k, x));
  if (i) dist += ((vs[i - 1] + vk) / 2) * DT;
  vs.push(vk);
  ss.push(Math.min(dist, L));
}

// phone GPS: a few meters of slowly drifting error, speed within about half a mph
const t0 = Date.UTC(2026, 9, 14, 23, 5, 0), sigma = 2.5, rho = Math.exp(-1 / 20);
let ex = gauss() * sigma, ey = gauss() * sigma;
const fixes: Fix[] = [];
for (let k = 0; k <= Math.floor(t); k++) {
  const i = Math.round(k / DT), vk = vs[i];
  const pos = pointAlong(route, ss[i]);
  ex = rho * ex + Math.sqrt(1 - rho * rho) * sigma * gauss();
  ey = rho * ey + Math.sqrt(1 - rho * rho) * sigma * gauss();
  const [lon, lat] = P.toLngLat([pos[0] + ex, pos[1] + ey]);
  const speed = vk > 0.3 ? Math.max(0, vk + gauss() * 0.2) : Math.abs(gauss()) * 0.05;
  fixes.push({ t: t0 + k * 1000, lat: +lat.toFixed(6), lon: +lon.toFixed(6), accuracy: Math.round(4 + uniform() * 2), speed: +speed.toFixed(2) });
}
writeFileSync('public/data/sample-drive.json', JSON.stringify(fixes));
console.log(`${fixes.length} fixes, ${Math.round(L)} m, ${(t / 60).toFixed(1)} min`);
