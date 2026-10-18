// The trip a drop takes from a street to where it ends up, as a few plain steps, plus the details for staff.
import { decodePath, KINDS } from '../../data/bundle.ts';
import type { App } from '../app.ts';
import { fmt } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';
import { timeline, type Tone } from '../ui/ui.ts';
import { clsIcon, drainOutcome, endLabel, feetText, KIND, why, type Outcome } from './common.ts';

export interface Step {
  icon: string;
  title: string;
  detail: string;
  cls?: Cls;
  /** the kit tone for its dot; the street is yours */
  tone?: Tone;
}

export function journey(app: App, drain: number, street: string | null, lead?: string): Step[] {
  const { data } = app, b = data.bundle;
  const path = data.path(drain);
  const o = drainOutcome(app, drain);
  const steps: Step[] = [];
  if (street) steps.push({ icon: ICON.drop(), title: street, detail: lead ?? 'Rain lands here and picks up tire dust.', tone: 'you' });
  const id = b.assets.key[b.drains.asset[drain]] ?? '';
  if (o.ditch) steps.push({ icon: ICON.ditch(), title: 'Roadside ditch', detail: 'Rain runs off the road into it.' });
  else if (o.code.startsWith('bridge-')) steps.push({ icon: ICON.grate(), title: 'Bridge drain', detail: 'It has no pipe on the map, so rain most likely drops straight through.' });
  else steps.push({ icon: ICON.grate(), title: 'Storm drain', detail: o.city && /^CB/i.test(id) ? 'A catch basin at the curb.' : '' });
  // a roadside ditch the rain runs into counts as ditch on the way
  let pipes = 0, ditches = o.ditch ? 1 : 0, fac: Step | null = null;
  const ids = decodePath(b, drain), last = ids[ids.length - 1];
  for (const a of ids.slice(1)) {
    const kind = KINDS[b.assets.kind[a]];
    if (kind === 'pipe') pipes++;
    else if (kind === 'channel') ditches++;
    // only the first pond or tank on the way gets its own step; one the water ends in is told by the last step
    else if (fac || (a === last && !/^pond-to-/.test(o.code))) continue;
    else if (kind === 'pond') fac = { icon: ICON.pond(), title: 'Pond', detail: 'Holds the water for a while.' };
    else if (kind === 'vault') fac = { icon: ICON.vault(), title: 'Underground tank', detail: 'Holds the water for a while.' };
  }
  if (path.lengthM >= 2) {
    const what = pipes && ditches ? 'pipes and ditches' : ditches ? 'roadside ditches' : 'underground pipes';
    steps.push({ icon: ditches > pipes ? ICON.ditch() : ICON.pipe(), title: `${fmt.ft(path.lengthM)} of ${what}`, detail: ditches > pipes ? 'Along the road, downhill.' : 'Under the street, downhill.' });
  }
  if (fac) steps.push(fac);
  steps.push({ icon: clsIcon(o.cls), title: endTitle(o), detail: endWhy(o), cls: o.cls });
  return steps;
}

/** Where it ends, as a step title. */
export const endTitle = endLabel;

/** Why it ends there, or what that means, in a sentence: how it soaks in, or what the data says about coho. */
function endWhy(o: Outcome): string {
  if (o.cls === 'none') return '';
  const w = why(o);
  return o.cls === 'ground' ? w.body : w.title;
}

/** The technical details, for the notes. */
export function staff(app: App, drain: number): [string, string][] {
  const { data } = app, b = data.bundle, d = data.drain(drain);
  let pieces = 0;
  const fac: string[] = [];
  for (const a of decodePath(b, drain).slice(1)) {
    const kind = KINDS[b.assets.kind[a]];
    if (kind === 'pipe' || kind === 'channel') pieces++;
    else if (kind === 'pond' || kind === 'vault') fac.push(b.assets.key[a]);
  }
  return [
    ['Inlet ID', d.id],
    ['Pipe and ditch pieces', String(pieces)],
    ['Ponds and tanks', fac.length ? fac.join(', ') : 'None'],
    ['Ending code', d.code],
    ['Receiving water', d.receiving || 'None recorded'],
    ['Why it ends here', feetText(d.reason) || 'No note'],
    ['How sure', d.confidence],
    ['Data source', source(app, drain)],
  ];
}

function source(app: App, drain: number): string {
  const R = app.region, at = app.world.drains[drain];
  if (!R) return 'City of Bonney Lake storm data (unofficial screening data)';
  if (R.ownerAt(at) === 'city') {
    const pl = R.placeAt(at)?.name ?? 'Bonney Lake';
    return pl === 'Bonney Lake' ? 'City of Bonney Lake storm data (unofficial screening data)' : `City of ${pl} storm data`;
  }
  const c = R.countyAt(at);
  return `${c ? `${c.name} County` : 'County'} GIS drainage layers`;
}

/** The trip as the kit's timeline, each dot a pixel icon; the last step is the answer, in its color. */
export function journeyEl(steps: Step[]): HTMLElement {
  const el = timeline(steps.map((s) => ({ tone: s.cls ? KIND[s.cls].tone : s.tone ?? 'plain', title: s.title, sub: s.detail || undefined })));
  el.classList.add('mu-tl');
  el.querySelectorAll<HTMLElement>('.u-tl-node').forEach((n, i) => { n.innerHTML = steps[i]?.icon ?? ''; });
  return el;
}
