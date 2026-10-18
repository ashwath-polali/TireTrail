// Walks each drain downstream and classifies where its water ends up.
// Take the most trusted exit at each asset until an ending or the map stops.
// Revisiting an asset means a loop.
import { isDrain, isDrywell, type Asset } from './assets.ts';
import {
  DETENTION_TYPES,
  INFILTRATION_OVERFLOW_TYPES,
  INFILTRATION_TYPES,
  TREATMENT_TYPES,
} from './facilities.ts';
import { text, type FeatureCollection } from './geojson.ts';
import { WEAK_LINKS, type LinkHow, type Network } from './network.ts';
import type { Waters } from './waters.ts';

/** Where a drain's water ends up. Red creek, green ground, grey elsewhere/unknown. */
export type DrainClass = 'creek' | 'ground' | 'elsewhere' | 'unknown';
export const DRAIN_CLASSES: readonly DrainClass[] = ['creek', 'ground', 'elsewhere', 'unknown'];

export type EndingCode =
  | 'outfall-creek'
  | 'stream-creek'
  | 'pond-to-creek'
  | 'pond-to-creek-partial'
  | 'infiltration-pond'
  | 'infiltration-pond-overflow'
  | 'infiltration-vault'
  | 'drywell'
  | 'perforated-pipe'
  | 'pipe-to-infiltration'
  | 'pond-to-ground'
  | 'pond-to-ground-partial'
  | 'outfall-elsewhere'
  | 'stream-elsewhere'
  | 'pond-to-elsewhere'
  | 'pond-to-elsewhere-partial'
  | 'outfall-unknown'
  | 'dead-end'
  | 'gallery-unverified'
  | 'outlet-unmapped'
  | 'device-unmapped'
  | 'detention-unmapped'
  | 'pond-unmapped'
  | 'pond-other'
  | 'loop'
  | 'too-long'
  // county only (src/county/trace.ts says what each means)
  | 'discharge-point'
  | 'discharge-unknown'
  | 'downstream-creek'
  | 'not-connected'
  | 'bridge-creek'
  | 'bridge-elsewhere'
  | 'pipe-end-creek'
  | 'pipe-end-elsewhere'
  | 'discharge-by-water'
  | 'discharge-probable';

export interface Ending {
  code: EndingCode;
  cls: DrainClass;
  /** Last asset walked. */
  terminal: number;
  /** Where water leaves the map: outfall, pipe/ditch at the stream, or deciding pond. Usually the terminal. */
  exit: number;
  /** Receiving water if known, e.g. "Lake Tapps". */
  receiving: string;
  /** Plain-English reason. IDs and types only, no business names. */
  reason: string;
}

export interface Trace {
  drain: number;
  /** Asset indexes, drain to terminal. */
  path: number[];
  ending: Ending;
  /** high: outfall via recorded or touching links only; likely: any other known ending. */
  confidence: 'high' | 'likely' | 'none';
  linkCounts: Partial<Record<LinkHow, number>>;
  weakLinks: number;
  /** Meters of pipe and ditch walked. */
  pipeM: number;
}

export interface OutfallInfo {
  outfallId: string;
  pipe: string;
  receiving: string;
  /** null if receiving water unconfirmed. */
  fennel: boolean | null;
}

export interface TraceOptions {
  /** Ending this close to a stream or lake discharges into it. */
  streamTolM: number;
  /** Runaway walk stop. */
  maxSteps: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = { streamTolM: 15, maxSteps: 5000 };

export interface TraceContext {
  net: Network;
  waters: Waters;
  /** MS4 outfalls by their pipe's AssetID. */
  outfalls: ReadonlyMap<string, OutfallInfo>;
  opts?: TraceOptions;
}

/** Outfall receiving-water table (one point per permitted outfall). */
export function loadOutfalls(fc: FeatureCollection): Map<string, OutfallInfo> {
  const out = new Map<string, OutfallInfo>();
  for (const f of fc.features) {
    const p = f.properties;
    const pipe = text(p.pipe);
    if (!pipe) continue;
    const fennel = p.fennel_system === true ? true : p.fennel_system === false ? false : null;
    out.set(pipe, { outfallId: text(p.outfall_id), pipe, receiving: text(p.receiving_water), fennel });
  }
  return out;
}

/** Everyday asset name, e.g. "catch basin CB-M6-17". */
export function describe(a: Asset): string {
  const t = a.type.toLowerCase();
  let label: string;
  switch (a.kind) {
    case 'structure':
      label = a.id.startsWith('DW-') || a.type === 'Drum' ? 'drywell' : t.startsWith('catch basin') ? 'catch basin' : t.startsWith('manhole') ? 'manhole' : 'structure';
      break;
    case 'pipe':
      label = a.type === 'Culvert' ? 'culvert' : 'pipe';
      break;
    case 'channel':
      label = t.includes('swale') ? 'swale' : 'ditch';
      break;
    case 'barrier':
      label = 'ditch barrier';
      break;
    case 'pond':
      label = t.includes('infiltration') ? 'infiltration pond' : t.includes('detention') ? 'detention pond' : t.includes('swale') ? 'filtration swale' : 'pond';
      break;
    default:
      label = a.kind;
  }
  return a.id ? `${label} ${a.id}` : `unnamed ${label}`;
}

const FENNEL_RE = /fenn/i; // also catches the typo "Fennek Creek" in the pond layer

/** Recorded or touching links (no guessed gap). */
const TOUCHING_LINKS: ReadonlySet<LinkHow> = new Set(['id', 'snap', 'snap-mid', 'snap-pond']);

/** Endings where the map just stops (not a loop or unconfirmed outfall). */
const MAP_STOPS: ReadonlySet<EndingCode> = new Set([
  'dead-end',
  'gallery-unverified',
  'outlet-unmapped',
  'device-unmapped',
  'detention-unmapped',
  'pond-unmapped',
  'pond-other',
]);
const ELSEWHERE_RE = /tapps|puyallup|church lake/i;

export class Tracer {
  private readonly net: Network;
  private readonly waters: Waters;
  private readonly outfalls: ReadonlyMap<string, OutfallInfo>;
  private readonly opts: TraceOptions;

