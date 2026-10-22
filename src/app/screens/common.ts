// Words and colors shared by the tabs: one color and one label per answer, then where the rain goes,
// why it matters and what to do, in plain sentences.
import { nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CAT } from '../map/palette.ts';
import type { Region } from '../map/region.ts';
import { CLS, type Cls, type Run } from '../map/world.ts';
import type { Tone } from '../ui/format.ts';
import { button, glyph, stagger } from '../ui/ui.ts';

/** Per answer: map color, label, kit tone, pixel glyph and the art for pages. */
export const KIND: Record<Cls, { color: string; chip: string; tone: Tone; glyph: string; art: string }> = {
  creek: { color: CAT.creek, chip: 'SALMON STREAM', tone: 'salmon', glyph: 'fish', art: 'tut-4-salmon' },
  ground: { color: CAT.ground, chip: 'SOAKS IN', tone: 'soak', glyph: 'soak', art: 'tut-3-pipes' },
  elsewhere: { color: CAT.elsewhere, chip: 'OTHER WATER', tone: 'other', glyph: 'wave', art: 'tut-3-pipes' },
  unknown: { color: CAT.unknown, chip: 'MAP GAP', tone: 'plain', glyph: 'info', art: 'tut-2-drain' },
  none: { color: CAT.none, chip: 'NO MAPPED DRAIN', tone: 'plain', glyph: 'drop', art: 'tut-2-drain' },
  treatment: { color: CAT.treatment, chip: 'TREATMENT PLANT', tone: 'plain', glyph: 'info', art: 'tut-3-pipes' },
};

// a class the data file has no name for comes through as undefined; it reads as a map gap
Object.defineProperty(KIND, 'undefined', { value: KIND.unknown });

/** Gray answers get outline chips. */
export const isGray = (c: Cls): boolean => c === 'unknown' || c === 'none';
const kind = (c: Cls) => KIND[c] ?? KIND.unknown;

export const chip = (c: Cls) => h('span.chip', { style: `--k:${kind(c).color}` }, kind(c).chip);

/** The kit tone for an answer. */
export const toneOf = (c: Cls): Tone => kind(c).tone;

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
  if (/^an? wetland$/i.test(s)) return 'a wetland';
  if (/unnamed (lake|pond)|unnamed .*(lake|pond)$/i.test(s)) return 'a small lake or pond with no name on the map';
  if (/unnamed/i.test(s)) return 'a small stream with no name on the map';
  return s;
}

/** Short water words for a card headline: no "with no name on the map". */
export function shortWater(receiving: string): string {
  const s = plainWater(receiving);
  return s.replace(/ with no name on the map$/, '');
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
  /** the rain goes in at a roadside ditch, not a storm drain */
  ditch?: boolean;
}

/** Where coho salmon are, as the data says it: down Fennel Creek, here, downstream, maybe (modeled) or in the past. */
export type CohoSay = 'spawn' | 'here' | 'down' | 'modeled' | 'historic' | null;

export function cohoSay(o: Pick<Outcome, 'cls' | 'reason' | 'city' | 'receiving'>): CohoSay {
  const r = o.reason ?? '';
  if (o.cls === 'creek' && o.city) return 'spawn';
  if (/WDFW records coho salmon/.test(r)) return /downstream|on into/.test(r) ? 'down' : 'here';
  if (/WDFW maps (this stream )?as reachable by coho|which WDFW maps as reachable by coho/.test(r)) return 'modeled';
  if (/WDFW lists coho salmon/.test(r)) return 'historic';
  if (o.cls !== 'creek') return null;
  // Bonney Lake's own data: the Fennel Creek system, upstream of where coho spawn
  const w = o.receiving.trim();
  return !w || /^fennel creek/i.test(w) || FENNEL_SYS.test(w) ? 'spawn' : 'here';
}

// Tian et al. 2021 (Science); Scholz et al. 2011: affected fish die within hours
const KILLS = '6PPDQ in tire dust can kill coho within hours of a storm.';

/** "ends up in Fennel Creek.": what the rain does, after "Rain here". */
export function ends(o: Pick<Outcome, 'cls' | 'receiving'> & { code?: string }): string {
  const r = o.receiving.trim(), code = o.code ?? '';
  const likely = code.startsWith('bridge-') ? 'most likely drops into ' : code.startsWith('pipe-end-') ? 'most likely flows into ' : '';
  switch (o.cls) {
    case 'creek':
      if (!r || /^fennel creek$/i.test(r)) return `${likely || 'ends up in '}Fennel Creek.`;
      if (/^fennel creek tributary/i.test(r)) return `${likely || 'ends up in '}a stream that feeds Fennel Creek.`;
      if (FENNEL_SYS.test(r)) return `reaches ${r}, then Fennel Creek.`;
      if (/unnamed/i.test(r)) return `${likely || 'ends up in '}a small salmon stream.`;
      return `${likely || 'ends up in '}${plainWater(r)}.`;
    case 'ground': return 'soaks into the ground.';
    case 'elsewhere': return `${likely || 'drains to '}${shortWater(r) || 'other water'}.`;
    case 'treatment': return 'goes to a sewage treatment plant.';
    case 'unknown': return 'reaches a gap in the pipe map.';
    default: return 'has no mapped drain.';
  }
}

