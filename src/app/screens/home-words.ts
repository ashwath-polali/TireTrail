// Words for Drive home: the pitch and the line under it. No DOM, so tests run it.

/** The pitch, plain: gas first to read, the salmon in color. */
export const HOME_TITLE = ['Save gas.', 'Help the salmon.'] as const;

/** Smoother driving wastes less gas and sheds less tire dust (money.ts, dust.ts). It can't keep dust out of streams. */
export const HOME_LINE = 'Drive smoother. Shed less tire dust.';

/** This week's strip on home: salmon streams crossed, tire dust vs typical, gas cents. Short captions. */
export const WEEK_CAPS = { streams: (n: number) => (n === 1 ? 'salmon stream' : 'salmon streams'), less: 'less tire dust', more: 'more tire dust', typical: 'tire dust, typical', gas: 'added a gallon' } as const;
