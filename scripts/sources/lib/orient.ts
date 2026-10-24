// Which way lines are drawn, for maps that join by geometry: each line's own inverts, its compass flow
// direction and the ground (USGS 3DEP) at its ends, each checked against the drawn order. A line turns
// around only where two of them say so and none says otherwise more often.
import type { SourceAsset, Trust } from '../../../src/county/source.ts';
import { FT, invertSign, type LonLat } from '../bellevue.ts';
import { groundSign, type Ground } from './downhill.ts';

export interface DrawnLine {
  asset: SourceAsset;
  /** line type for the notes, e.g. 'pipe', 'ditch' */
  kind: string;
  /** invert at the first and last vertex (feet), where set */
  up?: number;
  down?: number;
  /** flow bearing in degrees, where set */
  compass?: number;
}

const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
export const compassOf = (v: unknown): number | undefined => COMPASS[String(v ?? '').trim().toUpperCase()];

function bearing(c: readonly LonLat[]): number {
  const [a, b] = [c[0], c[c.length - 1]];
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), dy = b[1] - a[1];
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** 1 = the compass agrees with the drawn order, -1 = it opposes it, 0 = too square to tell */
export function compassSign(c: readonly LonLat[], deg: number): number {
  const d = Math.abs(((bearing(c) - deg + 540) % 360) - 180);
  return d < 67.5 ? 1 : d > 112.5 ? -1 : 0;
}

/** a test agreeing with the drawn order this often (on lines it decides) may vote */
const VOTE_OK = 0.75;
/** the ground falling along this share of lines, as drawn, keeps unchecked lines as 'digitized' */
export const GROUND_OK = 0.75;

/** Orients the lines in place; returns notes and adds counts to extra. */
export function orientLines(lines: DrawnLine[], ground: Ground, extra: Record<string, number>): string[] {
  const tests = (l: DrawnLine) => ({
    inverts: l.up !== undefined && l.down !== undefined ? invertSign(l.up, l.down) : 0,
    compass: l.compass !== undefined ? compassSign(l.asset.coords, l.compass) : 0,
    ground: groundSign(ground, l.asset.coords),
  });
  const said = lines.map(tests);
  type K = 'inverts' | 'compass' | 'ground';
  const KEYS: K[] = ['inverts', 'compass', 'ground'];
  const tally = (k: K, pick = (_: DrawnLine) => true) => {
    let d = 0, u = 0;
    said.forEach((s, i) => {
      if (!pick(lines[i])) return;
      if (s[k] > 0) d++;
      else if (s[k] < 0) u++;
    });
    return { d, u, share: d + u ? d / (d + u) : 0 };
  };
  const all = Object.fromEntries(KEYS.map((k) => [k, tally(k)])) as Record<K, ReturnType<typeof tally>>;
  const votes = KEYS.filter((k) => all[k].d + all[k].u >= 20 && all[k].share >= VOTE_OK);
  const drawnOk = all.ground.d + all.ground.u >= 20 ? all.ground.share >= GROUND_OK : all.inverts.d + all.inverts.u >= 20 && all.inverts.share >= GROUND_OK;

  let reversed = 0, agreeAny = 0, checked = 0;
  lines.forEach((l, i) => {
    const s = said[i];
    const back = votes.filter((k) => s[k] < 0).length;
    const fwd = votes.filter((k) => s[k] > 0).length;
    // first test that decides: inverts, then compass, then ground
    const first = KEYS.map((k) => s[k]).find((v) => v !== 0);
    if (first !== undefined) {
      checked++;
      if (first > 0) agreeAny++;
    }
    const a = l.asset;
    const flip = back >= 2 && back > fwd;
    if (flip) {
      a.coords = [...a.coords].reverse();
      reversed++;
      extra[`lines.reversed.${l.kind}`] = (extra[`lines.reversed.${l.kind}`] ?? 0) + 1;
    }
    const sign = (k: K) => (flip ? -s[k] : s[k]);
    const trust: Trust = sign('inverts') > 0 ? 'inverts' : sign('compass') > 0 && votes.includes('compass') ? 'compass' : drawnOk ? 'digitized' : 'none';
    a.trust = trust;
    if (trust === 'inverts') {
      const m = (ft: number) => Math.round(ft * FT * 1000) / 1000;
      [a.upInv, a.downInv] = flip ? [m(l.down!), m(l.up!)] : [m(l.up!), m(l.down!)];
    }
  });

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const line = (t: ReturnType<typeof tally>) => `${t.d}/${t.d + t.u} (${pct(t.share)})`;
  const notes = [`Drawn order checked on ${checked} of ${lines.length} lines (inverts, else compass, else ground): agrees on ${agreeAny} (${pct(checked ? agreeAny / checked : 0)})`];
  for (const k of KEYS) {
    extra[`check.${k}.agree`] = all[k].d;
    extra[`check.${k}.oppose`] = all[k].u;
    const kinds = [...new Set(lines.map((l) => l.kind))].map((kind) => `${kind} ${line(tally(k, (l) => l.kind === kind))}`).join(', ');
    notes.push(`${k === 'ground' ? 'Ground (3DEP, ends 0.5 m or more apart) falls' : k === 'inverts' ? 'Inverts fall' : 'Compass points'} along the drawn order on ${line(all[k])}${votes.includes(k) ? '' : ' (not used to turn lines)'}: ${kinds}`);
  }
  extra['lines.reversed'] = reversed;
  extra['lines.checked'] = checked;
  extra['lines.checkedAgree'] = agreeAny;
  notes.push(`${reversed} lines turned around where two tests opposed the drawing; the rest kept as drawn (${drawnOk ? "'digitized' where unchecked" : "'none' where unchecked"})`);
  return notes;
}

/** a stream's recorded name where it reads as one (catalog numbers like 'Tributary 0056' left out) */
export const streamName = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return /\b(Creek|River|Ditch|Brook)\b/.test(s) && !/\d/.test(s) ? s : undefined;
};