// map gap endings TireTrail knows, as a short line and one more; any other code (like water handed to another agency) uses its own reason
const GAP: Record<string, (owner: string) => [string, string]> = {
  'dead-end': (w) => [`Then ${w} map has a gap.`, 'TireTrail stops there instead of guessing.'],
  'pond-unmapped': () => ['Then it flows into a pond.', "The map doesn't show where the pond drains."],
  'pond-other': () => ['Then it flows into a pond.', "The map doesn't show where the pond drains."],
  'outlet-unmapped': () => ['Then it reaches a culvert or ditch.', "Where it goes next isn't mapped."],
  'gallery-unverified': () => ['Then it reaches a spot that may soak it in.', "The city tagged it as a possible soak-in gallery but hasn't confirmed it."],
  'device-unmapped': () => ['Then it reaches a tank or treatment box.', "Where that drains isn't mapped."],
  'detention-unmapped': () => ['Then it reaches a tank or treatment box.', "Where that drains isn't mapped."],
  loop: () => ['Then the pipes on the map loop back on themselves.', "So which way the water goes isn't clear."],
  'outfall-unknown': () => ['Then the pipes empty out at an outfall.', "The stream or pond it flows into isn't on the map."],
  'discharge-unknown': (w) => [`Then ${w} map ends at a discharge point.`, "It doesn't say where the water goes next."],
  'too-long': () => ['The path is too long to follow.', ''],
};

/** The path is too short to follow (or not connected at all). */
const stub = (o: Outcome) => o.lengthM < 10 || o.code === 'not-connected';

/** The card's big line: where the rain goes. */
export function headline(o: Outcome): string {
  if (o.cls === 'unknown') {
    if (o.code === 'discharge-probable') return 'Rain here probably soaks into the ground.';
    if (stub(o)) return o.ditch ? "This roadside ditch isn't connected to anything on the map." : "This storm drain isn't connected to any pipe on the map.";
    return `TireTrail can follow this rain for ${fmt.ft(o.lengthM)}.`;
  }
  if (o.cls === 'none') return 'No storm drain is mapped on this stretch.';
  return `Rain here ${ends(o)}`;
}

/** The words in a headline to color like the map: the water or the ground ('' for gray answers). */
export function destWords(o: Outcome): string {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek':
      if (/^fennel creek tributary/i.test(r)) return 'a stream that feeds Fennel Creek';
      if (!r || /^fennel creek/i.test(r)) return 'Fennel Creek';
      if (FENNEL_SYS.test(r)) return r;
      return /unnamed/i.test(r) ? 'a small salmon stream' : plainWater(r);
    case 'elsewhere': return shortWater(r) || 'other water';
    case 'ground': return 'soaks into the ground';
    case 'treatment': return 'a sewage treatment plant';
    default: return '';
  }
}

/** Soaking in, by what it soaks through (the audit's honest words). */
function facility(o: Outcome): string {
  const where = /unnamed|^an? /i.test(o.receiving.trim()) ? plainWater(o.receiving) : o.receiving.trim();
  switch (o.code) {
    case 'drywell': return 'It drains into a dry well, a pit that lets it soak into the ground.';
    case 'infiltration-pond': case 'pond-to-ground': case 'pond-to-ground-partial': return 'It drains to a pond built to soak it into the ground.';
    case 'infiltration-pond-overflow': return 'It drains to a pond built to soak it in. In very big storms this pond can overflow.';
    case 'infiltration-vault': return 'It drains to an underground tank that lets it soak into the ground.';
    case 'perforated-pipe': return 'It drains into a pipe with holes that lets it soak into the ground.';
    case 'discharge-point': return `It drains to a spot ${countyWord(o.owner)} lists as built to soak water into the ground.`;
    case 'discharge-by-water': return where ? `It drains to a spot built to soak it in, close to ${where}. Some may still reach the water.` : 'It drains to a spot built to soak it in, close to water. Some may still reach the water.';
    default: return 'It drains to a spot built to soak it into the ground.';
  }
}

/** "Pierce County's" -> "Pierce County"; "the city's" -> "the city". */
const countyWord = (owner: string) => owner.replace(/'s$/, '').replace(/'$/, '');

