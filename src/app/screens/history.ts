// My drives: drives saved on this device.
import type { XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { h } from '../dom.ts';
import { forgetDrive, savedDrives } from './saved.ts';

const thisYear = (t: number) => new Date(t).getFullYear() === new Date().getFullYear();

export class HistoryScreen implements Screen {
  private readonly app: App;
  /** a drive was picked while one is still recording */
  private blocked = false;

  constructor(app: App) {
    this.app = app;
  }

  enter(): void {
    const app = this.app, list = savedDrives();
    const click = app.layout === 'laptop' && !matchMedia('(any-pointer: coarse)').matches;
    const open = (at: number) => {
      // opening a saved drive mid-recording would leave the recording half on screen
      if (app.screens.drive.openSaved(at)) return;
      this.blocked = true;
      this.enter();
    };
    const row = (d: (typeof list)[number]) => h('div.drive', {},
      h('button.item', { onclick: () => open(d.at) },
        h('span.n.dot', { style: `--k:${d.creek ? 'var(--creek)' : 'var(--ground)'}` }, ''),
        h('span', {},
          h('span.t', {}, new Date(d.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(thisYear(d.at) ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' })),
          h('span.s', {}, `${d.mi} · ${d.smooth}${d.creek ? ` · ${d.creek} ${d.creek === 1 ? 'stop' : 'stops'} sent dust to a salmon stream` : ''}`))),
      h('button.forget', { 'aria-label': 'Delete this drive', onclick: () => { forgetDrive(d.at); this.enter(); } }, '×'));
    const warn = this.blocked && app.screens.drive.recording;
    this.blocked = false;
    app.showPage(h('div.wrap.narrow.fade', {},
      h('div.eyebrow', {}, 'MY DRIVES'),
      h('h1.h1', {}, list.length ? 'Your drives' : 'No drives yet'),
      warn ? h('p.warn', { role: 'alert' }, 'Stop your drive first.') : null,
      h('p.lead', {}, list.length ? `${click ? 'Click' : 'Tap'} a drive to see its stops again.` : 'When you record a drive, it shows up here so you can compare later.'),
      list.length ? h('div.list', {}, ...list.map(row)) : h('div.actions.row', {}, h('button.btn.main', { onclick: () => { app.setTab('drive'); app.screens.drive.home(); } }, 'Start a drive')),
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
