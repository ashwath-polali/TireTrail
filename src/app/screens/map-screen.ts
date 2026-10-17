// Map tab: every street colored by where its rain goes. Tap one to read its answer.
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { legend } from './common.ts';
import { Intro, introSeen } from './intro.ts';

export class MapScreen implements Screen {
  private readonly app: App;
  private intro: Intro | null = null;
  private opened = false;

  constructor(app: App) {
    this.app = app;
  }

  get introActive(): boolean {
    return this.intro !== null;
  }

  enter(): void {
    const app = this.app, first = !this.opened;
    this.opened = true;
    app.showStage();
    // the zoom from the West Coast plays the first time the map opens
    if (first && app.region && (app.introMode === 'force' || (app.introMode === 'auto' && !introSeen()))) this.playIntro();
    else this.idle();
  }

  leave(): void {
    if (this.intro) {
      // put the camera home instead of leaving it over the whole country
      this.app.camera.follow();
      this.app.camera.cam = this.intro.end();
      this.intro = null;
    }
  }

  relayout(): void {
    if (this.intro) this.intro.relayout();
    else this.idle();
  }

  playIntro(): void {
    // only moves made after this count as interrupting it
    this.app.camera.follow();
    this.intro = new Intro(this.app, () => { this.intro = null; this.idle(); });
  }

  idle(): void {
    const app = this.app;
    app.setCaption('map', ICON.drop(), '<span class="say">Tap any street to see where its rain goes.</span>');
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'THE MAP'),
      h('p.p', {}, 'Each street is colored by where its storm drains send the rain.'),
      legend(),
      h('div.actions.row', {},
        h('button.btn.quiet', { onclick: () => app.setTab('fix') }, 'Where to fix it'),
        app.region ? h('button.btn.quiet', { onclick: () => this.playIntro() }, 'Zoom out to the West Coast') : null)));
  }

  tap(p: XY): boolean {
    if (this.intro) { this.intro.skip(); return true; }
    // far out, let the app zoom in instead of grabbing a street
    if (this.app.camera.cam.mpp > 16) return false;
    const run = this.app.world.nearestRun(p, 6 * this.app.camera.cam.mpp + 8);
    if (!run) return false;
    this.app.screens.street.open(run);
    return true;
  }

  frame(now: number): FrameOut {
    if (this.intro) return { scene: {}, cam: this.intro.frame(now) };
    return { scene: {} };
  }
}