/** Why it matters: a short bold line and one more sentence. */
export function why(o: Outcome): { title: string; body: string } {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek': {
      const c = cohoSay(o);
      const title = c === 'spawn' ? 'Coho salmon spawn downstream.' : c === 'down' ? 'WDFW records coho salmon downstream.' : 'WDFW records coho salmon in this stream.';
      return { title, body: KILLS };
    }
    case 'ground':
      return { title: 'Soil removes most of the tire chemical that harms salmon.', body: facility(o) };
    case 'elsewhere': {
      const c = cohoSay(o);
      if (c === 'modeled') return { title: 'WDFW maps this stream as reachable by coho salmon.', body: `They haven't been confirmed here. ${KILLS}` };
      if (c === 'historic') return { title: 'WDFW lists coho salmon in this stream in the past.', body: KILLS };
      if (o.city) return { title: "It doesn't reach Fennel Creek, the salmon stream here.", body: '' };
      if (/^puget sound$/i.test(r)) return { title: 'It reaches salt water, not a coho spawning stream.', body: '' };
      if (/^fennel creek$/i.test(r)) return { title: "WDFW doesn't map this part of the creek as coho water.", body: 'Coho salmon spawn farther down Fennel Creek.' };
      return { title: "The state's fish maps don't list it as coho salmon water.", body: '' };
    }
    case 'treatment':
      return { title: 'In big storms, some of it can overflow untreated into nearby water.', body: 'The rest is treated at the plant.' };
    case 'unknown': {
      if (o.code === 'discharge-probable') return { title: `The pipes end at a spot ${countyWord(o.owner)} lists as built to soak water in.`, body: "The map doesn't show that part, so TireTrail can't confirm it." };
      if (stub(o)) return { title: "So TireTrail can't follow its rain.", body: "It could end up in a creek or soak in. The map doesn't say which." };
      const g = GAP[o.code];
      if (g) {
        const [title, body] = g(o.owner);
        // the county names the nearest water to an outfall it can't place
        const nearest = /The nearest mapped water, [^.]*? is (?:about [\d,.]+ (?:ft|miles?)|a few feet) away\./.exec(o.reason)?.[0];
        return { title, body: nearest ?? body };
      }
      // a reason with asset ids stays in the notes for city staff
      const said = feetText(o.reason);
      return { title: said && !hasId(said) ? said : "From there it goes into pipes that aren't on the map TireTrail uses.", body: "It could end up in a creek or soak in. The map doesn't say which." };
    }
    default:
      return { title: `${cap(o.owner)} map shows no storm drain within 160 feet of this stretch.`, body: "So TireTrail can't tell where its rain goes." };
  }
}

/** What you can do: the action, and why in a few words. */
export function todoParts(o: Outcome, street: string): { title: string; body: string } {
  const s = street && !/^this (street|spot)$/i.test(street) ? street : 'this street';
  // a salmon stream, or one WDFW says coho may reach or once used
  const coho = o.cls === 'creek' || (o.cls === 'elsewhere' && (cohoSay(o) === 'modeled' || cohoSay(o) === 'historic'));
  if (coho) return { title: `Brake gently on ${s}.`, body: 'Hard brakes leave more tire dust.' };
  if (o.cls === 'unknown') return { title: 'Brake gently here.', body: 'Less dust is better wherever it goes.' };
  return { title: 'Brake gently anyway.', body: 'It saves your tires.' };
}

/** What you can do, in one line. */
export function todo(o: Outcome, street: string): string {
  const t = todoParts(o, street);
  return `${t.title} ${t.body}`;
}

/** A card row: a line short enough for one phone line, and the longer words behind a tap ('' when none). */
export interface Line { text: string; more: string }

/** The longest row line that still fits one line on a 360 px phone. */
export const LINE_MAX = 36;

// map gap endings, short: the full words go behind the tap
const GAP_SHORT: Record<string, string> = {
  'dead-end': 'Then the map has a gap.', 'pond-unmapped': 'Then it flows into a pond.', 'pond-other': 'Then it flows into a pond.',
  'outlet-unmapped': 'Then it reaches a culvert or ditch.', 'gallery-unverified': 'Then it may soak in.', 'device-unmapped': 'Then it reaches a tank.',
  'detention-unmapped': 'Then it reaches a tank.', loop: 'Then the pipes loop back.', 'outfall-unknown': 'Then it leaves at an outfall.',
  'discharge-unknown': 'Then the map ends.', 'too-long': 'The path is too long to follow.',
};

