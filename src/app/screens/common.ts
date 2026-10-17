// Words and colors shared by the tabs.
import { esc, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';

export const KIND: Record<Cls, { color: string; chip: string }> = {
  creek: { color: '#ee7a63', chip: 'TO THE CREEK' },
  ground: { color: '#8fd69a', chip: 'SOAKS IN' },
  elsewhere: { color: '#8fa6ba', chip: 'OTHER WATER' },
  unknown: { color: '#9aa39d', chip: 'MAP STOPS' },
  none: { color: '#9aa39d', chip: 'NO DRAIN' },
};

export const chip = (c: Cls) => h('span.chip', { style: `--k:${KIND[c].color}` }, KIND[c].chip);

export function legend(): HTMLElement {
  const k = (c: string, t: string) => `<span style="--k:${c}">${t}</span>`;
  return h('div.key', { html: k('#ee7a63', 'To the creek') + k('#8fd69a', 'Soaks in') + k('#7f93a6', 'Other water') + k('#5f6862', 'Not traced') });
}

// Bonney Lake waters that feed Fennel Creek
const FENNEL = /fennel|lake bonney outflow|debra jane|^bonney lake$/i;

/** The salmon stream a drain reaches, named plainly. */
export function creekName(receiving: string): string {
  if (!receiving || /^fennel creek tributary/i.test(receiving)) return 'Fennel Creek';
  if (/unnamed/i.test(receiving)) return 'a small salmon stream';
  return receiving;
}

/** Where the water ends up, as a title and a caption line. */
export function destination(cls: Cls, receiving: string): { title: string; say: string; icon: string } {
  const r = esc(receiving);
  switch (cls) {
    case 'creek': {
      const name = creekName(receiving);
      if (name === 'Fennel Creek') return { title: 'Fennel Creek', say: /tributary/i.test(receiving) ? 'It reaches a stream that feeds <b>Fennel Creek</b>, where coho salmon spawn.' : 'It reaches <b>Fennel Creek</b>, where coho salmon spawn.', icon: ICON.fish() };
      if (FENNEL.test(receiving)) return { title: receiving, say: `It reaches <b>${r}</b>, which drains to Fennel Creek.`, icon: ICON.fish() };
      return { title: name === 'a small salmon stream' ? 'A salmon stream' : name, say: `It reaches <b>${esc(name)}</b>, where coho salmon live.`, icon: ICON.fish() };
    }
    case 'ground':
      return { title: 'Into the ground', say: 'It <b>soaks into the ground</b>.', icon: ICON.pond() };
    case 'elsewhere':
      return { title: receiving || 'Other water', say: `It drains to <b>${r || 'other water'}</b>.`, icon: ICON.drop() };
    default:
      return { title: 'The map stops here', say: 'The pipe map <b>stops here</b>.', icon: ICON.x() };
  }
}

/** One plain sentence on why the ending matters. */
export function why(cls: Cls, receiving: string): string {
  switch (cls) {
    case 'creek':
      return 'Tire dust carries <b>6PPD-quinone</b>, a tire chemical that can kill coho salmon within hours of a storm.';
    case 'ground':
      return 'The water soaks into the soil here instead of running to a creek.';
    case 'elsewhere':
      return `This water drains to ${esc(receiving || 'other water')}.`;
    default:
      return "The pipe map has a gap here, so TireTrail won't guess where the water goes.";
  }
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
