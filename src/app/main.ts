import { loadTireTrail } from '../data/tiretrail.ts';
import { App, type Layout, type Tab } from './app.ts';
import { loadRegion } from './map/region.ts';

declare const __BUILD__: string;

const host = document.getElementById('app')!;
// For screenshots: #view=phone&tab=map&run=120&t=4000 freezes the clock 4 s into a story.
const q = new URLSearchParams(location.hash.slice(1));

async function boot(): Promise<void> {
  const [data, region] = await Promise.all([loadTireTrail('data/tiretrail.json'), loadRegion('data/region.json')]);
  const app = new App(host, data, region);
  if (q.has('e2e')) (window as unknown as { tt: App }).tt = app; // click-through tests
  if (q.has('t')) [app.frozen, app.camera.instant] = [0, true];
  if (q.has('t') || q.has('still')) document.documentElement.classList.add('still');
  if (q.has('intro')) app.introMode = 'force';
  else if (['run', 'pick', 'sample', 'fix', 'tab', 'cam', 'nointro'].some((k) => q.has(k))) app.introMode = 'off';
  await app.start((q.get('view') as Layout | null) ?? undefined);
  await debug(app);
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
}

// offline copy for phones (not in dev, and not where the page is sandboxed)
if (__BUILD__) try { void navigator.serviceWorker?.register(`./sw.js?v=${__BUILD__}`).catch(() => {}); } catch { /* no service workers here */ }

boot().catch((e: unknown) => {
  host.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'boot';
  p.textContent = e instanceof Error ? e.message : 'TireTrail could not start.';
  host.append(p);
});
