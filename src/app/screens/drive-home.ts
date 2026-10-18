// Drive home: the living pixel scene and one main key. Signed out: a quiet sign-in line. Signed in: the dashboard.
import { moneyText } from '../../drive/money.ts';
import { progressOf } from '../../drive/progress.ts';
import type { Spot } from '../../drive/spots.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { challengeCard } from '../features/challenge-ui.ts';
import { bars, button, calm, glyph, insight, meter, panel, salmonSVG, score, scoreTone, stagger } from '../ui/ui.ts';
import { weekUsd } from './drive-coach.ts';
import { needMoreLine, REC, shortDay, spotWords } from './drive-words.ts';
import { heroScene } from './hero.ts';

export interface HomeIn {
  app: App;
  /** "Pierce County, WA" */
  where: string;
  canRecord: boolean;
  busy: boolean;
  error: string;
  /** a recording was cut off by a reload */
  lost: boolean;
  /** start and stop by itself is watching for the car to move */
  waiting: boolean;
  /** the signed-in person's first name; null when signed out */
  who: string | null;
  sums: DriveSummary[];
  spots: Spot[];
  start(): void;
  sample(): void;
  finishLost(): void;
  dropLost(): void;
  openSpot(s: Spot): void;
  signIn(from: HTMLElement): void;
  /** the start-automatically guide */
  autostart(): void;
  file: HTMLInputElement;
}

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const off = (el: HTMLElement, busy: boolean) => { if (busy) el.setAttribute('disabled', ''); return el; };

// Google's mark, as Google gives it
const G_MARK = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

export function homeView(c: HomeIn): HTMLElement {
  const app = c.app, signed = c.who !== null;
  const rain = h('canvas.dv-rain', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const scene = h('div.dv-scene', {}, heroScene(), rain,
    h('div.dv-mark', { 'aria-hidden': 'true' }, h('span.dv-mark-fish', { html: salmonSVG(2) }), h('span', {}, 'TIRETRAIL')));

  const hello = signed
    ? h('header.dv-hello.dv-hello-back', {}, h('p.u-eyebrow', {}, c.where.toUpperCase()), h('h1.dv-hi', {}, c.who ? `Hi, ${c.who}.` : 'Welcome back.'))
    : h('header.dv-hello', {},
      h('p.u-eyebrow', {}, c.where.toUpperCase()),
      h('h1.dv-h1', {}, h('span', {}, 'Drive smoother.'), ' ', h('span', {}, 'Help the salmon.')),
      h('p.dv-sub', {}, 'See what hard stops and speeding cost you, and where your tire dust goes when it rains.'));

  const notes = [
    c.error ? insight({ icon: 'warn', tone: 'warn', title: c.error }) : null,
    c.lost ? h('div.dv-lost', {},
      insight({ icon: 'record', tone: 'warn', title: "Your last drive didn't finish recording.", body: 'TireTrail closed while it was recording. You can still see it.' }),
      h('div.dv-row-keys', {},
        off(button('Show it', { kind: 'secondary', onClick: c.finishLost }), c.busy),
        off(button('Delete it', { kind: 'ghost', icon: 'trash', onClick: c.dropLost }), c.busy))) : null,
  ];

  // one main key: record on a phone, the sample on a laptop
  const sampleWord = c.busy ? 'Loading the sample…' : 'Try a sample drive';
  const keys = c.canRecord
    ? h('div.dv-main', {},
      off(button(c.waiting ? 'Start now' : 'Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }), c.busy),
      c.waiting ? h('p.u-caption.dv-waiting', {}, REC.autoWaiting) : null)
    : h('div.dv-main', {},
      off(button(sampleWord, { kind: 'primary', icon: 'play', wide: true, onClick: c.sample }), c.busy),
      h('div.dv-phone', {}, ico('phone', 3), h('p', {}, h('b', {}, 'Drives record on your phone.'), ' Open TireTrail on your phone to record one.')));

  const signLine = signed ? null : h('div.dv-signin', {},
    h('p', {}, 'Sign in to save your progress and learn your hard-brake spots.'),
    signKey(c));

  const auto = button('Start automatically when you get in the car', { kind: 'ghost', icon: 'car', onClick: c.autostart });
  auto.classList.add('dv-autolink');
  auto.append(ico('chevron'));

  const links = h('nav.dv-links', { 'aria-label': 'More' },
    c.canRecord ? off(button(sampleWord, { kind: 'ghost', icon: 'play', onClick: c.sample }), c.busy) : null,
    button('How it works', { kind: 'ghost', icon: 'info', onClick: () => app.tutorial.open() }),
    button('About', { kind: 'ghost', onClick: () => app.about(() => app.screens.drive.home()) }),
    c.canRecord ? null : button('Record on this computer', { kind: 'ghost', icon: 'record', onClick: c.start }),
    c.file);

  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, keys, signLine, auto, links));
  const dock = h('div.dv-dock', {}, main, signed ? stagger(dashboard(c)) : null);
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, dock);
  startRain(rain);
  return root;
}

