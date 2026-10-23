// Share card: a 1080x1350 pixel-style PNG of one drive, salmon first. No map, no route, no times, nothing near home (privacy).
import type { DriveReport } from '../../drive/analyze.ts';
import type { LngLat } from '../../geo/geo.ts';
import { button, toast } from '../ui/ui.ts';
import { shareFacts, type Crossing, type ShareFacts } from './share-facts.ts';
import { CODE_COHO } from '../screens/pixel-anim.ts';
import './features.css';

export const CARD_W = 1080, CARD_H = 1350;

const C = { bg: '#0b0f0d', panel: '#121a16', sunk: '#0d1310', rim: '#2a352f', rimMid: '#44534a', off: '#18231d', text: '#eef3ef', text2: '#a9b6ae', text3: '#76837b', you: '#ffd166', youShade: '#9a7424', salmon: '#e98552', money: '#8fe38a', warn: '#ffb547', soak: '#7fd8c0' };
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
  const x = 72, w = CARD_W - 144, pad = 32, art = sprite ? 112 + 32 : 0;
  g.font = `500 38px ${UI}`;
  const lines = wrap(g, text, w - 2 * pad - art).slice(0, 2);
  const h = Math.max(pad * 2 + 44 + lines.length * 50, sprite ? 112 + 2 * pad : 0);
  box(g, x, y, w, h, C.panel, C.rim);
  g.fillStyle = tone;
  g.fillRect(x + 8, y + 8, 8, h - 16);
  if (sprite) g.drawImage(sprite, x + pad + 8, y + (h - 112) / 2, 112, 112);
  const tx = x + pad + 8 + art;
  g.font = `400 28px ${PX}`;
  g.fillStyle = tone;
  g.fillText(label.toUpperCase(), tx, y + pad + 24);
  g.font = `500 38px ${UI}`;
  g.fillStyle = C.text;
  lines.forEach((l, i) => g.fillText(l, tx, y + pad + 82 + i * 50));
  return y + h;
}

/** A tile with a big pixel number and up to 2 caption lines. */
function tile(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, tone: string, big: string, caps: string[]): void {
  box(g, x, y, w, h, C.panel, C.rim);
  g.fillStyle = tone;
  g.fillRect(x + 8, y + 8, w - 16, 8);
  g.font = `400 28px ${PX}`;
  g.fillStyle = C.text2;
  g.fillText(label, x + 32, y + 68);
  let size = 128;
  g.font = `400 ${size}px ${PX}`;
  while (g.measureText(big).width > w - 64 && size > 48) g.font = `400 ${(size -= 8)}px ${PX}`;
  g.fillStyle = '#000';
  g.globalAlpha = 0.45;
  g.fillText(big, x + 28, y + 186 + 10);
  g.globalAlpha = 1;
  g.fillStyle = tone;
  g.fillText(big, x + 28, y + 186);
  g.font = `500 32px ${UI}`;
  g.fillStyle = C.text2;
  caps.slice(0, 2).forEach((c, i) => g.fillText(fit(g, c, w - 64), x + 32, y + 236 + i * 38));
}

/** text cut to fit w, with an ellipsis */
function fit(g: CanvasRenderingContext2D, t: string, w: number): string {
  if (g.measureText(t).width <= w) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Draws the card for these facts: salmon first, then tire dust. */
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

  // the headline, up to 3 lines, beside a tiny coho
  g.font = `700 56px ${UI}`;
  g.fillStyle = C.text;
  const head = wrap(g, f.headline, CARD_W - 144 - 96).slice(0, 3);
  head.forEach((l, i) => g.fillText(l, 72 + 96, 316 + i * 68));
  g.save();
  g.translate(72, 270);
  g.scale(5, 5);
  CODE_COHO.draw(g, 0, 0, 0);
  g.restore();
  let y = 316 + (head.length - 1) * 68 + 60;

  // salmon streams crossed (when checked) and tire dust
  const tw = (CARD_W - 144 - 24) / 2, th = 300, near = Math.abs(f.dustPct) < 5, less = f.dustPct < 0;
  if (f.streams !== null) tile(g, 72, y, tw, th, 'SALMON STREAMS', C.salmon, String(f.streams), [f.streams ? 'crossed' : 'none crossed', 'this drive']);
  const dx = f.streams !== null ? 72 + tw + 24 : 72;
  tile(g, dx, y, CARD_W - 72 - dx, th, 'TIRE DUST', near || less ? C.money : C.warn, near ? f.grams.replace(/(\d) g$/, '$1g') : `${Math.abs(f.dustPct)}%`,
    near ? ['about typical', 'estimated'] : [`${less ? 'less' : 'more'} than typical`, `${f.grams}, estimated`]);
  y += th + 24;

  // the salmon: the streams by name, or where the hard brakes' rain goes
  y = card(g, y, f.creeks.length ? 'Streams crossed' : 'Salmon', C.salmon, f.creeks.length ? f.creeks.join(', ') : f.salmon, fish) + 24;

  // smooth driving: hard brakes and fast starts
  const sh = 130;
  for (const [i, label, n] of [[0, 'HARD BRAKES', f.hard], [1, 'FAST STARTS', f.fast]] as const) {
    const x = 72 + i * (tw + 24);
    box(g, x, y, tw, sh, C.panel, C.rim);
    g.font = `400 28px ${PX}`;
    g.fillStyle = C.text2;
    g.fillText(label, x + 32, y + 56);
    g.font = `400 64px ${PX}`;
    g.fillStyle = n ? C.warn : C.money;
    g.fillText(String(n), x + 28, y + 112);
  }

  g.font = `500 30px ${UI}`;
  g.fillStyle = C.text3;
  g.fillText('Save gas. Help the salmon.', 72, CARD_H - 64);
  g.textAlign = 'right';
  g.fillText('tiretrail.vercel.app', CARD_W - 72, CARD_H - 64);
  g.textAlign = 'left';
  return cv;
}

/** The card as a PNG. at: when the drive started (only the date shows). ends: where it started and ended, kept off the card. crossings: salmon streams crossed, if checked. */
export async function shareCard(report: DriveReport, at: number = Date.now(), ends: readonly LngLat[] = [], crossings: readonly Crossing[] | null = null): Promise<Blob> {
  const cv = await drawShareCard(shareFacts(report, at, ends, crossings));
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
export function shareButton(report: DriveReport, opts: { at?: number; label?: string; ends?: readonly LngLat[]; crossings?: readonly Crossing[] | null } = {}): HTMLElement {
  const name = `tiretrail-${new Date(opts.at ?? Date.now()).toISOString().slice(0, 10)}.png`;
  let file: File | null = null;
  // made ahead, so the share opens right from the tap (Safari needs that)
  const making = shareCard(report, opts.at, opts.ends, opts.crossings ?? null).then((b) => (file = new File([b], name, { type: 'image/png' })));
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
