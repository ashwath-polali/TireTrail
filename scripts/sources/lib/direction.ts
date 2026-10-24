// Which way a line is drawn: its own evidence (inverts, or pipe directions recorded at catch basins) and the
// ground at its ends. Shared by the adapters whose lines join by geometry (Newcastle, Clyde Hill, Medina, North Bend).
import type { SourceAsset, Trust } from '../../../src/county/source.ts';
import { DRAWN_OK, approxM, type LonLat, type NodeIndex } from '../bellevue.ts';
import { groundSign, type Ground } from './downhill.ts';

/** share of sloped lines drawn downhill for lines with no evidence to be kept as drawn */
export const GROUND_OK = 0.75;

export interface DirLine {
  asset: SourceAsset;
  /** 1 = the evidence says drawn in flow order, -1 = drawn backward, 0 = none */
  says: number;
}

/** Bearing in degrees from north, clockwise, from a toward b. */
export function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

/** Bearing of a line leaving its first (atEnd false) or last vertex, over its first few meters. */
export function leaving(line: readonly LonLat[], atEnd: boolean, overM = 3): number {
  const pts = atEnd ? [...line].reverse() : line;
  let b = pts[1];
  for (let i = 1; i < pts.length; i++) {
    b = pts[i];
    if (approxM(pts[0], b) >= overM) break;
  }
  return bearing(pts[0], b);
}

const turn = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

export interface Port {
  /** degrees from north, the way the pipe leaves the structure */
  az: number;
  out: boolean;
}

/** 1 = the structure's port this line end matches says the drawn order is right, -1 = backward, 0 = no single match. */
export function portSays(ports: readonly Port[], lineBearing: number, isFirst: boolean, tolDeg: number): number {
  const near = ports.filter((p) => turn(p.az, lineBearing) <= tolDeg);
  if (!near.length) return 0;
  const outs = near.filter((p) => p.out).length;
  if (outs && outs < near.length) return 0;
  // water leaves by the first vertex's out port, or comes in at the last vertex's in port
  return (outs > 0) === isFirst ? 1 : -1;
}

/** What the structures at a line's two ends say about its drawn order (1, -1 or 0; ends that disagree say 0). */
export function endsSay(line: readonly LonLat[], nodes: NodeIndex, ports: ReadonlyMap<string, Port[]>, tolDeg: number, withinM = 2): number {
  let v = 0;
  for (const atEnd of [false, true]) {
    const n = nodes.nearest(atEnd ? line[line.length - 1] : line[0], withinM);
    const p = n && ports.get(n.ref.key);
    if (p?.length) v += portSays(p, leaving(line, atEnd), !atEnd, tolDeg);
  }
  return Math.sign(v);
}

/**
 * Sets each line's trust and flow order. Evidence that agrees: kept, `trust`. Evidence that disagrees: the
 * ground decides where it is sure, else the evidence. No evidence: 'digitized' when the lines with evidence or
 * the ground along these lines show the map is drawn in flow order, else 'none'.
 */
export function settle(lines: readonly DirLine[], ground: Ground, trust: Trust, extra: Record<string, number>): string[] {
  const inc = (k: string, n = 1) => (extra[k] = (extra[k] ?? 0) + n);
  const g = new Map(lines.map((l) => [l, groundSign(ground, l.asset.coords)]));
  let agree = 0, against = 0, gDown = 0, gUp = 0;
  const gBy = { agree: [0, 0], against: [0, 0], none: [0, 0] };
  for (const l of lines) {
    if (l.says > 0) agree++;
    else if (l.says < 0) against++;
    const s = g.get(l)!;
    if (s > 0) gDown++;
    else if (s < 0) gUp++;
    const b = gBy[l.says > 0 ? 'agree' : l.says < 0 ? 'against' : 'none'];
    if (s > 0) b[0]++;
    else if (s < 0) b[1]++;
  }
  const evShare = agree / Math.max(1, agree + against);
  const gShare = gDown / Math.max(1, gDown + gUp);
  const [sd, su] = gBy.none;
  // the lines with evidence, or the ground along the lines without, show the map is drawn in flow order
  const drawnOk = (agree + against >= 20 && evShare >= DRAWN_OK) || (sd + su >= 20 && sd / (sd + su) >= GROUND_OK) || (agree + against < 20 && gDown + gUp >= 20 && gShare >= GROUND_OK);
  // Lines with agreeing evidence show how often the ground runs downhill along a pipe (q). Among lines with no
  // evidence, the share drawn downhill (s) gives the share drawn right: p = (s - (1 - q)) / (2q - 1). Where the
  // ground says one is drawn uphill, it is more likely backward when (1 - p) q > p (1 - q): turn it.
  const [qd, qu] = gBy.agree;
  const q = qd / Math.max(1, qd + qu);
  const p = Math.min(1, Math.max(0, (sd / Math.max(1, sd + su) - (1 - q)) / Math.max(0.01, 2 * q - 1)));
  const flipUphill = drawnOk && qd + qu >= 50 && sd + su >= 20 && q >= 0.7 && (1 - p) * q > p * (1 - q);
  for (const l of lines) {
    const a = l.asset;
    const s = g.get(l)!;
    if (l.says > 0) a.trust = trust;
    else if (l.says < 0) {
      if (s > 0) {
        a.trust = 'digitized';
        inc('lines.keptByGround');
      } else {
        a.coords = [...a.coords].reverse();
        [a.upInv, a.downInv] = [a.downInv, a.upInv];
        a.trust = trust;
        inc('lines.reversed');
      }
    } else if (drawnOk) {
      a.trust = 'digitized';
      if (flipUphill && s < 0) {
        a.coords = [...a.coords].reverse();
        inc('lines.turnedByGround');
      }
    }
  }
  // after: how often the ground agrees with the order the map now gives
  let fDown = 0, fUp = 0;
  for (const l of lines) {
    if (l.asset.trust === 'none') continue;
    const s = groundSign(ground, l.asset.coords);
    if (s > 0) fDown++;
    else if (s < 0) fUp++;
  }
  Object.assign(extra, {
    'dir.evidenceAgrees': agree, 'dir.evidenceAgainst': against, 'dir.noEvidence': lines.length - agree - against,
    'ground.downhill': gDown, 'ground.uphill': gUp, 'ground.final.downhill': fDown, 'ground.final.uphill': fUp,
  });
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(1)}%` : '-');
  const gs = ([d, u]: number[]) => `${d}/${d + u} (${pct(d, d + u)})`;
  return [
    `Evidence (${trust}) says ${agree} of ${agree + against} lines are drawn in flow order (${pct(agree, agree + against)}); ${lines.length - agree - against} lines have none`,
    `Ground (USGS 3DEP, ends 0.5 m or more apart) falls along ${gDown}/${gDown + gUp} lines as drawn (${pct(gDown, gDown + gUp)}): evidence agrees ${gs(gBy.agree)}, against ${gs(gBy.against)}, none ${gs(gBy.none)}`,
    `Against the evidence: ${extra['lines.keptByGround'] ?? 0} kept where the ground says drawn downhill, ${extra['lines.reversed'] ?? 0} reversed; no evidence: ${drawnOk ? "'digitized'" : "'none'"} ${qd + qu >= 50 ? ` (about ${pct(p, 1)} drawn right by the ground, ${extra['lines.turnedByGround'] ?? 0} drawn uphill turned)` : ''}; after, the ground falls along ${fDown}/${fDown + fUp} (${pct(fDown, fDown + fUp)}) of directed lines`,
  ];
}
