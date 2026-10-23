// Share your week: a 1080x1350 picture for family. The creek scene with its coho, the week's line and the one fix. No map, no places near home.
import { drawScene, sceneReady } from '../screens/history-scene.ts';
import { button, toast } from '../ui/ui.ts';
import { box, C, CARD_H, CARD_W, download, fonts, img, PX, UI, wrap } from './share.ts';

export interface WeekFacts {
  /** "Week of Oct 19" */
  week: string;
  /** "Gentle at 6 of 7 salmon creeks." */
  headline: string;
  /** coho in the scene */
  fish: number;
  /** "2 more than last week." */
  change: string | null;
  /** creek names, up to 3 */
  creeks: string[];
  /** "Next week: ease off at Pacific Ave S." */
  fix: string | null;
}

/** Draws the week's card. */
export async function drawWeekCard(f: WeekFacts): Promise<HTMLCanvasElement> {
  const [, , fish] = await Promise.all([fonts(), sceneReady(), img('art/icon-salmon.png')]);
  const cv = document.createElement('canvas');
  cv.width = CARD_W;
  cv.height = CARD_H;
  const g = cv.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = C.bg;
  g.fillRect(0, 0, CARD_W, CARD_H);

  // the scene across the top, 3 card px per art px, fish at rest
  const S = 3, AW = Math.round(CARD_W / S), AH = 200, art = document.createElement('canvas');
  art.width = AW;
  art.height = AH;
  const a = art.getContext('2d')!;
  drawScene(a, AW, AH, { fish: f.fish }, 0, true);
  g.drawImage(art, 0, 0, AW * S, AH * S);
  g.fillStyle = C.rimMid;
  g.fillRect(0, AH * S, CARD_W, 8);

  // wordmark over the scene
  box(g, 48, 44, 420, 92, C.bg, C.rim);
  g.font = `400 52px ${PX}`;
  g.fillStyle = C.youShade;
  g.fillText('TIRETRAIL', 80, 112 + 5);
  g.fillStyle = C.you;
  g.fillText('TIRETRAIL', 80, 112);

  let y = AH * S + 92;
  g.font = `400 30px ${PX}`;
  g.fillStyle = C.text2;
  g.fillText(f.week.toUpperCase(), 72, y);
  y += 78;
  g.font = `700 64px ${UI}`;
  g.fillStyle = C.text;
  for (const l of wrap(g, f.headline, CARD_W - 144).slice(0, 3)) { g.fillText(l, 72, y); y += 76; }
  if (f.change) {
    g.font = `600 40px ${UI}`;
    g.fillStyle = C.money;
    g.fillText(f.change, 72, y + 4);
    y += 64;
  }
  if (f.creeks.length) {
    y += 8;
    if (fish) g.drawImage(fish, 72, y - 40, 56, 56);
    g.font = `500 36px ${UI}`;
    g.fillStyle = C.text2;
    g.fillText(wrap(g, f.creeks.join(', '), CARD_W - 144 - 76)[0] ?? '', 72 + 76, y);
    y += 56;
  }
  if (f.fix) {
    y += 16;
    g.font = `500 38px ${UI}`;
    const lines = wrap(g, f.fix, CARD_W - 144 - 72).slice(0, 2), h = 64 + lines.length * 50;
    box(g, 72, y, CARD_W - 144, h, C.panel, C.rim);
    g.fillStyle = C.warn;
    g.fillRect(80, y + 8, 8, h - 16);
    g.fillStyle = C.text;
    lines.forEach((l, i) => g.fillText(l, 72 + 48, y + 66 + i * 50));
  }

  g.font = `500 30px ${UI}`;
  g.fillStyle = C.text3;
  g.fillText('Drive gently. Help the salmon.', 72, CARD_H - 64);
  g.textAlign = 'right';
  g.fillText('tiretrail.vercel.app', CARD_W - 72, CARD_H - 64);
  g.textAlign = 'left';
  return cv;
}

/** A button that shares the week as a picture, or saves it where sharing files isn't supported. */
export function shareWeekButton(f: WeekFacts, at: number): HTMLElement {
  const name = `tiretrail-week-${new Date(at).toISOString().slice(0, 10)}.png`;
  let file: File | null = null, making: Promise<File> | null = null;
  const make = () => (making ??= drawWeekCard(f)
    .then((cv) => new Promise<Blob>((done, fail) => cv.toBlob((b) => (b ? done(b) : fail(new Error('no PNG'))), 'image/png')))
    .then((b) => (file = new File([b], name, { type: 'image/png' }))));
  const go = (x: File) => {
    const data = { files: [x], title: 'My week on TireTrail' };
    if (navigator.canShare?.(data)) {
      navigator.share(data).catch((e: unknown) => { if ((e as { name?: string })?.name !== 'AbortError') download(x); });
    } else {
      download(x);
      toast('Saved the picture', { icon: 'check' });
    }
  };
  const key = button('Share your week', {
    kind: 'secondary', icon: 'share', wide: true,
    onClick: () => {
      if (file) { go(file); return; }
      make().then(go, () => toast("Couldn't make the picture", { icon: 'warn' }));
    },
  });
  // made a moment after the page settles, so the share opens right from the tap (Safari needs that)
  setTimeout(() => { if (key.isConnected) make().catch(() => {}); }, 1500);
  return key;
}
