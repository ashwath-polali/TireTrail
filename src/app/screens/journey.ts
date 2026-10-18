// The trip a drop takes from a street to where it ends up, as a few plain steps, plus the details for staff.
import { decodePath, KINDS } from '../../data/bundle.ts';
import type { App } from '../app.ts';
import { fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';
import { cap, clsIcon, creekName, drainOutcome, feetText, fennelSystem, KIND, line, plainWater, type Outcome } from './common.ts';

export interface Step {
  icon: string;
  title: string;
  detail: string;
  cls?: Cls;
}

export function journey(app: App, drain: number, street: string | null, lead?: string): Step[] {
  const { data } = app, b = data.bundle;
  const path = data.path(drain);
  const o = drainOutcome(app, drain);
  const steps: Step[] = [];
  if (street) steps.push({ icon: ICON.drop(), title: street, detail: lead ?? 'Rain lands here and picks up tire dust.' });
  steps.push({ icon: ICON.grate(), title: 'Storm drain', detail: 'At the curb.' });
  let pipes = 0, ditches = 0, fac: Step | null = null;
  const ids = decodePath(b, drain), last = ids[ids.length - 1];
  for (const a of ids.slice(1)) {
    const kind = KINDS[b.assets.kind[a]];
    if (kind === 'pipe') pipes++;
    else if (kind === 'channel') ditches++;
    // only the first pond or tank on the way gets its own step; one the water ends in is told by the last step
    else if (fac || (a === last && !/^pond-to-/.test(o.code))) continue;
    else if (kind === 'pond') fac = { icon: ICON.pond(), title: 'Pond', detail: 'Holds the water for a while.' };
    else if (kind === 'vault') fac = { icon: ICON.vault(), title: 'Underground tank', detail: '' };
  }
  if (path.lengthM >= 2) {
    const what = pipes && ditches ? 'pipes and ditches' : ditches ? 'roadside ditches' : 'underground pipes';
    steps.push({ icon: ditches > pipes ? ICON.ditch() : ICON.pipe(), title: `${fmt.ft(path.lengthM)} of ${what}`, detail: '' });
  }
  if (fac) steps.push(fac);
  steps.push({ icon: clsIcon(o.cls), title: endTitle(o), detail: endWhy(o), cls: o.cls });
  return steps;
}

/** Where it ends, as a step title. */
export function endTitle(o: Outcome): string {
  const r = o.receiving.trim();
  switch (o.cls) {
    case 'creek': return fennelSystem(r) ? r : cap(creekName(r));
    case 'ground': return 'Soaks into the ground';
    case 'elsewhere': return cap(plainWater(r) || 'other water');
    case 'treatment': return 'A sewage treatment plant';
    case 'none': return 'No storm drain';
    default: return 'The pipe map stops here';
  }
}

/** Why it ends there, in plain words. */
function endWhy(o: Outcome): string {
  if (o.cls !== 'creek') return o.cls === 'none' ? '' : line(o);
  if (o.code === 'downstream-creek') return line(o);
  return fennelSystem(o.receiving) ? 'It drains on to Fennel Creek, where coho salmon live.' : 'Coho salmon live there.';
}

/** The technical details, for the "For city staff" toggle. */
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

export function journeyEl(steps: Step[]): HTMLElement {
  return h('ol.journey', {}, ...steps.map((s, i) =>
    h('li' + (i === steps.length - 1 ? '.end' : ''), { style: s.cls ? `--k:${KIND[s.cls].color}` : undefined },
      h('span.ji', { html: s.icon }),
      h('span.jt', {}, h('b', {}, s.title), s.detail ? h('span', {}, s.detail) : null))));
}
