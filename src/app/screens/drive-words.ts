// Words for the Drive screens: gas, hard brakes, where the dust goes, progress. No DOM, so tests run it.
// Copy rules: plain words, no dashes, estimates say "about", Fennel Creek "flows down to where coho salmon spawn".
import { answered, type StopClass } from '../../drive/tips.ts';
import { SALMON } from '../../salmon/watch.ts';

const FT = 3.28084;

/** "1 hard brake", "3 hard brakes" */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C" */
export const and = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const mph = (mps: number): number => Math.round(mps * 2.23694);

/** feet to the nearest 10: "1,070 ft" */
export const feet = (m: number): string => `${(Math.round((m * FT) / 10) * 10).toLocaleString('en-US')} ft`;

/** feet under 0.2 mi, then miles */
export const far = (m: number): string => (m < 321.9 ? feet(Math.max(m, 3)) : `${(m / 1609.344).toFixed(1)} mi`);

/** A fix list gap's "(4.19 m gap)", said in feet: "(about 14 ft)" */
export const gapFeet = (s: string): string => s.replace(/\((\d+(?:\.\d+)?) m gap\)/g, (_, m: string) => `(about ${Math.max(1, Math.round(Number(m) * FT))} ft)`);

// ---------- days ----------

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", "Fri, Oct 16", or "Oct 16, 2025" in another year */
export function dayWord(t: number, now = Date.now()): string {
  const d = new Date(t), n = new Date(now), y = new Date(now);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, n)) return 'Today';
  if (sameDay(d, y)) return 'Yesterday';
  if (d.getFullYear() !== n.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "4:02 PM" */
export const timeWord = (t: number): string => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Oct 16" for chart labels */
export const shortDay = (t: number): string => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ---------- tire dust ----------

/** whole percent vs typical: -21 is 21% less */
export const pctVs = (mg: number, typMg: number): number => (typMg > 0 ? Math.round((mg / typMg - 1) * 100) : 0);

/** "21% less", "12% more", "About typical" (within 2%) */
export function vsWord(pct: number): string {
  if (pct <= -3) return `${-pct}% less`;
  return pct >= 3 ? `${pct}% more` : 'About typical';
}

/** tone for the head: less is good */
export const vsTone = (pct: number): 'money' | 'warn' | 'plain' => (pct <= -3 ? 'money' : pct >= 3 ? 'warn' : 'plain');

/** a hard brake this close to a crossing counts against it, m (the same rule everywhere) */
const NEAR_M = SALMON.brakeM;

/** A salmon creek the drive crossed: gently, or with a hard brake within 150 m. */
export interface CreekMark { name: string; at: readonly [number, number]; gentle: boolean }

/** Each salmon creek crossed, in drive order, gentle or not. Pure. */
export function creekMarks(t: { crossed: number; gentle: number; streams: readonly { name: string; at: readonly [number, number] }[] } | null, brakes: readonly (readonly [number, number])[]): CreekMark[] {
  if (!t?.crossed) return [];
  const all = t.gentle >= t.crossed, none = !t.gentle;
  const near = (a: readonly [number, number]) => brakes.some((b) => {
    const k = Math.cos((a[1] * Math.PI) / 180);
    return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_320 <= NEAR_M;
  });
  return t.streams.map((s) => ({ name: s.name, at: s.at, gentle: all || (!none && !near(s.at)) }));
}

// ---------- the report ----------

/**
 * The one headline over the map. Salmon creeks first: "Gentle at 2 of 3 salmon creeks", "Gentle at Clover Creek".
 * With none crossed, the most useful true line: "1 hard brake. Smooth otherwise."
 */
export function reportHead(creeks: readonly Pick<CreekMark, 'name' | 'gentle'>[], brakes: number, starts: number): string {
  const n = creeks.length, g = creeks.filter((c) => c.gentle).length;
  if (n === 1) return creeks[0].gentle ? `Gentle at ${creeks[0].name || 'the salmon creek'}` : `Hard brake near ${creeks[0].name || 'the salmon creek'}`;
  if (n > 1) return g === n ? `Gentle at all ${n} salmon creeks` : `Gentle at ${g} of ${n} salmon creeks`;
  if (!brakes && !starts) return 'Smooth drive. No hard brakes.';
  if (!brakes) return `No hard brakes. ${count(starts, 'fast start')}.`;
  if (!starts) return brakes === 1 ? '1 hard brake. Smooth otherwise.' : `${count(brakes, 'hard brake')} this drive`;
  return `${count(brakes, 'hard brake')}, ${count(starts, 'fast start')}`;
}

/** "The Clover Creek drive", after the first named creek crossed; else "Your drive". */
export function driveTitle(creeks: readonly Pick<CreekMark, 'name'>[], sample: boolean): string {
  const name = creeks.find((c) => c.name)?.name;
  return name ? `The ${name} drive` : sample ? 'The sample drive' : 'Your drive';
}

/** "Today 5:42 PM · 3.5 mi · 7 min"; the sample: "Sample · 3.5 mi · 7 min" */
export function driveWhen(at: number, sample: boolean, miles: number, sec: number, now = Date.now()): string {
  const min = Math.max(1, Math.round(sec / 60));
  return [sample ? 'Sample' : `${dayWord(at, now)} ${timeWord(at)}`, `${miles.toFixed(1)} mi`, `${min} min`].join(' · ');
}

const FIX_VERB: Record<string, string> = { hard: 'Brake earlier', firm: 'Ease off sooner', 'fast-start': 'Start slower', speeding: 'Slow down' };

/** The one fix as a sentence at a real place: "Brake earlier on 138th St S at Pacific Ave S." Null when there's nothing to fix. */
export function fixLine(s: { kind: string; limitMph: number | null }, where: string): string | null {
  const verb = s.kind === 'speeding' && s.limitMph ? `Keep to ${s.limitMph} mph` : FIX_VERB[s.kind];
  if (!verb) return null;
  return where ? `${verb} on ${where}.` : `${verb} at the marked spot.`;
}

/** The habits a gas line names, plainly: "hard brakes and fast starts". */
export const gasWho = (g: { hard: boolean; speed: boolean }): string => (g.hard && g.speed ? 'speeding, hard brakes and fast starts' : g.speed ? 'speeding' : 'hard brakes and fast starts');

/** The gas line under the fix: "About 70¢ of each gallon went to hard brakes and fast starts." */
export function gasShort(g: { hard: boolean; speed: boolean; text: string }): string {
  return `${g.text.charAt(0).toUpperCase()}${g.text.slice(1)} of each gallon went to ${gasWho(g)}.`;
}

/** Under the headline's coho, when some are gray: "Gray: a hard brake near Spanaway Creek." Null when none or all are. */
export function grayKey(creeks: readonly Pick<CreekMark, 'gentle' | 'name'>[]): string | null {
  const rough = creeks.filter((c) => !c.gentle);
  if (!rough.length || rough.length === creeks.length) return null;
  const names = [...new Set(rough.map((c) => c.name).filter(Boolean))];
  return names.length === 1 && rough.length === 1 ? `Gray: a hard brake near ${names[0]}.` : 'Gray: a hard brake near those creeks.';
}

/** More: how a creek went */
export const creekWord = (gentle: boolean): string => (gentle ? 'Crossed gently' : 'Hard brake nearby');

/** the live counter: "salmon stream crossed" */
export const crossedWord = (n: number): string => (n === 1 ? 'salmon stream crossed' : 'salmon streams crossed');

/** The live dust meter's full mark, g: the next step up, so the meter fills as you drive. */
export function dustScale(g: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100]) if (g < s * 0.98) return s;
  return Math.ceil(g / 100) * 100;
}