  constructor(ctx: TraceContext) {
    this.net = ctx.net;
    this.waters = ctx.waters;
    this.outfalls = ctx.outfalls;
    this.opts = ctx.opts ?? DEFAULT_TRACE_OPTIONS;
  }

  /** Traces every drain (catch basins, manholes and inlets), in asset order. */
  traceAll(): Trace[] {
    return this.net.assets.filter(isDrain).map((a) => this.trace(a.index));
  }

  trace(start: number): Trace {
    const { assets, out } = this.net;
    const path = [start];
    const seen = new Set(path);
    let cur = start;
    let ending: Ending | null = null;
    while (path.length < this.opts.maxSteps) {
      ending = this.terminalEnding(cur);
      if (ending) break;
      const next = out[cur].find((l) => !seen.has(l.to));
      if (!next) {
        if (out[cur].length > 0) {
          // every exit leads back into this walk: a loop (through a pond, ends in that pond)
          const back = out[cur][0].to;
          const pond = path.slice(path.indexOf(back)).find((k) => assets[k].kind === 'pond');
          ending =
            pond !== undefined
              ? this.pondEnding(pond)
              : this.make('loop', 'unknown', cur, `The city's map loops back on itself at ${describe(assets[back])}.`);
        } else {
          ending = this.sinkEnding(cur);
        }
        break;
      }
      path.push(next.to);
      seen.add(next.to);
      cur = next.to;
    }
    ending ??= this.make('too-long', 'unknown', cur, 'The trace ran too long to follow.');

    // passed a detention pond with a recorded discharge, then the outlet stops: use its receiving water
    // (not for loops or unconfirmed outfalls)
    if (MAP_STOPS.has(ending.code)) {
      for (let i = path.length - 2; i >= 0; i--) {
        const a = assets[path[i]];
        if (a.kind !== 'pond' || !a.toType) continue;
        const pond = this.pondEnding(path[i]);
        if (pond.cls !== 'unknown') {
          ending = {
            ...pond,
            code: `${pond.code}-partial` as EndingCode,
            terminal: cur,
            reason: `${pond.reason} Its outlet is mapped only as far as ${describe(assets[cur])}.`,
          };
        }
        break;
      }
    }

    const linkCounts: Partial<Record<LinkHow, number>> = {};
    let weakLinks = 0;
    let guessedLinks = 0;
    let pipeM = 0;
    for (let i = 0; i < path.length; i++) {
      const a = assets[path[i]];
      if (a.line) pipeM += a.lengthM;
      if (i === 0) continue;
      const link = out[path[i - 1]].find((l) => l.to === path[i])!;
      linkCounts[link.how] = (linkCounts[link.how] ?? 0) + 1;
      if (WEAK_LINKS.has(link.how)) weakLinks++;
      if (!TOUCHING_LINKS.has(link.how)) guessedLinks++;
    }
    const confidence =
      ending.cls === 'unknown' ? 'none' : ending.code.startsWith('outfall-') && guessedLinks === 0 ? 'high' : 'likely';
    return { drain: start, path, ending, confidence, linkCounts, weakLinks, pipeM: Math.round(pipeM) };
  }

  private make(code: EndingCode, cls: DrainClass, terminal: number, reason: string, receiving = '', exit = terminal): Ending {
    return { code, cls, terminal, exit, receiving, reason };
  }

  /** Walk stops here even if the map continues: outfalls, non-pass-through ponds, infiltration vaults. */
  private terminalEnding(k: number): Ending | null {
    const a = this.net.assets[k];
    if (a.line && this.outfalls.has(a.id)) return this.outfallEnding(k);
    // detention pond with a mapped outlet only slows water: pass through
    if (a.kind === 'pond' && !(DETENTION_TYPES.has(a.type) && this.net.out[k].length > 0)) return this.pondEnding(k);
    if (a.kind === 'vault' && a.type === 'Infiltration Vault') {
      return this.make('infiltration-vault', 'ground', k, `Soaks into the ground at infiltration vault ${a.id}.`);
    }
    return null;
  }

