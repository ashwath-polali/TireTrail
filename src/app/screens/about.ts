// About: the pixel scene, one sentence, three rows (the problem, what it does, the data), then the depth folded away.
import { h } from '../dom.ts';
import { glyph, salmonSVG } from '../ui/ui.ts';
import { HABITAT_LINKS } from '../../salmon/index.ts';
import { ABOUT, METHODS, SCIENCE } from './guide-words.ts';
// @ts-ignore: Vite loads the CSS
import './about.css';

export type Fold = 'sources' | 'privacy' | 'credits';

export interface AboutIn {
  /** storm drains loaded, all areas */
  drains: number;
  /** "8 cities and unincorporated King and Pierce counties" */
  coverage: string;
  /** the cities by name, when coverage only counts them */
  cities: string | null;
  /** the biggest cities not added yet */
  missing: string | null;
  credits: string[];
  /** folds to show open */
  open: readonly Fold[];
  back(): void;
  guide(): void;
  fixList(): void;
}

const ico = (name: string) => h('span.ab-ico', { 'aria-hidden': 'true', html: glyph(name, 2) });

function fold(key: Fold, title: string, open: boolean, ...body: (HTMLElement | null)[]): HTMLElement {
  const d = h('details.ab-fold', { 'data-k': key, id: `about-${key}` },
    h('summary', {}, h('span', {}, title), ico('chevron')),
    h('div.ab-fold-body', {}, ...body));
  (d as HTMLDetailsElement).open = open;
  return d;
}

export function aboutView(o: AboutIn): HTMLElement {
  const n = o.drains.toLocaleString('en-US');
  const rows = h('ul.ab-rows', {}, ...ABOUT.rows.map((r) => h('li.ab-row', {},
    h('img.ab-row-art', { src: `art/${r.icon}.png`, alt: '', width: '48', height: '48', draggable: 'false' }),
    h('div', {}, h('h2.ab-row-head', {}, r.head), h('p.ab-row-line', {}, r.line.replace('{drains}', n))))));

  const sources = fold('sources', 'Sources and methods', o.open.includes('sources'),
    h('h3.ab-sub', {}, 'Why coho die'),
    h('ul.ab-facts', {}, ...SCIENCE.map((f) => h('li', {}, h('span', {}, f.fact), h('small', {}, f.source)))),
    h('h3.ab-sub', {}, 'How TireTrail figures it'),
    h('dl.ab-terms', {}, ...METHODS.flatMap((m) => [h('dt', {}, m.term), h('dd', {}, h('span', {}, m.line), h('small', {}, m.source))]),
      h('dt', {}, 'Storm drains'),
      h('dd', {},
        h('span', {}, `${n} drains from city and county pipe maps. Where a map has a gap, TireTrail says so instead of guessing.`),
        h('small', {}, `So far: ${o.coverage}.${o.cities ? ` ${o.cities}.` : ''}${o.missing ? ` Not added yet: ${o.missing}.` : ''}`))),
    h('h3.ab-sub', {}, 'See it for yourself'),
    h('ul.ab-links', {}, ...HABITAT_LINKS.map((l) => h('li', {},
      h('a', { href: l.url, target: '_blank', rel: 'noopener' }, h('span', {}, l.label), ico('arrow')), h('small', {}, l.by)))));

  const privacy = fold('privacy', 'Privacy', o.open.includes('privacy'),
    h('ul.ab-plain', {}, ...ABOUT.privacy.map((t) => h('li', {}, t))),
    h('p.ab-small', {}, 'No ads and no analytics.'),
    // RCW 46.20.075(4): intermediate license holders may not use a phone while driving
    h('p.ab-small', {}, 'Under 18? Washington law bars intermediate license drivers from using a phone while driving. Try the sample drive, or ride with an adult driver.'));

  const credits = fold('credits', 'Credits', o.open.includes('credits'),
    h('ul.ab-credits', {}, ...o.credits.map((c) => h('li', {}, c))),
    // every source's, not only the Bonney Lake bundle's
    h('p.ab-small', {}, 'Independent student project. Not made, reviewed or endorsed by any city, county, tribe, state agency or university whose data or research it uses. Planning-level estimates. Map data is provided as is, without warranty.'),
    h('p.ab-small', {}, 'Fonts: Silkscreen by Jason Kottke and Geist by Vercel (SIL Open Font License).'));

  return h('div.wrap.narrow.ab', {},
    h('button.backlink', { onclick: o.back }, h('span', { 'aria-hidden': 'true' }, '‹'), ' Back'),
    h('div.ab-hero', {}, h('img', { src: 'art/hero.png', alt: 'Rain on a street. A storm drain pipe empties into a creek where a coho swims.', width: '384', height: '216', draggable: 'false' })),
    h('p.ab-mark', {}, h('span', { 'aria-hidden': 'true', html: salmonSVG(2) }), h('span', {}, 'TireTrail')),
    h('h1.ab-title', {}, ABOUT.title),
    rows,
    h('div.ab-folds', {}, sources, privacy, credits),
    h('nav.ab-keys', { 'aria-label': 'More' },
      h('button.ab-key', { type: 'button', onclick: o.guide }, ico('play'), h('span', {}, 'How it works')),
      h('button.ab-key', { type: 'button', onclick: o.fixList }, ico('list'), h('span', {}, 'Fix list for your city'))),
    h('p.ab-foot', {}, '© 2026 Ashwath Polali. Made for the 2026 Congressional App Challenge.'));
}
