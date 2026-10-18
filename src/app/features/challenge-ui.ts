// The weekly challenge strip: this week's goal and progress blocks; a tap shows how, and the smooth-drive streak.
import { challengeOf, type Challenge, type ChallengeDrive } from '../../drive/challenge.ts';
import type { LngLat } from '../../geo/geo.ts';
import { h } from '../dom.ts';
import { driveSummaries, savedDrives } from '../screens/saved.ts';
import { glyph, type Tone } from '../ui/ui.ts';
import { challengeLeft, challengeNote, streakNote } from './challenge-words.ts';
import './features.css';

/** Every saved drive, with its route when this phone still has it. */
export function challengeDrives(): ChallengeDrive[] {
  const tracks = new Map(savedDrives().map((d) => [d.at, d.fixes.map((f): LngLat => [f[2] as number, f[1] as number])]));
  return driveSummaries().map((s) => ({ at: s.at, hardBrakes: s.hardBrakes, brakes: s.brakes, track: tracks.get(s.at) ?? null }));
}

function render(c: Challenge, open: boolean, flip: () => void): HTMLElement[] {
  const tone: Tone = c.state === 'done' ? 'money' : c.state === 'missed' ? 'warn' : 'you';
  const blocks = h('span.f-ch-blocks', { 'data-tone': tone, 'aria-hidden': 'true' },
    ...Array.from({ length: c.need }, (_, i) => h('i' + (i < c.got ? '.f-on' : ''), {}, i < c.got ? h('span', { html: glyph('check', 2) }) : null)));
  const key = h('button.f-ch-key', { type: 'button', 'aria-expanded': String(open), onclick: flip },
    h('span.f-ch-top', {},
      h('span.u-eyebrow.f-ch-eyebrow', {}, 'This week'),
      h('span.f-ch-left', { 'data-tone': c.state === 'open' ? 'plain' : tone }, challengeLeft(c)),
      h('span.f-ch-chev', { 'aria-hidden': 'true', html: glyph('chevron') })),
    h('span.f-ch-title', {}, c.title),
    h('span.f-ch-row', {}, blocks, h('span.f-ch-count', { 'data-tone': tone }, `${c.got}/${c.need}`), h('span.u-sr', {}, `${c.got} of ${c.need} done`)));
  return [key, open ? h('div.f-ch-more', {}, h('p', {}, challengeNote(c)), h('p', {}, streakNote(c))) : null].filter((n): n is HTMLElement => !!n);
}

/** The strip. It redraws itself when drives are saved, deleted or come back from the backup. */
export function challengeCard(opts: { now?: () => number; drives?: () => ChallengeDrive[] } = {}): HTMLElement {
  const now = opts.now ?? Date.now, drives = opts.drives ?? challengeDrives;
  const el = h('section.u-panel.u-plain.u-pad-m.f-ch', { 'aria-label': 'Weekly challenge' });
  let open = false;
  const draw = () => {
    try {
      const had = el.contains(document.activeElement);
      el.replaceChildren(...render(challengeOf(drives(), now()), open, () => { open = !open; draw(); }));
      if (had) el.querySelector<HTMLElement>('.f-ch-key')?.focus();
    } catch (e) { console.warn(e); }
  };
  draw();
  const on = (e?: Event) => {
    if (!el.isConnected && el.dataset.seen) { removeEventListener('tt:drives', on); removeEventListener('storage', on); return; }
    if (e instanceof StorageEvent && e.key !== 'tt-sums') return;
    draw();
  };
  addEventListener('tt:drives', on);
  addEventListener('storage', on);
  requestAnimationFrame(() => { if (el.isConnected) el.dataset.seen = '1'; });
  return el;
}
