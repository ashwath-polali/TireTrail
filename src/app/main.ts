/// <reference types="vite/client" />
import { loadTireTrail } from '../data/tiretrail.ts';
import { App, makeShell, type Layout, type Tab } from './app.ts';
import { h } from './dom.ts';
import { loadRegion } from './map/region.ts';
import './install.ts';
import { markOpened, setupOpen, setupPending, showWorks } from './screens/autostart.ts';
import { heroLoaded } from './screens/hero.ts';
import { fontsReady, guideSeen } from './screens/onboarding.ts';
import { Tutorial } from './screens/tutorial.ts';
import './shell.css';

declare const __BUILD__: string;

const host = document.getElementById('app')!;
// For screenshots: #view=phone&tab=map&run=120&t=4000 freezes the clock 4 s into a story.
const q = new URLSearchParams(location.hash.slice(1));

async function boot(): Promise<void> {
  // the map loads behind the splash, or behind the guide
  const loading = Promise.all([loadTireTrail('data/tiretrail.json'), loadRegion('data/region.json')]);
  loading.catch(() => {}); // boot's catch reports it
  if (q.has('t') || q.has('still')) document.documentElement.classList.add('still');
  const intro: App['introMode'] = q.has('intro') ? 'force'
    : ['run', 'pick', 'sample', 'fix', 'tab', 'cam', 'nointro', 'ui', 'autostart', 'start'].some((k) => q.has(k)) ? 'off' : 'auto';
  const view = (q.get('view') as Layout | null) ?? undefined;
  const shell = makeShell(host, view ?? null);
  // first open: the guide needs no map, so it comes up at once
  let guide: Tutorial | null = null;
  if (intro === 'force' || (intro === 'auto' && !guideSeen())) {
    guide = new Tutorial(shell.frame);
    await guide.open();
  }
  const [data, region] = await loading;
  const app = new App(data, region, shell, guide);
  if (q.has('e2e')) (window as unknown as { tt: App }).tt = app; // click-through tests
  if (q.has('t')) [app.frozen, app.camera.instant] = [0, true];
  if (q.has('hero')) document.documentElement.dataset.heroAt = q.get('hero')!;
  app.introMode = intro;
  await app.start(view);
  // the phone reloaded TireTrail behind Maps mid drive: the same drive goes on
  if (app.screens.drive.comeBack()) { if (q.has('autostart') || q.has('start')) clearHash(q); }
  else if (q.has('autostart') || q.has('start')) autostart(app, q);
  // Safari often reloads after a trip to Shortcuts: reopen the setup on its step
  else if (setupPending()) app.screens.drive.guide();
  // the car may open the link in a tab that already has TireTrail
  addEventListener('hashchange', () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has('autostart') || p.has('start')) autostart(app, p);
  });
  // the splash goes once the first screen is drawn, its fonts and pictures in (under an open guide, at once)
  if (!app.tutorial.isOpen) {
    const pics = Array.from(host.querySelectorAll<HTMLImageElement>('.page img'), (i) => i.decode().catch(() => {}));
    if (host.querySelector('.page canvas.hero')) pics.push(heroLoaded());
    await Promise.race([Promise.all([fontsReady(), ...pics]), new Promise((r) => setTimeout(r, 2500))]);
  }
  host.querySelector('.splash')?.remove();
  await debug(app);
}

/**
 * #autostart, opened by the phone when it meets the car, and #start, the icon's "Start a drive": the Drive tab, recording.
 * During the setup's test it only says it works. The hash goes so a reload doesn't start again.
 */
function autostart(app: App, p: URLSearchParams): void {
  const byCar = p.has('autostart');
  clearHash(p);
  if (byCar && markOpened()) {
    // the setup in this tab shows it works by itself
    if (!setupOpen()) showWorks(() => { if (app.tab !== 'drive') app.setTab('drive'); });
    return;
  }
  void app.screens.drive.autostart(byCar);
}

/** Takes #autostart and #start off the address, so a reload doesn't start again. */
function clearHash(p: URLSearchParams): void {
  p.delete('autostart');
  p.delete('start');
  const rest = p.toString().replace(/=(&|$)/g, '$1');
  try { history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`); } catch { /* sandboxed */ }
}

async function debug(app: App): Promise<void> {
  if (q.has('tab')) app.setTab(q.get('tab') as Tab);
  if (q.has('cam')) {
    const [x, y, mpp] = q.get('cam')!.split(',').map(Number);
    app.camera.cam = { x, y, mpp };
  }
  if (q.has('run')) app.screens.street.open(app.world.runs[Number(q.get('run'))]);
  if (q.has('pick')) app.screens.street.pick(Number(q.get('pick')));
  if (q.has('watch') && app.tab === 'street') app.screens.street.watch();
  if (q.has('sample')) {
    app.setTab('drive');
    await app.screens.drive.loadSample();
    if (q.has('stop')) app.screens.drive.stopCard(Number(q.get('stop')), false);
    if (q.has('watch') && q.has('stop')) app.screens.drive.watch(Number(q.get('stop')));
  }
  if (q.has('fix')) app.screens.fix.select(Number(q.get('fix')));
  if (q.has('t')) app.frozen = Number(q.get('t'));
  // #ui: the UI kit's demo page
  if (q.has('ui')) app.showPage((await import('./ui/demo.ts')).uiDemo());
}

// offline copy for phones (not in dev, and not where the page is sandboxed)
if (__BUILD__) try { void navigator.serviceWorker?.register(`./sw.js?v=${__BUILD__}`).catch(() => {}); } catch { /* no service workers here */ }

boot().catch((e: unknown) => {
  console.warn('TireTrail could not start:', e);
  // in the splash's place, so an open guide stays on top until it closes
  host.querySelector('.splash')?.remove();
  host.append(h('div.bootfail.splash', { role: 'alert' },
    h('p', {}, "TireTrail couldn't load its map data. Check your connection, then try again."),
    h('button.btn.main', { onclick: () => location.reload() }, 'Try again')));
});