  private outfallEnding(k: number): Ending {
    const o = this.outfalls.get(this.net.assets[k].id)!;
    if (o.fennel === null || !o.receiving) {
      return this.make('outfall-unknown', 'unknown', k, `Leaves the pipes at city outfall ${o.outfallId}, but its receiving water isn't confirmed.`);
    }
    const reason = `Leaves the pipes at city outfall ${o.outfallId} into ${o.receiving}.`;
    return o.fennel
      ? this.make('outfall-creek', 'creek', k, reason, o.receiving)
      : this.make('outfall-elsewhere', 'elsewhere', k, reason, o.receiving);
  }

  pondEnding(k: number): Ending {
    const a = this.net.assets[k];
    const listed = a.toType;
    if (INFILTRATION_TYPES.has(a.type)) {
      return this.make('infiltration-pond', 'ground', k, `Soaks into the ground at infiltration pond ${a.id}.`);
    }
    if (INFILTRATION_OVERFLOW_TYPES.has(a.type)) {
      return this.make(
        'infiltration-pond-overflow',
        'ground',
        k,
        `Soaks into the ground at infiltration pond ${a.id} (it has an overflow route for big storms).`,
      );
    }
    if (DETENTION_TYPES.has(a.type) || a.type === 'Filtration Swale') {
      const what = `${a.type === 'Filtration Swale' ? 'filtration swale' : 'detention pond'} ${a.id}`;
      if (/infiltration/i.test(listed)) {
        return this.make('pond-to-ground', 'ground', k, `Flows into ${what}, which the city lists as draining to an infiltration facility.`);
      }
      if (FENNEL_RE.test(listed)) {
        return this.make('pond-to-creek', 'creek', k, `Flows into ${what}, which the city lists as draining to Fennel Creek.`, 'Fennel Creek');
      }
      if (ELSEWHERE_RE.test(listed)) {
        return this.make('pond-to-elsewhere', 'elsewhere', k, `Flows into ${what}, which the city lists as draining to ${listed}.`, listed);
      }
      return this.make('pond-unmapped', 'unknown', k, `Flows into ${what}, whose outlet isn't mapped.`);
    }
    return this.make('pond-other', 'unknown', k, `Flows into pond ${a.id}${a.type ? ` (type: ${a.type})` : ''}, with no recorded outlet.`);
  }

  /** No way out: real ending or map gap? */
  private sinkEnding(k: number): Ending {
    const a = this.net.assets[k];
    if (a.line) {
      if (a.perforated) return this.make('perforated-pipe', 'ground', k, `Soaks into the ground through perforated pipe ${a.id}.`);
      if (INFILTRATION_TYPES.has(a.toType) || INFILTRATION_OVERFLOW_TYPES.has(a.toType)) {
        return this.make('pipe-to-infiltration', 'ground', k, `${capitalize(describe(a))} is listed as draining into an infiltration facility.`);
      }
      if (DETENTION_TYPES.has(a.toType)) {
        return this.make('detention-unmapped', 'unknown', k, `Reaches a detention facility after ${describe(a)}, but its outlet isn't mapped.`);
      }
      if (TREATMENT_TYPES.has(a.toType)) {
        return this.make('device-unmapped', 'unknown', k, `Reaches a ${a.toType.toLowerCase()} after ${describe(a)}, but its outlet isn't mapped.`);
      }
    } else if (isDrywell(a)) {
      return this.make('drywell', 'ground', k, `Soaks into the ground through ${a.id.startsWith('DW-') || a.type === 'Drum' ? 'drywell' : 'open-bottom structure'} ${a.id}.`);
    } else if (a.kind === 'vault') {
      return this.make('device-unmapped', 'unknown', k, `Reaches ${(a.type || 'vault').toLowerCase()} ${a.id}, but its outlet isn't mapped.`);
    }

    // only pipe/ditch ends discharge at the water; a basin near a creek is a gap
    const end = a.line ? a.line[a.line.length - 1] : a.anchor;
    const hit = a.line || a.kind === 'outlet' ? this.waters.at(end, this.opts.streamTolM) : null;
    if (hit) {
      const reason = `${capitalize(describe(a))} ends at ${hit.water.name}.`;
      return hit.water.fennel
        ? this.make('stream-creek', 'creek', k, reason, hit.water.name)
        : this.make('stream-elsewhere', 'elsewhere', k, reason, hit.water.name);
    }
    if (a.kind === 'outlet') {
      return this.make('outlet-unmapped', 'unknown', k, `Pours out at outlet ${a.id} into a ditch or low spot the city hasn't mapped.`);
    }
    if (a.gallery) {
      return this.make('gallery-unverified', 'unknown', k, `The map stops at ${describe(a)}, tagged as a possible infiltration gallery (unverified).`);
    }
    return this.make('dead-end', 'unknown', k, `The city's map stops at ${describe(a)} (a broken or missing link).`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
