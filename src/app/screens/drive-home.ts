// Drive home: the living pixel scene behind one panel with one main key, Start by itself and quiet links.
// Signed in: one timely note (rain ahead, or coho season) and one line for the week, a tap from My drives.
// The account sits in the corner on a phone, in the top bar on a laptop.
import { weekStart } from '../../drive/gas.ts';
import { weekStats } from '../../drive/creeks.ts';
import { homeNote, rainKnown, type Note } from '../../intel/index.ts';
import { forecastPage } from '../../intel/rain.ts';
import { nwsSource, RAIN_BODY, rainTitle, rainWhy, SEASON_LINE, SEASON_WHY, SRC, weekLine, type Source } from '../../intel/words.ts';
import type { App } from '../app.ts';
import { accountEntry } from '../cloud/account.ts';
import { h } from '../dom.ts';
import { bitmapSVG } from '../ui/glyphs.ts';
import { button, calm, glyph, insight, salmonSVG, stagger } from '../ui/ui.ts';
import { autoRow } from './autostart.ts';
import { animate, heroScene } from './hero.ts';
import { HOME_LINE, HOME_TITLE } from './home-words.ts';
import { driveSummaries } from './saved.ts';
import { crossingsOf, findCrossings, needsCrossings } from './history-creeks.ts';
import './home.css';

export interface HomeIn {
  app: App;
  /** "Washington" */
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
      h('h1.dv-h1', {}, h('span', {}, HOME_TITLE[0]), ' ', h('span', {}, HOME_TITLE[1])),
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
    button('About', { kind: 'ghost', onClick: () => app.about(() => app.screens.drive.home()) }),
    c.file);

  const sums = driveSummaries();
  const now = signed ? h('div.hm-now', {}, noteSlot(sums), weekRow(app)) : null;
  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, key, phone ? autoRow(c) : qrCard(), now, links));
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, accountEntry('dv-acct'), h('div.dv-dock', {}, main));
  startRain(rain, rainKnown(sums));
  return root;
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

/** This week in one line: gentle at so many creek crossings. A tap opens My drives. */
function weekRow(app: App): HTMLElement | null {
  const sums = driveSummaries(), w = weekStats(sums, weekStart(), crossingsOf);
  const line = weekLine({ ...w, drives: w.drives.length }, sums.length > 0);
  if (!line) return null;
  const [head, rest] = line.split(': ');
  if (needsCrossings(sums)) void findCrossings(sums).then((more) => { if (more) dispatchEvent(new CustomEvent('tt:drives')); });
  return h('button.hm-week', { type: 'button', onclick: () => app.setTab('drives') },
    h('span.hm-week-fish', { 'aria-hidden': 'true', html: salmonSVG(2) }),
    rest ? h('span.hm-text', {}, h('span.hm-eyebrow', {}, head), h('span.hm-week-line', {}, ` ${rest[0].toUpperCase()}${rest.slice(1)}`)) : h('span.hm-week-line', {}, line),
    h('span.hm-go', { 'aria-hidden': 'true', html: glyph('arrow', 2) }));
}

// ---------- rain ahead and coho season ----------

/** A rain cloud: C cloud, S its underside. The drops are drawn on their own so they can fall. */
const CLOUD = [
  '.....CCCCC.....',
  '...CCCCCCCCC...',
  '..CCCCCCCCCCCC.',
  '.CCCCCCCCCCCCCC',
  'CCCCCCCCCCCCCCC',
  'SSSSSSSSSSSSSSS',
  '.SSSSSSSSSSSSS.',
];
const DROPS = [
  '..D....D....D..',
  '.D....D....D...',
  '...............',
  '....D....D....D',
  '...D....D....D.',
];
/** A spawning coho: red flanks, dark green back, green head with the hooked jaw, pale belly. */
const SPAWNER = [
  '........DDDDD.......',
  'T.....DDDDDDDDDD....',
  'TT..DDRRRRRRRRGGGG..',
  '.TTRRRRRRRRRRRGGEGG.',
  'TT..RRRRRRRRRRRGGGGG',
  'T....PPPPPPPPPPGG..G',
  '.......R...R........',
];

const rainIcon = () => h('span.hm-ico.hm-ico-rain', { 'aria-hidden': 'true' },
  h('span.hm-cloud', { html: bitmapSVG(CLOUD, 2, { C: '#c9d4cf', S: '#8a9a92' }) }),
  h('span.hm-drops', { html: bitmapSVG(DROPS, 2, { D: '#9fd3ea' }) }));
const cohoIcon = () => h('span.hm-ico.hm-ico-coho', { 'aria-hidden': 'true',
  html: bitmapSVG(SPAWNER, 2, { T: '#a33a30', D: '#3c5a43', R: '#d2453a', G: '#5f9a63', E: '#0b0f0d', P: '#e9b9a8' }) });

/** One timely note: what is kept shows at once, the fresh forecast when it lands, nothing offline. */
function noteSlot(sums: Parameters<typeof homeNote>[0]): HTMLElement {
  const slot = h('div.hm-slot', { 'aria-live': 'polite' });
  const { now, next } = homeNote(sums);
  const key = (n: Note) => (n ? (n.kind === 'rain' ? `rain:${n.r.when}:${n.r.mm}:${n.f.place}` : `season:${n.season}`) : '');
  let shown = key(now);
  if (now) slot.append(noteView(now));
  void next.then((n) => {
    if (!slot.isConnected || key(n) === shown) return;
    shown = key(n);
    slot.replaceChildren(...(n ? [noteView(n, true)] : []));
  });
  return slot;
}

/** The note: a line (two for rain); a tap opens why it matters and the sources. */
function noteView(n: NonNullable<Note>, fresh = false): HTMLElement {
  const rain = n.kind === 'rain';
  const lines = rain ? rainWhy(n.f, n.r) : SEASON_WHY;
  const srcs: Source[] = rain ? [nwsSource(forecastPage(n.f)), SRC.scholz, SRC.tian] : [SRC.quinn, SRC.scholz];
  return h(`details.hm-note.hm-${rain ? 'rain' : 'season'}${fresh && !calm() ? '.hm-in' : ''}`, {},
    h('summary.hm-sum', {},
      rain ? rainIcon() : cohoIcon(),
      h('span.hm-text', {},
        h('b.hm-title', {}, rain ? rainTitle(n.r.when) : SEASON_LINE[n.season]),
        rain ? h('span.hm-body', {}, RAIN_BODY) : null),
      h('span.hm-more', { 'aria-hidden': 'true', html: glyph('chevron', 2) })),
    h('div.hm-why', {},
      ...lines.map((l) => h('p', {}, l)),
      h('ul.hm-src', { 'aria-label': 'Sources' }, ...srcs.map((s) => h('li', {}, h('a', { href: s.href, target: '_blank', rel: 'noopener' }, s.label))))));
}

/**
 * Slow pixel rain over the home picture, drawn at a third of the size. It rests and stops with the picture.
 * It follows the forecast: heavier with rain ahead, a light drizzle on a dry day, the usual with no forecast.
 */
function startRain(c: HTMLCanvasElement, wet: boolean | null): void {
  if (calm()) return;
  const n = wet === null ? 70 : wet ? 120 : 18, fast = wet ? 1.25 : 1;
  const drops = Array.from({ length: n }, (_, i) => ({ x: (i * 97) % 400, y: (i * 53) % 220, v: (0.6 + ((i * 7) % 5) * 0.12) * fast }));
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