/** Why it matters, short, with the rest behind a tap. Same facts as why(). */
export function whyLine(o: Outcome): Line {
  const w = why(o), c = cohoSay(o), r = o.receiving.trim();
  const full = (text: string): Line => ({ text, more: [text === w.title ? '' : w.title, w.body].filter(Boolean).join(' ') });
  switch (o.cls) {
    case 'creek': return { text: c === 'spawn' ? 'Coho salmon spawn downstream.' : c === 'down' ? 'WDFW records coho downstream.' : 'WDFW records coho in this stream.', more: w.body };
    case 'ground': return { text: 'Soil removes most of the tire toxin.', more: w.body };
    case 'elsewhere':
      if (c === 'modeled') return { text: 'Coho may reach this stream.', more: `WDFW maps it as reachable by coho, but they aren't confirmed here. ${KILLS}` };
      if (c === 'historic') return { text: 'WDFW lists coho here in the past.', more: w.body };
      if (o.city) return { text: "It doesn't reach Fennel Creek.", more: 'Fennel Creek is the salmon stream here.' };
      if (/^puget sound$/i.test(r)) return { text: 'Salt water, not a coho stream.', more: '' };
      if (/^fennel creek$/i.test(r)) return { text: 'Not coho water on WDFW maps.', more: w.body };
      return { text: 'Not coho water on state maps.', more: '' };
    case 'treatment': return full('Big storms can overflow untreated.');
    case 'unknown':
      if (o.code === 'discharge-probable') return full('Likely a spot built to soak it in.');
      if (stub(o)) return full(w.title);
      return full(GAP_SHORT[o.code] ?? (w.title.length <= LINE_MAX ? w.title : 'Then the map stops.'));
    default: return full('No drain within 160 ft on the map.');
  }
}

/** What to do, short: "Brake gently on 214th Ave E." with the reason behind a tap. */
export function todoLine(o: Outcome, street: string): Line {
  const t = todoParts(o, street);
  return { text: t.title.length <= LINE_MAX ? t.title : 'Brake gently here.', more: t.body };
}

/** One short card row with a pixel icon; the longer words, if any, open under it. label is for screen readers. */
export function row(icon: string, line: Line, opts: { tone?: Tone; label?: string } = {}): HTMLElement {
  const ico = h('span.mu-li-ico', { 'aria-hidden': 'true', html: icon.trim().startsWith('<') ? icon : glyph(icon) });
  const words = h('span.mu-li-t', {}, opts.label ? h('span.mu-vh', {}, `${opts.label}: `) : null, keepNames(line.text));
  const tone = opts.tone ?? 'plain';
  if (!line.more) return h('div.mu-li', { 'data-tone': tone }, h('div.mu-li-row', {}, ico, words));
  return h('details.mu-li', { 'data-tone': tone },
    h('summary.mu-li-row', {}, ico, words, h('span.mu-li-more', { 'aria-hidden': 'true' }, h('span', {}, 'More'), h('span.mu-chev', { html: glyph('chevron') }))),
    h('p.mu-li-body', {}, keepNames(line.more)));
}

/** The supporting line: why it matters, in one or two sentences (the trip's last step, the drive stop pages). */
export function line(o: Outcome): string {
  const w = why(o);
  return o.cls === 'creek' ? `${w.title} ${w.body}` : w.title;
}

/** "Rain on {Street} ..." for a tap near a street. */
export function nearLine(o: Outcome, street: string): string {
  if (o.cls === 'unknown' && o.code === 'discharge-probable') return `Rain on ${street} probably soaks into the ground.`;
  return `Rain on ${street} ${ends(o)}`;
}

/** The second sentence after "A storm drain is mapped right here." */
export function drainLine(o: Outcome): string {
  if (o.cls === 'unknown') return o.lengthM >= 10 && o.code !== 'not-connected' ? `TireTrail can follow its water for ${fmt.ft(o.lengthM)}. Then the map stops.` : "It isn't connected to any pipe on the map.";
  if (o.cls === 'none') return "The map doesn't show where its water goes.";
  return `Its water ${ends(o)}`;
}

/** The coho water a creek answer leads to, for "In {Creek}, ..." */
export function cohoName(receiving: string): string {
  const r = receiving.trim();
  if (!r || /^fennel creek/i.test(r) || FENNEL_SYS.test(r)) return 'Fennel Creek';
  if (/unnamed/i.test(r)) return 'this salmon stream';
  return plainWater(r);
}

/** The card after See it happen: a label, where it ends up (with how far it went, when there's room), why it matters and what to do. */
export function ending(o: Outcome, street: string, howFar = true): { kicker: string; head: string; why: { title: string; body: string }; todo: string } {
  const s = street || 'this street', far1 = howFar && o.lengthM >= 10 ? ` travels ${far(o.lengthM)} and` : '';
  const w = why(o), t = todo(o, street);
  switch (o.cls) {
    case 'creek': return { kicker: 'WHERE IT ENDS UP', head: `Tire dust from ${s}${far1} ${ends(o)}`, why: w, todo: t };
    case 'ground': return { kicker: 'WHERE IT ENDS UP', head: `Rain from ${s}${far1} soaks into the ground.`, why: w, todo: t };
    case 'elsewhere': return { kicker: 'WHERE IT ENDS UP', head: `Rain from ${s}${far1} ${ends(o)}`, why: w, todo: t };
    case 'treatment': return { kicker: 'WHERE IT ENDS UP', head: `Rain from ${s}${far1} goes to a sewage treatment plant.`, why: w, todo: t };
    default:
      if (o.code === 'discharge-probable') return { kicker: 'AS FAR AS THE MAP GOES', head: `Rain from ${s} probably soaks into the ground.`, why: w, todo: t };
      if (stub(o)) return { kicker: 'AS FAR AS THE MAP GOES', head: `TireTrail can't follow rain from ${s} past its ${o.ditch ? 'ditch' : 'storm drain'}.`, why: { title: o.ditch ? "The ditch isn't connected to anything on the map." : "The drain isn't connected to any pipe on the map.", body: w.body }, todo: t };
      return { kicker: 'AS FAR AS THE MAP GOES', head: `TireTrail followed rain from ${s} for ${fmt.ft(o.lengthM)}.`, why: w, todo: t };
  }
}

