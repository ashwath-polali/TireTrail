// Per-stop words and general tips.
import type { StreetClass } from '../trace/streets.ts';

/** A stop's answer: a street class, or a combined sewer that takes it to a treatment plant. */
export type StopClass = StreetClass | 'treatment';
const KNOWN = new Set<string>(['creek', 'ground', 'elsewhere', 'unknown', 'none', 'treatment']);
/** A class name this code doesn't know reads as unknown. */
export const stopClass = (c: string | null | undefined): StopClass => (c && KNOWN.has(c) ? (c as StopClass) : 'unknown');
/** Classes with a real answer to show. */
export const answered = (c: StopClass): boolean => c === 'creek' || c === 'ground' || c === 'elsewhere' || c === 'treatment';

export interface Tip {
  id: 'brake-earlier' | 'slow-into-turns' | 'tire-pressure';
  title: string;
  text: string;
}

export const GENERAL_TIPS: readonly Tip[] = [
  { id: 'brake-earlier', title: 'Brake earlier', text: 'Start slowing sooner so you can stop gently. Brake as hard as you need to; just begin earlier.' },
  { id: 'slow-into-turns', title: 'Slow into turns', text: 'Take corners at a gentler speed. Cornering wears tread too.' },
  { id: 'tire-pressure', title: 'Check tire pressure monthly', text: 'Under-inflated tires wear out faster, which also costs money.' },
];

export const NO_DATA = "TireTrail doesn't have pipe maps where you stopped yet.";
export const TREATMENT = 'In big storms, some of it can overflow untreated into nearby water.';

// Bonney Lake waters that drain on to Fennel Creek
const FENNEL_SYSTEM = /lake bonney outflow|bonney lake outflow|debra jane|^bonney lake$/i;

export interface SalmonWater {
  kind: 'fennel' | 'feeds' | 'system' | 'unnamed' | 'named';
  /** where the water goes, as it reads in a sentence */
  name: string;
  /** the water where coho salmon live */
  coho: string;
}

/** A salmon stream ending, named plainly. */
export function salmonWater(receiving: string): SalmonWater {
  const r = receiving.trim();
  if (!r || /^fennel creek$/i.test(r)) return { kind: 'fennel', name: 'Fennel Creek', coho: 'Fennel Creek' };
  if (/^fennel creek tributary/i.test(r)) return { kind: 'feeds', name: 'a stream that feeds Fennel Creek', coho: 'Fennel Creek' };
  if (FENNEL_SYSTEM.test(r)) return { kind: 'system', name: r, coho: 'Fennel Creek' };
  if (/unnamed/i.test(r)) return { kind: 'unnamed', name: 'a small salmon stream with no name on the map', coho: 'a small salmon stream' };
  return { kind: 'named', name: r, coho: r };
}

/** Other water, named plainly. */
export function plainWater(receiving: string): string {
  const r = receiving.trim();
  if (!r) return 'other water';
  if (/^(an )?unnamed (stream|creek)$/i.test(r)) return 'a small stream with no name on the map';
  if (/^(an )?unnamed lake or pond$/i.test(r)) return 'a small lake or pond with no name on the map';
  return r;
}

/** Where one stop's dust ends up, as a headline. mapped: TireTrail has pipe maps there. */
export function stopAnswer(cls: StopClass, receiving = '', mapped = true): string {
  switch (cls) {
    case 'creek': {
      const w = salmonWater(receiving);
      return w.kind === 'system' ? `Its tire dust reaches ${w.name}, which drains to Fennel Creek.` : `Its tire dust ends up in ${w.name}.`;
    }
    case 'ground': return 'Its tire dust soaks into the ground.';
    case 'elsewhere': return `Its tire dust drains to ${plainWater(receiving)}.`;
    case 'treatment': return 'Its tire dust goes to a sewage treatment plant.';
    case 'unknown': return 'The pipe map loses track of its tire dust.';
    default: return mapped ? 'No storm drain is mapped near this stop.' : NO_DATA;
  }
}

/** One stop's line for its details page. Only salmon stream stops say the rubber reaches coho water. */
export function stopTip(cls: StopClass, hard: boolean, receiving: string, code = '', mapped = true): string {
  const brake = hard ? ' Brake earlier here.' : '';
  switch (cls) {
    case 'creek': {
      const w = salmonWater(receiving);
      if (code === 'downstream-creek' && w.kind !== 'unnamed') return `This stop's rubber reaches a smaller stream first, which runs into ${w.coho}, where coho salmon live.${brake}`;
      switch (w.kind) {
        case 'feeds': return `This stop's rubber goes down a small stream into Fennel Creek, where coho salmon live.${brake}`;
        case 'system': return `This stop's rubber reaches ${w.name}, which drains to Fennel Creek, where coho salmon live.${brake}`;
        case 'unnamed': return `This stop's rubber goes to a small stream where coho salmon live.${brake}`;
        default: return `This stop's rubber goes to ${w.name}, where coho salmon live.${brake}`;
      }
    }
    case 'ground':
      return `This one soaks into the ground.${brake}`;
    case 'elsewhere':
      return `This one drains to ${plainWater(receiving)}.${brake}`;
    case 'treatment':
      return `This one goes to a sewage treatment plant. ${TREATMENT}${brake}`;
    case 'unknown':
      return `The pipe map doesn't show where this one goes.${brake}`;
    case 'none':
      return mapped ? `There's no mapped storm drain near this stop.${brake}` : `${NO_DATA}${brake}`;
  }
}

