// Drive home: the living pixel scene behind one panel with one main key, Start by itself and quiet links.
// Signed in: this week's challenge. The account sits in the corner on a phone, in the top bar on a laptop.
import type { StopClass } from '../../drive/tips.ts';
import type { App } from '../app.ts';
import { accountEntry } from '../cloud/account.ts';
import { h } from '../dom.ts';
import { challengeCard } from '../features/challenge-ui.ts';
import { button, calm, glyph, insight, salmonSVG, stagger } from '../ui/ui.ts';
import { autoOkAt, setupSeen } from './autostart.ts';
import { autoStatus } from './autostart-words.ts';
import { animate, heroScene } from './hero.ts';
import { HOME_LINE, salmonCount, salmonLine } from './home-words.ts';
import { driveSummaries } from './saved.ts';

export interface HomeIn {
  app: App;
  /** "Pierce County, WA" */
  where: string;
  canRecord: boolean;
  busy: boolean;
  error: string;
  /** a recording was cut off by a reload */
  lost: boolean;
  /** Start by itself is on */
  auto: boolean;
  /** the signed-in person's first name; null when signed out */
  who: string | null;
  start(): void;
  sample(): void;
  finishLost(): void;
  dropLost(): void;
  /** opens the account sheet; home's corner button does this itself now */
  signIn(from: HTMLElement): void;
  setAuto(on: boolean): void;
  /** the Start by itself setup */
  setup(): void;
  file: HTMLInputElement;
}

/** The address the laptop's code points to. */
export const SITE = 'tiretrail.vercel.app';

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const off = (el: HTMLElement, busy: boolean) => { if (busy) el.setAttribute('disabled', ''); return el; };

export function homeView(c: HomeIn): HTMLElement {
  const app = c.app, signed = c.who !== null, phone = c.canRecord;
  // a laptop that already has drives opens them first; the sample comes second
  const mine = signed && !phone && driveSummaries().length > 0;
  const rain = h('canvas.dv-rain', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const scene = h('div.dv-scene', {}, heroScene(), rain,
    h('div.dv-mark', { 'aria-hidden': 'true' }, h('span.dv-mark-fish', { html: salmonSVG(2) }), h('span', {}, 'TIRETRAIL')));

  const hello = signed
    ? h('header.dv-hello.dv-hello-back', {}, h('p.u-eyebrow', {}, c.where.toUpperCase()), h('h1.dv-hi', {}, c.who ? `Hi, ${c.who}.` : 'Welcome back.'))
    : h('header.dv-hello', {},
      h('p.u-eyebrow', {}, c.where.toUpperCase()),
      h('h1.dv-h1', {}, h('span', {}, 'Drive smoother.'), ' ', h('span', {}, 'Help the salmon.')),
      h('p.dv-sub', {}, HOME_LINE));

  const notes = [
    c.error ? insight({ icon: 'warn', tone: 'warn', title: c.error }) : null,
    c.lost ? h('div.dv-lost', {},
      insight({ icon: 'record', tone: 'warn', title: "Your last drive didn't finish recording." }),
      h('div.dv-row-keys', {},
        off(button('Show it', { kind: 'secondary', onClick: c.finishLost }), c.busy),
        off(button('Delete it', { kind: 'ghost', icon: 'trash', onClick: c.dropLost }), c.busy))) : null,
  ];

  // one main key: record on a phone; on a laptop, your drives once there are some, else the sample
  const sampleWord = c.busy ? 'Loading the sample…' : 'Try a sample drive';
  const key = phone
    ? off(button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }), c.busy)
    : mine
      ? button('See my drives', { kind: 'primary', icon: 'list', wide: true, onClick: () => app.setTab('drives') })
      : off(button(sampleWord, { kind: 'primary', icon: 'play', wide: true, onClick: c.sample }), c.busy);

  // sign-in lives in the corner (phone) or the top bar (laptop), not here
  const links = h('nav.dv-links', { 'aria-label': 'More' },
    phone || mine ? off(button(sampleWord, { kind: 'ghost', onClick: c.sample }), c.busy) : null,
    button('How it works', { kind: 'ghost', onClick: () => app.tutorial.open() }),
    c.file);

  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, key, phone ? autoRow(c) : qrCard(), signed ? weekCard(c) : null, links));
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, accountEntry('dv-acct'), h('div.dv-dock', {}, main));
  startRain(rain);
  return root;
}