/** The card after See it happen, as a headline and one line (kept for older callers). */
export function closing(o: Outcome, street: string): { head: string; line: string } {
  const e = ending(o, street);
  return { head: e.head, line: `${e.why.title} ${e.why.body}`.trim() };
}

/** Where the water ends up, as a title and a caption line (drive stops and the story use it). */
export function destination(cls: Cls, receiving: string): { title: string; say: string; icon: string } {
  const r = receiving.trim();
  switch (cls) {
    case 'creek': {
      const name = creekName(r);
      if (FENNEL_SYS.test(r)) return { title: r, say: `It reaches <b>${esc(r)}</b>, then Fennel Creek.`, icon: ICON.fish() };
      if (name.includes('Fennel Creek')) return { title: cap(name), say: `It reaches <b>${esc(name)}</b>. Coho salmon spawn farther down the creek.`, icon: ICON.fish() };
      return { title: cap(name), say: `It reaches <b>${esc(name)}</b>, where WDFW records coho salmon.`, icon: ICON.fish() };
    }
    case 'ground':
      return { title: 'Into the ground', say: 'It <b>soaks into the soil</b> here.', icon: ICON.soak() };
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

/** The story's captions, fixed for ditches, for whose water it is, and for where coho really are. */
export interface Narration { rain: string; drain: string; pipes: string; end: string; steps: [string, string, string, string] }

export function narrate(o: Outcome & { name: string; curb?: boolean; pipes: number; ditches: number; tiny?: boolean; calm?: boolean; intro?: string }): Narration {
  const n = `<b>${esc(o.name)}</b>`, ditch = !!o.ditch;
  const rain = o.intro ?? (ditch ? `Rain washes tire dust off ${n} into the roadside ditch.` : `Rain washes tire dust off ${n} toward the storm drain${o.curb ? ' at the curb' : ''}.`);
  const drain = ditch
    ? 'It runs along the roadside ditch, downhill.'
    : o.calm ? 'It pours into the storm drain, then into pipes under the street.' : "It pours into the storm drain. Now you're looking under the street.";
  // the roadside ditch the rain runs into is ditch on the way too
  const d = o.ditches + (ditch ? 1 : 0);
  const way = o.pipes && d ? 'storm pipes and ditches' : d ? 'roadside ditches' : 'storm pipes';
  const pipes = o.calm
    ? `The dotted blue line shows its path through the ${way}, downhill.`
    : o.pipes && !ditch ? 'Gray tubes are storm pipes. The blue dot is the rain, running downhill.' : `The blue dot is the rain, running downhill through the ${way}.`;
  return {
    rain,
    drain,
    pipes,
    end: endCaption(o),
    steps: [`Rain washes tire dust off ${o.name}`, ditch ? 'It runs into a roadside ditch' : 'It pours into a storm drain', `It runs through the ${way}`, 'Where it ends up'],
  };
}

/** The last caption: where it ends up. What the data says about coho is on the card under it. */
function endCaption(o: Outcome & { tiny?: boolean }): string {
  const r = o.receiving.trim(), b = (s: string) => `<b>${esc(s)}</b>`;
  const pond = /^pond-to-/.test(o.code);
  if (o.cls === 'creek') {
    const where = !r || /^fennel creek$/i.test(r) ? b('Fennel Creek')
      : /^fennel creek tributary/i.test(r) ? `a stream that feeds ${b('Fennel Creek')}`
        : FENNEL_SYS.test(r) ? `${b(r)}, then Fennel Creek`
          : /unnamed/i.test(r) ? 'a small salmon stream' : b(plainWater(r));
    return pond ? `It flows into a pond, then on to ${where}.`
      : o.code.startsWith('bridge-') ? `It drops through the bridge drain into ${where}.`
        : o.code.startsWith('pipe-end-') ? `The map stops just short of ${where}. It most likely flows in.`
          : o.code === 'downstream-creek' ? `It reaches a smaller stream that runs into ${where}.` : `It reaches ${where}.`;
  }
  if (o.cls === 'elsewhere') {
    const where = r ? b(shortWater(r)) : 'other water nearby';
    if (pond) return `It flows into a pond, then on to ${where}.`;
    if (o.code.startsWith('bridge-')) return `It drops through the bridge drain into ${where}.`;
    if (o.code.startsWith('pipe-end-')) return `The map stops just short of ${where}. It most likely flows in.`;
    return `It ends up in ${where}.`;
  }
  if (o.cls === 'ground') return o.tiny ? 'It soaks into the ground right at the drain.' : /pond/.test(o.code) ? 'It flows into a pond built to soak it into the ground.' : 'It soaks into the soil here.';
  if (o.cls === 'treatment') return 'It joins a sewer pipe that goes to a sewage treatment plant.';
  if (o.code === 'discharge-probable') return 'The pipes end at a spot built to soak it in. The map doesn\'t show that part.';
  return 'Here the pipe map stops, so TireTrail stops too.';
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

const SHORT: Record<string, string> = { Street: 'St', Avenue: 'Ave', Road: 'Rd', Drive: 'Dr', Boulevard: 'Blvd', Highway: 'Hwy', Court: 'Ct', Place: 'Pl', Lane: 'Ln', Parkway: 'Pkwy' };
const SIDE: Record<string, string> = { East: 'E', West: 'W', North: 'N', South: 'S', Northeast: 'NE', Northwest: 'NW', Southeast: 'SE', Southwest: 'SW' };

/** An OSM road name in the street data's short style: "184 Avenue Court East" -> "184 Ave Ct E". */
export function roadName(s: string): string {
  return s.trim()
    .replace(/\b(Street|Avenue|Road|Drive|Boulevard|Highway|Court|Place|Lane|Parkway)\b/g, (w) => SHORT[w])
    .replace(/ (East|West|North|South|Northeast|Northwest|Southeast|Southwest)$/, (_, d: string) => ` ${SIDE[d]}`);
}

/** "A", "A and B", "A, B and C" */
export function list(xs: string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** "Sumner's", "Des Moines'" */
export const owns = (name: string): string => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** Where TireTrail has pipe maps, from the data, county by county: "Pierce County (Bonney Lake and unincorporated areas)". county: the county areas count. */
export function covers(R: Region | null, county = true): string {
  if (!R) return 'parts of Washington';
  const by = new Map<string, string[]>();
  const add = (co: string, what: string) => by.set(co, [...(by.get(co) ?? []), what]);
  // cities with their own pipe maps, under their county; county streets at a city's edge don't count
  for (const name of R.cityMaps) {
    const pl = R.places.find((p) => p.name === name);
    add((pl && R.countyAt(pl.at, true)?.name) ?? '', name);
  }
  if (county) for (const c of R.counties) if (R.covered(c)) add(c.name, 'unincorporated areas');
  // counties by name; a city no county holds goes last
  const order = [...by.keys()].sort((a, b) => Number(!a) - Number(!b) || a.localeCompare(b));
  return list(order.map((co) => (co ? `${co} County (${list(by.get(co)!)})` : list(by.get(co)!)))) || 'parts of Washington';
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

/** A box around the lines, r m wider, to skip far points fast. */
function boxOf(lines: XY[][], r: number): (p: XY) => boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  return (p) => p[0] >= x0 - r && p[0] <= x1 + r && p[1] >= y0 - r && p[1] <= y1 + r;
}

/** How many point sets (one drive's hard brakes) come within r m of any of the lines. */
export function touching(lines: XY[][], sets: XY[][], r: number): number {
  const inBox = boxOf(lines, r);
  const near = (p: XY) => inBox(p) && lines.some((l) => nearestOnPolyline(p, l).d <= r);
  return sets.filter((s) => s.some(near)).length;
}

/** How many routes drove along the lines (within r m for span m of the street, or most of a short one), not just across them. */
export function driven(lines: XY[][], routes: XY[][], r = 20, span = 40): number {
  const inBox = boxOf(lines, r);
  const along = (route: XY[], l: XY[]) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of route) {
      if (!inBox(p)) continue;
      const n = nearestOnPolyline(p, l);
      if (n.d <= r) [lo, hi] = [Math.min(lo, n.along), Math.max(hi, n.along)];
    }
    return hi - lo >= Math.min(span, 0.6 * lineLength(l));
  };
  return routes.filter((route) => lines.some((l) => l.length > 1 && along(route, l))).length;
}

const lineLength = (l: XY[]) => l.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);

/** Points along a route every step m, so a coarse route's straight runs count as driven. */
export function densify(pts: XY[], step: number): XY[] {
  const out: XY[] = [];
  pts.forEach((b, i) => {
    if (!i) { out.push(b); return; }
    const a = pts[i - 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  });
  return out;
}

/** Splits n blocks by share, at least one each, largest remainders first (the pixel strip of a whole street). */
export function blocks(values: number[], n: number): number[] {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const k = values.length;
  if (k >= n) return values.map(() => 1);
  const raw = values.map((v) => (v / total) * (n - k));
  const out = raw.map((r) => 1 + Math.floor(r));
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left > 0; j = (j + 1) % k, left--) out[order[j][1]]++;
  return out;
}

/** "Your drives pass here 3 times" or "You braked hard here on 2 drives", or null when neither. */
export function mineText(m: { passes: number; hard: number }): { text: string; tone: Tone; icon: string } | null {
  if (m.hard > 0) return { text: `You braked hard here on ${m.hard} ${m.hard === 1 ? 'drive' : 'drives'}.`, tone: 'warn', icon: 'warn' };
  if (m.passes > 0) return { text: m.passes === 1 ? 'One of your drives passes here.' : `Your drives pass here ${m.passes} times.`, tone: 'you', icon: 'route' };
  return null;
}

/** A Bonney Lake city street, where "other water" means "not the Fennel Creek system". */
export function isCityStreet(app: App, run: Run): boolean {
  return app.placeOf(run.i) === 'Bonney Lake' && (!app.region || app.region.ownerAt(midOf(run)) === 'city');
}

/** The rain goes in at a roadside ditch (the drain's own asset is a ditch). */
export function isDitch(app: Pick<App, 'data'>, drain: number): boolean {
  const b = app.data.bundle;
  return b.assets.kind[b.drains.asset[drain]] === 6;
}

/** Everything a card needs about a drain's ending. at: where to ask whose map it is. */
export function outcomeOf(app: App, drain: number | null, at: XY, city: boolean): Outcome {
  if (drain === null) return { cls: 'none', code: '', receiving: '', reason: '', lengthM: 0, owner: ownerOf(app.region, at, city), city };
  const d = app.data.drain(drain);
  return { cls: app.world.drainCls(drain), code: d.code, receiving: d.receiving, reason: d.reason, lengthM: app.data.path(drain).lengthM, owner: ownerOf(app.region, at, city), city, ditch: isDitch(app, drain) };
}

/** A drain's answer, asking whose map it is at the drain itself. */
export function drainOutcome(app: App, drain: number): Outcome {
  const R = app.region, at = app.world.drains[drain];
  const city = R ? R.ownerAt(at) === 'city' && R.placeAt(at)?.name === 'Bonney Lake' : true;
  return outcomeOf(app, drain, at, city);
}

// ---------- card parts (the map's cards and the More details page share them) ----------

/** The small pixel label over a card's headline, in the answer's color. */
export const kicker = (text: string, tone: Tone = 'plain'): HTMLElement => h('p.mu-kicker', { 'data-tone': tone }, text);

const ROADS = 'St|Ave|Rd|Dr|Blvd|Hwy|Ct|Pl|Ln|Way|Pkwy|Cir|Ter|Loop';

/** Street names and distances kept on one line: "106th St E" never breaks into "106th St / E", nor "0.7 mi" into "0.7 / mi". */
export function keepNames(s: string): string {
  return s.replace(new RegExp(`\\b(\\d+(?:st|nd|rd|th)?) (${ROADS})\\b`, 'g'), '$1\u00a0$2')
    .replace(new RegExp(`\\b(${ROADS}|SR \\d+|SR\u00a0\\d+) (E|W|N|S|NE|NW|SE|SW)\\b`, 'g'), '$1\u00a0$2')
    .replace(/\bSR (\d+)/g, 'SR\u00a0$1')
    .replace(/(\d) (ft|mi)\b/g, '$1\u00a0$2');
}

/** A headline whose words naming the water (or the ground) take the answer's color. */
export function headEl(text: string, dest = '', tag = 'h2'): HTMLElement {
  const el = h(`${tag}.mu-h`, { tabindex: '-1' });
  const i = dest ? text.lastIndexOf(dest) : -1;
  if (i < 0) el.textContent = keepNames(text);
  else el.append(keepNames(text.slice(0, i)), h('span.mu-dest', {}, dest), keepNames(text.slice(i + dest.length)));
  return el;
}

/** The square close key. */
export const closeKey = (fn: () => void): HTMLElement =>
  h('button.u-btn.u-secondary.u-square.mu-x', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: fn, html: glyph('x') });

