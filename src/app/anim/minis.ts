// The live screens' strip of running water with a coho crossing it, as CSS sprites.
import './anim.css';
import { stripURL } from './px.ts';
import { CODE, SPRITES } from './sprites.ts';

let vars = false;

/** The water and coho strips as CSS images (--an-water, --an-coho), made once. */
export function spriteVars(): void {
  if (vars || typeof document === 'undefined') return;
  vars = true;
  const s = document.documentElement.style;
  s.setProperty('--an-water', `url(${stripURL(SPRITES.water)})`);
  s.setProperty('--an-coho', `url(${stripURL(CODE.coho)})`);
}

/** A strip of water a coho swims across (class an-go runs it), as markup. Transform steps only. For the live screens. */
export function waterHTML(go = true): string {
  spriteVars();
  return `<i class="an-ws${go ? ' an-go' : ''}" aria-hidden="true"><i class="an-ws-water"></i><i class="an-ws-lane"><i class="an-ws-fish"></i></i></i>`;
}
