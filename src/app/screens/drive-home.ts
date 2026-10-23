// Drive home: the living pixel scene behind one panel. The headline is what matters for today's drive (rain ahead, else
// coho season) when signed in, else what TireTrail does. Then one main key, Start by itself, and the way into My drives.
// The account sits in the corner on a phone, in the top bar on a laptop; How it works and About sit in its sheet.
import { weekStart } from '../../drive/gas.ts';
import { weekStats } from '../../drive/creeks.ts';
import { homeNote, rainKnown, type Note } from '../../intel/index.ts';
import { forecastPage } from '../../intel/rain.ts';
import { RAIN_DO, rainLine, rainTitle, SEASON_LINE, SEASON_SUB, weekLine } from '../../intel/words.ts';
import type { App } from '../app.ts';
import { accountEntry } from '../cloud/account.ts';
import { h } from '../dom.ts';
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
  const app = c.app, signed = c.who !== null, phone = c.canRecord, sums = driveSummaries();
  // a laptop that already has drives opens them first; the sample comes second
  const mine = signed && !phone && sums.length > 0;
  const rain = h('canvas.dv-rain', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const scene = h('div.dv-scene', {}, heroScene(), rain,
    h('div.dv-mark', { 'aria-hidden': 'true' }, h('span.dv-mark-fish', { html: salmonSVG(2) }), h('span', {}, 'TIRETRAIL')));

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

  // signed in, How it works and About live in the account sheet; a first visit keeps them here
  const links = h('nav.dv-links', { 'aria-label': 'More' },
    !signed && phone ? off(button(sampleWord, { kind: 'ghost', onClick: c.sample }), c.busy) : null,
    signed ? null : button('How it works', { kind: 'ghost', onClick: () => app.tutorial.open() }),
    signed ? null : button('About', { kind: 'ghost', onClick: () => app.about(() => app.screens.drive.home()) }),
    c.file);

  // the headline: what matters for today's drive when signed in (rain ahead, else coho season), else what TireTrail does
  const lead = signed ? leadSlot(app, sums) : pitch();
  const week = signed ? weekRow(app, sums) : null;
  const main = stagger(h('div.dv-dock-main', {}, lead, ...notes, key, phone ? autoRow(c) : qrCard(), week, links));
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, accountEntry('dv-acct'), h('div.dv-dock', {}, main));
  startRain(rain, rainKnown(sums));
  return root;
}

/** What TireTrail does, in two lines and one more. */
function pitch(): HTMLElement {
  return h('header.dv-hello', {},
    h('h1.dv-h1', {}, h('span', {}, HOME_TITLE[0]), ' ', h('span', {}, HOME_TITLE[1])),
    h('p.dv-sub', {}, HOME_LINE));
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

/** The way into My drives, in its own words: how many drives this week. */
function weekRow(app: App, sums: ReturnType<typeof driveSummaries>): HTMLElement | null {
  const w = weekStats(sums, weekStart(), crossingsOf), line = weekLine(w.drives.length, sums.length > 0);
  if (!line) return null;
  if (needsCrossings(sums)) void findCrossings(sums).then((more) => { if (more) dispatchEvent(new CustomEvent('tt:drives')); });
  return h('div.hm-now', {}, h('button.hm-week', { type: 'button', onclick: () => app.setTab('drives') },
    h('span.hm-week-ico', { 'aria-hidden': 'true', html: glyph('map', 2) }),
    h('span.hm-week-line', {}, line),
    h('span.hm-go', { 'aria-hidden': 'true', html: glyph('arrow', 2) })));
}

// ---------- rain ahead and coho season ----------

/** PixelLab icons: rain (heavier from half an inch) and a leaping coho. */
const art = (src: string) => h('img', { src, alt: '', width: '32', height: '32', draggable: 'false' });
const rainIcon = (mm: number) => h('span.hm-ico.hm-ico-rain', { 'aria-hidden': 'true' },
  art(mm >= 12.7 ? 'art/home/icon-heavy-rain.png' : 'art/home/icon-rain.png'));
const cohoIcon = () => h('span.hm-ico.hm-ico-coho', { 'aria-hidden': 'true' }, art('art/home/icon-spawning.png'));

/** The headline slot: the kept note at once, the fresh forecast when it lands; the pitch with no note. */
function leadSlot(app: App, sums: Parameters<typeof homeNote>[0]): HTMLElement {
  const slot = h('div.dv-lead', { 'aria-live': 'polite' });
  const { now, next } = homeNote(sums);
  const key = (n: Note) => (n ? (n.kind === 'rain' ? `rain:${n.r.when}:${n.r.mm}:${n.f.place}` : `season:${n.season}`) : '');
  let shown = key(now);
  slot.append(leadFor(app, now));
  void next.then((n) => {
    if (!slot.isConnected || key(n) === shown) return;
    shown = key(n);
    slot.replaceChildren(leadFor(app, n, true));
  });
  return slot;
}

/** Rain: "Rain tonight. Brake gently today." and the forecast. Season: the coho line. One link to why, on About. */
function leadFor(app: App, n: Note, fresh = false): HTMLElement {
  if (!n) return pitch();
  const rain = n.kind === 'rain';
  const why = h('button.dv-why', { type: 'button', onclick: () => app.about(() => app.screens.drive.home(), true, 'sources') }, rain ? 'Why rain matters' : 'When coho return');
  return h(`header.dv-hello.dv-note.dv-note-${rain ? 'rain' : 'season'}${fresh && !calm() ? '.hm-in' : ''}`, {},
    h('h1.dv-h1.dv-h1-note', {}, rain ? rainIcon(n.r.mm) : cohoIcon(), h('span', {}, rain ? `${rainTitle(n.r.when)} ${RAIN_DO}` : SEASON_LINE[n.season])),
    rain
      ? h('p.dv-sub', {}, `${rainLine(n.f, n.r)} `, h('a.dv-src', { href: forecastPage(n.f), target: '_blank', rel: 'noopener' }, 'National Weather Service'))
      : h('p.dv-sub', {}, SEASON_SUB),
    why);
}

/**
 * Slow pixel rain over the home picture, drawn at a third of the size. It rests and stops with the picture.
 * It follows the forecast: heavier with rain ahead, none on a dry day, the usual with no forecast.
 */
function startRain(c: HTMLCanvasElement, wet: boolean | null): void {
  if (calm() || wet === false) return;
  const n = wet ? 120 : 70, fast = wet ? 1.25 : 1;
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
