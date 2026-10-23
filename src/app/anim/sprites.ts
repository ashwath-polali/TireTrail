// The reveal's pixel art: PixelLab sprite sheets, with the same art drawn in code as stand-ins and for the small live strips.
import { codeFrames, sheetFrames, type Frames, type Pal } from './px.ts';

/** the app's coho colors (ui/glyphs.ts salmonSVG) */
export const COHO_PAL: Pal = { G: '#4f9ea3', R: '#e3503f', W: '#f1ece4', E: '#0b0f0d' };

/** a spawning coho swimming right: tail spread, up, spread, down */
export const COHO: readonly (readonly string[])[] = [
  [
    '.......GGG......',
    'G....GGGGGGGG...',
    'GG..GRRRRRRGGGG.',
    '.GGGRRRRRRRRGEGG',
    'GG..RRRRRRRRWWW.',
    'G....WWWWWWWW...',
    '.......G..G.....',
  ],
  [
    'GG.....GGG......',
    '.GG..GGGGGGGG...',
    '..G.GRRRRRRGGGG.',
    '..GGRRRRRRRRGEGG',
    '....RRRRRRRRWWW.',
    '.....WWWWWWWW...',
    '........G..G....',
  ],
  [
    '.......GGG......',
    'G....GGGGGGGG...',
    'GG..GRRRRRRGGGG.',
    '.GGGRRRRRRRRGEGG',
    'GG..RRRRRRRRWWW.',
    'G....WWWWWWWW...',
    '........G..G....',
  ],
  [
    '.......GGG......',
    '.....GGGGGGGG...',
    '....GRRRRRRGGGG.',
    '..GGRRRRRRRRGEGG',
    '..G.RRRRRRRRWWW.',
    '.GG..WWWWWWWW...',
    'GG.....G..G.....',
  ],
];

const SPARKLE_PAL: Pal = { Y: '#ffe09a', W: '#ffffff' };
export const SPARKLE: readonly (readonly string[])[] = [
  ['.......', '.......', '.......', '...W...', '.......', '.......', '.......'],
  ['.......', '.......', '...Y...', '..YWY..', '...Y...', '.......', '.......'],
  ['...Y...', '.Y.Y.Y.', '..YWY..', 'YYWWWYY', '..YWY..', '.Y.Y.Y.', '...Y...'],
  ['.......', '...Y...', '...Y...', '.YYWYY.', '...Y...', '...Y...', '.......'],
  ['.......', '.......', '...Y...', '..YWY..', '...Y...', '.......', '.......'],
];

const PUFF_PAL: Pal = { A: '#8a7f6a', B: '#b5a98f', C: '#5e574a' };
export const PUFF: readonly (readonly string[])[] = [
  ['..........', '..........', '..........', '....AA....', '...ABBA...', '....AA....', '..........', '..........'],
  ['..........', '..........', '...AAA....', '..ABBBA...', '..ABBBAA..', '...AAAA...', '..........', '..........'],
  ['..........', '...AA.....', '..ABBAAA..', '.ABBBBBBA.', '.ABBBBBA..', '..AACAA...', '..........', '..........'],
  ['....A.....', '..A.B.AA..', '.A.B.B.BA.', 'A.B.B.B.A.', '.A.B.B.A..', '..A.C.A...', '....A.....', '..........'],
  ['.A......A.', '....A.....', 'A.......A.', '...A..A...', '.A.......A', '.....A....', '..A.......', '..........'],
];

const TIRE_PAL: Pal = { K: '#2a332e', T: '#56625b', H: '#a9b6ae', X: '#44534a', S: '#eef3ef' };

/** A side-on tire, size px across, turned `turn` of a tread step (0 to 1). Pure, for tests. */
export function tireRows(size = 14, turn = 0): string[] {
  const c = (size - 1) / 2, R = size / 2, rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
      const tread = ((a * 8 + turn) % 1 + 1) % 1, spoke = ((a * 4 + turn / 2) % 1 + 1) % 1;
      if (r > R) row += '.';
      else if (r > R - 1.6) row += tread < 0.35 ? 'T' : 'K';
      else if (r > R - 2.6) row += 'K';
      else if (r > R - 3.5) row += 'H';
      else if (r > 1.6) row += spoke < 0.2 ? 'H' : 'X';
      else row += 'S';
    }
    rows.push(row);
  }
  return rows;
}

