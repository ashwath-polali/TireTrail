// Drive home: the living pixel scene, one main key, and once there are drives, a dashboard.
import { moneyText } from '../../drive/money.ts';
import { progressOf } from '../../drive/progress.ts';
import type { Spot } from '../../drive/spots.ts';
import type { DriveSummary } from '../../drive/summary.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { bars, button, calm, glyph, insight, meter, panel, salmonSVG, score, scoreTone, stagger } from '../ui/ui.ts';
import { driveChips } from './drive-sheets.ts';
import { count, dayWord, monthUsd, needMoreLine, REC, shortDay, spotWords, usdShort } from './drive-words.ts';
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
  /** start and stop by itself is on */
  auto: boolean;
  /** and is watching for the car to move */
  waiting: boolean;
  sums: DriveSummary[];
  spots: Spot[];
  start(): void;
  sample(): void;
  setAuto(on: boolean): void;
  finishLost(): void;
  dropLost(): void;
  openSpot(s: Spot): void;
  openLast(): void;
  file: HTMLInputElement;
}

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const off = (el: HTMLElement, busy: boolean) => { if (busy) el.setAttribute('disabled', ''); return el; };

export function homeView(c: HomeIn): HTMLElement {
  const app = c.app, has = c.sums.length > 0;
  const rain = h('canvas.dv-rain', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const scene = h('div.dv-scene', {}, heroScene(), rain,
    h('div.dv-mark', { 'aria-hidden': 'true' }, h('span.dv-mark-fish', { html: salmonSVG(2) }), h('span', {}, 'TIRETRAIL')));

  const hello = has ? h('header.dv-hello.dv-hello-back', {}, h('p.u-eyebrow', {}, c.where.toUpperCase()))
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

  const keys = c.canRecord
    ? h('div.dv-main', {},
      off(button(c.waiting ? 'Start now' : 'Start a drive', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }), c.busy),
      off(button(c.busy ? 'Loading the sample…' : 'Try a sample drive', { kind: 'secondary', icon: 'play', wide: true, onClick: c.sample }), c.busy))
    : h('div.dv-main', {},
      off(button(c.busy ? 'Loading the sample…' : 'Try a sample drive', { kind: 'primary', icon: 'play', wide: true, onClick: c.sample }), c.busy),
      h('div.dv-phone', {}, ico('phone', 3), h('p', {}, h('b', {}, 'Drives record on your phone.'), ' Open TireTrail on your phone to record one.')));

  const sw = c.canRecord ? h('button.dv-switch', { type: 'button', role: 'switch', 'aria-checked': String(c.auto), onclick: () => c.setAuto(!c.auto) },
    h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')),
    h('span.dv-switch-text', {}, h('b', {}, 'Start and stop by itself'), h('span', {}, c.waiting ? REC.autoWaiting : REC.autoRules))) : null;

  const links = h('nav.dv-links', { 'aria-label': 'More' },
    button('How it works', { kind: 'ghost', icon: 'info', onClick: () => app.tutorial.open() }),
    button('About', { kind: 'ghost', onClick: () => app.about(() => app.screens.drive.home()) }),
    c.canRecord ? null : button('Record on this computer', { kind: 'ghost', icon: 'record', onClick: c.start }),
    c.file);

  // the main column (hello, keys, switch, links) and, with drives, the dashboard beside or below it
  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, keys, sw, links));
  const dock = h('div.dv-dock', {}, main, has ? stagger(dashboard(c)) : null);
  const root = h('div.dv-home' + (has ? '.dv-has' : '.dv-first'), {}, scene, dock);
  startRain(rain);
  return root;
}

/** Score, money this month, the streak, the top spot and the last drive. */
function dashboard(c: HomeIn): HTMLElement {
  const p = progressOf(c.sums, 8), latest = p.recent[p.recent.length - 1];
  const avg = p.avgScore ?? latest.score, tone = scoreTone(avg);
  const scoreCard = panel([
    h('div.dv-card-head', {}, h('p.u-eyebrow', {}, 'SMOOTH SCORE'), h('span.dv-card-note', {}, p.drives >= 3 ? 'Last 3 drives' : p.drives === 1 ? 'Your drive' : 'Your 2 drives')),
    h('div.dv-meter-row', {}, meter(avg, 100, { blocks: 20, tone })),
    p.recent.length >= 2 ? bars(p.recent.map((d) => d.score), { labels: p.recent.map((d) => shortDay(d.at)), tone: 'you' }) : null,
    h('p.dv-card-foot', {}, p.verdictText ? `${p.verdictText}.` : needMoreLine(p.needMore)),
  ], { pad: 'm' });

  const month = monthUsd(c.sums);
  const moneyCard = panel([
    score(month, { label: 'THIS MONTH', prefix: '$', decimals: month >= 10 ? 0 : 2, tone: 'money', countUp: true }),
    h('p.dv-card-foot', {}, p.year && p.year.total.typical > 0 ? `Lost to hard stops and speeding. ${moneyText(p.year.total.typical, 'year').replace(/^a/, 'A')} a year at this rate.` : 'Lost to hard stops and speeding.'),
  ], { pad: 'm' });

  const streakCard = panel([
    score(p.streak, { label: 'STREAK', suffix: p.streak === 1 ? 'DRIVE' : 'DRIVES', tone: p.streak ? 'you' : 'plain', countUp: true }),
    h('p.dv-card-foot', {}, p.streak ? 'In a row with no hard brakes.' : 'Drive with no hard brakes to start one.'),
  ], { pad: 'm' });

  const top = c.spots[0];
  const spot = top
    ? insight({ ...spotWords(top), icon: 'bell', tone: 'you', action: { label: 'See it on the map', onClick: () => c.openSpot(top) } })
    : insight({ icon: 'bell', tone: 'plain', title: 'No hard-stop spots yet.', body: 'Brake hard in the same place on 2 drives and TireTrail learns it. Next time it chimes before you get there.' });

  const last = c.sums[0];
  const lastCard = panel([
    h('div.dv-card-head', {}, h('p.u-eyebrow', {}, `LAST DRIVE · ${dayWord(last.at).toUpperCase()}`), ico('chevron')),
    h('p.dv-last-line', {}, `${last.mi.toFixed(1)} mi · ${usdShort(last.gas.typical + last.tires.typical)} lost`),
    driveChips(last),
  ], { onClick: c.openLast, pad: 'm' });

  return h('section.dv-dash', { 'aria-label': 'Your driving' },
    scoreCard, h('div.dv-pair', {}, moneyCard, streakCard), spot, lastCard,
    h('p.dv-dash-note', {}, `${count(p.drives, 'drive')} saved on this ${c.canRecord ? 'phone' : 'computer'}.`));
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
