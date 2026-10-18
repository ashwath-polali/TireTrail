// Community totals in one Firestore document, community/totals. Signed-in drives add to it once each; anyone can read it.
// Never blocks the app: every failure is quiet, and an unsent drive waits for the next try.
import type { DriveReport } from '../../drive/analyze.ts';
import { driveAdd, scoreboardLine, totalsFromRest, type CommunityAdd, type CommunityTotals } from '../../drive/community.ts';
import type { StopClass } from '../../drive/tips.ts';
import type { LngLat } from '../../geo/geo.ts';
import { h } from '../dom.ts';
import { formatNumber, stat } from '../ui/ui.ts';
import { authPhase, person, prepare } from './auth.ts';
import { cloudNow, FIREBASE_CONFIG, loadCloud } from './firebase.ts';
import '../features/features.css';

const SENT = 'tt-community-sent';
const WAIT = 'tt-community-wait';

type Waiting = { id: number; add: CommunityAdd };

function read<T>(key: string, d: T): T {
  try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? d; } catch { return d; }
}
function write(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or blocked */ }
}

let flushing: Promise<void> | null = null;

/**
 * Call right after a drive is saved. at: the drive's id (when it started).
 * clsAt: where rain at a point goes, so gentle stops above salmon streams count. Only counts while signed in.
 */
export function countDrive(at: number, report: DriveReport, clsAt?: (p: LngLat) => StopClass): void {
  try {
    if (!person()) return;
    const sent = read<number[]>(SENT, []), wait = read<Waiting[]>(WAIT, []);
    if (sent.includes(at) || wait.some((w) => w.id === at)) return;
    const add = driveAdd(report, clsAt);
    if (!add) return;
    write(WAIT, [...wait, { id: at, add }].slice(-20));
    void flush();
  } catch (e) { console.warn(e); }
}

/** Sends waiting drives. Runs again when the phone comes back online. */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!person() || !read<Waiting[]>(WAIT, []).length) return;
    if (authPhase() !== 'ready' && !(await prepare())) return;
    if (!person()) return;
    const [c, m] = await Promise.all([loadCloud(), import('./community-sdk.ts')]);
    for (const w of read<Waiting[]>(WAIT, [])) {
      try {
        await m.addDrive(c.db, w.add);
      } catch (e) {
        // the rules said no: this one never will go, so drop it
        if (String((e as { code?: unknown })?.code) !== 'permission-denied') throw e;
      }
      write(SENT, [...read<number[]>(SENT, []), w.id].slice(-200));
      write(WAIT, read<Waiting[]>(WAIT, []).filter((x) => x.id !== w.id));
    }
  })().catch((e) => { console.warn('Community count will try again:', e); }).finally(() => { flushing = null; });
  return flushing;
}

try { addEventListener('online', () => { void flush(); }); } catch { /* no window */ }

/** The totals, or null when offline or there are none. Reads without loading Firebase. */
export async function communityTotals(): Promise<CommunityTotals | null> {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/community/totals?key=${FIREBASE_CONFIG.apiKey}`;
    const res = await fetch(url);
    if (res.ok) return totalsFromRest(await res.json());
    if (res.status === 404) return null;
  } catch { /* offline, or the REST call is blocked */ }
  // Firebase is already loaded (signed in): ask it instead
  const c = cloudNow();
  if (!c) return null;
  try {
    const d = await (await import('./community-sdk.ts')).readTotals(c.db);
    const f = (x: unknown) => (typeof x === 'number' && x >= 0 ? x : 0);
    return d ? { drives: f(d.drives), smoothStops: f(d.smoothStops), salmonSmoothStops: f(d.salmonSmoothStops), miles: f(d.miles), updated: null } : null;
  } catch { return null; }
}

/** The scoreboard for every TireTrail driver. Starts hidden and stays hidden when offline or empty. */
export function communityCard(opts: { totals?: CommunityTotals | null } = {}): HTMLElement {
  const el = h('section.u-panel.u-plain.u-pad-m.f-community', { hidden: true, 'aria-label': 'All TireTrail drivers' });
  const fill = (t: CommunityTotals | null) => {
    const line = scoreboardLine(t);
    if (!t || !line) { el.hidden = true; return; }
    el.replaceChildren(
      h('p.u-eyebrow', {}, 'All TireTrail drivers'),
      h('div.u-grid3', { 'aria-hidden': 'true' },
        stat('Drives', formatNumber(t.drives), { tone: 'you' }),
        stat('Smooth stops above salmon streams', formatNumber(t.salmonSmoothStops), { tone: 'salmon' }),
        stat('Miles', formatNumber(t.miles), { tone: 'plain' })),
      h('p.u-caption.f-community-line', {}, `${line}.`));
    el.hidden = false;
  };
  if (opts.totals !== undefined) fill(opts.totals);
  else void communityTotals().then(fill, () => fill(null));
  return el;
}