const COIN_PAL: Pal = { Y: '#ffd166', D: '#9a7424', W: '#fff0c4' };

/** A coin 8 px tall seen at a turn: width from full to edge-on. Pure, for tests. */
export function coinRows(half: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = '';
    const dy = y - 3.5;
    for (let x = 0; x < 8; x++) {
      const dx = (x - 3.5) / Math.max(0.5, half / 4);
      const r = Math.hypot(dx, dy);
      row += r > 4 ? '.' : r > 3 ? 'D' : dx < -0.5 && dy < 0 && half > 1 ? 'W' : 'Y';
    }
    rows.push(row);
  }
  return rows;
}

const PUMP_PAL: Pal = { R: '#c8473b', r: '#7e2a22', h: '#e86a5a', K: '#0b0f0d', Y: '#ffd166', D: '#44534a', N: '#a9b6ae', H: '#151817' };
export const PUMP: readonly string[] = [
  '.RRRRRRRRRR.....',
  'RhhhhhhhhhhR....',
  'RKKKKKKKKKKR.NN.',
  'RKYYYYYYYYKR.NNN',
  'RKKKKKKKKKKR.N..',
  'RRRRRRRRRRRR.H..',
  'RRRRRRRRRRRR.H..',
  'RRRhhhhhhRRR.H..',
  'RRRhKKKKhRRR.H..',
  'RRRhhhhhhRRR.H..',
  'RRRRRRRRRRRR.H..',
  'RRRRRRRRRRRR.H..',
  'RRRRRRRRRRRRH...',
  'rRRRRRRRRRRr....',
  'rrrrrrrrrrrr....',
  'DDDDDDDDDDDDDD..',
];

const WATER_PAL: Pal = { d: '#22404a', m: '#2f6273', b: '#3b7688', l: '#8fc3d2', w: '#d4ecf3' };
/** one tile of running water, for the live banner (repeats across) */
export const WATER_TILE: readonly string[] = [
  'dddddddddddddddd',
  'bbbbbbbbbbbbbbbb',
  'bbllbbbbbbbbbwbb',
  'mmmmmmmlllmmmmmm',
  'mmmmmmmmmmmmmmmm',
  'dddddddddddddddd',
];

/** The same animations drawn in code: the stand-ins, and the small strips on the live screens. */
export const CODE = {
  coho: codeFrames(COHO, COHO_PAL, 12),
  sparkle: codeFrames(SPARKLE, SPARKLE_PAL, 12),
  puff: codeFrames(PUFF, PUFF_PAL, 12),
  tire: codeFrames([0, 0.25, 0.5, 0.75].map((k) => tireRows(14, k)), TIRE_PAL, 12),
  coin: codeFrames([4, 3, 1, 3].map(coinRows), COIN_PAL, 12),
  pump: codeFrames([PUMP], PUMP_PAL, 12),
  water: codeFrames([WATER_TILE], WATER_PAL, 12),
};

/** Each animation: PixelLab sheets (public/art/anim, sizes from their .json). Swap a line for CODE.x to go back. */
export const SPRITES: Record<keyof typeof CODE | 'creek', Frames> = {
  coho: sheetFrames('art/anim/salmon-swim.png', 64, 32, 8, 10, true),
  sparkle: sheetFrames('art/anim/sparkle.png', 16, 16, 4, 6),
  puff: sheetFrames('art/anim/dust-puff.png', 48, 32, 8, 12),
  tire: sheetFrames('art/anim/tire-roll.png', 32, 32, 4, 12),
  coin: sheetFrames('art/anim/coin-spin.png', 16, 16, 6, 10),
  pump: sheetFrames('art/anim/gas-pump.png', 48, 64, 4, 4),
  creek: sheetFrames('art/anim/creek-strip.png', 128, 24, 4, 6),
  water: CODE.water,
};

/** Every sheet is in (or failed): draw again then. */
export const spritesReady = (): Promise<unknown> => Promise.all(Object.values(SPRITES).map((f) => f.ready));
