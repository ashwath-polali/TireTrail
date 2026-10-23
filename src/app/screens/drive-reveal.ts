// The end-of-drive reveal, on the map: the route draws itself in about 2 s, each salmon creek gets its name as the route
// gets there (a coho leaps if it was crossed gently, a dust puff if a hard brake was near), and the one fix pins last.
// A tap skips it; less motion shows the end at once.
import type { XY } from '../../geo/geo.ts';
import { Show } from '../anim/clock.ts';
import { MapLeaps, type Leap } from '../anim/map-leaps.ts';
import { DRAW_MS, mapPlan, RouteDraw, type MapPlan } from '../anim/route-reveal.ts';
import { spritesReady } from '../anim/sprites.ts';
import type { Pin, Scene, Tag } from '../map/render.ts';
import { calm } from '../ui/ui.ts';
import { lightCoho } from './drive-report.ts';

type Replay = NonNullable<Scene['replay']>;

export interface RevealScene {
  /** the drive's stretches, by stretch index, as the map draws them */
  lines: readonly { i: number; path: XY[] }[];
  replay: Replay;
  /** each item of replay's stretch index (gaps: -1) */
  idx: readonly number[];
  creeks: readonly { at: XY; gentle: boolean; tag: Tag }[];
  pins: readonly Pin[];
  /** the fix's pin, or -1 */
  fix: number;
}

export class MapReveal {
  show: Show | null = null;
  private leaps: MapLeaps | null = null;
  private draw: RouteDraw | null = null;
  private drawFor: unknown = null;
  private plan: { key: string; p: MapPlan } | null = null;
  private lit = -1;

  /** Starts it again from the top, after `lead` ms for the camera to frame the route; with less motion, nothing plays. */
  start(lead = 800): void {
    this.show = calm() ? null : new Show(DRAW_MS + 1200, performance.now() + lead);
    this.plan = null;
    this.lit = -1;
    // the sprite sheets are asked for now, so the first leap has them
    void spritesReady();
  }

  get running(): boolean {
    return !!this.show && !this.show.done;
  }

  skip(): void {
    this.show?.skip();
  }

  /** The scene t ms in: the route cut short, the creeks and pins it has reached; the coho leaps over the map. */
  scene(s: RevealScene, map: HTMLCanvasElement, toScreen: (p: XY) => XY): { replay: Replay; pins: Pin[]; tags: Tag[] } {
    const run = this.running, t = run ? this.show!.at() : Infinity;
    if (!run) {
      this.leaps?.clear();
      if (this.lit !== Infinity) { this.lit = Infinity; lightCoho(Infinity); }
      return { replay: s.replay, pins: [...s.pins], tags: s.creeks.map((c) => c.tag) };
    }
    if (this.drawFor !== s.lines) [this.draw, this.drawFor, this.plan] = [new RouteDraw(s.lines), s.lines, null];
    const d = this.draw!, key = `${s.creeks.length}:${s.pins.length}:${s.fix}`;
    if (this.plan?.key !== key) {
      this.plan = { key, p: mapPlan(s.creeks.map((c) => d.reach(c.at)), s.pins.map((p) => d.reach(p.at))) };
      this.show!.end = this.plan.p.end;
    }
    const p = this.plan.p, cut = d.cut(t / DRAW_MS);
    const replay: Replay = [];
    s.replay.forEach((r, k) => {
      const path = cut.get(s.idx[k]);
      if (path && path.length > 1) replay.push({ ...r, path, dot: false, hi: false });
    });
    const pins = s.pins.filter((_, k) => (k === s.fix ? t >= p.fix : t >= p.pins[k]));
    const tags = s.creeks.filter((_, k) => t >= p.creeks[k] + 250).map((c) => c.tag);
    this.leaps ??= new MapLeaps(map);
    const leaps: Leap[] = s.creeks.map((c, k) => ({ at: toScreen(c.at), gentle: c.gentle, start: p.creeks[k] }));
    this.leaps.draw(t, leaps);
    // every frame: the caption may have been drawn again meanwhile
    this.lit = p.creeks.filter((at) => t >= at).length;
    lightCoho(this.lit);
    return { replay, pins, tags };
  }

  /** Off the report: no sprites left on the map. */
  hide(): void {
    this.leaps?.clear();
    this.lit = -1;
  }
}
