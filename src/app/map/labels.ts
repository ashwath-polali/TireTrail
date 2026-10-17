// Names over the map, from states down to streets, placed without overlaps.
import { polygonsCentroid, polylineLength, type XY } from '../../geo/geo.ts';
import type { Region } from './region.ts';
import type { Cam, Renderer } from './render.ts';
import type { World } from './world.ts';

type Kind = 'street' | 'water' | 'region' | 'place' | 'home' | 'city' | 'peak' | 'sea';

interface Cand {
  text: string;
  kind: Kind;
  weight: number;
  at: XY[]; // possible anchor points, best first
  min: number; // shown for min < mpp <= max
  max: number;
  dx?: number; // css px offset from the anchor
  dy?: number;
  el?: HTMLDivElement;
}

const CHAR: Record<Kind, number> = { street: 6.6, water: 7.5, region: 8.6, place: 7, home: 7.6, city: 7, peak: 6.6, sea: 7.5 };

export class Labels {
  private readonly cands: Cand[] = [];
  private readonly box: HTMLElement;

  constructor(box: HTMLElement, world: World, region: Region | null) {
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
      this.cands.push({ text, kind: 'street', weight: e.len, min: 0, max: 12, at: e.mids.sort((a, b) => b[0] - a[0]).slice(0, 6).map((m) => m[1]) });
    }
    const waters = new Map<string, XY[]>();
    for (const w of world.waters) {
      if (!w.name || /unnamed|tributary/i.test(w.name)) continue;
      const at = w.ring ? polygonsCentroid([[w.ring]]) : w.line![w.line!.length >> 1];
      waters.set(w.name, [...(waters.get(w.name) ?? []), at]);
    }
    for (const [text, at] of waters) this.cands.push({ text: text.toUpperCase(), kind: 'water', weight: 1e9, min: 0, max: 16, at });
    if (!region) return;
    for (const s of region.states) if (s.west) this.cands.push({ text: s.name.toUpperCase(), kind: 'region', weight: 1e8, min: 700, max: Infinity, at: [s.at] });
    const home = region.home;
    if (home) this.cands.push({ text: 'PIERCE COUNTY', kind: 'region', weight: 9e7, min: 110, max: 1500, at: [home.at], dy: 22 });
    for (const p of region.places) {
      const mine = p.name === 'Bonney Lake';
      this.cands.push({ text: p.name, kind: mine ? 'home' : 'place', weight: mine ? 1e10 : p.area, min: mine ? 14 : 24, max: mine ? 2600 : p.area > 3e7 ? 1200 : 420, at: [mine ? world.center : p.at], dy: mine ? -27 : 0 });
    }
    for (const pt of region.points) {
      if (pt.kind === 'city') this.cands.push({ text: pt.name, kind: 'city', weight: 5e7, min: 90, max: 7000, at: [pt.at], dx: 8 });
      if (pt.kind === 'peak') this.cands.push({ text: pt.name, kind: 'peak', weight: 6e7, min: 50, max: 2600, at: [pt.at], dy: 14 });
      if (pt.kind === 'water') this.cands.push({ text: pt.name.toUpperCase(), kind: 'sea', weight: 4e7, min: pt.name === 'Puget Sound' ? 120 : 700, max: pt.name === 'Puget Sound' ? 1600 : Infinity, at: [pt.at] });
    }
  }

  /** blocks: world points other things sit on, kept clear of labels */
  update(cam: Cam, r: Renderer, hide = false, blocks: XY[] = []): void {
    const W = r.AW * 3, H = r.AH * 3, m = cam.mpp;
    const max = m > 5 ? 8 : m > 2.6 ? 14 : 22;
    const minLen = m > 5 ? 900 : m > 2.6 ? 300 : 0;
    const placed: [number, number, number, number][] = blocks.map((p) => {
      const [x, y] = r.toScreen(cam, p);
      return [x - 16, y - 16, x + 16, y + 16];
    });
    let shown = 0;
    for (const c of [...this.cands].sort((a, b) => b.weight - a.weight)) {
      let spot: XY | null = null;
      const inRange = m > c.min && m <= c.max && (c.kind !== 'street' || (c.weight >= minLen && shown < max));
      if (!hide && inRange) {
        for (const p of c.at) {
          const [x0, y0] = r.toScreen(cam, p);
          const w = c.text.length * CHAR[c.kind] + 10, h = 18;
          // city labels sit to the right of their dot
          const x = x0 + (c.dx ? c.dx + w / 2 : 0), y = y0 + (c.dy ?? 0);
          const box: [number, number, number, number] = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
          if (box[0] < 6 || box[2] > W - 6 || box[1] < 6 || box[3] > H - 6) continue;
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
        c.el.textContent = c.text;
        this.box.append(c.el);
      }
      c.el.style.display = '';
      c.el.style.transform = `translate(${Math.round(spot[0])}px, ${Math.round(spot[1])}px) translate(-50%, -50%)`;
    }
  }
}
