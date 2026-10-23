// A creek's page, over the map of your crossings: what lives there and how you crossed it, and the official maps.
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

/** "coho, chinook and steelhead" */
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Coho stream", "Coho and chinook stream", else "Salmon stream" */
export function streamKind(sp: number): string {
  const fish = speciesIn(sp).map((f) => f.word);
  return fish.length ? `${cap(andList(fish))} stream` : 'Salmon stream';
}

/** The creek's sheet: what lives there and how you crossed it in one line, your crossings, the official maps, and the source folded away. */
export function creekSheet(c: Creek, stream: Stream | null, head: HTMLElement): HTMLElement {
  const sp = c.sp || stream?.sp || 0;
  const roads = stream ? roadsLine(stream.crossings) : null;
  // plain words here; the chemical's name stays in More
  const links = HABITAT_LINKS.filter((l) => l.label !== '6PPDQ map').map((l) => (l.label === 'WA Ecology' ? { ...l, by: 'How tire chemicals harm salmon' } : { ...l, by: 'See this creek on the state map' }));
  return h('div.my-sheet.my-creek', {},
    head,
    h('p.my-creek-sub', {}, `${streamKind(sp)}. ${creekTimes(c)}`),
    crossMarks(c.marks, 12),
    h('ul.my-links', {}, ...links.map((l) => h('li', {}, h('a.my-link', { href: l.url, target: '_blank', rel: 'noopener' },
      h('span', {}, h('b', {}, l.label), h('small', {}, l.by)), h('span.u-ico', { 'aria-hidden': 'true', html: glyph('arrow', 2) }))))),
    h('details.my-src-fold', {}, h('summary', {}, 'Source'),
      h('p.my-src', {}, roads ? `${roads} ` : '', sp ? SPECIES_SOURCE : `${creekName(c.name)} is on WDFW's salmon stream map.`, ` ${HABITAT}`)));
}
