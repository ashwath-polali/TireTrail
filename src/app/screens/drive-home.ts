// Drive home: the living pixel scene, one main key, Start by itself, and quiet links. Signed in: one "this week" card.
import { challengeOf } from '../../drive/challenge.ts';
import { progressOf } from '../../drive/progress.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { StopClass } from '../../drive/tips.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { challengeDrives } from '../features/challenge-ui.ts';
import { bars, button, calm, chip, glyph, insight, panel, salmonSVG, scoreTone, stagger } from '../ui/ui.ts';
import { autoOkAt, setupSeen } from './autostart.ts';
import { autoStatus } from './autostart-words.ts';
import { shortDay } from './drive-words.ts';
import { heroScene } from './hero.ts';
import { moneyLine, salmonCount, salmonLine } from './home-words.ts';

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
  sums: DriveSummary[];
  start(): void;
  sample(): void;
  finishLost(): void;
  dropLost(): void;
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
  const rain = h('canvas.dv-rain', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const scene = h('div.dv-scene', {}, heroScene(), rain,
    h('div.dv-mark', { 'aria-hidden': 'true' }, h('span.dv-mark-fish', { html: salmonSVG(2) }), h('span', {}, 'TIRETRAIL')));

  const hello = signed
    ? h('header.dv-hello.dv-hello-back', {}, h('p.u-eyebrow', {}, c.where.toUpperCase()), h('h1.dv-hi', {}, c.who ? `Hi, ${c.who}.` : 'Welcome back.'))
    : h('header.dv-hello', {},
      h('p.u-eyebrow', {}, c.where.toUpperCase()),
      h('h1.dv-h1', {}, h('span', {}, 'Drive smoother.'), ' ', h('span', {}, 'Help the salmon.')),
      h('p.dv-sub', {}, 'Save on gas and tires. Keep tire dust out of salmon streams.'));

  const notes = [
    c.error ? insight({ icon: 'warn', tone: 'warn', title: c.error }) : null,
    c.lost ? h('div.dv-lost', {},
      insight({ icon: 'record', tone: 'warn', title: "Your last drive didn't finish recording." }),
      h('div.dv-row-keys', {},
        off(button('Show it', { kind: 'secondary', onClick: c.finishLost }), c.busy),
        off(button('Delete it', { kind: 'ghost', icon: 'trash', onClick: c.dropLost }), c.busy))) : null,
  ];

  // one main key: record on a phone, the sample on a laptop
  const sampleWord = c.busy ? 'Loading the sample…' : 'Try a sample drive';
  const key = phone
    ? off(button('Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }), c.busy)
    : off(button(sampleWord, { kind: 'primary', icon: 'play', wide: true, onClick: c.sample }), c.busy);

  const signLink = signed ? null : button('Sign in', { kind: 'ghost', onClick: () => c.signIn(signLink!) });
  const links = h('nav.dv-links', { 'aria-label': 'More' },
    phone ? off(button(sampleWord, { kind: 'ghost', onClick: c.sample }), c.busy) : null,
    button('How it works', { kind: 'ghost', onClick: () => app.tutorial.open() }),
    signLink,
    c.file);

  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, key, phone ? autoRow(c) : qrCard(), links));
  const dock = h('div.dv-dock', {}, main, signed ? stagger(h('div.dv-dash', {}, weekCard(c))) : null);
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, dock);
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

/** One card for the week: score and its trend, the challenge, one money line, one salmon line. Opens My drives. */
function weekCard(c: HomeIn): HTMLElement {
  const app = c.app, open = () => app.setTab('drives');
  const card = panel([], { onClick: open });
  card.classList.add('dv-week');
  if (!c.sums.length) {
    card.append(
      h('p.u-eyebrow', {}, 'THIS WEEK'),
      h('p.dv-week-empty', {}, 'Your first drive shows up here.'),
      fishLine(salmonLine({ gentle: 0, hard: 0, week: true })));
    return card;
  }
  const p = progressOf(c.sums, 7), avg = p.avgScore ?? 0, tone = scoreTone(avg);
  let ch = null as ReturnType<typeof challengeOf> | null;
  try { ch = challengeOf(challengeDrives(), Date.now()); } catch { /* no goal this week */ }
  const chTone = ch?.state === 'done' ? 'money' : ch?.state === 'missed' ? 'warn' : 'you';
  const left = ch ? (ch.state === 'done' ? 'Done' : ch.state === 'missed' ? 'Missed' : ch.daysLeft <= 1 ? 'Last day' : `${ch.daysLeft} days left`) : '';

  const clsAt = (ll: [number, number]): StopClass => {
    const d = app.data.nearestDrain(ll, 50);
    return d ? (app.world.drainCls(d.drain.index) as StopClass) : 'none';
  };
  const money = moneyLine(p.year ? p.year.total.typical : null);

  card.append(...[
    h('div.u-spread', {}, h('p.u-eyebrow', {}, 'THIS WEEK'), h('span.dv-week-go', {}, 'My drives', ico('chevron'))),
    h('div.dv-week-score', { 'data-tone': tone },
      h('div.dv-week-num', {},
        h('span.u-sr', {}, `Smooth score ${avg} out of 100`),
        h('b', { 'aria-hidden': 'true' }, String(avg)),
        h('span', { 'aria-hidden': 'true' }, p.verdictText ?? (p.drives >= 3 ? 'Smooth score, last 3 drives' : 'Smooth score'))),
      p.recent.length >= 2 ? bars(p.recent.map((d) => d.score), { labels: p.recent.map((d) => shortDay(d.at)), tone: 'you' }) : null),
    ch ? h('div.dv-week-ch', {},
      h('div.u-spread', {}, h('p.dv-week-ch-t', {}, ch.title), chip(left, ch.state === 'open' ? 'plain' : chTone)),
      h('div.f-ch-row', {},
        h('div.f-ch-blocks', { 'data-tone': chTone, role: 'img', 'aria-label': `${ch.got} of ${ch.need} done` },
          ...Array.from({ length: ch.need }, (_, i) => h('i' + (i < ch.got ? '.f-on' : ''), {}, i < ch.got ? h('span', { html: glyph('check', 2) }) : null))),
        h('span.f-ch-count', { 'data-tone': chTone }, `${ch.got}/${ch.need}`))) : null,
    money ? h('p.dv-week-line', {}, ico('coin'), h('span', {}, money, h('small', {}, ' · estimate'))) : null,
    fishLine(salmonLine(salmonCount(c.sums, clsAt))),
  ].filter((x): x is HTMLElement => !!x));
  return card;
}

const fishLine = (s: string) => h('p.dv-week-line.dv-week-fish', {}, h('span.dv-fish', { 'aria-hidden': 'true', html: salmonSVG(2) }), h('span', {}, s));

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
