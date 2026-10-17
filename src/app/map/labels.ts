// Street, lake and creek names over the map, placed without overlaps.
import { polygonsCentroid, polylineLength, type XY } from '../../geo/geo.ts';
import type { Cam, Renderer } from './render.ts';
import type { World } from './world.ts';

interface Cand {
  text: string;
  kind: 'street' | 'water';
  weight: number;
  at: XY[]; // possible anchor points, best first
  el?: HTMLDivElement;
}

export class Labels {
  private readonly cands: Cand[] = [];
  private readonly box: HTMLElement;

  constructor(box: HTMLElement, world: World) {
    this.box = box;
    // one label per street name, anchored on its longest runs
    const byName = new Map<string, { len: number; mids: [number, XY][] }>();
    for (const r of world.runs) {
      const name = world.pieceNames[r.piece];
      if (!name) continue;
      const len = polylineLength(r.line);
      const e = byName.get(name) ?? { len: 0, mids: [] };
      e.len += len;
      e.mids.push([len, r.line[r.line.length >> 1]]);
      byName.set(name, e);
    }
    for (const [text, e] of byName) {
      this.cands.push({ text, kind: 'street', weight: e.len, at: e.mids.sort((a, b) => b[0] - a[0]).slice(0, 6).map((m) => m[1]) });
    }
    const waters = new Map<string, XY[]>();
    for (const w of world.waters) {
      if (!w.name || /unnamed|tributary/i.test(w.name)) continue;
      const at = w.ring ? polygonsCentroid([[w.ring]]) : w.line![w.line!.length >> 1];
      waters.set(w.name, [...(waters.get(w.name) ?? []), at]);
    }
    for (const [text, at] of waters) this.cands.push({ text, kind: 'water', weight: 1e9, at });
  }

  update(cam: Cam, r: Renderer, hide = false): void {
    const W = r.AW * 3, H = r.AH * 3;
    const max = cam.mpp > 5 ? 8 : cam.mpp > 2.6 ? 14 : 22;
    const minLen = cam.mpp > 5 ? 900 : cam.mpp > 2.6 ? 300 : 0;
    const placed: [number, number, number, number][] = [];
    let shown = 0;
    for (const c of [...this.cands].sort((a, b) => b.weight - a.weight)) {
      let spot: XY | null = null;
      if (!hide && (c.kind === 'water' || (c.weight >= minLen && shown < max))) {
        for (const p of c.at) {
          const [x, y] = r.toScreen(cam, p);
          const w = c.text.length * (c.kind === 'water' ? 7.5 : 6.6) + 10, h = 18;
          const box: [number, number, number, number] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
          if (box[0] < 8 || box[2] > W - 8 || box[1] < 8 || box[3] > H - 8) continue;
          if (placed.some((q) => !(box[2] < q[0] || box[0] > q[2] || box[3] < q[1] || box[1] > q[3]))) continue;
          placed.push(box);
          spot = [x, y];
          break;
        }
      }
      if (!spot) { if (c.el) c.el.style.display = 'none'; continue; }
      if (c.kind === 'street') shown++;
      if (!c.el) {
        c.el = document.createElement('div');
        c.el.className = `maplabel ${c.kind}`;
        c.el.textContent = c.kind === 'water' ? c.text.toUpperCase() : c.text;
        this.box.append(c.el);
      }
      c.el.style.display = '';
      c.el.style.transform = `translate(${Math.round(spot[0])}px, ${Math.round(spot[1])}px) translate(-50%, -50%)`;
    }
  }
}
