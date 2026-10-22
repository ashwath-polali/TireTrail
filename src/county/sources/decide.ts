// Where a walked drain's water ends up, in the same codes and words as the county trace.
import type { Bundle } from '../../data/bundle.ts';
import type { XY } from '../../geo/geo.ts';
import { cleanWaterName, unnamedWater, type CountyWaters } from '../waters.ts';
import { WDFW_SAYS } from '../trace.ts';
import type { SourceAsset } from '../source.ts';
import type { SourceConfig } from './config.ts';
import { GAP_CODE, SEWER_CODE, SOAK_CODE, type Decided, type Reached } from './walk.ts';

/** an outfall or stream this close to water empties into it (as the county trace) */
export const WATER_TOL_M = 30;
/** the app's class code for a sewer to a treatment plant (src/app/map/world.ts) */
export const TREATMENT = 5;

type Waters = Pick<CountyWaters, 'coho' | 'receiving' | 'nameFor'>;

/** "Piper's Creek" and "Pipers Creek" match */
export const waterKey = (s: string): string => s.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim();

/** a documented coho reach of this name this close counts, though the reach is drawn too far off to touch */
export const NAMED_COHO_M = 3000;

/**
 * cohoNamed: is there a WDFW documented coho reach with this name within NAMED_COHO_M of p.
 * The source's own receiving water name decides that; small creeks are drawn too coarsely to meet by distance.
 */
export function decide(r: Reached, src: readonly SourceAsset[], xy: readonly XY[][], W: Waters, cfg: Pick<SourceConfig, 'owner' | 'sewer'>, cohoNamed: (name: string, p: XY) => boolean = () => false): Decided {
  const a = src[r.terminal];
  const what = a.role === 'outfall' ? `outfall ${a.id}` : a.role === 'discharge' ? `sewer connection ${a.id}` : `pipe ${a.id}`;
  switch (r.sink) {
    case 'sewer': {
      const combined = a.system === 'combined';
      return {
        code: SEWER_CODE,
        cls: 'treatment',
        receiving: '',
        reason: combined ? `Joins a combined sewer at ${what}. It goes to ${cfg.sewer}.` : `Joins a sewer pipe at ${what}. It goes to ${cfg.sewer}.`,
      };
    }
    case 'ground':
      return { code: SOAK_CODE, cls: 'ground', receiving: '', reason: `Ends at ${what}, built to soak water into the ground.` };
    case 'water':
    case 'stream': {
      const pts = xy[r.terminal];
      const hint = cleanWaterName((a.receivingHint ?? '').replace(/\s+\d+$/, ''));
      const stream = r.sink === 'stream';
      let doc: { p: XY; hit: NonNullable<ReturnType<Waters['coho']>> } | null = null;
      for (const p of pts) {
        const hit = W.coho(p, WATER_TOL_M);
        if (hit && (!doc || hit.d < doc.hit.d)) doc = { p, hit };
      }
      // a named creek right at the end beats the source's name, which is often the basin it joins
      let creek = '', other = '';
      for (const p of pts) {
        const hit = W.receiving(p, WATER_TOL_M);
        if (!hit) continue;
        const name = W.nameFor(p, hit, WATER_TOL_M);
        if (name && ['stream', 'nhd', 'coho'].includes(hit.water.source)) creek ||= name;
        other ||= name || unnamedWater(hit.water);
      }
      const docName = doc ? W.nameFor(doc.p, doc.hit, WATER_TOL_M) : '';
      const named = creek && cohoNamed(creek, pts[0]) ? creek : hint && cohoNamed(hint, pts[0]) ? hint : '';
      if (!doc && named && creek && named !== creek) {
        return { code: 'downstream-creek', cls: 'creek', receiving: named, reason: `${stream ? 'Reaches' : 'Flows out of'} ${what} into ${creek}, which runs into ${named}, where WDFW records coho salmon.` };
      }
      if (doc || named) {
        const name = docName || named || creek || hint || 'an unnamed stream';
        return { code: stream ? 'stream-creek' : 'outfall-creek', cls: 'creek', receiving: name, reason: `${stream ? 'Reaches' : 'Flows out of'} ${what} into ${name}. ${WDFW_SAYS.documented}` };
      }
      const near = creek || hint || other;
      if (!near) return { code: 'outfall-unknown', cls: 'unknown', receiving: '', reason: `Ends at ${what}. The water it flows into isn't on the map.` };
      return { code: stream ? 'stream-elsewhere' : 'outfall-elsewhere', cls: 'elsewhere', receiving: near, reason: `${stream ? 'Reaches' : 'Flows out of'} ${what} into ${near}.` };
    }
    case 'loop':
      return { code: 'loop', cls: 'unknown', receiving: '', reason: 'The pipes on the map loop back on themselves.' };
    case 'not-connected':
      return { code: 'not-connected', cls: 'unknown', receiving: '', reason: "This drain isn't connected to any pipe on the map." };
    default:
      return { code: GAP_CODE, cls: 'unknown', receiving: '', reason: `Then ${cfg.owner} pipe map has a gap.` };
  }
}

/**
 * Marks sewer endings with the treatment class the encoder doesn't know (it saw them as "elsewhere"),
 * on endings, street runs and pieces. Returns the area's drains by class.
 */
export function finishBundle(b: Bundle, ownByClass: Record<string, number>, ownSewer: number): Record<string, number> {
  b.endings.forEach((e) => {
    if (e.code === SEWER_CODE) e.cls = TREATMENT;
  });
  const R = b.streets.runs;
  const byPiece = new Map<number, number[]>();
  R.drain.forEach((d, i) => {
    if (d >= 0 && b.endings[b.drains.ending[d]].cls === TREATMENT) R.cls[i] = TREATMENT;
    const len = byPiece.get(R.piece[i]) ?? [0, 0, 0, 0, 0, 0];
    len[R.cls[i]] += runLength(R.geom[i]);
    byPiece.set(R.piece[i], len);
  });
  for (const [k, len] of byPiece) {
    let best = 0;
    for (let c = 1; c < len.length; c++) if (len[c] > len[best]) best = c;
    b.streets.pieces[k].cls = best;
  }
  return { ...ownByClass, elsewhere: ownByClass.elsewhere - ownSewer, treatment: ownSewer };
}

/** a run's length in microdegree steps, enough to compare runs */
function runLength(g: readonly number[]): number {
  let m = 0;
  for (let i = 2; i + 1 < g.length; i += 2) m += Math.hypot(g[i] * 0.67, g[i + 1]);
  return m;
}