/** Start by itself: one switch, one status line. The status line opens the setup. */
function autoRow(c: HomeIn): HTMLElement {
  const ok = autoOkAt();
  const sw = h('button.dv-switch.dv-auto-sw', {
    type: 'button', role: 'switch', 'aria-checked': String(c.auto), 'aria-describedby': 'auto-status',
    onclick: () => {
      const on = !c.auto;
      c.setAuto(on);
      if (on && !setupSeen()) c.setup();
    },
  }, h('span.dv-switch-text', {}, h('b', {}, 'Start by itself')), h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')));
  const status = autoStatus({ on: c.auto, okAt: ok });
  // the time stays on one line
  const [a, b] = status.split(' · ');
  const said = h('span', {}, a, b ? ' · ' : '', b ? h('span.dv-nw', {}, b) : '');
  const line = c.auto
    ? h('button.dv-auto-line', { type: 'button', id: 'auto-status', 'aria-label': `${status}. Opens the setup`, onclick: () => c.setup() }, said, ico('chevron'))
    : h('p.dv-auto-line', { id: 'auto-status' }, said);
  return h('section.dv-auto-row' + (c.auto ? '.dv-on' : ''), { 'aria-label': 'Start by itself' }, sw, line);
}

/** Laptop: drives record on a phone, so a code to open TireTrail there. */
function qrCard(): HTMLElement {
  return h('section.dv-qr', { 'aria-label': 'Drive with it on your phone' },
    h('img.dv-qr-code', { src: 'qr.svg', alt: `Code that opens ${SITE}`, width: '132', height: '132', draggable: 'false' }),
    h('div.dv-qr-text', {},
      h('h2.dv-qr-title', {}, 'Drive with it on your phone'),
      h('p.dv-qr-line', {}, 'Point your phone camera at the code.'),
      h('p.dv-qr-site', {}, SITE)));
}

/**
 * This week: the challenge (a tap shows how, and the streak) and one salmon line.
 * The score, money leaks and salmon totals live on My drives, so home doesn't repeat them.
 */
function weekCard(c: HomeIn): HTMLElement {
  const app = c.app;
  const clsAt = (ll: [number, number]): StopClass => {
    const d = app.data.nearestDrain(ll, 50);
    return d ? (app.world.drainCls(d.drain.index) as StopClass) : 'none';
  };
  const card = challengeCard({ foot: () => fishLine(salmonLine(salmonCount(driveSummaries(), clsAt))) });
  card.classList.add('dv-week');
  return card;
}

const fishLine = (s: string) => h('p.dv-week-fish', {}, h('span.dv-fish', { 'aria-hidden': 'true', html: salmonSVG(2) }), h('span', {}, s));

/** Slow pixel rain over the home picture, drawn at a third of the size. It rests and stops with the picture. */
function startRain(c: HTMLCanvasElement): void {
  if (calm()) return;
  const drops = Array.from({ length: 70 }, (_, i) => ({ x: (i * 97) % 400, y: (i * 53) % 220, v: 0.6 + ((i * 7) % 5) * 0.12 }));
  let g: CanvasRenderingContext2D | null = null, last = 0;
  animate(c, 20, (now) => {
    g ??= c.getContext('2d');
    if (!g) return;
    // resizing clears the canvas, so only when the box changes
    const w = Math.max(1, Math.ceil(c.clientWidth / 3)), ht = Math.max(1, Math.ceil(c.clientHeight / 3));
    if (c.width !== w || c.height !== ht) { c.width = w; c.height = ht; }
    // drops fall at the same speed whatever the frame rate; a long rest doesn't jump them
    const k = last ? Math.min(6, (now - last) / 16.7) : 1;
    last = now;
    g.clearRect(0, 0, w, ht);
    g.fillStyle = 'rgba(200,232,242,.5)';
    for (const d of drops) {
      d.y += d.v * k;
      if (d.y > ht) { d.y = -4; d.x = (d.x + 131) % w; }
      g.fillRect(Math.round(d.x % w), Math.round(d.y), 1, 3);
    }
  });
}
