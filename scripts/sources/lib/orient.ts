// Picks each line's flow order from the evidence a city has (ids, structure flags, inverts, an outfall at
// one end, the ground at its ends) and tallies how often each agrees with the drawing.
import type { SourceAsset, Trust } from '../../../src/county/source.ts';

/** 'down' = the drawn order is the flow order, 'up' = reversed */
export type Say = 'down' | 'up' | undefined;

export interface LineCheck {
  asset: SourceAsset;
  /** line type for the ground check, e.g. 'pipe', 'ditch' */
  type: string;
  ground?: Say;
  outfall?: Say;
  /** the city's own direction evidence: ids, structure IN/OUT flags or inverts */
  own?: Say;
}

export interface Tally {
  down: number;
  up: number;
  share: number;
}

export function tally(checks: readonly LineCheck[], pick: (c: LineCheck) => Say, only: (c: LineCheck) => boolean = () => true): Tally {
  let down = 0, up = 0;
  for (const c of checks) {
    if (!only(c)) continue;
    const s = pick(c);
    if (s === 'down') down++;
    else if (s === 'up') up++;
  }
  return { down, up, share: down + up ? down / (down + up) : 0 };
}

export const shareText = (t: Tally): string => `${t.down}/${t.down + t.up} (${t.down + t.up ? (100 * t.share).toFixed(1) : '-'}%)`;

export interface OrientOptions {
  /** trust for lines the city's own evidence orients */
  ownTrust: Trust;
  /** drawn order is kept for a line type when the ground falls along at least this share (with 20 or more sloped lines) */
  drawnOk: number;
  /** the city's own evidence is used when it agrees with the ground at least this often (20 or more) */
  ownOk: number;
}

export interface Oriented {
  /** lines oriented by each rule */
  by: Record<string, number>;
  /** the ground along the final order */
  final: Tally;
  reversedTypes: string[];
  ground: Record<string, Tally>;
  groundAll: Tally;
  own: Tally;
  outfall: Tally;
  ownVsGround: Tally;
  drawnOkTypes: string[];
  ownUsed: boolean;
}

/**
 * Own evidence first (when it agrees with the ground), then an outfall at one end, then the drawing where its
 * line type passes the ground check (or reversed, where the type is drawn against it), then the ground where it
 * falls enough, else the drawing.
 */
export function orient(checks: readonly LineCheck[], o: OrientOptions): Oriented {
  const types = [...new Set(checks.map((c) => c.type))];
  const ground: Record<string, Tally> = {};
  for (const t of types) ground[t] = tally(checks, (c) => c.ground, (c) => c.type === t);
  const groundAll = tally(checks, (c) => c.ground);
  const allOk = groundAll.down + groundAll.up >= 20 && groundAll.share >= o.drawnOk;
  const okType = new Set(types.filter((t) => (ground[t].down + ground[t].up >= 20 ? ground[t].share >= o.drawnOk : allOk)));
  // a line type drawn against the flow just as consistently
  const allBack = groundAll.down + groundAll.up >= 20 && groundAll.share <= 1 - o.drawnOk;
  const backType = new Set(types.filter((t) => (ground[t].down + ground[t].up >= 20 ? ground[t].share <= 1 - o.drawnOk : allBack)));
  // own evidence vs the ground: 'down' when they agree
  const ownVsGround = tally(checks, (c) => (c.own && c.ground ? (c.own === c.ground ? 'down' : 'up') : undefined));
  const ownUsed = ownVsGround.down + ownVsGround.up >= 20 && ownVsGround.share >= o.ownOk;
  const by: Record<string, number> = {};
  const finalSays: Say[] = [];
  for (const c of checks) {
    const a = c.asset;
    let say: Say, trust: Trust = 'none', rule: string;
    if (ownUsed && c.own) [say, trust, rule] = [c.own, o.ownTrust, 'own'];
    else if (c.outfall) [say, trust, rule] = [c.outfall, 'node-flags', 'outfall'];
    else if (okType.has(c.type)) [say, trust, rule] = ['down', 'digitized', c.ground === 'up' ? 'drawnOverGround' : 'drawn'];
    else if (backType.has(c.type)) [say, trust, rule] = ['up', 'digitized', c.ground === 'down' ? 'reversedOverGround' : 'reversed'];
    else if (c.ground) [say, rule] = [c.ground, 'ground'];
    else [say, rule] = ['down', 'drawnUnchecked'];
    by[rule] = (by[rule] ?? 0) + 1;
    a.trust = trust;
    if (say === 'up') a.coords = [...a.coords].reverse();
    finalSays.push(say);
  }
  // the ground along the final order
  let i = 0;
  const final = tally(checks, (c) => (c.ground ? (c.ground === finalSays[i++] ? 'down' : 'up') : void i++));
  return { by, final, reversedTypes: [...backType], ground, groundAll, own: tally(checks, (c) => c.own), outfall: tally(checks, (c) => c.outfall), ownVsGround, drawnOkTypes: [...okType], ownUsed };
}

/** Counts and note lines for meta.json. */
export function orientNotes(r: Oriented, ownName: string, extra: Record<string, number>): string[] {
  for (const [k, v] of Object.entries(r.by)) extra[`orientedBy.${k}`] = v;
  const put = (k: string, t: Tally) => {
    extra[`${k}.down`] = t.down;
    extra[`${k}.up`] = t.up;
  };
  for (const [t, v] of Object.entries(r.ground)) put(`ground.${t}`, v);
  put('own', r.own);
  put('outfall', r.outfall);
  put('ownVsGround', r.ownVsGround);
  put('final', r.final);
  return [
    `Ground check (USGS 3DEP at both ends, drops of 0.5 m or more), share drawn downhill: all ${shareText(r.groundAll)}; ${Object.entries(r.ground).map(([t, v]) => `${t} ${shareText(v)}`).join(', ')}. Kept as drawn: ${r.drawnOkTypes.join(', ') || 'none'}; reversed: ${r.reversedTypes.join(', ') || 'none'}`,
    `${ownName}: says drawn order on ${shareText(r.own)}; agrees with the ground on ${shareText(r.ownVsGround)}, so ${r.ownUsed ? 'it orients the lines it covers' : 'it is not used'}. Lines with an outfall at one end are drawn toward it on ${shareText(r.outfall)}`,
    `Oriented by: ${Object.entries(r.by).map(([k, v]) => `${k} ${v}`).join(', ')}. The ground falls along ${shareText(r.final)} of lines in the final order`,
  ];
}
