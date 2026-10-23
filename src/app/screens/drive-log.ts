// A drive's log on this phone (pauses, what was said, the motion summary), and the report's checking tools:
// the "not recorded" line, Every event, and Share drive data. Works for older drives from what they kept.
import type { DriveReport } from '../../drive/analyze.ts';
import { driveFile, driveFileName, everyEvent, gapLine, gapsOf, readLog, SAID_WORDS, type DriveLog } from '../../drive/drivelog.ts';
import type { Fix } from '../../drive/types.ts';
import { h } from '../dom.ts';
import { button, glyph, toast } from '../ui/ui.ts';
import { timeWord } from './drive-words.ts';

declare const __BUILD__: string;

const KEY = 'tt-drive-log';
/** logs kept, and how many of the newest keep their motion summary */
const MAX = 8, WITH_MOTION = 2;

function all(): DriveLog[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return (Array.isArray(raw) ? raw : []).flatMap((x) => readLog(x) ?? []);
  } catch { return []; }
}

/** Keeps a drive's log; older logs lose their motion first when the phone is full. False if it can't be kept. */
export function saveLog(log: DriveLog): boolean {
  const list = [log, ...all().filter((l) => l.at !== log.at)].sort((a, b) => b.at - a.at).slice(0, MAX)
    .map((l, i) => (i < WITH_MOTION ? l : { ...l, motion: null }));
  for (let keep = WITH_MOTION; keep >= 0; keep--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.map((l, i) => (i < keep ? l : { ...l, motion: null }))));
      return true;
    } catch { /* full: drop more motion */ }
  }
  return false;
}

/** The log kept for a drive, or null (older drives, the sample). */
export function logFor(at: number): DriveLog | null {
  return all().find((l) => l.at === at) ?? null;
}

export function forgetLog(at: number): void {
  try { localStorage.setItem(KEY, JSON.stringify(all().filter((l) => l.at !== at))); } catch { /* blocked */ }
}

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const label = (text: string) => h('p.u-eyebrow.dv-label', {}, text);

export interface CoachExtras {
  /** one line when part of the drive wasn't recorded, else null */
  note: HTMLElement | null;
  /** for the report's Details: Every event, and Share drive data */
  details: HTMLElement[];
}

export interface ExtrasIn {
  report: DriveReport;
  fixes: readonly Fix[];
  log: DriveLog | null;
  at: number;
  sample: boolean;
  /** a place name at a lon/lat, '' if none */
  place(ll: [number, number]): string;
  /** shows one event on the map */
  show?(ll: readonly [number, number]): void;
}

/** The report's checking tools for one drive. */
export function coachExtras(c: ExtrasIn): CoachExtras {
  const gaps = c.sample ? [] : gapsOf(c.fixes, c.log), gl = gapLine(gaps);
  const note = gl ? h('p.dv-gap-note', {}, ico('pause'), h('span', {}, gl)) : null;
  const rows = everyEvent(c.report, c.log, c.place);
  const list = rows.length
    ? h('ol.dv-ev', {}, ...rows.map((r) => {
      const kids = [
        h('span.dv-ev-main', {}, h('b', {}, `${r.what}, ${r.strength}`), h('span', {}, [timeWord(r.t), r.place].filter(Boolean).join(' · '))),
        r.said ? h('span.dv-ev-said', { 'data-said': r.said }, SAID_WORDS[r.said]) : null,
      ];
      const ll = r.ll, show = c.show;
      // a tap flies the map to it
      return h('li.dv-ev-row', { 'data-what': r.what === 'Over the limit' ? 'speeding' : r.what === 'Fast start' ? 'start' : 'brake' },
        ll && show ? h('button.dv-ev-go', { type: 'button', 'aria-label': `${r.what}, ${r.strength}, ${r.place || timeWord(r.t)}. Show it on the map.`, onclick: () => show(ll) }, ...kids) : h('div.dv-ev-go', {}, ...kids));
    }))
    : h('p.u-caption', {}, 'No hard brakes, fast starts or speeding on this drive.');
  const how = c.sample ? null : h('p.u-caption', {},
    [c.report.sensor ? 'Measured with location and the motion sensor.' : 'Measured with location only, no motion sensor.', c.log ? '' : "This drive didn't keep what was said."].filter(Boolean).join(' '));
  const events = h('section.dv-sec.dv-d-events', {}, label(rows.length ? `EVERY EVENT · ${rows.length}` : 'EVERY EVENT'), list, how);
  const share = c.sample ? null : h('section.dv-sec.dv-d-share', {},
    label('DRIVE DATA'),
    h('p.u-caption', {}, "A file of this drive's readings. It includes the full route, start to end."),
    button('Share drive data', { kind: 'secondary', icon: 'share', onClick: () => void shareDrive(c) }));
  return { note, details: [events, share].filter((x): x is HTMLElement => !!x) };
}

/** Shares the drive's file (the phone's share sheet), or downloads it. */
async function shareDrive(c: ExtrasIn): Promise<void> {
  const data = driveFile({ report: c.report, fixes: c.fixes, log: c.log, at: c.at, build: typeof __BUILD__ === 'string' ? __BUILD__ : '', device: navigator.userAgent });
  const name = driveFileName(c.at), text = JSON.stringify(data);
  try {
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'TireTrail drive data' });
      return;
    }
  } catch (e) {
    // closed the share sheet: nothing to do
    if ((e as Error)?.name === 'AbortError') return;
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('Saved the drive data file.', { icon: 'check', ms: 3000 });
  } catch {
    toast("This browser can't save the file.", { icon: 'info', ms: 4000 });
  }
}
