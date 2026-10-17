// My drives: drives saved on this device.
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { forgetDrive, savedDrives } from './saved.ts';

export class HistoryScreen implements Screen {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  enter(): void {
    const app = this.app, list = savedDrives();
    const row = (d: (typeof list)[number]) => h('div.drive', {},
      h('button.item', { onclick: () => app.screens.drive.openSaved(d.at) },
        h('span.n.dot', { style: `--k:${d.creek ? 'var(--creek)' : 'var(--ground)'}` }, ''),
        h('span', {},
          h('span.t', {}, new Date(d.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
          h('span.s', {}, `${d.mi} · ${d.smooth}${d.creek ? ` · ${d.creek} sent dust to the creek` : ''}`))),
      h('button.forget', { 'aria-label': 'Delete this drive', onclick: () => { forgetDrive(d.at); this.enter(); } }, '×'));
    app.showPage(h('div.wrap.narrow.fade', {},
      h('div.eyebrow', {}, 'MY DRIVES'),
      h('h1.h1', {}, list.length ? 'Your drives' : 'No drives yet'),
      h('p.lead', {}, list.length ? 'Tap a drive to see its stops again.' : 'When you record a drive, it shows up here so you can compare later.'),
      list.length ? h('div.list', {}, ...list.map(row)) : h('div.actions.row', {}, h('button.btn.main', { onclick: () => app.setTab('drive') }, 'Start a drive')),
      h('p.note', {}, 'Your drives stay on this device. Nothing is uploaded.')));
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
