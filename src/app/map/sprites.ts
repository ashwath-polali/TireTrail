// PixelLab sprites for the story overlays. Houses and trees now come from real data (basemap.ts).
import type { World } from './world.ts';

const NAMES = ['pond', 'salmon2', 'grate', 'car'] as const;

export class Sprites {
  readonly img: Record<string, HTMLImageElement> = {};
  private readonly base: string;

  // the world is no longer needed; the parameter stays so callers don't change
  constructor(_world: World, base = 'sprites/') {
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
}
