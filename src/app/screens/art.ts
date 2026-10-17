// Pixel art images, with a quiet fallback if one hasn't been made yet.
import { h } from '../dom.ts';

export function art(name: string, cls = 'art'): HTMLElement {
  const img = h('img.' + cls, { src: `art/${name}.png`, alt: '', draggable: 'false' }) as HTMLImageElement;
  img.addEventListener('error', () => img.classList.add('missing'));
  return img;
}
