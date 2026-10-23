// Words for Drive home: the pitch and the line under it. No DOM, so tests run it.

/** The pitch, plain: what to do, then what you get. The second line is in color. */
export const HOME_TITLE = ['Brake gently near salmon creeks.', 'Save gas.'] as const;

/** How it helps: the creek cue (src/drive/coach/live.ts). */
export const HOME_LINE = 'A voice warns you as you get close.';

/** This week's strip on home: salmon streams crossed, tire dust vs typical, gas cents. Short captions. */
export const WEEK_CAPS = { streams: (n: number) => (n === 1 ? 'salmon stream' : 'salmon streams'), less: 'less tire dust', more: 'more tire dust', typical: 'tire dust, typical', gas: 'added a gallon' } as const;