// ---------- too short to score ----------

/** What a short drive was: "0.3 mi in 1 min", "0.1 mi in 20 s". Never rounds up to the half mile or 2 minutes it missed. */
export function shortWhat(mi: number, sec: number): string {
  const t = sec < 60 ? `${Math.max(1, Math.round(sec))} sec` : `${Math.floor(sec / 60)} min`;
  const m = mi < 0.5 ? Math.floor(Math.max(0, mi) * 10) / 10 : mi;
  return `${m.toFixed(1)} mi in ${t}`;
}

/** The one rule it missed, in one line. */
export function shortRule(mi: number, sec: number): string {
  if (mi >= 0.5 && sec < 120) return 'Drives over 2 minutes get a score.';
  if (mi >= 0.5) return 'The location signal was too weak to score it.';
  return 'Drives over half a mile get a score.';
}

export const SHORT = { title: 'Too short to score', toast: "Short drive, so it wasn't saved." } as const;

// ---------- hard brakes ----------

/** What a screen needs to know about one hard brake. */
export interface BrakeView {
  /** 1-based, in driving order */
  n: number;
  /** ended in a full stop */
  stopped: boolean;
  /** mph lost in the hardest second */
  mphPerS: number;
  /** mph a second before the hardest moment */
  fromMph: number;
  /** full stops only: speed as braking began, feet it took, seconds sooner to start slowing, feet a gentle stop takes */
  entryMph: number;
  brakingFt: number;
  soonerS: number;
  gentleFt: number;
  veryHard: boolean;
  cls: StopClass;
  receiving: string;
  code: string;
  /** false where TireTrail has no pipe maps */
  mapped: boolean;
  /** how far TireTrail followed its rain, m */
  lengthM: number;
  /** in Bonney Lake's own map, where the salmon stream is the Fennel Creek system */
  local: boolean;
  /** street, '' if unknown */
  place: string;
}

