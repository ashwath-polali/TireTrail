// A creek's page, over the map of your crossings: its fish, how often and how gently you crossed it, and the official maps.
import type { Creek } from '../../drive/creeks.ts';
import type { LngLat } from '../../geo/geo.ts';
import { salmonData, toRegion } from '../../salmon/index.ts';
import { streamAt } from '../../salmon/hit.ts';
import { HABITAT_LINKS } from '../../salmon/links.ts';
import { routeTiles } from '../../salmon/row.ts';
import { speciesIn } from '../../salmon/species.ts';
import type { Stream } from '../../salmon/tiles.ts';
import { h } from '../dom.ts';
import { glyph } from '../ui/ui.ts';
import { portrait } from './history-scene.ts';
import { creekName, creekTimes, HABITAT, roadsLine, SPECIES_SOURCE } from './history-words.ts';

/** a creek's stream from the state's salmon map, looked up once */
const streams = new Map<string, Promise<Stream | null>>();
export function streamOf(ll: LngLat): Promise<Stream | null> {
  const k = ll.join();
  let p = streams.get(k);
  if (!p) {
    const at = toRegion(ll);
    p = salmonData.some(routeTiles([at])).then((tiles) => streamAt(tiles, at, 120), () => null);
    streams.set(k, p);
  }
  return p;
}

/** The last crossings as small squares: green gentle, amber with a hard brake near. Oldest first. */
export function crossMarks(marks: readonly { gentle: boolean }[], most = 8, cls = 'my-marks-row'): HTMLElement {
  const shown = marks.slice(-most);
  return h(`span.${cls}`, { 'aria-hidden': 'true' }, ...shown.map((m) => h(`i.my-m${m.gentle ? '' : '.my-m-hard'}`, { html: m.gentle ? glyph('check', 1) : '' })));
}

/** "Coho, chinook and steelhead" */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The creek's sheet. sp: species bits, from your crossings or the state's map. */
export function creekSheet(c: Creek, stream: Stream | null, head: HTMLElement): HTMLElement {
  const sp = c.sp || stream?.sp || 0, fish = speciesIn(sp);
  const roads = stream ? roadsLine(stream.crossings) : null;
  const links = HABITAT_LINKS.filter((l) => l.label !== '6PPDQ map');
  return h('div.my-sheet.my-creek', {},
    head,
    fish.length ? h('ul.my-species', { 'aria-label': `Fish here: ${andList(fish.map((f) => f.word))}` }, ...fish.map((f) =>
      h('li', {}, portrait(f.bit, 'my-fish my-fish-big'), h('span', {}, cap(f.word))))) : null,
    h('div.my-times', {}, crossMarks(c.marks, 12), h('p', {}, creekTimes(c))),
    h('p.my-p', {}, HABITAT),
    h('ul.my-links', {}, ...links.map((l) => h('li', {}, h('a.my-link', { href: l.url, target: '_blank', rel: 'noopener' },
      h('span', {}, h('b', {}, l.label), h('small', {}, l.by)), h('span.u-ico', { 'aria-hidden': 'true', html: glyph('arrow', 2) }))))),
    h('p.my-src', {}, roads ? `${roads} ` : '', fish.length ? SPECIES_SOURCE : `${creekName(c.name)} is on WDFW's salmon stream map.`));
}
