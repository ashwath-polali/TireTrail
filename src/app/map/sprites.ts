// PixelLab trees and houses, placed per 128 m tile so they never move between frames.
import type { XY } from '../../geo/geo.ts';
import { hash, vnoise } from './noise.ts';
import { G_GRASS, type World } from './world.ts';

export interface Sprite {
  img: 'fir' | 'maple' | 'house3' | 'house4';
  x: number;
  y: number;
  house: boolean;
}

const TILE = 128;
const NAMES = ['fir', 'maple', 'house3', 'house4', 'pond', 'salmon2', 'grate', 'car'] as const;

export class Sprites {
  readonly img: Record<string, HTMLImageElement> = {};
  private readonly cache = new Map<number, Sprite[]>();

  private readonly world: World;
  private readonly base: string;

  constructor(world: World, base = 'sprites/') {
    this.world = world;
    this.base = base;
  }

  load(): Promise<void> {
    return Promise.all(
      NAMES.map((n) => new Promise<void>((ok) => {
        const i = new Image();
        i.onload = () => ok();
        i.onerror = () => ok();
        i.src = `${this.base}${n}.png`;
        this.img[n] = i;
      })),
    ).then(() => undefined);
  }

  /** Sprites whose base lies in the box, front to back. */
  visible(x0: number, y0: number, x1: number, y1: number): Sprite[] {
    const out: Sprite[] = [];
    for (let ty = Math.floor((y0 - 40) / TILE); ty <= Math.floor((y1 + 40) / TILE); ty++) {
      for (let tx = Math.floor((x0 - 40) / TILE); tx <= Math.floor((x1 + 40) / TILE); tx++) {
        for (const s of this.tile(tx, ty)) if (s.x >= x0 - 40 && s.x <= x1 + 40 && s.y >= y0 - 10 && s.y <= y1 + 60) out.push(s);
      }
    }
    return out.sort((a, b) => a.y - b.y);
  }

  private clear(x: number, y: number, r: number): boolean {
    if (this.world.groundAt(x, y) !== G_GRASS) return false;
    for (let a = 0; a < 8; a++) if (this.world.groundAt(x + r * Math.cos(a * .785), y + r * Math.sin(a * .785)) !== G_GRASS) return false;
    return true;
  }

  private tile(tx: number, ty: number): Sprite[] {
    const key = (tx + 4096) * 8192 + (ty + 4096);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const x0 = tx * TILE, y0 = ty * TILE;
    const inside = (p: XY) => p[0] >= x0 && p[0] < x0 + TILE && p[1] >= y0 && p[1] < y0 + TILE;
    const out: Sprite[] = [];
    const houses: XY[] = [];
    // houses every 36 m along each street, set back on both sides
    for (const i of this.world.runsNear([x0 + TILE / 2, y0 + TILE / 2], TILE)) {
      const line = this.world.runs[i].line;
      let walked = 0;
      for (let k = 1; k < line.length; k++) {
        const [ax, ay] = line[k - 1], [bx, by] = line[k];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        for (let d = (36 - (walked % 36)) % 36; d < len; d += 36) {
          const px = ax + ((bx - ax) * d) / len, py = ay + ((by - ay) * d) / len;
          const nx = -(by - ay) / len, ny = (bx - ax) / len;
          for (const side of [-1, 1]) {
            const p: XY = [px + nx * side * 26, py + ny * side * 26];
            if (!inside(p) || hash(p[0], p[1], 3) > .58 || !this.clear(p[0], p[1], 15)) continue;
            if (houses.some((h) => Math.hypot(h[0] - p[0], h[1] - p[1]) < 26)) continue;
            houses.push(p);
            out.push({ img: hash(p[0], p[1], 4) < .55 ? 'house3' : 'house4', x: p[0], y: p[1], house: true });
          }
        }
        walked += len;
      }
    }
    // forests in clusters with clearings
    for (let gy = y0; gy < y0 + TILE; gy += 15) for (let gx = x0; gx < x0 + TILE; gx += 15) {
      const x = gx + hash(gx, gy, 1) * 13, y = gy + hash(gx, gy, 2) * 13;
      if (!this.clear(x, y, 12) || houses.some((h) => Math.hypot(h[0] - x, h[1] - y) < 22)) continue;
      const dense = Math.min(.92, Math.max(.06, (vnoise(x, y, 75, 33) - .32) * 2.4));
      if (hash(x, y, 5) < dense) out.push({ img: hash(x, y, 6) < .8 ? 'fir' : 'maple', x, y, house: false });
    }
    if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, out);
    return out;
  }
}