/** "SR 410 E at 192nd Ave E", or "hard brake 2" with no name */
export const placeOf = (b: Pick<BrakeView, 'place' | 'n' | 'stopped'>): string => b.place || `hard brake ${b.n}`;

/** Always "Hard brake": one name everywhere, stop or not. */
export const brakeKind = (_b: Pick<BrakeView, 'stopped'>): string => 'Hard brake';

/** What happened: "30 mph to a stop in 110 ft." or "Hard brake at 42 mph." */
export function brakeWhat(b: BrakeView): string {
  return b.stopped ? `${b.entryMph} mph to a stop in ${b.brakingFt.toLocaleString('en-US')} ft.` : `Hard brake at ${b.fromMph} mph.`;
}

/** "You slowed 9 mph in one second." */
export const brakeRate = (b: Pick<BrakeView, 'mphPerS'>): string => `You slowed ${Math.round(b.mphPerS)} mph in one second.`;

/** Seconds as words: "1 second", "3 seconds" */
const secs = (s: number) => (Math.round(s) <= 1 ? '1 second' : `${Math.round(s)} seconds`);

/** What to do there: start slowing sooner, or ease off sooner when there was no stop. */
export function brakeDo(b: BrakeView): string {
  if (b.stopped && b.soonerS >= 0.5) return `Start slowing about ${secs(b.soonerS)} sooner here.`;
  return b.stopped ? 'Ease off a little sooner and brake more gently here.' : 'Ease off sooner here, so you don\'t need to brake so hard.';
}

/** The gentle stop for comparison: "A gentle stop from 30 mph takes about 210 ft." */
export const gentleLine = (b: BrakeView): string | null => (b.stopped && b.gentleFt > 0 ? `A gentle stop from ${b.entryMph} mph takes about ${b.gentleFt.toLocaleString('en-US')} ft.` : null);

// ---------- where the dust goes ----------

const FENNEL_SYS = /lake bonney outflow|bonney lake outflow|debra jane|^bonney lake$/i;

/** Other water, named plainly. */
export function waterName(receiving: string): string {
  const r = receiving.trim().replace(/\s*\/\s*/g, ', then ');
  const trib = /^(.+?)\s+tributary\b/i.exec(r);
  if (trib) return `a stream that feeds ${trib[1]}`;
  if (/unnamed (lake|pond)|unnamed .*(lake|pond)$/i.test(r)) return 'a small lake or pond with no name on the map';
  if (/unnamed/i.test(r)) return 'a small stream with no name on the map';
  return r || 'other water';
}

/** The salmon stream, named for a sentence: Fennel Creek's system reads as Fennel Creek. */
function salmonWords(receiving: string, local: boolean): string {
  const r = receiving.trim();
  if (local) {
    if (!r || /^fennel creek$/i.test(r)) return 'Fennel Creek, which flows down to where coho salmon spawn';
    if (/^fennel creek tributary/i.test(r)) return 'a stream that feeds Fennel Creek, which flows down to where coho salmon spawn';
    if (FENNEL_SYS.test(r)) return `${r}, which flows on to Fennel Creek and down to where coho salmon spawn`;
    return `${waterName(r)}, which flows down to where coho salmon spawn`;
  }
  if (!r || /unnamed/i.test(r)) return 'a small stream where the state records coho salmon';
  return `${waterName(r)}, where the state records coho salmon`;
}

