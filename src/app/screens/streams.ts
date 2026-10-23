// Salmon stream crossings kept on each saved drive, for this week's creek strip on home and My drives.
import type { DriveSummary } from '../../drive/summary.ts';
import { salmonTripFor } from '../../salmon/row.ts';
import { allSummaries, saveSummary, trackOf, unpack } from './saved.ts';

/** Keeps a saved drive's crossings once the report knows them. */
export function noteStreams(at: number, n: number): void {
  const s = allSummaries().find((x) => x.at === at);
  if (!s || s.streams === n) return;
  if (saveSummary({ ...s, streams: n })) dispatchEvent(new CustomEvent('tt:drives'));
}

const tried = new Set<number>();

/** Counts crossings for recent drives saved before they were kept, from routes on this phone. True if any were added. */
export async function fillStreams(sums: readonly DriveSummary[], since: number): Promise<boolean> {
  let added = false;
  for (const s of sums) {
    if (s.at < since || s.streams != null || tried.has(s.at)) continue;
    tried.add(s.at);
    const d = trackOf(s.at);
    if (!d) continue;
    try {
      const t = await salmonTripFor(d.fixes.map(unpack), s.brakes.map((b) => [b.lon, b.lat]));
      if (!t) continue;
      const now = allSummaries().find((x) => x.at === s.at);
      if (now && now.streams == null && saveSummary({ ...now, streams: t.crossed })) added = true;
    } catch { /* this drive just shows no fish */ }
  }
  return added;
}
