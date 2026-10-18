// Share card: a 1080x1350 pixel-style PNG of one drive. No map, no route, no times (privacy).
import type { DriveReport } from '../../drive/analyze.ts';
import { button, meterLit, scoreTone, toast, type Tone } from '../ui/ui.ts';
import { shareFacts, type ShareFacts } from './share-facts.ts';
import './features.css';

export const CARD_W = 1080, CARD_H = 1350;

const C = { bg: '#0b0f0d', panel: '#121a16', sunk: '#0d1310', rim: '#2a352f', rimMid: '#44534a', off: '#18231d', text: '#eef3ef', text2: '#a9b6ae', text3: '#76837b', you: '#ffd166', youShade: '#9a7424', salmon: '#e98552', money: '#8fe38a', warn: '#ffb547', soak: '#7fd8c0' };
const TONE: Partial<Record<Tone, string>> = { money: C.money, you: C.you, warn: C.warn };
const PX = "'Silkscreen', ui-monospace, monospace", UI = "'Geist', system-ui, sans-serif";

function img(src: string): Promise<HTMLImageElement | null> {
  return new Promise((done) => {
    const i = new Image();
    i.onload = () => done(i);
    i.onerror = () => done(null);
    i.src = src;
  });
}

async function fonts(): Promise<void> {
  if (!document.fonts?.load) return;
  const wait = Promise.all([document.fonts.load(`400 96px ${PX}`), document.fonts.load(`500 40px ${UI}`), document.fonts.load(`700 40px ${UI}`)]);
  await Promise.race([wait, new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
}

/** A notched box: fill, a 4 px border, corners stepped in. */
function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, border: string): void {
  const b = 4;
  g.fillStyle = border;
  g.fillRect(x + b, y, w - 2 * b, h);
  g.fillRect(x, y + b, w, h - 2 * b);
  g.fillStyle = fill;
  g.fillRect(x + 2 * b, y + b, w - 4 * b, h - 2 * b);
  g.fillRect(x + b, y + 2 * b, w - 2 * b, h - 4 * b);
}

function wrap(g: CanvasRenderingContext2D, text: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const t = line ? `${line} ${word}` : word;
    if (g.measureText(t).width > w && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

/** A labeled panel with wrapped text and an optional sprite on the left. Returns its bottom. */
function card(g: CanvasRenderingContext2D, y: number, label: string, tone: string, text: string, sprite: HTMLImageElement | null): number {
  const x = 72, w = CARD_W - 144, pad = 32, art = sprite ? 144 + 32 : 0;
  g.font = `500 38px ${UI}`;
  const lines = wrap(g, text, w - 2 * pad - art).slice(0, 3);
  const h = Math.max(pad * 2 + 44 + lines.length * 50, sprite ? 144 + 2 * pad : 0);
  box(g, x, y, w, h, C.panel, C.rim);
  g.fillStyle = tone;
  g.fillRect(x + 8, y + 8, 8, h - 16);
  if (sprite) g.drawImage(sprite, x + pad + 8, y + (h - 144) / 2, 144, 144);
  const tx = x + pad + 8 + art;
  g.font = `400 28px ${PX}`;
  g.fillStyle = tone;
  g.fillText(label.toUpperCase(), tx, y + pad + 24);
  g.font = `500 38px ${UI}`;
  g.fillStyle = C.text;
  lines.forEach((l, i) => g.fillText(l, tx, y + pad + 82 + i * 50));
  return y + h;
}

/** Draws the card for these facts. */
export async function drawShareCard(f: ShareFacts): Promise<HTMLCanvasElement> {
  const [, car, fish] = await Promise.all([fonts(), img('sprites/car.png'), img('art/icon-salmon.png')]);
  const cv = document.createElement('canvas');
  cv.width = CARD_W;
  cv.height = CARD_H;
  const g = cv.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.bg;
  g.fillRect(0, 0, CARD_W, CARD_H);
  // a faint dot grid
  g.fillStyle = '#111813';
  for (let y = 4; y < CARD_H; y += 24) for (let x = 4; x < CARD_W; x += 24) g.fillRect(x, y, 4, 4);
  // frame
  g.fillStyle = C.rimMid;
  g.fillRect(32, 28, CARD_W - 64, 4); g.fillRect(32, CARD_H - 32, CARD_W - 64, 4);
  g.fillRect(28, 32, 4, CARD_H - 64); g.fillRect(CARD_W - 32, 32, 4, CARD_H - 64);

  // wordmark
  if (car) g.drawImage(car, 72, 64, 128, 128);
  let size = 104;
  g.font = `400 ${size}px ${PX}`;
  while (g.measureText('TIRETRAIL').width > CARD_W - 72 - 232 && size > 48) g.font = `400 ${(size -= 4)}px ${PX}`;
  g.fillStyle = C.youShade;
  g.fillText('TIRETRAIL', 224, 160 + 8);
  g.fillStyle = C.you;
  g.fillText('TIRETRAIL', 224, 160);
  g.font = `500 32px ${UI}`;
  g.fillStyle = C.text2;
  g.fillText(f.date, 228, 210);

  // score
  const tone = TONE[scoreTone(f.score)] ?? C.you;
  g.font = `400 32px ${PX}`;
  g.fillStyle = C.text2;
  g.fillText('SMOOTH SCORE', 72, 272);
  g.font = `400 200px ${PX}`;
  const num = String(f.score);
  g.fillStyle = '#000';
  g.globalAlpha = 0.45;
  g.fillText(num, 64, 456 + 14);
  g.globalAlpha = 1;
  g.fillStyle = tone;
  g.fillText(num, 64, 456);
  const nw = g.measureText(num).width;
  g.font = `400 48px ${PX}`;
  g.fillStyle = C.text3;
  g.fillText('/100', 64 + nw + 20, 456);
  // segmented meter
  const n = 20, lit = meterLit(f.score, 100, n), mx = 72, my = 488, mw = CARD_W - 144, mh = 64;
  box(g, mx, my, mw, mh, C.sunk, C.rim);
  const gap = 6, bw = (mw - 24 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const bx = Math.round(mx + 12 + i * (bw + gap)), w = Math.round(bw);
    g.fillStyle = i < lit ? tone : C.off;
    g.fillRect(bx, my + 12, w, mh - 24);
    if (i < lit) {
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(bx, my + mh - 24, w, 12);
      g.fillStyle = 'rgba(255,255,255,.3)';
      g.fillRect(bx, my + 12, w, 4);
    }
  }

  // facts
  let y = 580;
  y = card(g, y, 'Money', C.money, f.money, null) + 20;
  y = card(g, y, 'Hardest spot', C.warn, f.spot, null) + 20;
  card(g, y, 'Salmon', C.salmon, f.salmon, fish);

  g.font = `500 28px ${UI}`;
  g.fillStyle = C.text3;
  g.fillText('Drive smoother. Help the salmon.', 72, CARD_H - 56);
  return cv;
}

/** The card as a PNG. at: when the drive started (only the date shows). */
export async function shareCard(report: DriveReport, at: number = Date.now()): Promise<Blob> {
  const cv = await drawShareCard(shareFacts(report, at));
  return new Promise((done, fail) => cv.toBlob((b) => (b ? done(b) : fail(new Error('no PNG'))), 'image/png'));
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A button that shares the drive as an image, or saves it where sharing files isn't supported. */
export function shareButton(report: DriveReport, opts: { at?: number; label?: string } = {}): HTMLElement {
  const name = `tiretrail-${new Date(opts.at ?? Date.now()).toISOString().slice(0, 10)}.png`;
  let file: File | null = null;
  // made ahead, so the share opens right from the tap (Safari needs that)
  const making = shareCard(report, opts.at).then((b) => (file = new File([b], name, { type: 'image/png' })));
  making.catch(() => {});
  const go = (f: File) => {
    const data = { files: [f], title: 'My TireTrail drive' };
    if (navigator.canShare?.(data)) {
      navigator.share(data).catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        download(f);
      });
    } else {
      download(f);
      toast('Saved the picture', { icon: 'check' });
    }
  };
  return button(opts.label ?? 'Share this drive', {
    kind: 'secondary', icon: 'share',
    onClick: () => {
      if (file) { go(file); return; }
      making.then(go, () => toast("Couldn't make the picture", { icon: 'warn' }));
    },
  });
}
