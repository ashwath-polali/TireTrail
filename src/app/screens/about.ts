// About: the same pitch as home, then how it works on one picture (tap the car, the drain or the creek),
// then the depth folded away: sources and methods, privacy and credits.
import { h } from '../dom.ts';
import { calm, glyph } from '../ui/ui.ts';
import { HABITAT_LINKS } from '../../salmon/index.ts';
import { ABOUT, METHODS, SCIENCE, SEASON_FACTS } from './guide-words.ts';
import { HOME_LINE, HOME_TITLE } from './home-words.ts';
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
  disclaimer: string;
  /** folds to show open */
  open: readonly Fold[];
  back(): void;
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

/** A fact and its source, linked when it can be. */
const fact = (f: { fact: string; source: string; href?: string }) => h('li', {}, h('span', {}, f.fact),
  f.href ? h('a.ab-src', { href: f.href, target: '_blank', rel: 'noopener' }, f.source) : h('small', {}, f.source));

/** The rain scene with a spot to tap on the car, the drain and the creek; the picked spot's line under it. */
function howItWorks(): HTMLElement {
  const line = h('p.ab-how-line', { 'aria-live': 'polite' });
  const keys: HTMLElement[] = [];
  const pick = (i: number) => {
    const s = ABOUT.spots[i];
    keys.forEach((k, j) => k.setAttribute('aria-pressed', String(j === i)));
    line.replaceChildren(h('span.ab-how-ico', { 'aria-hidden': 'true', html: glyph(s.icon, 2) }), h('span', {}, s.line));
  };
  ABOUT.spots.forEach((s, i) => keys.push(h('button.ab-spot', {
    type: 'button', 'aria-pressed': 'false', 'aria-label': s.label, style: `left:${(s.x * 100).toFixed(1)}%;top:${(s.y * 100).toFixed(1)}%`, onclick: () => pick(i),
  }, h('span.ab-spot-in', { 'aria-hidden': 'true', html: glyph(s.icon, 2) }))));
  pick(0);
  return h('figure.ab-how' + (calm() ? '' : '.ab-live'), {},
    h('div.ab-hero', {},
      h('img', { src: 'art/hero.png', alt: 'Rain on a street. A car, a storm drain, and a pipe that empties into a creek where a coho swims.', width: '384', height: '216', draggable: 'false' }),
      ...keys),
    h('figcaption.ab-how-cap', {}, h('span.ab-how-hint', {}, 'Tap the car, the drain or the creek.'), line));
}

export function aboutView(o: AboutIn): HTMLElement {
  const n = o.drains.toLocaleString('en-US');

  const sources = fold('sources', 'Sources and methods', o.open.includes('sources'),
    h('h3.ab-sub', { id: 'about-rain' }, 'Why rain matters'),
    h('ul.ab-facts', {}, ...SCIENCE.map(fact)),
    h('h3.ab-sub', { id: 'about-coho' }, 'When coho return'),
    h('ul.ab-facts', {}, ...SEASON_FACTS.map(fact)),
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
    h('p.ab-small', {}, 'No ads and no analytics.'));

  const credits = fold('credits', 'Credits', o.open.includes('credits'),
    h('ul.ab-credits', {}, ...o.credits.map((c) => h('li', {}, c))),
    h('p.ab-small', {}, `${o.disclaimer} Map data is provided as is, without warranty.`),
    h('p.ab-small', {}, 'Fonts: Silkscreen by Jason Kottke and Geist by Vercel (SIL Open Font License).'));

  return h('div.wrap.narrow.ab', {},
    h('button.backlink', { onclick: o.back }, h('span', { 'aria-hidden': 'true' }, '‹'), ' Back'),
    h('h1.ab-title', {}, h('span', {}, HOME_TITLE[0]), ' ', h('span', {}, HOME_TITLE[1])),
    h('p.ab-lead', {}, HOME_LINE),
    howItWorks(),
    h('div.ab-folds', {}, sources, privacy, credits),
    h('nav.ab-keys', { 'aria-label': 'More' },
      h('button.ab-key', { type: 'button', onclick: o.fixList }, ico('list'), h('span', {}, 'Fix list for your city'))),
    h('p.ab-foot', {}, '© 2026 Ashwath Polali. Made for the 2026 Congressional App Challenge.'));
}