/** What you can do, in your color, with a pixel icon. */
export const doLine = (text: string, icon = 'stop'): HTMLElement =>
  h('p.mu-do', {}, h('span.mu-do-ico', { 'aria-hidden': 'true', html: glyph(icon) }), h('span', {}, keepNames(text)));

/** Marks a phone card whose words scroll under its keys, so the keys get a rule above them. */
export function scrolls(sheet: HTMLElement): void {
  requestAnimationFrame(() => sheet.classList.toggle('mu-scrolls', sheet.scrollHeight > sheet.clientHeight + 1));
}

/** A card's top: the label, the headline, and the close key. */
export const cardHead = (label: string, tone: Tone, head: HTMLElement, close: (() => void) | null): HTMLElement =>
  h('div.mu-head', {}, h('div.mu-titles', {}, kicker(label, tone), head), close ? closeKey(close) : null);

/** Where it ends up, as a short label: the end card's head and the trip's last step. */
export function endLabel(o: Outcome): string {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek': return fennelSystem(r) ? r : cap(creekName(r));
    case 'ground': return 'Soaks into the ground';
    case 'elsewhere': return cap(plainWater(r) || 'other water');
    case 'treatment': return 'A sewage treatment plant';
    case 'none': return 'No storm drain';
    default: return o.code === 'discharge-probable' ? 'Probably soaks in' : 'The pipe map stops here';
  }
}

