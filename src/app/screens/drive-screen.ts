// My drive: record or load a drive, find its hardest stops, and follow each one's tire dust.
import { analyzeDrive, type DriveReport, type StopReport } from '../../drive/analyze.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { browserDeps, DriveRecorder } from '../../drive/recorder.ts';
import type { Fix } from '../../drive/types.ts';
import { nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';
import { chip, destination, KIND } from './common.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';

const TIP_ICON: Record<string, () => string> = { 'brake-earlier': () => ICON.brake(), 'slow-into-turns': () => ICON.turn(), 'tire-pressure': () => ICON.gauge() };
const times = (x: number) => `${x < 3 ? x.toFixed(1) : Math.round(x)}×`;
const WAITING = 'Waiting for GPS…';
const SAVED = 'tt-drives';

type View = 'idle' | 'recording' | 'results' | 'route' | 'stop' | 'watch';

/** Where one stop's dust ends up, as a sentence. */
function stopAnswer(cls: Cls | null, receiving: string): string {
  switch (cls) {
    case 'creek': return /tributary/i.test(receiving) || !receiving || receiving === 'Fennel Creek' ? 'Its tire dust ends up in Fennel Creek.' : `Its tire dust ends up in ${receiving}, which drains to Fennel Creek.`;
    case 'ground': return 'Its tire dust soaks into the ground.';
    case 'elsewhere': return `Its tire dust drains to ${receiving || 'other water'}.`;
    case 'unknown': return "The city's pipe map loses track of its tire dust.";
    default: return 'No storm drain near this stop.';
  }
}

interface SavedDrive { at: number; mi: string; fixes: (number | null)[][] }

export class DriveScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly file: HTMLInputElement;
  private view: View = 'idle';
  private report: DriveReport | null = null;
  private sample = false;
  private when = 0;
  private route: XY[] | null = null;
  private pins: XY[] = [];
  private names: string[] = [];
  private sel = -1;
  private error = '';
  /** bumps on every load, so a slow one that finishes late is dropped */
  private loadTok = 0;
  private busy = false;
  // live recording
  private rec: DriveRecorder | null = null;
  private track: XY[] = [];
  private trackM = 0;
  private started = 0;
  private timer = 0;
  private status = WAITING;
  private live: { time: HTMLElement; dist: HTMLElement; fixes: HTMLElement; msg: HTMLElement } | null = null;

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.file = h('input', { type: 'file', accept: '.gpx,application/gpx+xml' }) as HTMLInputElement;
    this.file.addEventListener('change', () => void this.openFile());
  }

  private get here(): boolean {
    return this.app.tab === 'drive';
  }

  enter(): void {
    if (this.rec) { this.app.camera.follow(); this.recording(); return; }
    if (!this.report) { this.idle(); return; }
    if (this.view === 'stop' || this.view === 'watch') this.stopPage(this.sel, false);
    else if (this.view === 'route') this.routeView(false);
    else this.results(false);
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'stop';
  }

  back(): boolean {
    if (this.rec) return true;
    if (this.view === 'watch') { this.stopPage(this.sel, false); return true; }
    if (this.view === 'stop' || this.view === 'route') { this.results(false); return true; }
    if (this.view === 'results') { this.idle(); return true; }
    return false;
  }

  relayout(): void {
    if (this.view === 'watch') this.player.relayout();
    else this.enter();
  }

  // ---------- start ----------

  private idle(): void {
    const app = this.app, busy = this.busy;
    this.view = 'idle';
    this.player.stop();
    const saved = this.saved();
    app.showPage(h('div.wrap.narrow', {},
      h('div.eyebrow', {}, 'MY DRIVE'),
      h('h1.h1', {}, 'Which of your stops send tire dust to the creek?'),
      h('p.lead', {}, 'Have a passenger tap Start before you drive. Afterward, TireTrail finds your hardest stops and follows the rain from each one to where it ends up.'),
      this.error ? h('p.warn', {}, this.error) : null,
      h('div.actions.row', {},
        h('button.btn.main', { onclick: () => void this.startRec(), disabled: busy }, 'Start a drive'),
        h('button.btn.quiet', { onclick: () => void this.loadSample(), disabled: busy }, busy ? 'Loading…' : 'Try a sample drive')),
      h('button.link', { onclick: () => this.file.click(), disabled: busy }, 'Open a GPX file'),
      this.file,
      saved.length ? h('div.eyebrow.gap', {}, 'YOUR SAVED DRIVES') : null,
      saved.length ? h('div.picks', {}, ...saved.map((s) => h('button.pick', { onclick: () => this.show(s.fixes.map(unpack), false, s.at) },
        h('b', {}, new Date(s.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('span', {}, s.mi)))) : null,
      h('p.note', {}, 'Your drives stay on this device. Nothing is uploaded.')));
  }

  // ---------- recording ----------

  private async startRec(): Promise<void> {
    if (this.busy) return;
    // browsers only share location with https pages (and localhost)
    if (!window.isSecureContext) {
      this.error = 'GPS only works when TireTrail is opened from an https:// address. Try the sample drive, or open a GPX file.';
      this.idle();
      return;
    }
    this.stopRecorder();
    this.loadTok++; // a sample still loading must not replace the recording
    this.error = '';
    this.status = WAITING;
    this.track = [];
    this.trackM = 0;
    this.started = Date.now();
    this.app.camera.follow();
    const rec = new DriveRecorder(browserDeps(), {
      onState: (s, msg) => {
        if (rec !== this.rec) return;
        if (s === 'denied' || s === 'unsupported') {
          this.endTimer();
          this.rec = null;
          // an embedded preview can't ask for location at all
          this.error = s === 'denied' && window.self !== window.top ? "This preview can't use GPS. Try the sample drive, or open a GPX file." : msg ?? '';
          if (this.here) this.idle();
        } else this.say(s === 'recording' ? 'Drive normally. Keep TireTrail open with the screen on.' : msg ?? this.status);
      },
      onFix: (f) => { if (rec === this.rec) this.addFix(f); },
      onNotice: (_k, m) => { if (rec === this.rec) this.say(m); },
    });
    this.rec = rec;
    this.recording();
    this.timer = window.setInterval(() => this.tickLive(), 1000);
    await rec.start();
  }

  private say(msg: string): void {
    this.status = msg;
    if (this.live) this.live.msg.textContent = msg;
  }

  private addFix(f: Fix): void {
    const p = this.app.world.toWorld([f.lon, f.lat]);
    const last = this.track[this.track.length - 1];
    if (last) this.trackM += Math.hypot(p[0] - last[0], p[1] - last[1]);
    this.track.push(p);
    this.tickLive();
  }

  private recording(): void {
    const app = this.app;
    this.view = 'recording';
    app.showStage();
    app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    const cell = (b: HTMLElement, label: string) => h('div', {}, b, h('span', {}, label));
    this.live = { time: h('b', {}, '0:00'), dist: h('b', {}, '0.0 mi'), fixes: h('b', {}, '0'), msg: h('p.p', {}, this.status) };
    const L = this.live;
    app.setPanel(h('div', {},
      h('div.live', {}, h('i'), 'RECORDING'),
      h('div.stats', {}, cell(L.time, 'Time'), cell(L.dist, 'Distance'), cell(L.fixes, 'GPS readings')),
      L.msg,
      h('div.actions.row', {}, h('button.btn.main', { onclick: () => this.stopRec() }, 'Stop and see my stops')),
      h('button.link', { onclick: () => app.camera.follow() }, 'Center the map on my car')));
    this.tickLive();
  }

  private tickLive(): void {
    if (!this.live || !this.rec) return;
    this.live.time.textContent = fmt.clock((Date.now() - this.started) / 1000);
    this.live.dist.textContent = fmt.mi(this.trackM);
    this.live.fixes.textContent = String(this.rec.fixes.length);
  }

  private endTimer(): void {
    clearInterval(this.timer);
    this.live = null;
  }

  private stopRecorder(): void {
    if (!this.rec) return;
    const old = this.rec;
    this.rec = null;
    old.stop();
    this.endTimer();
  }

  private stopRec(): void {
    if (!this.rec) return;
    const old = this.rec;
    this.rec = null;
    const drive = old.stop();
    this.endTimer();
    if (this.show(drive.fixes, false, drive.startedAt)) this.save(drive.startedAt, drive.fixes);
  }

  // ---------- saved drives (this device only) ----------

  private saved(): SavedDrive[] {
    try { return JSON.parse(localStorage.getItem(SAVED) ?? '[]') as SavedDrive[]; } catch { return []; }
  }

  private save(at: number, fixes: readonly Fix[]): void {
    const list = this.saved().filter((s) => s.at !== at);
    list.unshift({ at, mi: fmt.mi((this.report?.distanceKm ?? 0) * 1000), fixes: fixes.map(pack) });
    try { localStorage.setItem(SAVED, JSON.stringify(list.slice(0, 5))); } catch { /* full or blocked */ }
  }

  // ---------- loading ----------

  private setBusy(on: boolean): void {
    this.busy = on;
    if (this.here && this.view === 'idle') this.idle();
  }

  async loadSample(): Promise<void> {
    if (this.busy || this.rec) return;
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      const res = await fetch('data/sample-drive.json');
      if (!res.ok) throw new Error(String(res.status));
      const fixes = (await res.json()) as Fix[];
      if (tok === this.loadTok && !this.rec) this.show(fixes, true, 0);
    } catch {
      if (tok === this.loadTok) this.error = "The sample drive didn't load. Check the connection and try again.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  private async openFile(): Promise<void> {
    const f = this.file.files?.[0];
    this.file.value = '';
    if (!f || this.busy || this.rec) return;
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      const fixes = parseGPX(await f.text());
      if (tok === this.loadTok && !this.rec && this.show(fixes, false, fixes[0]?.t ?? 0)) this.save(fixes[0]?.t ?? Date.now(), fixes);
    } catch (e) {
      if (tok === this.loadTok) this.error = e instanceof GpxError ? e.message : "That file couldn't be read as a GPX track.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  /** Analyzes a drive; false if it was too short. */
  private show(fixes: readonly Fix[], sample: boolean, when: number): boolean {
    const app = this.app;
    const report = analyzeDrive(fixes, app.data);
    this.sel = -1;
    if (report.usedFixes < 10) {
      // drop the last drive too, so no old pins outlive their report
      this.error = report.warnings[0] ?? 'This drive is too short to look at.';
      [this.report, this.route, this.pins, this.names] = [null, null, [], []];
      if (this.here) this.idle();
      return false;
    }
    this.error = '';
    this.report = report;
    this.sample = sample;
    this.when = when;
    this.route = fixes.map((f) => app.world.toWorld([f.lon, f.lat]));
    this.pins = report.hardest.map((s) => app.world.toWorld(s.lngLat));
    this.names = this.pins.map((p) => this.place(p));
    // if the person moved to another tab meanwhile, enter() shows this later
    this.view = 'results';
    if (this.here) this.results(true);
    return true;
  }

  /** "SR 410 E at 192nd Ave E", or just the street. */
  private place(p: XY): string {
    const w = this.app.world, r = w.nearestRun(p, 30);
    const name = r ? w.pieceNames[r.piece] : '';
    if (!name) return '';
    let cross = '', best = 70;
    for (const i of w.runsNear(p, 70)) {
      const other = w.pieceNames[w.runs[i].piece];
      if (!other || other === name) continue;
      const d = nearestOnPolyline(p, w.runs[i].line).d;
      if (d < best) [cross, best] = [other, d];
    }
    return cross ? `${name} at ${cross}` : name;
  }

  // ---------- results ----------

  private results(push: boolean): void {
    const app = this.app, r = this.report!;
    this.view = 'results';
    this.player.stop();
    if (push) app.pushStep();
    const n = r.hardest.length;
    const creek = r.hardest.filter((s) => s.cls === 'creek').length;
    const stat = (v: string, label: string) => h('div', {}, h('b', {}, v), h('span', {}, label));
    const head = this.sample ? 'SAMPLE DRIVE' : `YOUR DRIVE${this.when ? ' · ' + new Date(this.when).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toUpperCase() : ''}`;
    app.showPage(h('div.wrap.narrow', {},
      h('button.backlink', { onclick: () => this.idle() }, '‹ My drive'),
      h('div.eyebrow', {}, head),
      h('h1.h1', {}, `This drive wore about ${fmt.mass(r.dust.mg.typical)} of rubber off your tires.`),
      h('p.lead', {}, n === 0 ? 'There were no full stops in this drive.'
        : creek ? `${creek === 1 ? 'One' : creek} of your ${n} hardest stops ${creek === 1 ? 'sends its' : 'send their'} tire dust straight to Fennel Creek, where coho salmon spawn.`
          : `None of your ${n} hardest stops drain to Fennel Creek. Here is where their tire dust goes.`),
      h('div.stats', {},
        stat(fmt.mi(r.distanceKm * 1000), 'Distance'),
        stat(fmt.mass(r.dust.mg.typical), 'Tread worn'),
        stat(fmt.pct(r.hardestWearShare), n === 1 ? 'From your hardest stop' : `From these ${n} stops`)),
      n ? h('div.eyebrow.gap', {}, 'YOUR HARDEST STOPS') : null,
      h('div.list', {}, ...r.hardest.map((s, i) => this.item(s, i))),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.routeView(true) }, 'See the route on the map')),
      h('div.eyebrow.gap', {}, 'TO SHED LESS RUBBER'),
      h('ul.tips', {}, ...r.tips.map((t) => h('li', { html: `${TIP_ICON[t.id]()}<span><b>${esc(t.title)}</b>${esc(t.text)}</span>` }))),
      ...r.warnings.map((w) => h('p.note', {}, w)),
      h('p.note', {}, `Tread worn is an estimate (${fmt.mass(r.dust.mg.low)} to ${fmt.mass(r.dust.mg.high)}) from how hard you braked and turned. It is not a measurement.`),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.clear() }, this.sample ? 'Close the sample drive' : 'Close this drive'))));
  }

  private item(s: StopReport, i: number): HTMLElement {
    return h('button.item', { onclick: () => this.stopPage(i, true) },
      h('span.n', { style: `--k:${KIND[s.cls].color}` }, String(i + 1)),
      h('span', {},
        h('span.t', {}, this.names[i] || 'Unnamed street'),
        h('span.s', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')),
        h('span.s', {}, `From ${fmt.mph(s.entrySpeed)}, stopped in ${fmt.ft(s.brakingM)}. ${times(s.wearVsGentle)} the wear of a gentle stop.`),
        h('span.tags', {}, chip(s.cls))));
  }

  // ---------- one stop ----------

  stopPage(i: number, push: boolean): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.view = 'stop';
    this.sel = i;
    this.player.stop();
    if (push) app.pushStep();
    const name = this.names[i] || 'Unnamed street';
    const fact = (k: string, v: string) => h('div', {}, h('b', {}, v), h('span', {}, k));
    const cls = s.drain ? s.cls : 'none';
    const dest = s.drain ? destination(s.cls, s.drain.receiving) : null;
    app.showPage(h('div.wrap.narrow', {},
      h('button.backlink', { onclick: () => this.results(false) }, '‹ Back to my drive'),
      h('div.answer', { style: `--k:${KIND[cls].color}` },
        h('span.ai', { html: dest ? dest.icon : ICON.x() }),
        h('div', {}, h('div.eyebrow', {}, `STOP ${i + 1} · ${name.toUpperCase()}`), h('h1.h1', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')))),
      h('p.lead', {}, s.tip),
      h('div.stats', {}, fact('Speed before', fmt.mph(s.entrySpeed)), fact('Stopped in', fmt.ft(s.brakingM)), fact('Wear vs gentle', times(s.wearVsGentle))),
      s.drain ? h('div.actions.row', {},
        h('button.btn.main', { onclick: () => this.watch(i) }, '▶  See it happen'),
        h('button.btn.quiet', { onclick: () => this.results(false) }, 'Back to my drive')) : null,
      s.drain ? h('div.eyebrow.gap', {}, 'THE TRIP, STEP BY STEP') : null,
      s.drain ? journeyEl(journey(app, s.drain.index, name, 'Your tires left dust on the road here when you stopped.')) : null));
  }

  watch(i: number): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s?.drain) return;
    this.view = 'watch';
    this.sel = i;
    app.pushStep();
    app.showStage();
    const name = this.names[i] || 'this street';
    const run = app.world.nearestRun(this.pins[i], 30);
    this.player.start({
      drain: s.drain.index,
      street: run?.line ?? null,
      name,
      intro: `Rain washes the tire dust from stop ${i + 1} off <b>${esc(name)}</b>.`,
      end: (d) => h('div', {},
        h('div.eyebrow', {}, `STOP ${i + 1}`),
        h('h2.h2', {}, destination(d.cls, d.receiving).title),
        h('div.actions.row', {},
          h('button.btn.main', { onclick: () => this.stopPage(i, false) }, '‹ Back to the stop'),
          h('button.btn.quiet', { onclick: () => this.player.replay() }, 'Watch again'))),
    });
  }

  // ---------- the route on the map ----------

  private routeView(push: boolean): void {
    const app = this.app, r = this.report!;
    this.view = 'route';
    this.player.stop();
    if (push) app.pushStep();
    app.showStage();
    app.setCaption('route', ICON.car(), `<span class="say">Your ${r.hardest.length} hardest stops are pinned. <b>Tap one</b> to see its trip.</span>`);
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, this.sample ? 'SAMPLE DRIVE' : 'YOUR DRIVE'),
      h('div.list.tight', {}, ...r.hardest.map((s, i) => h('button.item.small', { onclick: () => this.stopPage(i, true) },
        h('span.n', { style: `--k:${KIND[s.cls].color}` }, String(i + 1)),
        h('span', {}, h('span.t', {}, this.names[i] || 'Unnamed street'), h('span.s', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')))))),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.results(false) }, '‹ Back to my drive'))));
    app.fitView(this.pins.length ? this.pins : this.route ?? []);
  }

  private clear(): void {
    this.player.stop();
    [this.report, this.route, this.pins, this.names, this.sel] = [null, null, [], [], -1];
    this.idle();
  }

  tap(p: XY): boolean {
    if (this.view !== 'route') return false;
    const k = this.app.pinAt(this.pins, p);
    if (k >= 0) this.stopPage(k, true);
    return k >= 0;
  }

  frame(now: number): FrameOut {
    const pins = this.pins.map((at, k) => ({ at, n: k + 1, active: k === this.sel, color: KIND[this.report?.hardest[k]?.cls ?? 'none'].color }));
    const f = this.player.frame(now);
    if (f) {
      const under = (f.scene.dissolve ?? 0) > 0;
      return { ...f, scene: { ...f.scene, route: under ? null : this.route, pins: under ? [] : pins } };
    }
    if (this.rec) {
      const last = this.track[this.track.length - 1] ?? null;
      return { scene: { route: this.track.length > 1 ? this.track : null, car: last }, cam: last ? this.app.camAt(last, 2) : null };
    }
    return { scene: { route: this.route, pins } };
  }
}

// drives are stored compactly: [t, lat, lon, speed, accuracy]
function pack(f: Fix): (number | null)[] {
  return [f.t, +f.lat.toFixed(6), +f.lon.toFixed(6), f.speed == null ? null : +f.speed.toFixed(2), f.accuracy == null ? null : Math.round(f.accuracy)];
}

function unpack(a: (number | null)[]): Fix {
  return { t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] };
}
