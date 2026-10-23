// The guide's two drawn stills: the live road before a salmon creek, and the sample drive's map after it.
// Drawn at art pixels and scaled up crisp. Only the water and the coho's tail move; reduced motion holds still.
import { h } from '../dom.ts';
import { ROUTE as ROUTE_C, SALMON, SALMON_WATER } from '../map/palette.ts';
import { calm, glyph } from '../ui/ui.ts';
import { COHO, run, sheetSprite, WATER, type Sprite } from './pixel-anim.ts';
import { BRAKES, CREEKS, ROUTE } from './guide-sample.ts';
import { mapSay, ROAD_SAY } from './guide-words.ts';

const CAR: Sprite = sheetSprite('art/guide/car.png', 32, 32, 1, 1);
const FIR: Sprite = sheetSprite('art/guide/fir.png', 32, 32, 1, 1);

/** The sprite sheets the stills use, decoded; a missing one never holds the guide up. */
export function stillsReady(): Promise<void> {
  const urls = ['art/guide/car.png', 'art/guide/fir.png', 'art/anim/salmon-swim.png', 'art/anim/creek-strip.png'];
  return Promise.all(urls.map((u) => { const i = new Image(); i.src = u; return i.decode().catch(() => {}); })).then(() => {});
}

const LAND = { base: '#24382a', dark: '#1d2f23', lite: '#2c4433' };
const ROAD = { asphalt: '#3b4045', bridge: '#454b50', edge: '#7d847e', rail: '#c7ccc4', dash: '#d4a93c' };

/** A canvas that fills its box at a whole number of CSS px per art pixel, redrawn when the box changes. moves: it animates. */
function stage(cls: string, moves: boolean, draw: (g: CanvasRenderingContext2D, W: number, H: number, S: number, now: number) => void): HTMLCanvasElement {
  const c = h('canvas.gd-canvas.' + cls, { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null = null;
  const paint = (now: number) => {
    if (!c.isConnected || !c.clientHeight) return;
    g ??= c.getContext('2d');
    if (!g) return;
    // about 120 to 180 art pixels tall, whatever the box
    const S = Math.max(2, Math.round(c.clientHeight / 150));
    const W = Math.ceil(c.clientWidth / S), H = Math.ceil(c.clientHeight / S);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    g.imageSmoothingEnabled = false;
    draw(g, W, H, S, now);
  };
  const still = !moves || calm();
  // drawn as soon as it is on the page, before the slide's first frame shows
  queueMicrotask(() => paint(still ? 0 : performance.now()));
  if (still) {
    // sheets may land after the first paint
    for (const ms of [300, 900]) setTimeout(() => requestAnimationFrame(() => paint(0)), ms);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => paint(0)).observe(c);
  } else run(c, 8, paint);
  return c;
}

/** Grass with a scatter of darker and lighter pixels, the same every time. */
function grass(g: CanvasRenderingContext2D, W: number, H: number): void {
  g.fillStyle = LAND.base;
  g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 3) for (let x = (y * 7) % 5; x < W; x += 5) {
    const k = (x * 31 + y * 17) % 13;
    if (k < 2) { g.fillStyle = k ? LAND.lite : LAND.dark; g.fillRect(x, y, 1, 1); }
  }
}

/** Slide 1: a two-lane road crossing Clover Creek, a coho in the water, the car coming up to it. */
export function roadStill(): HTMLElement {
  const canvas = stage('gd-road', true, (g, W, H, S, now) => {
    grass(g, W, H);
    // the road a little right of center, so the coho has room upstream
    const rw = 40, cx = Math.max(Math.round(W * 0.6), COHO.w + rw / 2), left = cx - rw / 2;
    // the creek, a third of the way down, drifting left
    const cy = Math.round(H * 0.24), drift = now ? Math.floor(now / 160) % WATER.w : 0, wf = now ? Math.floor(now / 160) : 0;
    for (let x = -drift; x < W; x += WATER.w) WATER.draw(g, wf, x, cy);
    // firs in the grass, clear of the road and the creek
    for (const [fx, fy] of [[0.04, 0.5], [0.2, 0.7], [0.06, 0.86], [0.72, 0.52], [0.86, 0.72], [0.76, 0.92], [0.1, -0.06], [0.82, -0.04]]) {
      const x = Math.round(fx * W), y = Math.round(fy * H);
      if (x + 26 > left && x + 6 < left + rw) continue;
      if (y + 30 > cy && y < cy + WATER.h) continue;
      FIR.draw(g, 0, x, y);
    }
    // the road, then the bridge deck and its rails over the water
    g.fillStyle = ROAD.asphalt;
    g.fillRect(left, 0, rw, H);
    g.fillStyle = ROAD.edge;
    g.fillRect(left, 0, 1, H);
    g.fillRect(left + rw - 1, 0, 1, H);
    g.fillStyle = ROAD.bridge;
    g.fillRect(left - 3, cy, rw + 6, WATER.h);
    g.fillStyle = ROAD.rail;
    g.fillRect(left - 4, cy - 1, rw + 8, 2);
    g.fillRect(left - 4, cy + WATER.h - 1, rw + 8, 2);
    g.fillStyle = ROAD.dash;
    for (let y = -2; y < H; y += 12) if (y + 6 < cy - 1 || y > cy + WATER.h) g.fillRect(cx - 1, y, 2, 6);
    // the coho, upstream of the bridge, facing upstream
    COHO.draw(g, now ? now / 100 : 0, left - COHO.w - 2, cy + Math.round(WATER.h / 2) - 16);
    // the car in the right lane, a little short of the creek, clear of the caption
    CAR.draw(g, 0, cx - 6, Math.max(cy + WATER.h + 6, H - Math.ceil(64 / S) - 34));
  });
  return h('figure.gd-still', { role: 'img', 'aria-label': `A road about to cross Clover Creek, with a coho in the water. The voice says: ${ROAD_SAY}` },
    canvas,
    h('figcaption.gd-say', { 'aria-hidden': 'true' }, h('span.gd-say-ico', { html: glyph('sound', 2) }), h('span', {}, ROAD_SAY)));
}

