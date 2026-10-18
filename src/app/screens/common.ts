// Words and colors shared by the tabs: one color, one chip and one plain sentence per answer.
import type { XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CAT } from '../map/palette.ts';
import type { Region } from '../map/region.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';

export const KIND: Record<Cls, { color: string; chip: string }> = {
  creek: { color: CAT.creek, chip: 'SALMON STREAM' },
  ground: { color: CAT.ground, chip: 'SOAKS IN' },
  elsewhere: { color: CAT.elsewhere, chip: 'OTHER WATER' },
  unknown: { color: CAT.unknown, chip: 'MAP GAP' },
  none: { color: CAT.none, chip: 'NO DRAIN' },
  treatment: { color: CAT.treatment, chip: 'TREATMENT PLANT' },
};

/** Gray answers get outline chips. */
export const isGray = (c: Cls): boolean => c === 'unknown' || c === 'none';
const kind = (c: Cls) => KIND[c] ?? KIND.unknown;

export const chip = (c: Cls) => h('span.chip', { style: `--k:${kind(c).color}` }, kind(c).chip);

/** The card icon for an answer. */
export function clsIcon(c: Cls): string {
  switch (c) {
    case 'creek': return ICON.fish();
    case 'ground': return ICON.soak();
    case 'elsewhere': return ICON.waves();
    case 'treatment': return ICON.plant();
    case 'none': return ICON.dropGray();
    default: return ICON.q();
  }
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Bonney Lake waters that drain to Fennel Creek but aren't its coho water
const FENNEL_SYS = /debra jane|lake bonney outflow|bonney lake outflow|^bonney lake$/i;
export const fennelSystem = (receiving: string): boolean => FENNEL_SYS.test(receiving.trim());

/** A receiving water as plain words: "Clover Creek Tributary 7" -> "a stream that feeds Clover Creek". */
export function plainWater(receiving: string): string {
  const s = receiving.trim().replace(/\s*\/\s*/g, ' and ');
  const t = /^(.+?)\s+tributary\b/i.exec(s);
  if (t) return `a stream that feeds ${t[1]}`;
  if (/unnamed (lake|pond)|unnamed .*(lake|pond)$/i.test(s)) return 'a small lake or pond with no name on the map';
  if (/unnamed/i.test(s)) return 'a small stream with no name on the map';
  return s;
}

/** The salmon stream a drain reaches, named plainly (drive stops use it too). */
export function creekName(receiving: string): string {
  const r = receiving.trim();
  if (!r || /^fennel creek/i.test(r) || FENNEL_SYS.test(r)) return /tributary/i.test(r) ? 'a stream that feeds Fennel Creek' : 'Fennel Creek';
  if (/unnamed/i.test(r)) return 'a small salmon stream';
  return plainWater(r);
}

/** What a street's or drain's answer needs. owner: "the city's" or "Pierce County's"; city: a Bonney Lake street. */
export interface Outcome {
  cls: Cls;
  code: string;
  receiving: string;
  reason: string;
  lengthM: number;
  owner: string;
  city: boolean;
}

/** "ends up in Fennel Creek.": what the rain does, after "Rain here". */
export function ends(o: Pick<Outcome, 'cls' | 'receiving'>): string {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek':
      if (!r || /^fennel creek$/i.test(r)) return 'ends up in Fennel Creek.';
      if (/^fennel creek tributary/i.test(r)) return 'ends up in a stream that feeds Fennel Creek.';
      if (FENNEL_SYS.test(r)) return `reaches ${r}, which drains to Fennel Creek.`;
      if (/unnamed/i.test(r)) return 'ends up in a small salmon stream with no name on the map.';
      return `ends up in ${plainWater(r)}.`;
    case 'ground': return 'soaks into the ground.';
    case 'elsewhere': return `drains to ${plainWater(r) || 'other water'}.`;
    case 'treatment': return 'goes to a sewage treatment plant.';
    case 'unknown': return 'reaches a gap in the pipe map.';
    default: return 'has no mapped drain.';
  }
}

