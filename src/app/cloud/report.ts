// The report a drive's own phone showed, kept on its summary so the backup carries it (src/drive/report-copy.ts).
// Another device reads it back in place of its own reading of the trimmed route: the same headline, creeks, fix, miles and minutes.
import { makeCopy, type CreekCopy } from '../../drive/report-copy.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import { reportHead } from '../screens/drive-words.ts';
import { allSummaries, saveSummary } from '../screens/saved.ts';
import { stableJson } from './merge.ts';

/** What the phone's report showed, as the drive screen knows it once its creeks are in. */
export interface PhoneReading {
  creeks: readonly { name: string; gentle: boolean; at: readonly [number, number] }[];
  /** the fix line, '' for nothing to fix */
  fix: string;
  /** where the fix was, so the backup can leave out one near home */
  fixLl: readonly [number, number] | null;
  miles: number;
  sec: number;
}

/** Keeps the phone's reading on its drive's summary; the next sync sends it. False when unchanged or not saved. */
export function noteReport(at: number, r: PhoneReading): boolean {
  const s = allSummaries().find((x) => x.at === at);
  if (!s) return false;
  const rep = makeCopy(r.creeks, r.fix, r.fixLl, r.miles, r.sec);
  if (stableJson(s.rep ?? null) === stableJson(rep)) return false;
  return saveSummary({ ...s, rep });
}

/** A drive's report as its phone read it: headline, creeks, fix (undefined: not carried), miles and minutes. */
export interface Carried {
  /** null on older backups: the device reads its own route for these */
  head: string | null;
  creeks: CreekCopy[] | null;
  fix?: string;
  mi: number;
  min: number;
}

/** What another device shows for a drive whose route here is the backup's trimmed one. Older backups still give the phone's miles and minutes. Pure. */
export function carried(s: Pick<DriveSummary, 'rep' | 'mi' | 'min' | 'hardBrakes' | 'fastStarts'>): Carried {
  const rep = s.rep;
  if (!rep) return { head: null, creeks: null, mi: s.mi, min: Math.max(1, Math.round(s.min)) };
  return { head: reportHead(rep.creeks, s.hardBrakes, s.fastStarts), creeks: rep.creeks, ...(rep.fix != null ? { fix: rep.fix } : {}), mi: rep.mi, min: rep.min };
}

/** carried() for a drive saved here, or null. */
export function carriedFor(at: number): Carried | null {
  const s = allSummaries().find((x) => x.at === at);
  return s ? carried(s) : null;
}
