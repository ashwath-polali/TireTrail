// Small pixel pictures for the reveal: a tire that rolls and puffs dust, a gas pump that coins drop into.
import { h } from '../dom.ts';
import { drawPx, easeOut, frameAt, onFrame, sizePx, stripURL } from './px.ts';
import { CODE, SPRITES } from './sprites.ts';

export interface Mini {
  el: HTMLElement;
  /** draws it t ms into the reveal */
  draw(t: number): void;
}

/** A canvas 1 CSS px a pixel (crisp at any screen density, as the art is drawn in whole CSS px). */
function canvas(cls: string, w: number, h_: number): HTMLCanvasElement {
  const cv = h(`canvas.${cls}`, { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  [cv.width, cv.height] = [w, h_];
  cv.style.width = `${w}px`;
  cv.style.height = `${h_}px`;
  return cv;
}

/** A tire rolling from roll[0] to roll[1] ms, leaving puffs of dust behind it, then still with a little dust. k: CSS px per code pixel. */
export function tireMini(roll: [number, number], k = 3): Mini {
  const S = SPRITES, [tw, th] = sizePx(S.tire, k), [pw, ph] = sizePx(S.puff, k);
  const W = tw + Math.round(pw * 0.6), H = Math.max(th, ph), cv = canvas('an-tire', W, H);
  const tx = W - tw / 2, ty = H - th / 2, road = H - 2;
  return {
    el: cv,
    draw(t) {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const tf = onFrame(t);
      ctx.clearRect(0, 0, W, H);
      const rolling = tf >= roll[0] && tf < roll[1];
      // the puffs: one every 240 ms while it rolls, each drifting back
      for (let s = roll[0]; s < Math.min(tf, roll[1]); s += 240) {
        const i = Math.floor((tf - s) / (1000 / S.puff.fps));
        if (i < S.puff.n) drawPx(ctx, S.puff, i, tx - tw / 2 - Math.round((tf - s) / 40), H - ph / 2, k);
      }
      // what's left on the road
      if (tf >= roll[0]) {
        ctx.fillStyle = '#8a7f6a';
        const n = Math.round(7 * easeOut((tf - roll[0]) / (roll[1] - roll[0])));
        for (let j = 0; j < n; j++) ctx.fillRect(2 + j * 5, road - (j % 2) * 2, 2, 2);
      }
      drawPx(ctx, S.tire, rolling ? frameAt(S.tire, tf) : 0, tx, ty, k);
    },
  };
}

/** A gas pump; a coin spins down into it at each of `coins` (ms), and its window lights. k: CSS px per code pixel. */
export function pumpMini(coins: readonly number[], k = 3): Mini {
  const S = SPRITES, [pw, ph] = sizePx(S.pump, k), [, ch] = sizePx(S.coin, k);
  const W = pw, H = ph + ch + 8, top = H - ph, cv = canvas('an-pump', W, H);
  return {
    el: cv,
    draw(t) {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const tf = onFrame(t);
      ctx.clearRect(0, 0, W, H);
      drawPx(ctx, S.pump, 0, W / 2, top + ph / 2, k);
      // the window lights up as the coins go in (a sheet's window is at 18,23, 14 by 10)
      if (coins.length && tf >= coins[0]) {
        const lit = Math.min(1, (tf - coins[0]) / 500);
        ctx.fillStyle = '#ffd166';
        if (S.pump.hi) {
          ctx.fillRect(20, top + 26, Math.max(2, Math.round(10 * lit)), 2);
          ctx.fillRect(20, top + 30, Math.max(2, Math.round(6 * lit)), 2);
        } else ctx.fillRect(2 * k, top + 3 * k, Math.max(k, Math.round(8 * k * lit)), k);
      }
      for (const c of coins) {
        const dt = tf - c;
        if (dt < 0 || dt > 420) continue;
        const y = -ch / 2 + (top + 6) * easeOut(dt / 420) ** 2;
        if (y < top + 2) drawPx(ctx, S.coin, frameAt(S.coin, dt), W / 2 - 4, y, k);
      }
    },
  };
}
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