/** Pixel art for the end of the trip: the coho, the pipes, the storm drain; and a sprite for where there's no room. */
const BANNER: Record<Cls, string> = { creek: 'tut-4-salmon', ground: 'tut-3-pipes', elsewhere: 'tut-3-pipes', treatment: 'tut-3-pipes', unknown: 'tut-2-drain', none: 'tut-2-drain' };
const SPRITE: Record<Cls, string> = { creek: 'icon-salmon', ground: 'icon-soil', elsewhere: 'icon-pond', treatment: 'icon-pipe', unknown: 'icon-grate', none: 'icon-grate' };

/** The card at the end of See it happen: where it ends up, why it matters, what to do, and what next. */
export function endingEl(o: Outcome, street: string, acts: { done: () => void; again: () => void; drive?: (() => void) | null; driveLabel?: string | null; next?: { label: string; go: () => void } | null; art?: boolean }): HTMLElement {
  // a phone (no art) keeps it short: no distance (the story just showed it), one row of keys
  const e = ending(o, street, !!acts.art), k = kind(o.cls);
  const art = acts.art ? h(`div.mu-banner.mu-b-${o.cls}`, { 'aria-hidden': 'true', style: `background-image:url(art/${BANNER[o.cls] ?? BANNER.unknown}.png)` }) : null;
  // after a salmon stream: go practice gentle stops; after anything else: go see one that does reach salmon
  const main = acts.next ? button(acts.next.label, { kind: 'primary', icon: 'fish', onClick: acts.next.go })
    : acts.drive ? button(acts.driveLabel ?? 'Start a drive', { kind: 'primary', icon: acts.driveLabel ? 'phone' : 'car', onClick: acts.drive })
      : button('Done', { kind: 'primary', icon: 'check', onClick: acts.done });
  // with no room for the art, its sprite: the coho, the soil, the pond, the drain
  const icon = acts.art ? k.glyph : `<img src="art/${SPRITE[o.cls] ?? SPRITE.unknown}.png" width="32" height="32" alt="">`;
  const el = stagger(h('div.u-sheet.mu-sheet.mu-end', { 'data-tone': k.tone },
    art,
    // the caption above says where in a sentence; here it's a label
    cardHead(e.kicker, k.tone, headEl(endLabel(o), isGray(o.cls) ? '' : endLabel(o)), acts.done),
    h('div.mu-lines', {},
      row(icon, whyLine(o), { tone: k.tone, label: 'Why it matters' }),
      row('stop', todoLine(o, street), { tone: 'you', label: 'What to do' })),
    h('div.mu-acts', {}, main, acts.art
      ? button('Watch again', { kind: 'secondary', icon: 'play', onClick: acts.again })
      : h('button.u-btn.u-secondary.u-square', { type: 'button', 'aria-label': 'Watch again', title: 'Watch again', onclick: acts.again, html: glyph('play') }))));
  scrolls(el);
  return el;
}