const SOAK: Record<string, string> = {
  drywell: 'It runs into a dry well, a pit that lets water sink into the soil.',
  'infiltration-pond': 'It runs into a pond built to let water soak into the soil.',
  'pond-to-ground': 'It runs into a pond built to let water soak into the soil.',
  'pond-to-ground-partial': 'It runs into a pond built to let water soak into the soil.',
  'infiltration-pond-overflow': 'It runs into a pond built to let water soak in. In very big storms the pond can overflow.',
  'infiltration-vault': 'It runs into an underground tank that lets water soak into the soil.',
  'perforated-pipe': 'It runs into a pipe with holes that lets water soak into the soil.',
  'pipe-to-infiltration': 'It runs to a spot built to let water soak into the soil.',
};

// map gap endings TireTrail knows; any other code (like water handed to another agency) uses its own reason
const GAP: Record<string, (owner: string) => string> = {
  'dead-end': (w) => `The pipe it flows into just ends on ${w} map. TireTrail stops there instead of guessing.`,
  'pond-unmapped': () => "It reaches a pond, but the map doesn't show where the pond drains.",
  'pond-other': () => "It reaches a pond, but the map doesn't show where the pond drains.",
  'outlet-unmapped': () => "It reaches a culvert or ditch whose next stop isn't mapped.",
  'gallery-unverified': () => "It reaches an underground spot that may let water soak in, but the city hasn't confirmed it.",
  'device-unmapped': () => "It reaches a tank or treatment box whose outlet isn't mapped.",
  'detention-unmapped': () => "It reaches a tank or treatment box whose outlet isn't mapped.",
  loop: () => "The pipes on the map loop back on themselves here, so the direction isn't clear.",
  'outfall-unknown': () => "It leaves the pipes at an outfall, but the map doesn't say which water it flows into.",
  'discharge-unknown': (w) => `${cap(w)} map ends at a discharge point and doesn't say where the water goes next.`,
  'not-connected': () => "TireTrail can't follow it any farther.",
  'too-long': () => 'The path is too long to follow.',
};

/** The path is too short to follow (or not connected at all). */
const stub = (o: Outcome) => o.lengthM < 10 || o.code === 'not-connected';

/** The card's big line. */
export function headline(o: Outcome): string {
  if (o.cls === 'unknown') {
    if (stub(o)) return "This storm drain isn't connected to any pipe on the map.";
    return `TireTrail can follow this rain for ${fmt.ft(o.lengthM)}. Then the pipe map ${GAP[o.code] ? 'has a gap' : 'stops'}.`;
  }
  if (o.cls === 'none') return 'No storm drain is mapped on this stretch.';
  return `Rain here ${ends(o)}`;
}

/** The card's supporting line. */
export function line(o: Outcome): string {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek':
      if (o.code === 'downstream-creek') return `It reaches a smaller stream first, which runs into ${/unnamed/i.test(r) ? 'that salmon stream' : creekName(r)}. Coho salmon live there.`;
      return 'Coho salmon live there. A chemical from tire dust can kill them within hours of a storm.';
    case 'ground':
      if (o.code === 'discharge-point') return `${cap(o.owner)} map shows the pipes ending at a spot built to let water soak in.`;
      if (o.code === 'infiltration-vault' && /permeable pavement/i.test(o.reason)) return 'It runs into pavement with gaps that let water soak into the soil.';
      return SOAK[o.code] ?? 'The soil filters it instead of the water running to a creek.';
    case 'elsewhere':
      if (/^fennel creek$/i.test(r)) return "The county's fish map doesn't list this part of the creek as coho habitat.";
      return o.city ? "It doesn't flow on to Fennel Creek, the salmon stream TireTrail follows here." : "The state's fish maps don't list it as coho salmon habitat.";
    case 'treatment': return 'In big storms, some of it can overflow untreated into nearby water.';
    case 'unknown': {
      if (stub(o) && (o.code === 'dead-end' || o.code === 'not-connected')) return "TireTrail can't follow it any farther.";
      const g = GAP[o.code];
      if (g) return g(o.owner);
      // a reason with asset ids stays under "For city staff"
      const why = feetText(o.reason);
      return why && !hasId(why) ? why : "From there it goes into pipes that aren't on the map TireTrail uses.";
    }
    default: return `${cap(o.owner)} map shows no drain within 160 feet, so rain runs off the side of the road here. TireTrail can't follow it.`;
  }
}

