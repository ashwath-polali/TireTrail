// The trip a drop takes from a street to where it ends up, as a few plain steps.
import { decodePath, KINDS } from '../../data/bundle.ts';
import type { App } from '../app.ts';
import { fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';
import { destination, KIND } from './common.ts';

export interface Step {
  icon: string;
  title: string;
  detail: string;
  cls?: Cls;
}

export function journey(app: App, drain: number, street: string | null, lead?: string): Step[] {
  const { data } = app, b = data.bundle;
  const d = data.drain(drain);
  const path = data.path(drain);
  const ids = decodePath(b, drain);
  const steps: Step[] = [];
  if (street) steps.push({ icon: ICON.drop(), title: street, detail: lead ?? 'Rain lands here and picks up tire dust from the road.' });
  steps.push({ icon: ICON.grate(), title: 'Into a storm drain', detail: `Catch basin ${d.id}, at the curb.` });
  let pipes = 0, ditches = 0, mid = '';
  const extras: Step[] = [];
  for (const a of ids.slice(1)) {
    const kind = KINDS[b.assets.kind[a]];
    if (kind === 'pipe') pipes++;
    else if (kind === 'channel') ditches++;
    else if (kind === 'pond' || kind === 'vault') {
      // only the first pond or vault on the way gets its own step
      if (!mid) mid = b.assets.key[a];
      if (extras.length < 2) extras.push(kind === 'pond'
        ? { icon: ICON.pond(), title: 'Through a pond', detail: `Pond ${b.assets.key[a]} holds the water for a while.` }
        : { icon: ICON.vault(), title: 'Through an underground vault', detail: `Vault ${b.assets.key[a]}.` });
    }
  }
  const what = pipes && ditches ? 'pipes and ditches' : ditches ? 'roadside ditches' : 'underground pipes';
  steps.push({ icon: ditches > pipes ? ICON.ditch() : ICON.pipe(), title: `${fmt.ft(path.lengthM)} of ${what}`, detail: `${pipes + ditches} ${pipes + ditches === 1 ? 'piece' : 'pieces'}, mapped by the city.` });
  steps.push(...extras);
  const dest = destination(d.cls, d.receiving);
  steps.push({ icon: dest.icon, title: dest.title, detail: d.reason, cls: d.cls });
  return steps;
}

export function journeyEl(steps: Step[]): HTMLElement {
  return h('ol.journey', {}, ...steps.map((s, i) =>
    h('li' + (i === steps.length - 1 ? '.end' : ''), { style: s.cls ? `--k:${KIND[s.cls].color}` : undefined },
      h('span.ji', { html: s.icon }),
      h('span.jt', {}, h('b', {}, s.title), h('span', {}, s.detail)))));
}