const SOAK: Record<string, string> = {
  'infiltration-pond': 'a pond built to soak it into the ground',
  'pond-to-ground': 'a pond built to soak it into the ground',
  'pond-to-ground-partial': 'a pond built to soak it into the ground',
  'pipe-to-infiltration': 'a pond built to soak it into the ground',
  'infiltration-pond-overflow': 'a pond built to soak it into the ground',
  drywell: 'a dry well, a pit that lets it soak into the ground',
  'perforated-pipe': 'a pipe with holes that lets it soak into the ground',
  'infiltration-vault': 'an underground tank that lets it soak into the ground',
  'discharge-point': 'a spot the county lists as built to soak water into the ground',
};

export interface RainIn {
  cls: StopClass;
  receiving: string;
  code: string;
  mapped: boolean;
  lengthM: number;
  local: boolean;
}

/** Where one stop's rain takes its tire dust, as one sentence. */
export function rainHead(r: RainIn): string {
  switch (r.cls) {
    case 'creek': return `Its rain drains to ${salmonWords(r.receiving, r.local)}.`;
    case 'ground': {
      const to = SOAK[r.code];
      return to ? `Its rain drains to ${to}.` : 'Its rain soaks into the ground.';
    }
    case 'elsewhere': return `Its rain drains to ${waterName(r.receiving)}.`;
    case 'treatment': return 'Its rain goes to a sewage treatment plant.';
    case 'unknown':
      return r.lengthM < 10 || r.code === 'not-connected'
        ? "This storm drain isn't connected to any pipe on the map."
        : `TireTrail can follow its rain for ${far(r.lengthM)}. Then the pipe map has a gap.`;
    default: return r.mapped ? 'No storm drain is mapped near this stop.' : "TireTrail doesn't have pipe maps here yet.";
  }
}

/** Why that matters, in plain words. */
export function rainWhy(r: RainIn): string {
  switch (r.cls) {
    case 'creek': return '6PPDQ in tire dust can kill coho salmon within hours of a storm. Gentle stops leave less dust behind.';
    case 'ground':
      return r.code === 'infiltration-pond-overflow'
        ? 'Soaking through soil removes most of the tire chemical that harms salmon. In very big storms this pond can overflow.'
        : 'Soaking through soil removes most of the tire chemical that harms salmon.';
    case 'elsewhere':
      if (/puget sound/i.test(r.receiving)) return 'The pipes empty at an outfall on the shore.';
      return r.local ? "It doesn't flow on to Fennel Creek, the salmon stream TireTrail follows here." : "The state's fish maps don't record coho salmon there.";
    case 'treatment': return 'In big storms, some of it can overflow untreated into nearby water.';
    default: return 'Wherever it ends up, gentle stops leave less tire dust to wash away.';
  }
}

/** Where it goes, in a few words, for a list: "Drains to Fennel Creek." */
export function rainShort(r: RainIn): string {
  switch (r.cls) {
    case 'creek': {
      const rc = r.receiving.trim();
      if (r.local) return /^fennel creek tributary/i.test(rc) ? 'Drains to a stream that feeds Fennel Creek.' : FENNEL_SYS.test(rc) ? `Drains to ${rc}, then Fennel Creek.` : 'Drains to Fennel Creek.';
      return `Drains to ${/unnamed/i.test(rc) || !rc ? 'a salmon stream' : waterName(rc)}.`;
    }
    case 'ground': return 'Soaks into the ground.';
    case 'elsewhere': return `Drains to ${waterName(r.receiving)}.`;
    case 'treatment': return 'Goes to a sewage treatment plant.';
    case 'unknown': return 'The pipe map has a gap here.';
    default: return r.mapped ? 'No storm drain is mapped here.' : 'No pipe map here yet.';
  }
}

/** The short tag for an answer. */
export function rainTag(r: Pick<RainIn, 'cls' | 'mapped'>): string {
  switch (r.cls) {
    case 'creek': return 'Salmon stream';
    case 'ground': return 'Soaks in';
    case 'elsewhere': return 'Other water';
    case 'treatment': return 'Treatment plant';
    case 'unknown': return 'Map gap';
    default: return r.mapped ? 'No mapped drain' : 'No pipe map yet';
  }
}

