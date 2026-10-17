// Labels for estimates, and the calibration tables (how often the estimate names the traced water).
import type { Estimate } from './estimate.ts';

const far = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

/** Short label the app can show; '' when there's no estimate. */
export function labelFor(e: Estimate): string {
  const coho = e.coho === 'yes' ? ', a coho stream' : e.coho === 'possible' ? ', which may carry coho' : '';
  switch (e.kind) {
    case 'stream':
      if (e.name) return `Estimated: heads toward ${e.name}${coho}`;
      return e.into ? `Estimated: heads toward an unnamed stream that runs into ${e.into}${coho}` : `Estimated: heads toward an unnamed stream${coho}`;
    case 'lake':
      return `Estimated: heads toward ${e.name || 'an unnamed lake or pond'}${coho}`;
    case 'sound':
      return 'Estimated: heads toward Puget Sound';
    case 'depression':
      return 'Estimated: runs into a low spot with no outlet, so it probably soaks in';
    default:
      return '';
  }
}

/** One plain sentence on how the estimate was made, for the ending's reason. */
export function reasonFor(e: Estimate): string {
  const tail = ' This is an estimate from the lay of the land: ditches, pipes and drywells can send the water elsewhere.';
  const coho =
    e.coho === 'yes'
      ? e.cohoDownstreamM
        ? `, which runs on into coho water about ${far(e.cohoDownstreamM)} downstream`
        : ', a stream WDFW maps as coho habitat'
      : e.coho === 'possible'
        ? ', which WDFW lists as possible coho habitat'
        : '';
  const water =
    e.kind === 'stream'
      ? e.name || (e.into ? `an unnamed stream that runs into ${e.into}` : 'an unnamed stream')
      : e.kind === 'lake'
        ? e.name || 'an unnamed lake or pond'
        : 'Puget Sound';
  if (e.kind === 'stream' || e.kind === 'lake' || e.kind === 'sound') {
    return `Following the ground downhill from where the map ends, the water likely reaches ${water}${e.kind === 'sound' ? '' : coho} about ${far(e.distanceM)} away.${tail}`;
  }
  if (e.kind === 'depression') return `Following the ground downhill from where the map ends, the water runs about ${far(e.distanceM)} into a low spot with no outlet, so it probably soaks in.${tail}`;
  return '';
}

/** "North Fork Clover Creek" and "north fork clover creek." match; unnamed waters give ''. */
export function normName(s: string): string {
  const t = s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(an?|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /unnamed/.test(t) ? '' : t;
}

export type Outcome = 'same water' | 'same system' | 'other named water' | 'unnamed water' | 'Puget Sound' | 'low spot' | 'no answer';
export const OUTCOMES: readonly Outcome[] = ['same water', 'same system', 'other named water', 'unnamed water', 'Puget Sound', 'low spot', 'no answer'];

/** How an estimate compares with the water the tracer found. */
export function outcome(e: Estimate, truth: string): Outcome {
  if (e.kind === 'unknown') return 'no answer';
  if (e.kind === 'depression') return 'low spot';
  if (e.kind === 'sound') return /sound|bay|inlet|harbor|passage|narrows/i.test(truth) ? 'same water' : 'Puget Sound';
  const t = normName(truth);
  const own = normName(e.name);
  // an unnamed traced water can only be matched by an unnamed estimate
  if (!t) return own ? 'other named water' : 'unnamed water';
  const names = [own, own ? '' : normName(e.into ?? '')].filter(Boolean);
  if (!names.length) return 'unnamed water';
  if (names.includes(t)) return 'same water';
  // "North Fork Clover Creek Tributary 5" for "North Fork Clover Creek", or the other way round
  if (names.some((n) => n.startsWith(`${t} `) || t.startsWith(`${n} `))) return 'same system';
  return 'other named water';
}

/** The class the app would give: creek (coho), elsewhere (other water), ground, unknown. */
export function estimateClass(e: Estimate): 'creek' | 'creek?' | 'elsewhere' | 'ground' | 'unknown' {
  if (e.kind === 'unknown') return 'unknown';
  if (e.kind === 'depression') return 'ground';
  if (e.kind === 'sound') return 'elsewhere';
  return e.coho === 'yes' ? 'creek' : e.coho === 'possible' ? 'creek?' : 'elsewhere';
}

/** Counts of rows x columns. */
export class Table {
  readonly cells = new Map<string, number>();
  readonly rows: string[] = [];
  readonly cols: string[];
  constructor(cols: readonly string[]) {
    this.cols = [...cols];
  }
  add(row: string, col: string, n = 1): void {
    if (!this.rows.includes(row)) this.rows.push(row);
    if (!this.cols.includes(col)) this.cols.push(col);
    this.cells.set(`${row}\t${col}`, (this.cells.get(`${row}\t${col}`) ?? 0) + n);
  }
  get(row: string, col: string): number {
    return this.cells.get(`${row}\t${col}`) ?? 0;
  }
  toJSON(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.rows.map((r) => [r, Object.fromEntries(this.cols.map((c) => [c, this.get(r, c)]))]));
  }
  text(title: string): string {
    const w0 = Math.max(title.length, ...this.rows.map((r) => r.length)) + 2;
    const ws = this.cols.map((c) => Math.max(c.length, 5) + 2);
    const line = (a: string, xs: string[]) => a.padEnd(w0) + xs.map((x, k) => x.padStart(ws[k])).join('');
    const out = [line(title, this.cols)];
    for (const r of this.rows) out.push(line(r, this.cols.map((c) => String(this.get(r, c)))));
    const tot = this.cols.map((c) => this.rows.reduce((s, r) => s + this.get(r, c), 0));
    out.push(line('total', tot.map(String)));
    return out.join('\n');
  }
}
