// Pure helpers for the UI kit: numbers, meters and block charts. No DOM, so tests can run them.

export type Tone = 'you' | 'salmon' | 'soak' | 'other' | 'money' | 'warn' | 'plain';
export const TONES: readonly Tone[] = ['you', 'salmon', 'soak', 'other', 'money', 'warn', 'plain'];

/** 1234.5 -> "1,234.5" with exactly `decimals` places; never shows "-0". */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '0';
  const d = Math.max(0, Math.min(6, Math.round(decimals)));
  const f = 10 ** d, r = Math.round(Math.abs(value) * f) / f;
  const s = r.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return value < 0 && r > 0 ? `-${s}` : s;
}

/** Rounds to the nearest step: roundTo(237, 5) = 235, roundTo(0.426, 0.01) = 0.43. */
export function roundTo(value: number, step: number): number {
  if (!Number.isFinite(value) || !(step > 0)) return 0;
  const r = Math.round(value / step) * step;
  // trims float noise like 0.43000000000000005
  const places = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(r.toFixed(Math.min(10, places)));
}

/**
 * What a scoreboard shows on tick `k` of `ticks`, counting up to value.
 * Fast at first, then settling; never passes the end, and the last tick is exact.
 */
export function tickAt(value: number, k: number, ticks = 14, decimals = 0): number {
  if (!Number.isFinite(value)) return 0;
  if (ticks <= 0 || k >= ticks) return value;
  if (k <= 0) return 0;
  const t = k / ticks, f = 10 ** Math.max(0, decimals), v = value * (1 - (1 - t) ** 3);
  return (value < 0 ? Math.ceil(v * f) : Math.floor(v * f)) / f;
}

/** A score on 0..100; anything odd is 0. */
export function clampScore(score: number): number {
  return Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
}

/** 80 and up reads green, 60 to 79 amber, under 60 orange. */
export function scoreTone(score: number): Tone {
  const s = Math.round(clampScore(score));
  return s >= 80 ? 'money' : s >= 60 ? 'you' : 'warn';
}

/**
 * How many of a meter's blocks light up. Anything above zero lights one;
 * only a full value lights them all, so 95 of 100 never looks perfect.
 */
export function meterLit(value: number, max: number, blocks = 10): number {
  const n = Math.max(1, Math.round(blocks));
  if (!Number.isFinite(value) || !(max > 0) || value <= 0) return 0;
  if (value >= max) return n;
  return Math.min(n - 1, Math.max(1, Math.round((value / max) * n)));
}

/** Block chart heights: how many of `rows` blocks each value fills. Above zero is at least one. */
export function barBlocks(values: number[], rows = 8): number[] {
  const n = Math.max(1, Math.round(rows));
  const vs = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const top = Math.max(0, ...vs);
  if (!top) return vs.map(() => 0);
  return vs.map((v) => (v > 0 ? Math.max(1, Math.round((v / top) * n)) : 0));
}

/** Snaps px to the 4 px grid. */
export const snap4 = (px: number): number => Math.round(px / 4) * 4;
