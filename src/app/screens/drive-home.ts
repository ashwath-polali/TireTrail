// Drive home: the living pixel scene behind one panel with one main key, Start by itself and quiet links.
// Signed in: this week's challenge. The account sits in the corner on a phone, in the top bar on a laptop.
// A small key in the scene's bottom left swaps the creek for the night drive toward Rainier, and back.
import type { StopClass } from '../../drive/tips.ts';
import type { App } from '../app.ts';
import { accountEntry } from '../cloud/account.ts';
import { h } from '../dom.ts';
import { challengeCard } from '../features/challenge-ui.ts';
import { button, calm, glyph, insight, salmonSVG, stagger } from '../ui/ui.ts';
import { autoRow } from './autostart.ts';
import { animate, heroScene } from './hero.ts';
import { keepScene, nextScene, savedScene, type HomeScene } from './home-scene.ts';
import { HOME_LINE, salmonCount, salmonLine, weekStopBoxes } from './home-words.ts';
import { nightLoaded, nightScene } from './night-road.ts';
import { driveSummaries } from './saved.ts';

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
  const scene = h('div.dv-scene', {}, h('div.dv-layer', { 'data-scene': 'creek' }, heroScene(), rain),
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
    button('About', { kind: 'ghost', onClick: () => app.about(() => app.screens.drive.home()) }),
    c.file);

  const main = stagger(h('div.dv-dock-main', {}, hello, ...notes, key, phone ? autoRow(c) : qrCard(), signed ? weekCard(c) : null, links));
  // the picture key comes last, so Tab reaches the panel first
  const root = h('div.dv-home' + (signed ? '.dv-has' : '.dv-first'), {}, scene, accountEntry('dv-acct'), h('div.dv-dock', {}, main), pictureKey(scene));
  startRain(rain);
  return root;
}

/** The creek or the night drive. The night sits on top and fades in steps; the hidden one rests. */
function pictureKey(scene: HTMLElement): HTMLElement {
  const creek = scene.firstElementChild as HTMLElement;
  let night: HTMLElement | null = null, now: HomeScene = savedScene(), turn = 0, timer = 0;
  const nightLayer = () => {
    night ??= h('div.dv-layer.dv-off', { 'data-scene': 'night', 'data-rest': '' }, nightScene());
    if (!night.isConnected) creek.after(night);
    return night;
  };
  const show = (s: HomeScene) => {
    const n = ++turn, top = nightLayer(), under = s === 'night' ? creek : top;
    now = s;
    scene.dataset.scene = s;
    clearTimeout(timer);
    // both move while they cross, then the hidden one rests
    creek.removeAttribute('data-rest');
    top.removeAttribute('data-rest');
    const go = () => {
      if (n !== turn) return;
      void top.offsetWidth;
      top.classList.toggle('dv-off', s === 'creek');
      // a night picture that didn't load leaves the creek showing, so the creek keeps moving
      const settle = () => { if (n === turn && !(s === 'night' && top.querySelector('.missing'))) under.setAttribute('data-rest', ''); };
      if (calm()) settle(); else timer = window.setTimeout(settle, 450);
    };
    // the night fades in once it's drawn
    if (s === 'night') void nightLoaded().then(go); else go();
  };
  if (now === 'night') {
    // straight in, no fade
    nightLayer().classList.remove('dv-off');
    night!.removeAttribute('data-rest');
    creek.setAttribute('data-rest', '');
  }
  scene.dataset.scene = now;
  return h('button.u-btn.u-secondary.u-square.dv-flip', {
    type: 'button', 'aria-label': 'Change the picture', title: 'Change the picture', html: glyph('cycle'),
    onclick: () => { const s = nextScene(now); keepScene(s); show(s); },
  });
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
 * The score, money leaks, tire dust and salmon totals live on My drives, so home doesn't repeat them.
 */
function weekCard(c: HomeIn): HTMLElement {
  const app = c.app;
  const clsAt = (ll: [number, number]): StopClass => {
    const d = app.data.nearestDrain(ll, 50);
    return d ? (app.world.drainCls(d.drain.index) as StopClass) : 'none';
  };
  const foot = () => h('div.dv-week-foot', {}, fishLine(salmonLine(salmonCount(driveSummaries(), clsAt))));
  const card = challengeCard({ foot });
  card.classList.add('dv-week');
  // the pipe areas under this week's stops may not be loaded yet (after a reload): load them, then say the line again
  const boxes = weekStopBoxes(driveSummaries());
  if (boxes.length) {
    setTimeout(() => void Promise.all(boxes.map((b) => app.ensureAreas(b, 2).catch(() => false))).then((got) => {
      if (got.some(Boolean)) card.querySelector('.dv-week-foot')?.replaceWith(foot());
    }), 400);
  }
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
