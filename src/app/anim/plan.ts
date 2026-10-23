// When each part of the end-of-drive reveal plays, in ms. Salmon first, then tire dust, then gas, then the one fix.

export interface RevealPlan {
  /** each coho: starts swimming in, gets to its place */
  fish: { from: number; at: number }[];
  /** the tire dust card slides in; its grams tick up from tick[0] to tick[1]; the bars fill */
  dust: number;
  tick: [number, number];
  bars: number;
  strip: number;
  /** the gas line, with its price ticking up and coins dropping; null without one */
  gas: { in: number; tick: [number, number]; coins: number[] } | null;
  fix: number;
  /** everything below the fix */
  rest: number;
  end: number;
}

export const SWIM_MS = 700;
const FISH_GAP = 200;

/** fish: coho swimming in (one per stream crossed, at most 4); gas: the gas line shows */
export function revealPlan(fish: number, gas: boolean): RevealPlan {
  const n = Math.max(1, Math.min(4, fish));
  const f = Array.from({ length: n }, (_, i) => ({ from: 150 + i * FISH_GAP, at: 150 + i * FISH_GAP + SWIM_MS }));
  const dust = 650 + Math.min(n - 1, 2) * 100;
  const g = gas ? { in: dust + 950, tick: [dust + 1050, dust + 1450] as [number, number], coins: [dust + 1100, dust + 1250, dust + 1400] } : null;
  const fix = g ? g.tick[1] + 150 : dust + 1100;
  return { fish: f, dust, tick: [dust + 150, dust + 850], bars: dust + 700, strip: dust + 400, gas: g, fix, rest: fix + 200, end: fix + 450 };
}