/** Opens the account sheet, where Google sign-in starts; Firebase starts loading on the first touch. */
function signKey(c: HomeIn): HTMLElement {
  const b = button('Sign in with Google', { kind: 'secondary', icon: G_MARK, onClick: () => c.signIn(b) });
  b.classList.add('dv-signin-key');
  return b;
}

/** Score and trend, this week's money, the streak, the top spot and this week's challenge. */
function dashboard(c: HomeIn): HTMLElement {
  if (!c.sums.length) {
    return h('section.dv-dash', { 'aria-label': 'Your driving' },
      panel([
        h('p.u-eyebrow', {}, 'YOUR SMOOTH SCORE'),
        h('p.dv-card-foot', {}, 'Record your first drive. Your score, what it cost you and your hard-brake spots show up here.'),
      ], { pad: 'm' }),
      challengeCard());
  }
  const p = progressOf(c.sums, 8), latest = p.recent[p.recent.length - 1];
  const avg = p.avgScore ?? latest.score, tone = scoreTone(avg);
  const scoreCard = panel([
    h('div.dv-card-head', {}, h('p.u-eyebrow', {}, 'SMOOTH SCORE'), h('span.dv-card-note', {}, p.drives >= 3 ? 'Last 3 drives' : p.drives === 1 ? 'Your drive' : 'Your 2 drives')),
    h('div.dv-meter-row', {}, meter(avg, 100, { blocks: 20, tone })),
    p.recent.length >= 2 ? bars(p.recent.map((d) => d.score), { labels: p.recent.map((d) => shortDay(d.at)), tone: 'you' }) : null,
    h('p.dv-card-foot', {}, p.verdictText ? `${p.verdictText}.` : needMoreLine(p.needMore)),
  ], { pad: 'm' });

  const week = weekUsd(c.sums);
  const moneyCard = panel([
    score(week, { label: 'THIS WEEK', prefix: '$', decimals: week >= 10 ? 0 : 2, tone: 'money', countUp: true }),
    h('p.dv-card-foot', {}, p.year && p.year.total.typical > 0
      ? `Extra gas and tire wear, estimated. ${moneyText(p.year.total.typical, 'year').replace(/^a/, 'A')} a year.`
      : 'Extra gas and tire wear, estimated.'),
  ], { pad: 'm' });

  const streakCard = panel([
    score(p.streak, { label: 'STREAK', suffix: p.streak === 1 ? 'DRIVE' : 'DRIVES', tone: p.streak ? 'you' : 'plain', countUp: true }),
    h('p.dv-card-foot', {}, p.streak ? 'In a row with no hard brakes.' : 'Drive with no hard brakes to start one.'),
  ], { pad: 'm' });

  const top = c.spots[0];
  const spot = top
    ? insight({ ...spotWords(top), icon: 'bell', tone: 'you', action: { label: 'See it on the map', onClick: () => c.openSpot(top) } })
    : insight({ icon: 'bell', tone: 'plain', title: 'No hard-stop spots yet.', body: 'Brake hard in the same place on 2 drives and TireTrail learns it. Next time it tells you before you get there.' });

  return h('section.dv-dash', { 'aria-label': 'Your driving' }, scoreCard, h('div.dv-pair', {}, moneyCard, streakCard), spot, challengeCard());
}

/** Slow pixel rain over the home picture; it stops when the page goes. */
function startRain(c: HTMLCanvasElement): void {
  if (calm()) return;
  const drops = Array.from({ length: 70 }, (_, i) => ({ x: (i * 97) % 400, y: (i * 53) % 220, v: 0.6 + ((i * 7) % 5) * 0.12 }));
  let g: CanvasRenderingContext2D | null = null, wait = 0;
  const step = () => {
    // not on the page yet: wait a little; gone from it: stop
    if (!c.isConnected) { if (!g && wait++ < 120) requestAnimationFrame(step); return; }
    g ??= c.getContext('2d');
    if (!g) return;
    const w = (c.width = Math.ceil(c.clientWidth / 3)), ht = (c.height = Math.ceil(c.clientHeight / 3));
    g.clearRect(0, 0, w, ht);
    g.fillStyle = 'rgba(200,232,242,.5)';
    for (const d of drops) {
      d.y += d.v;
      if (d.y > ht) { d.y = -4; d.x = (d.x + 131) % Math.max(1, w); }
      g.fillRect(Math.round(d.x % w), Math.round(d.y), 1, 3);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
