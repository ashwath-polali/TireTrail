// The weekly challenge card: this week's goal, progress blocks, and smooth-drive streaks.
import { challengeOf, type Challenge, type ChallengeDrive } from '../../drive/challenge.ts';
import type { LngLat } from '../../geo/geo.ts';
import { h } from '../dom.ts';
import { driveSummaries, savedDrives } from '../screens/saved.ts';
import { chip, glyph, stat, type Tone } from '../ui/ui.ts';
import './features.css';

/** Every saved drive, with its route when this phone still has it. */
export function challengeDrives(): ChallengeDrive[] {
  const tracks = new Map(savedDrives().map((d) => [d.at, d.fixes.map((f): LngLat => [f[2] as number, f[1] as number])]));
  return driveSummaries().map((s) => ({ at: s.at, hardBrakes: s.hardBrakes, brakes: s.brakes, track: tracks.get(s.at) ?? null }));
}

const STATE: Record<Challenge['state'], { tone: Tone; word: string }> = {
  open: { tone: 'plain', word: '' },
  done: { tone: 'money', word: 'Done' },
  missed: { tone: 'warn', word: 'Missed' },
};

function note(c: Challenge): string {
  if (c.state === 'done') return c.kind === 'spot' ? `You drove past it ${c.need} times with no hard brake. Nice work.` : `${c.need} smooth drives this week. Nice work.`;
  if (c.state === 'missed') return c.kind === 'spot' ? 'You braked hard there this week. A new goal starts Monday.' : 'A new goal starts Monday.';
  return c.how;
}

function render(c: Challenge): HTMLElement[] {
  const s = STATE[c.state];
  const tone: Tone = c.state === 'done' ? 'money' : c.state === 'missed' ? 'warn' : 'you';
  const left = c.state === 'open' ? (c.daysLeft <= 1 ? 'Last day' : `${c.daysLeft} days left`) : s.word;
  const blocks = h('div.f-ch-blocks', { 'data-tone': tone, role: 'img', 'aria-label': `${c.got} of ${c.need} done` },
    ...Array.from({ length: c.need }, (_, i) => h('i' + (i < c.got ? '.f-on' : ''), {}, i < c.got ? h('span', { html: glyph('check', 2) }) : null)));
  return [
    h('div.u-spread', {}, h('p.u-eyebrow.f-ch-eyebrow', {}, 'This week'), chip(left, c.state === 'open' ? 'plain' : s.tone)),
    h('h3.f-ch-title', {}, c.title),
    h('div.f-ch-row', {}, blocks, h('span.f-ch-count', { 'data-tone': tone }, `${c.got}/${c.need}`)),
    h('p.u-caption', {}, note(c)),
    h('div.u-grid2', {},
      stat('Smooth drives in a row', String(c.streak), { tone: c.streak ? 'money' : 'plain' }),
      stat('Best streak', String(c.best), { tone: 'plain', hint: 'A smooth drive has no hard brakes' })),
  ];
}

/** The card. It redraws itself when drives are saved, deleted or come back from the backup. */
export function challengeCard(opts: { now?: () => number; drives?: () => ChallengeDrive[] } = {}): HTMLElement {
  const now = opts.now ?? Date.now, drives = opts.drives ?? challengeDrives;
  const el = h('section.u-panel.u-plain.u-pad-m.f-ch', { 'aria-label': 'Weekly challenge' });
  const draw = () => { try { el.replaceChildren(...render(challengeOf(drives(), now()))); } catch (e) { console.warn(e); } };
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