/** "Rain on {Street} ..." for a tap near a street. */
export function nearLine(o: Outcome, street: string): string {
  return `Rain on ${street} ${ends(o)}`;
}

/** The second sentence after "A storm drain is mapped right here." */
export function drainLine(o: Outcome): string {
  if (o.cls === 'unknown' || o.cls === 'none') return 'The pipe map loses track of its water.';
  return `Its water ${ends(o)}`;
}

/** The coho water a creek answer leads to, for "In {Creek}, ..." */
export function cohoName(receiving: string): string {
  const r = receiving.trim();
  if (!r || /^fennel creek/i.test(r) || FENNEL_SYS.test(r)) return 'Fennel Creek';
  if (/unnamed/i.test(r)) return 'this salmon stream';
  return plainWater(r);
}

/** The card after See it happen: headline and line. */
export function closing(o: Outcome, street: string): { head: string; line: string } {
  switch (o.cls) {
    case 'creek': return { head: `This is where tire dust from ${street} ends up.`, line: `In ${cohoName(o.receiving)}, a chemical from tire dust can kill coho salmon within hours of a storm. Braking gently leaves less dust behind.` };
    case 'ground': return { head: `Rain from ${street} soaks into the ground.`, line: 'The soil filters it instead of the water running to a creek.' };
    case 'elsewhere': return { head: `Rain from ${street} ends up in ${plainWater(o.receiving) || 'other water'}.`, line: line(o) };
    case 'treatment': return { head: `Rain from ${street} goes to a sewage treatment plant.`, line: line(o) };
    default:
      if (stub(o)) return { head: `TireTrail can't follow rain from ${street} past its storm drain.`, line: "The drain isn't connected to any pipe on the map." };
      return { head: `TireTrail followed rain from ${street} for ${fmt.ft(o.lengthM)}.`, line: `Then ${o.owner} pipe map has a gap, so it stops instead of guessing.` };
  }
}

/** Where the water ends up, as a title and a caption line (drive stops and the story use it). */
export function destination(cls: Cls, receiving: string): { title: string; say: string; icon: string } {
  const r = receiving.trim();
  switch (cls) {
    case 'creek': {
      const name = creekName(r);
      if (FENNEL_SYS.test(r)) return { title: r, say: `It reaches <b>${esc(r)}</b>, which drains to Fennel Creek.`, icon: ICON.fish() };
      return { title: cap(name), say: `It reaches <b>${esc(name)}</b>, where coho salmon live.`, icon: ICON.fish() };
    }
    case 'ground':
      return { title: 'Into the ground', say: 'It <b>soaks into the ground</b>.', icon: ICON.soak() };
    case 'elsewhere': {
      const name = plainWater(r) || 'other water';
      return { title: cap(name), say: `It drains to <b>${esc(name)}</b>.`, icon: ICON.waves() };
    }
    case 'treatment':
      return { title: 'A sewage treatment plant', say: 'It goes to a <b>sewage treatment plant</b>.', icon: ICON.plant() };
    case 'none':
      return { title: 'No storm drain', say: 'No storm drain is mapped here.', icon: ICON.dropGray() };
    default:
      return { title: 'The pipe map stops here', say: 'The pipe map <b>stops here</b>.', icon: ICON.q() };
  }
}

/** Meters in a data sentence, said in feet: "1 m from" -> "3 ft from". */
export function feetText(s: string): string {
  return s.replace(/\b(\d+(?:\.\d+)?)\s?m\b/g, (_, n: string) => feet(Number(n)));
}

/** Short distances to the foot, longer ones to 10 ft. */
export function feet(m: number): string {
  const f = m * 3.28084;
  return f < 100 ? `${Math.max(1, Math.round(f))} ft` : fmt.ft(m);
}

// asset ids like DP_66567 or CB102400_r-20
const hasId = (s: string) => /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9]+[_-][\w-]+\b/.test(s);