/** The results headline. n: full stops, hard: how many were hard. */
export function driveHeadline(n: number, hard: number): string {
  const smooth = n - hard;
  if (n === 0) return 'A smooth drive.';
  if (n === 1) return hard ? 'Your only stop was a hard one.' : 'Your only stop was smooth.';
  if (smooth === n) return n === 2 ? 'Both of your stops were smooth.' : `All ${n} of your stops were smooth.`;
  if (smooth === 0) return n === 2 ? 'Neither of your stops was smooth.' : `None of your ${n} stops were smooth.`;
  return `${smooth} of your ${n} stops were smooth.`;
}

/** Short summary, for saved drives and the details page. */
export function smoothLine(n: number, hard: number): string {
  if (n === 0) return 'no full stops';
  if (n === 1) return hard ? '1 hard stop' : '1 smooth stop';
  return `${n - hard} of ${n} stops smooth`;
}

export interface StopWords { cls: StopClass; mapped: boolean; receiving: string }

/** One line on where the hardest stops' tire dust goes. n: all full stops; top: the hardest, as shown. */
export function driveSummary(n: number, top: readonly StopWords[]): string {
  if (n === 0 || !top.length) return 'There were no full stops on this drive.';
  const one = n === 1;
  const them = one ? 'your stop' : top.length === n ? 'your stops' : 'your hardest stops';
  const creek = top.filter((s) => s.cls === 'creek');
  if (creek.length) {
    const ws = creek.map((s) => salmonWater(s.receiving));
    const same = ws.every((w) => w.coho === ws[0].coho);
    const into = !same ? 'into streams where coho salmon live'
      : ws[0].kind === 'unnamed' ? 'into a small stream where coho salmon live'
        : `${ws.every((w) => w.kind === 'fennel' || w.kind === 'named') ? 'into' : 'toward'} ${ws[0].coho}, where coho salmon live`;
    if (one) return `Your stop sends its tire dust ${into}.`;
    if (creek.length === 1) return `One of ${them} sends its tire dust ${into}.`;
    const all = creek.length === n ? (n === 2 ? 'Both' : `All ${n}`) : String(creek.length);
    return `${all} of ${them} send their tire dust ${into}.`;
  }
  const ok = top.filter((s) => answered(s.cls)).length;
  if (ok === top.length) return one ? "Your stop doesn't drain to a salmon stream." : `None of ${them} drain to a salmon stream.`;
  if (ok) return ok === 1 ? "The one stop TireTrail could follow doesn't drain to a salmon stream." : `None of the ${ok} stops TireTrail could follow drain to a salmon stream.`;
  // no answers: say why
  if (top.some((s) => s.cls === 'unknown')) return one ? 'The pipe map loses track of where your stop drains.' : `The pipe maps lose track of where ${them} drain.`;
  if (top.some((s) => s.mapped)) return one ? 'No storm drain is mapped near your stop.' : `No storm drains are mapped near ${them}.`;
  return NO_DATA;
}

/**
 * The card at the end of a stop's See it happen. far: how far TireTrail followed the water, already in feet or miles.
 * local: the drain is in Bonney Lake's own map, where other water means "not the Fennel Creek system".
 */
export function storyEnd(n: number, cls: StopClass, receiving: string, code: string, far: string, short: boolean, local: boolean): { title: string; line: string } {
  const stop = `stop ${n}`;
  switch (cls) {
    case 'creek': {
      const w = salmonWater(receiving);
      const where = w.kind === 'unnamed' ? 'this small salmon stream' : w.coho;
      return { title: `This is where tire dust from ${stop} ends up.`, line: `In ${where}, a chemical from tire dust can kill coho salmon within hours of a storm. Braking gently leaves less dust behind.` };
    }
    case 'ground':
      return { title: `Rain from ${stop} soaks into the ground.`, line: 'The soil filters it instead of the water running to a creek.' };
    case 'elsewhere': {
      const line = local ? "It doesn't flow on to Fennel Creek, the salmon stream TireTrail follows here."
        : /^fennel creek$/i.test(receiving.trim()) ? "The county's fish map doesn't list this part of the creek as coho habitat."
          : "The state's fish maps don't list it as coho salmon habitat.";
      return { title: `Rain from ${stop} ends up in ${plainWater(receiving)}.`, line };
    }
    case 'treatment':
      return { title: `Rain from ${stop} goes to a sewage treatment plant.`, line: TREATMENT };
    default:
      return short || code === 'not-connected'
        ? { title: `The storm drain at ${stop} isn't connected to any pipe on the map.`, line: "TireTrail can't follow it any farther." }
        : { title: `TireTrail followed rain from ${stop} for ${far}.`, line: 'Then the pipe map has a gap, so it stops instead of guessing.' };
  }
}
