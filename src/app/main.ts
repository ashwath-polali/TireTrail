import { loadTireTrail } from '../data/tiretrail.ts';
import { App, type Layout, type Tab } from './app.ts';

const host = document.getElementById('app')!;

async function boot(): Promise<void> {
  const app = new App(host, await loadTireTrail('data/tiretrail.json'));
  await app.start();
  await debug(app);
}

// For screenshots: #view=phone&tab=map&run=120&t=4000 freezes the clock 4 s into a story.
async function debug(app: App): Promise<void> {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.size) return;
  if (q.has('t')) [app.frozen, app.camera.instant] = [0, true];
  if (q.has('view')) app.setLayout(q.get('view') as Layout, false);
  if (q.has('tab')) app.setTab(q.get('tab') as Tab);
  if (q.has('cam')) {
    const [x, y, mpp] = q.get('cam')!.split(',').map(Number);
    app.camera.cam = { x, y, mpp };
  }
  if (q.has('run')) app.screens.map.open(app.world.runs[Number(q.get('run'))]);
  if (q.has('pick')) app.screens.map.pick(Number(q.get('pick')));
  if (q.has('sample')) {
    app.setTab('drive');
    await app.screens.drive.loadSample();
    if (q.has('stop')) app.screens.drive.play(Number(q.get('stop')));
  }
  if (q.has('fix')) app.screens.fix.select(Number(q.get('fix')));
  if (q.has('t')) app.frozen = Number(q.get('t'));
}

boot().catch((e: unknown) => {
  host.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'boot';
  p.textContent = e instanceof Error ? e.message : 'TireTrail could not start.';
  host.append(p);
});