/** Plots a line of art pixels, w wide. */
function line(g: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], w: number, color: string, fleck?: string): void {
  g.fillStyle = color;
  let n = 0;
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps - w / 2), y = Math.round(y0 + ((y1 - y0) * i) / steps - w / 2);
      g.fillStyle = fleck && n++ % 5 === 0 ? fleck : color;
      g.fillRect(x, y, w, w);
    }
  }
}

// marks, 7 by 7: a check for a gentle crossing, a bang for a hard brake near one
const CHECK = ['.......', '.....X.', '....XX.', 'X..XX..', 'XXXX...', '.XX....', '.......'];
const BANG = ['...X...', '...X...', '...X...', '...X...', '.......', '...X...', '.......'];

function mark(g: CanvasRenderingContext2D, x: number, y: number, fill: string, rows: readonly string[]): void {
  g.fillStyle = '#0b0f0d';
  g.fillRect(x - 5, y - 5, 11, 11);
  g.fillStyle = fill;
  g.fillRect(x - 4, y - 4, 9, 9);
  g.fillStyle = '#0b0f0d';
  rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === 'X') g.fillRect(x - 3 + i, y - 3 + j, 1, 1); });
}

/** Slide 2: the sample drive's real route and creeks, a mark on each crossing, and how many went gently. */
export function mapStill(): HTMLElement {
  const gentle = CREEKS.filter((c) => c.gentle).length, say = mapSay(gentle, CREEKS.length);
  // each creek's name beside its mark: side when the map lies wide, then when it stands tall
  const SIDE: Record<string, [string, string]> = { 'Clover Creek': ['t', 'r'], 'Spanaway Creek': ['t', 'r'], 'Morey Creek': ['r', 'b'] };
  const pins = CREEKS.map((c) => h('span.gd-pin', {}, c.name));
  const canvas = stage('gd-map', false, (g, W, H, S) => {
    g.fillStyle = '#3c5334';
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 4) for (let x = (y * 3) % 7; x < W; x += 7) if ((x * 13 + y * 7) % 11 < 2) { g.fillStyle = '#354b2e'; g.fillRect(x, y, 2, 1); }
    // a tall box turns the drive a quarter turn, so it heads up the screen like the road: west is up
    const tall = H > W * 1.05, turn = (p: readonly [number, number]): [number, number] => (tall ? [-p[1], p[0]] : [p[0], p[1]]);
    // the creeks and the first leg, the caption clear below; the rest runs off the edge
    const room = H - Math.ceil(52 / S);
    const [x0, x1, y0, y1] = tall ? [-118, 48, -64, 345] : [-60, 345, -48, 112];
    const k = Math.min((W - 16) / (x1 - x0), (room - 12) / (y1 - y0));
    const ox = Math.round((W - (x1 - x0) * k) / 2 - x0 * k), oy = Math.round(Math.max(6, (room - (y1 - y0) * k) / 2) - y0 * k);
    const at = (p: readonly [number, number]): [number, number] => { const [x, y] = turn(p); return [ox + x * k, oy + y * k]; };
    for (const c of CREEKS) for (const l of c.lines) line(g, l.map(at), 2, SALMON_WATER, SALMON);
    line(g, ROUTE.map(at), 5, '#1a1712');
    line(g, ROUTE.map(at), 3, ROUTE_C.fill);
    for (const b of BRAKES) { const [x, y] = at(b).map(Math.round); g.fillStyle = '#0b0f0d'; g.fillRect(x - 2, y - 2, 5, 5); g.fillStyle = '#ffb547'; g.fillRect(x - 1, y - 1, 3, 3); }
    // the names go beside the marks, in CSS px
    const css = canvas.clientWidth / W;
    CREEKS.forEach((c, i) => {
      const [x, y] = at(c.at).map(Math.round);
      mark(g, x, y, c.gentle ? '#8fe38a' : '#ffb547', c.gentle ? CHECK : BANG);
      const side = SIDE[c.name]?.[tall ? 1 : 0] ?? 'r', p = pins[i];
      p.dataset.side = side;
      p.style.left = `${Math.round((side === 'r' ? x + 8 : x) * css)}px`;
      p.style.top = `${Math.round((side === 't' ? y - 8 : side === 'b' ? y + 8 : y) * css)}px`;
    });
  });
  const hard = CREEKS.filter((c) => !c.gentle).map((c) => c.name);
  return h('figure.gd-still', { role: 'img', 'aria-label': `Map of the sample drive over ${CREEKS.map((c) => c.name.replace(' Creek', '')).join(', ').replace(/, ([^,]*)$/, ' and $1')} creeks. ${say.n} ${say.rest}${hard.length ? `; a hard brake near ${hard.join(' and ')}` : ''}.` },
    canvas,
    h('div.gd-pins', { 'aria-hidden': 'true' }, ...pins),
    h('figcaption.gd-tally', { 'aria-hidden': 'true' }, h('b', {}, say.n), h('span', {}, say.rest)));
}
