// Drive tab: record or load a drive, pin its hardest stops, follow each one's tire dust.
import { analyzeDrive, type DriveReport, type StopReport } from '../../drive/analyze.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { browserDeps, DriveRecorder } from '../../drive/recorder.ts';
import type { Fix } from '../../drive/types.ts';
import type { DrainInfo, DrainPath } from '../../data/tiretrail.ts';
import { nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { chip, destination, KIND } from './common.ts';
import { Player } from './player.ts';

const TIP_ICON: Record<string, () => string> = { 'brake-earlier': () => ICON.brake(), 'slow-into-turns': () => ICON.turn(), 'tire-pressure': () => ICON.gauge() };
const times = (x: number) => `${x < 3 ? x.toFixed(1) : Math.round(x)}×`;
const WAITING = 'Waiting for GPS…';

export class DriveScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly file: HTMLInputElement;
  private report: DriveReport | null = null;
  private sample = false;
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
    if (this.rec) {
      this.app.camera.follow();
      this.recording();
    } else if (this.report) this.results(true);
    else this.idle();
  }

  leave(): void {
    this.player.stop();
    this.sel = -1;
  }

  relayout(): void {
    if (this.player.active) this.player.relayout();
    else if (this.rec) this.recording();
    else if (this.report) this.results(true);
  }

  private idle(): void {
    const app = this.app, busy = this.busy;
    app.setCaption('drive', ICON.car(), '<span class="say">Record a drive to see where your tire dust goes.</span>');
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, 'DRIVE'),
      h('h2.h', {}, "See where your drive's tire dust goes"),
      h('p.p', {}, 'A passenger taps Start before you drive. Afterward, TireTrail pins your 3 hardest stops and follows the rain from each one to where it ends up.'),
      this.error ? h('p.warn', {}, this.error) : null,
      h('div.actions', {},
        h('button.btn.main', { onclick: () => void this.startRec(), disabled: busy }, 'Start a drive'),
        h('button.btn.quiet', { onclick: () => void this.loadSample(), disabled: busy }, busy ? 'Loading…' : 'Try a sample drive')),
      h('button.link', { onclick: () => this.file.click(), disabled: busy }, 'Open a GPX file'),
      this.file,
      h('p.note', {}, 'Your drive stays on this device. Nothing is uploaded.')));
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
    app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    const cell = (b: HTMLElement, label: string) => h('div', {}, b, h('span', {}, label));
    this.live = { time: h('b', {}, '0:00'), dist: h('b', {}, '0.0 mi'), fixes: h('b', {}, '0'), msg: h('p.p', {}, this.status) };
    const L = this.live;
    app.setPanel(h('div', {},
      h('div.live', {}, h('i'), 'RECORDING'),
      h('div.stats', {}, cell(L.time, 'Time'), cell(L.dist, 'Distance'), cell(L.fixes, 'GPS readings')),
      L.msg,
      h('button.btn.main', { onclick: () => this.stopRec() }, 'Stop and see my stops'),
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
    this.show(drive.fixes, false);
  }

  // ---------- loading ----------

  private setBusy(on: boolean): void {
    this.busy = on;
    if (this.here && !this.rec && !this.report) this.idle();
  }

  async loadSample(): Promise<void> {
    if (this.busy || this.rec) return;
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      const res = await fetch('data/sample-drive.json');
      if (!res.ok) throw new Error(String(res.status));
      const fixes = (await res.json()) as Fix[];
      if (tok === this.loadTok && !this.rec) this.show(fixes, true);
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
      if (tok === this.loadTok && !this.rec) this.show(fixes, false);
    } catch (e) {
      if (tok === this.loadTok) this.error = e instanceof GpxError ? e.message : "That file couldn't be read as a GPX track.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  private show(fixes: readonly Fix[], sample: boolean): void {
    const app = this.app;
    const report = analyzeDrive(fixes, app.data);
    this.sel = -1;
    if (report.usedFixes < 10) {
      // drop the last drive too, so no old pins outlive their report
      this.error = report.warnings[0] ?? 'This drive is too short to look at.';
      [this.report, this.route, this.pins, this.names] = [null, null, [], []];
      if (this.here) this.idle();
      return;
    }
    this.error = '';
    this.report = report;
    this.sample = sample;
    this.route = fixes.map((f) => app.world.toWorld([f.lon, f.lat]));
    this.pins = report.hardest.map((s) => app.world.toWorld(s.lngLat));
    this.names = this.pins.map((p) => this.place(p));
    // if the person moved to another tab meanwhile, enter() shows this later
    if (this.here) this.results(true);
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

  private results(fit: boolean): void {
    const app = this.app, r = this.report!;
    const n = r.hardest.length;
    app.setCaption('results', ICON.car(), n
      ? `<span class="say">Your ${n === 1 ? 'hardest stop is' : `${n} hardest stops are`} pinned. <b>Tap one</b> to follow its tire dust.</span>`
      : '<span class="say">No full stops in this drive.</span>');
    const stat = (v: string, label: string) => h('div', {}, h('b', {}, v), h('span', {}, label));
    app.setPanel(h('div', {},
      h('div.eyebrow', {}, this.sample ? 'SAMPLE DRIVE' : 'YOUR DRIVE'),
      h('h2.h', {}, n ? `Your ${n} hardest stops` : 'No full stops found'),
      h('div.stats', {},
        stat(fmt.mi(r.distanceKm * 1000), 'Distance'),
        stat(fmt.mass(r.dust.mg.typical), 'Tread worn'),
        stat(fmt.pct(r.hardestWearShare), n === 1 ? 'From this stop' : `From these ${n}`)),
      h('div.list', {}, ...r.hardest.map((s, i) => this.item(s, i))),
      h('div.eyebrow', {}, 'TO SHED LESS RUBBER'),
      h('ul.tips', {}, ...r.tips.map((t) => h('li', { html: `${TIP_ICON[t.id]()}<span><b>${esc(t.title)}</b>${esc(t.text)}</span>` }))),
      ...r.warnings.map((w) => h('p.note', {}, w)),
      h('p.note', {}, `Tread worn is an estimate (${fmt.mass(r.dust.mg.low)} to ${fmt.mass(r.dust.mg.high)}) from how hard you braked and turned. It is not a measurement.`),
      h('button.btn.quiet', { onclick: () => this.clear() }, this.sample ? 'Close the sample drive' : 'Clear this drive')));
    if (fit && this.route) app.fitView(this.pins.length ? this.pins : this.route);
  }

  private item(s: StopReport, i: number): HTMLElement {
    const sub = `From ${fmt.mph(s.entrySpeed)}, ${s.hard ? 'a hard stop' : 'a normal stop'}. ${times(s.wearVsGentle)} the wear of a gentle stop.`;
    return h('button.item' + (i === this.sel ? '.on' : ''), { onclick: () => this.play(i) },
      h('span.n', { style: `--k:${KIND[s.cls].color}` }, String(i + 1)),
      h('span', {}, h('span.t', {}, this.names[i] || 'Unnamed street'), h('span.s', {}, sub), h('span.tags', {}, chip(s.cls))));
  }

  play(i: number): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.sel = i;
    const name = this.names[i] || 'this street';
    if (!s.drain) {
      this.player.stop();
      app.setCaption(`stop:${i}`, ICON.x(), `<span class="say">No mapped storm drain near stop ${i + 1}.</span>`);
      app.setPanel(this.card(i, null, null));
      app.camera.follow();
      app.camera.flyTo(app.camAt(this.pins[i], 1.6), 900);
      return;
    }
    const run = app.world.nearestRun(this.pins[i], 30);
    this.player.start({
      drain: s.drain.index,
      street: run?.line ?? null,
      name,
      intro: `Rain washes the tire dust from stop ${i + 1} off <b>${esc(name)}</b>.`,
      end: (d, p) => this.card(i, d, p),
    });
  }

  private card(i: number, d: DrainInfo | null, p: DrainPath | null): Node {
    const s = this.report!.hardest[i];
    const fact = (k: string, v: string) => h('div', {}, h('b', {}, v), h('span', {}, k));
    return h('div', {},
      h('div.eyebrow', {}, `STOP ${i + 1} · ${(this.names[i] || 'UNNAMED STREET').toUpperCase()}`),
      h('h2.h', {}, d ? destination(d.cls, d.receiving).title : 'No drain nearby'),
      h('p.p', {}, s.tip),
      h('div.stats', {}, fact('Speed before', fmt.mph(s.entrySpeed)), fact('Stopped in', fmt.ft(s.brakingM)), fact('Wear vs gentle', times(s.wearVsGentle))),
      d && p ? h('p.note', {}, `${d.reason} Traced ${fmt.ft(p.lengthM)} from catch basin ${d.id}.`) : null,
      h('div.actions', {},
        d ? h('button.btn.main', { onclick: () => this.player.replay() }, 'Watch it again') : null,
        h('button.btn.quiet', { onclick: () => this.back() }, 'Back to my drive')));
  }

  private back(): void {
    this.player.stop();
    this.sel = -1;
    this.results(true);
  }

  private clear(): void {
    this.player.stop();
    [this.report, this.route, this.pins, this.names, this.sel] = [null, null, [], [], -1];
    this.idle();
  }

  tap(p: XY): boolean {
    const k = this.app.pinAt(this.pins, p);
    if (k >= 0) this.play(k);
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
