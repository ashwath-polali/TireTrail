// Home: the question, two big buttons, and the few facts that matter.
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { art } from './art.ts';

export class HomeScreen implements Screen {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  enter(): void {
    const app = this.app, n = app.data.numbers, oneIn = n.creekShareFennelBasin.oneIn;
    const card = (icon: string, title: string, text: string, go: () => void) =>
      h('button.card', { onclick: go }, h('span.ci', { html: icon }), h('span', {}, h('b', {}, title), h('span', {}, text)));
    app.showPage(h('div.home', {},
      h('div.hero', {},
        h('div.heroart', {}, art('hero', 'art hero')),
        h('div.herotext', {},
          h('div.eyebrow', {}, 'BONNEY LAKE · PIERCE COUNTY, WA'),
          h('h1.display', {}, 'When it rains, where does your tire dust go?'),
          h('p.lead', {}, 'Every time you brake, your tires shed tiny bits of rubber. Rain washes it into storm drains, and some of them pipe it straight into creeks where coho salmon spawn.'),
          h('div.actions.row', {},
            h('button.btn.main', { onclick: () => app.setTab('street') }, 'Check my street'),
            h('button.btn.quiet', { onclick: () => app.setTab('drive') }, 'Check my drive')),
          h('button.link', { onclick: () => app.tutorial.open() }, 'How it works'))),
      h('div.wrap', {},
        h('div.facts', {},
          h('div', {}, h('b', {}, n.drains.total.toLocaleString('en-US')), h('span', {}, 'storm drains traced through the real pipes')),
          h('div', {}, h('b', {}, `1 in ${oneIn}`), h('span', {}, 'traced drains in the Fennel Creek basin end up in the creek')),
          h('div', {}, h('b', {}, `${Math.round(n.terrainVsPipes.disagreeShare * 100)}%`), h('span', {}, 'of streets checked, where a map of the hills alone gets it wrong'))),
        h('div.cards', {},
          card(ICON.map(3), 'Explore the map', 'Every street, colored by where its rain goes.', () => app.setTab('map')),
          card(ICON.grate(), 'Where to fix it', 'Five spots where cleaning the water would help the creek most.', () => app.setTab('fix')),
          card(ICON.drop(), 'About the data', 'Where it comes from, and what it can and can\'t tell you.', () => app.about(() => this.enter()))),
        h('p.note.center', {}, app.data.disclaimer))));
  }

  leave(): void {}

  tap(_p: XY): boolean {
    return false;
  }

  frame(): FrameOut {
    return { scene: {} };
  }

  relayout(): void {
    this.enter();
  }
}