/** One line on where all the hard brakes' dust goes (the report's headline for that part). */
export function dustSummary(bs: readonly (RainIn & { stopped?: boolean })[]): string {
  const n = bs.length;
  if (!n) return 'No hard brakes this drive. Gentle stops leave the least tire dust.';
  const creek = bs.filter((b) => b.cls === 'creek');
  const them = n === 1 ? 'Your hard brake' : `${n === 2 ? 'Both' : `All ${n}`} of your hard brakes`;
  if (creek.length) {
    const names = new Set(creek.map((b) => salmonWords(b.receiving, b.local)));
    const where = names.size === 1 ? [...names][0] : 'streams with coho salmon';
    if (creek.length === n) return `${them} ${n === 1 ? 'drains' : 'drain'} to ${where}.`;
    return `${creek.length} of your ${n} hard brakes ${creek.length === 1 ? 'drains' : 'drain'} to ${where}.`;
  }
  const ok = bs.filter((b) => answered(b.cls)).length;
  if (ok === n) return n === 1 ? "Your hard brake doesn't drain to a salmon stream." : `None of your ${n} hard brakes drain to a salmon stream.`;
  if (ok) return `${ok} of your hard brakes ${ok === 1 ? "doesn't" : "don't"} drain to a salmon stream. TireTrail couldn't follow the other ${n - ok}.`;
  if (bs.some((b) => b.cls === 'unknown')) return n === 1 ? 'The pipe map loses track of where your hard brake drains.' : 'The pipe maps lose track of where your hard brakes drain.';
  if (bs.some((b) => b.mapped)) return n === 1 ? 'No storm drain is mapped near your hard brake.' : 'No storm drains are mapped near your hard brakes.';
  return "TireTrail doesn't have pipe maps where you braked yet.";
}

/** A salmon stream's short name: "Fennel Creek", "a stream that feeds Fennel Creek", "a salmon stream". */
export function salmonName(receiving: string, local: boolean): string {
  const r = receiving.trim();
  if (local) {
    if (!r || /^fennel creek$/i.test(r)) return 'Fennel Creek';
    if (/^fennel creek tributary/i.test(r)) return 'a stream that feeds Fennel Creek';
    return FENNEL_SYS.test(r) ? r : waterName(r);
  }
  return !r || /unnamed/i.test(r) ? 'a salmon stream' : waterName(r);
}

/** "3 gentle stops where rain flows to salmon streams": the count, said the way the tracer backs it. */
export const gentleSalmonLine = (n: number): string => (n === 1 ? '1 gentle stop where rain flows to a salmon stream' : `${n} gentle stops where rain flows to salmon streams`);

/** A score chip: what cost points and how many, "3 hard brakes −30 pts". The minus is a minus sign, not a dash. */
export function lostChip(key: 'brakes' | 'starts' | 'speed', n: number, lost: number): string {
  const what = key === 'brakes' ? count(n, 'hard brake') : key === 'starts' ? count(n, 'fast start') : 'Over the limit';
  return `${what} −${lost} pts`;
}

/**
 * The report's salmon row, only what the tracer backs. gentle: gentle stops whose drain reaches a salmon stream.
 * Null when there is nothing true and short to say.
 */
export function salmonRow(bs: readonly RainIn[], gentle: number): { line: string; sub: string } | null {
  const creek = bs.filter((b) => b.cls === 'creek');
  if (creek.length) {
    const names = new Set(creek.map((b) => salmonName(b.receiving, b.local))), one = creek.length === 1;
    const where = names.size === 1 ? [...names][0] : 'salmon streams';
    const sub = names.size > 1 ? 'Coho salmon live downstream' : creek[0].local ? 'Coho salmon spawn downstream' : 'The state records coho salmon there';
    return { line: `Rain carries dust from ${count(creek.length, 'hard brake')} to ${where}`, sub };
  }
  if (gentle > 0) return { line: gentleSalmonLine(gentle), sub: 'Gentle stops leave less tire dust' };
  if (!bs.length) return { line: 'No hard brakes, so less tire dust for the salmon', sub: '6PPDQ in tire dust can kill coho' };
  if (bs.every((b) => answered(b.cls))) {
    return bs.length === 1 ? { line: "Your hard brake doesn't drain to a salmon stream", sub: rainShort(bs[0]) } : { line: 'No hard brakes drain to a salmon stream', sub: 'See where their rain goes' };
  }
  return null;
}