/** Feet under 0.2 mi, then miles. */
export const far = (m: number): string => (m < 321.9 ? fmt.ft(Math.max(m, 3)) : fmt.mi(m));

/** "Tap" on phones and touch screens, "Click" in the laptop layout. */
export const tapWord = (app: Pick<App, 'layout'>, lower = false): string => {
  const w = app.layout === 'laptop' ? 'Click' : 'Tap';
  return lower ? w.toLowerCase() : w;
};

/** "A", "A and B", "A, B and C" */
export function list(xs: string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** "Sumner's", "Des Moines'" */
export const owns = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Where TireTrail has pipe maps, from the data: "Bonney Lake and unincorporated Pierce County". */
export function covers(R: Region | null): string {
  if (!R) return 'Bonney Lake and unincorporated Pierce County';
  // cities with their own pipe maps; county streets at a city's edge don't count
  const cities = [...R.cityMaps];
  const counties = R.counties.filter((c) => R.covered(c)).map((c) => c.name);
  if (counties.length) cities.push(`unincorporated ${list(counties)} ${counties.length > 1 ? 'counties' : 'County'}`);
  return list(cities) || 'Bonney Lake';
}

/** Whose map it is: "the city's" in a city with its own pipe map, else "Pierce County's". */
export function ownerOf(R: Region | null, p: XY, cityData: boolean): string {
  if (!R) return cityData ? "the city's" : "the county's";
  if (R.ownerAt(p) === 'city') return "the city's";
  const c = R.countyAt(p);
  return c ? `${c.name} County's` : "the county's";
}

/** The county a point is in, as "Pierce County", or ''. */
export function countyName(R: Region | null, p: XY): string {
  const c = R?.countyAt(p);
  return c ? `${c.name} County` : '';
}

export const midOf = (run: Run): XY => run.line[run.line.length >> 1];

/** A Bonney Lake city street, where "other water" means "not the Fennel Creek system". */
export function isCityStreet(app: App, run: Run): boolean {
  return app.placeOf(run.i) === 'Bonney Lake' && (!app.region || app.region.ownerAt(midOf(run)) === 'city');
}

/** Everything a card needs about a drain's ending. at: where to ask whose map it is. */
export function outcomeOf(app: App, drain: number | null, at: XY, city: boolean): Outcome {
  if (drain === null) return { cls: 'none', code: '', receiving: '', reason: '', lengthM: 0, owner: ownerOf(app.region, at, city), city };
  const d = app.data.drain(drain);
  return { cls: app.world.drainCls(drain), code: d.code, receiving: d.receiving, reason: d.reason, lengthM: app.data.path(drain).lengthM, owner: ownerOf(app.region, at, city), city };
}

/** A drain's answer, asking whose map it is at the drain itself. */
export function drainOutcome(app: App, drain: number): Outcome {
  const R = app.region, at = app.world.drains[drain];
  const city = R ? R.ownerAt(at) === 'city' && R.placeAt(at)?.name === 'Bonney Lake' : true;
  return outcomeOf(app, drain, at, city);
}

/** The card after See it happen, with Done and Watch again. */
export function closingEl(o: Outcome, street: string, done: () => void, again: () => void): HTMLElement {
  const c = closing(o, street);
  return h('div.fade.mu-card', {},
    h('div.mu-eyebrow', {}, 'THE WHOLE TRIP'),
    h('h2.h2.mu-h', { tabindex: '-1' }, c.head),
    h('p.mu-line', {}, c.line),
    h('div.mu-btns', {}, h('button.btn.main.mu-btn', { onclick: done }, 'Done'), h('button.btn.quiet.mu-btn', { onclick: again }, 'Watch again')));
}

/** There is a history step to go back to (the app pushes {tt: 1}). */
export const hasStep = (): boolean => { try { return !!(history.state as { tt?: number } | null)?.tt; } catch { return false; } };

/** A street run's answer. */
export function runOutcome(app: App, run: Run): Outcome {
  const o = outcomeOf(app, run.drain, midOf(run), isCityStreet(app, run));
  // the run's own class wins, so the card matches the color drawn
  return { ...o, cls: CLS[run.k] ?? o.cls };
}