/** The card after See it happen, with Done and Watch again (kept for older callers). */
export function closingEl(o: Outcome, street: string, done: () => void, again: () => void): HTMLElement {
  return endingEl(o, street, { done, again });
}

/** There is a history step to go back to (the app pushes {tt: 1}). */
export const hasStep = (): boolean => { try { return !!(history.state as { tt?: number } | null)?.tt; } catch { return false; } };

/** A street run's answer. */
export function runOutcome(app: App, run: Run): Outcome {
  const o = outcomeOf(app, run.drain, midOf(run), isCityStreet(app, run));
  // the run's own class wins, so the card matches the color drawn
  return { ...o, cls: CLS[run.k] ?? o.cls };
}

/** A fix list spot, plainly: "Detention pond PN-M8-51, near SR 410 E" -> "Detention pond near SR 410 E", with the map id kept apart. */
export function spotName(label: string): { name: string; id: string } {
  const first = label.split(', ')[0], near = /near (.+)$/.exec(label)?.[1];
  const id = /\b[A-Z]{2}-[A-Z]\d+-\d+\b/.exec(first)?.[0] ?? '';
  // "Culvert PI-J5-2864 where it meets Lake Bonney Outflow" -> "Culvert"
  const what = id ? first.slice(0, first.indexOf(id)).trim() : first;
  return { name: near ? `${what || first} near ${near}` : first, id };
}