/** The card at the end of See it happen: where it ended up, why it matters, and what to do. */
export function endWords(b: BrakeView): { title: string; why: string; todo: string } {
  const at = b.place ? `your stop on ${b.place}` : `stop ${b.n}`;
  const from = b.place ? `your stop on ${b.place}` : `stop ${b.n}`;
  const todo = b.stopped && b.soonerS >= 0.5 ? `Next time, start slowing about ${secs(b.soonerS)} sooner here.` : 'Next time, ease off sooner here.';
  const r: RainIn = b;
  switch (b.cls) {
    case 'creek': return { title: `This is where tire dust from ${at} ends up.`, why: rainWhy(r), todo };
    case 'ground': return { title: `Rain from ${from} soaks into the ground.`, why: rainWhy(r), todo };
    case 'elsewhere': return { title: `Rain from ${from} ends up in ${waterName(b.receiving)}.`, why: rainWhy(r), todo };
    case 'treatment': return { title: `Rain from ${from} goes to a sewage treatment plant.`, why: rainWhy(r), todo };
    default:
      return b.lengthM < 10 || b.code === 'not-connected'
        ? { title: `The storm drain at ${at} isn't connected to any pipe on the map.`, why: "TireTrail can't follow it any farther.", todo }
        : { title: `TireTrail followed rain from ${from} for ${far(b.lengthM)}.`, why: 'Then the pipe map has a gap, so it stops instead of guessing.', todo };
  }
}

// ---------- recording ----------

export const REC = {
  waiting: 'Finding your location…',
  byHand: 'Recording. Drive as usual.',
  byItself: 'Started by itself. Drive as usual.',
  paused: 'Paused. Keep TireTrail open on screen.',
  signal: "Can't find your location. Still trying.",
  noLock: 'Keep the screen on, or recording stops.',
  spot: 'Hard-brake spot ahead.',
  spotDo: 'Ease off.',
  salmon: 'Salmon stream drain ahead.',
  creek: 'Creek drain ahead.',
  creekDo: 'Brake gently.',
  autoEnds: 'Ends by itself 3 minutes after you park.',
  voiceOn: 'Voice on.',
} as const;

/** Back on screen after a pause mid-drive: "Recording again. Missed 2 min while TireTrail was off screen." */
export function backLine(ms: number): string {
  const s = Math.round(ms / 1000), span = s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} seconds` : `${Math.round(s / 60)} min`;
  return `Recording again. Missed ${span} while TireTrail was off screen.`;
}

// ---------- progress ----------

/** "Record 2 more drives to see your trend." */
export const needMoreLine = (n: number): string => `Record ${count(n, 'more drive')} to see your trend.`;

/** The streak, said plainly. */
export function streakLine(n: number): string {
  if (n <= 0) return 'Drive with no hard brakes to start a streak.';
  return n === 1 ? '1 drive with no hard brakes. Keep it going.' : `${n} drives in a row with no hard brakes.`;
}

/** "1.4" hard brakes every 10 miles */
export const per10Word = (x: number): string => (x >= 10 ? String(Math.round(x)) : x.toFixed(1));

/** A hard-brake spot: where its rain goes, then why easing off matters there. Salmon only when it drains to a salmon creek. */
export function spotWhy(r: Pick<RainIn, 'cls' | 'receiving' | 'local'>): { rain: string | null; why: string } {
  if (r.cls === 'creek') {
    const name = salmonName(r.receiving, r.local);
    return { rain: `Rain here drains to ${name === 'a salmon stream' ? 'a salmon creek' : `${name}, a salmon creek`}.`, why: 'Gentle stops leave less tire dust to wash in.' };
  }
  const calmer = 'Easing off saves gas and gives the car behind you time to stop.';
  return { rain: r.cls === 'ground' ? 'Rain here soaks into the ground.' : null, why: calmer };
}

/** A learned spot, for home and My drives. */
export function spotWords(s: { name: string; count: number; drives: number; veryHard: number; salmon: boolean }): { title: string; body: string } {
  const where = s.name ? `at ${s.name}` : 'at this spot';
  const times = s.drives >= 2 ? `${count(s.count, 'hard brake')} here on ${s.drives} drives.` : s.veryHard ? 'One very hard brake here.' : `${count(s.count, 'hard brake')} here.`;
  const salmon = s.salmon ? ' Rain here drains to a salmon stream.' : '';
  return { title: `You brake hard ${where}.`, body: `${times}${salmon} We'll tell you before you get there.` };
}
