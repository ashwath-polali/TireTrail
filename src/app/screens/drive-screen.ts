// Drive: the home screen. Record a drive (by hand or hands-free), then see your stops on the map
// and where each one's tire dust goes when it rains.
import { analyzeDrive, type DriveReport, type StopReport } from '../../drive/analyze.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { browserDeps, DriveRecorder } from '../../drive/recorder.ts';
import type { Fix } from '../../drive/types.ts';
import { nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import type { Cls } from '../map/world.ts';
import { heroScene } from './hero.ts';
import { chip, creekName, destination, KIND } from './common.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';
import { pack, saveDrive, savedDrives } from './saved.ts';

const TIP_ICON: Record<string, () => string> = { 'brake-earlier': () => ICON.brake(), 'slow-into-turns': () => ICON.turn(), 'tire-pressure': () => ICON.gauge() };
const times = (x: number) => `${x < 3 ? x.toFixed(1) : Math.round(x)}×`;
const WAITING = 'Waiting for GPS…';
const GO_MPS = 6.7; // 15 mph: the car is really moving
const PARKED_MS = 3 * 60_000;
const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type View = 'home' | 'recording' | 'results' | 'stop' | 'watch' | 'details' | 'stopdetails';

/** Where one stop's dust ends up, as a sentence. */
export function stopAnswer(cls: Cls | null, receiving: string): string {
  switch (cls) {
    case 'creek': return `Its tire dust ends up in ${creekName(receiving)}.`;
    case 'ground': return 'Its tire dust soaks into the ground.';
    case 'elsewhere': return `Its tire dust drains to ${receiving || 'other water'}.`;
    case 'unknown': return "The pipe map loses track of its tire dust.";
    default: return 'No storm drain near this stop.';
  }
}

// a soft two-note chime; needs a tap first to unlock audio
let audio: AudioContext | null = null;
function unlockAudio(): void {
  try { audio ??= new AudioContext(); void audio.resume(); } catch { /* no audio */ }
}
function chime(): void {
  if (!audio) return;
  const t = audio.currentTime;
  for (const [f, dt] of [[660, 0], [880, 0.2]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.12, t + dt + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.45);
    o.connect(g).connect(audio.destination);
    o.start(t + dt);
    o.stop(t + dt + 0.5);
  }
}

export class DriveScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly file: HTMLInputElement;
  private view: View = 'home';
  private report: DriveReport | null = null;
  private sample = false;
  private at = 0;
  private route: XY[] | null = null;
  private pins: XY[] = [];
  private names: string[] = [];
  private sel = -1;
  private error = '';
  /** bumps on every load, so a slow one that finishes late is dropped */
  private loadTok = 0;
  private busy = false;
  // recording
  private rec: DriveRecorder | null = null;
  private track: XY[] = [];
  private trackM = 0;
  private started = 0;
  private lastMove = 0;
  /** the last 15 s of fixes, for phones that don't report speed */
  private recent: { t: number; p: XY }[] = [];
  private timer = 0;
  private status = WAITING;
  private live: { time: HTMLElement; dist: HTMLElement; msg: HTMLElement } | null = null;
  private cueUntil = 0;
  private areaAt = 0;
  private cued = new Map<number, number>();
  // hands-free: watch for the car to start moving while the page is open
  private auto = false;
  /** location was refused; don't keep asking until the switch is flipped again */
  private armFailed = false;
  private watchId: number | null = null;
  private fastSince = 0;
  private lastPos: { t: number; p: XY } | null = null;
  private lock: { release(): Promise<void> } | null = null;

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.file = h('input', { type: 'file', accept: '.gpx,application/gpx+xml' }) as HTMLInputElement;
    this.file.addEventListener('change', () => void this.openFile());
    try { this.auto = localStorage.getItem('tt-auto') === '1'; } catch { /* storage blocked */ }
  }

  private get here(): boolean {
    return this.app.tab === 'drive';
  }

  enter(): void {
    if (this.rec) { this.app.camera.follow(); this.recording(); return; }
    switch (this.view) {
      case 'results': case 'watch': this.results(false); break;
      case 'stop': this.stopCard(this.sel, false); break;
      case 'details': this.details(false); break;
      case 'stopdetails': this.stopDetails(this.sel, false); break;
      default: this.home();
    }
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'stop';
    this.disarm();
  }

  back(): boolean {
    if (this.rec) return true;
    switch (this.view) {
      case 'watch': case 'stopdetails': this.stopCard(this.sel, false); return true;
      case 'stop': case 'details': this.results(false); return true;
      case 'results': this.home(); return true;
      default: return false;
    }
  }

  relayout(): void {
    if (this.view === 'watch') this.player.relayout();
    else this.enter();
  }

  // ---------- home ----------

  home(): void {
    const app = this.app, busy = this.busy;
    this.view = 'home';
    this.player.stop();
    // arm first, so the status line below knows whether it's waiting
    if (this.auto && !this.armFailed) this.arm();
    const last = savedDrives()[0];
    const toggle = h('button.switch', { role: 'switch', 'aria-checked': String(this.auto), onclick: () => this.setAuto(!this.auto) },
      h('span.knob'), h('span', {}, 'Hands-free: start and stop by itself'));
    app.showPage(h('div.home', {},
      h('div.scene', {}, heroScene(), h('canvas.rain', { 'aria-hidden': 'true' })),
      h('div.wrap.narrow.homebox', {},
        h('div.eyebrow', {}, 'TIRETRAIL · PIERCE COUNTY, WA'),
        h('h1.display', {}, 'Drive smoother. Help the salmon.'),
        h('p.lead', {}, 'Save gas, brake safer, and see where your tire dust goes when it rains.'),
        this.error ? h('p.warn', {}, this.error) : null,
        h('div.actions', {},
          h('button.btn.main.big', { onclick: () => void this.startRec(), disabled: busy }, '●  Start a drive'),
          h('button.btn.quiet', { onclick: () => void this.loadSample(), disabled: busy }, busy ? 'Loading…' : 'Try a sample drive')),
        toggle,
        this.auto && this.watchId !== null ? h('p.status', {}, 'Waiting for the car to move. Keep TireTrail open on the screen.') : null,
        last ? h('button.lastdrive', { onclick: () => this.openSaved(last.at) }, h('span', {}, 'Last drive'), h('b', {}, `${when(last.at)} · ${last.smooth}`)) : null,
        h('div.links', {},
          h('button.link', { onclick: () => app.tutorial.open() }, 'How it works'),
          h('button.link', { onclick: () => this.file.click(), disabled: busy }, 'Open a GPX file'),
          h('button.link', { onclick: () => app.about(() => this.home()) }, 'About')),
        this.file)));
    this.rain();
  }

  /** Slow pixel rain over the home picture. */
  private rain(): void {
    const c = this.app.pageEl.querySelector<HTMLCanvasElement>('canvas.rain');
    if (!c || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const g = c.getContext('2d')!;
    const drops = Array.from({ length: 60 }, (_, i) => ({ x: (i * 97) % 400, y: (i * 53) % 220, v: 0.6 + ((i * 7) % 5) * 0.12 }));
    const step = () => {
      if (!c.isConnected) return;
      const w = (c.width = Math.ceil(c.clientWidth / 3)), ht = (c.height = Math.ceil(c.clientHeight / 3));
      g.clearRect(0, 0, w, ht);
      g.fillStyle = 'rgba(200,232,242,.55)';
      for (const d of drops) {
        d.y += d.v;
        if (d.y > ht) { d.y = -4; d.x = (d.x + 131) % Math.max(1, w); }
        g.fillRect(Math.round(d.x % w), Math.round(d.y), 1, 3);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private setAuto(on: boolean): void {
    this.auto = on;
    this.armFailed = false;
    this.error = '';
    try { localStorage.setItem('tt-auto', on ? '1' : '0'); } catch { /* storage blocked */ }
    unlockAudio();
    if (!on) this.disarm();
    this.home();
  }

  // ---------- hands-free ----------

  /** Watches speed while the page is open; starts recording once the car is really moving. */
  private arm(): void {
    if (this.watchId !== null || this.rec) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      this.armFailed = true;
      this.error = 'Hands-free needs GPS, which only works when TireTrail is opened from an https:// address.';
      return;
    }
    this.fastSince = 0;
    this.lastPos = null;
    this.watchId = navigator.geolocation.watchPosition((pos) => {
      // a rough fix (indoors, or just woken up) could look like a jump
      if (pos.coords.accuracy > 50) return;
      const p = this.app.world.toWorld([pos.coords.longitude, pos.coords.latitude]), t = pos.timestamp;
      let v = pos.coords.speed;
      if (v == null && this.lastPos && t > this.lastPos.t) v = Math.hypot(p[0] - this.lastPos.p[0], p[1] - this.lastPos.p[1]) / ((t - this.lastPos.t) / 1000);
      this.lastPos = { t, p };
      if ((v ?? 0) >= GO_MPS) {
        this.fastSince ||= t;
        if (t - this.fastSince >= 8000) { this.disarm(); void this.startRec(); }
      } else this.fastSince = 0;
    }, () => {
      // refused: say so once, and don't ask again until the switch is flipped
      this.disarm();
      this.armFailed = true;
      this.error = window.self !== window.top ? "This preview can't use GPS, so hands-free can't start here. Try the sample drive." : "Location is off for this page, so hands-free can't start.";
      if (this.here && this.view === 'home') this.home();
    }, { enableHighAccuracy: true, maximumAge: 0 });
    // keep the screen on while waiting, or GPS stops
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    wl?.request('screen').then((l) => { this.lock = l; }).catch(() => { /* not allowed */ });
  }

  private disarm(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    void this.lock?.release().catch(() => { /* gone */ });
    this.lock = null;
  }

  // ---------- recording ----------

  private async startRec(): Promise<void> {
    if (this.busy) return;
    if (!window.isSecureContext) {
      this.error = 'GPS only works when TireTrail is opened from an https:// address. Try the sample drive, or open a GPX file.';
      this.home();
      return;
    }
    unlockAudio();
    this.disarm();
    this.stopRecorder();
    this.loadTok++; // a sample still loading must not replace the recording
    this.error = '';
    this.status = WAITING;
    [this.track, this.trackM, this.started, this.lastMove, this.recent] = [[], 0, Date.now(), Date.now(), []];
    this.cued.clear();
    this.app.camera.follow();
    const rec = new DriveRecorder(browserDeps(), {
      onState: (s, msg) => {
        if (rec !== this.rec) return;
        if (s === 'denied' || s === 'unsupported') {
          this.endTimer();
          this.rec = null;
          // an embedded preview can't ask for location at all
          this.error = s === 'denied' && window.self !== window.top ? "This preview can't use GPS. Try the sample drive, or open a GPX file." : msg ?? '';
          if (this.here) this.home();
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
    if (f.t - this.areaAt > 20_000) {
      this.areaAt = f.t;
      void this.app.ensureAreas([f.lon - 0.02, f.lat - 0.015, f.lon + 0.02, f.lat + 0.015], 2);
    }
    const p = this.app.world.toWorld([f.lon, f.lat]);
    const last = this.track[this.track.length - 1];
    const v = this.speedOf(f, p);
    // GPS wobble while parked isn't distance
    if (last && v > 1) this.trackM += Math.hypot(p[0] - last[0], p[1] - last[1]);
    this.track.push(p);
    if (v > 2) this.lastMove = Date.now();
    this.lookAhead(p, f, v);
    this.tickLive();
  }

  /** m/s: the phone's own reading, or how far the car got over the last 15 s. */
  private speedOf(f: Fix, p: XY): number {
    const r = this.recent;
    r.push({ t: f.t, p });
    while (r.length > 2 && f.t - r[1].t >= 15_000) r.shift();
    if (f.speed != null) return f.speed;
    const a = r[0], dt = (f.t - a.t) / 1000;
    return dt >= 3 ? Math.hypot(p[0] - a.p[0], p[1] - a.p[1]) / dt : 0;
  }

  /** A soft reminder before a street that drains into a salmon creek. */
  private lookAhead(p: XY, f: Fix, v: number): void {
    const w = this.app.world, prev = this.track[this.track.length - 2];
    if (v < 4) return;
    let hd: number | null = null;
    if (f.heading != null && !Number.isNaN(f.heading)) hd = (f.heading * Math.PI) / 180;
    else if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 5) hd = Math.atan2(p[0] - prev[0], -(p[1] - prev[1]));
    if (hd === null) return;
    for (const ahead of [60, 120, 180]) {
      // heading is clockwise from north; world y grows southward
      const q: XY = [p[0] + Math.sin(hd) * ahead, p[1] - Math.cos(hd) * ahead];
      const run = w.nearestRun(q, 18);
      if (!run || run.k !== 0 || run.drain === null) continue;
      const seen = this.cued.get(run.piece) ?? 0;
      if (Date.now() - seen < 120_000) return;
      this.cued.set(run.piece, Date.now());
      this.cueUntil = Date.now() + 8000;
      this.app.setCaption(`cue:${run.piece}:${Date.now()}`, ICON.fish(), '<span class="say"><b>Salmon creek drain ahead.</b> Brake gently.</span>');
      chime();
      return;
    }
  }

  private recording(): void {
    const app = this.app;
    this.view = 'recording';
    app.showStage();
    app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    const cell = (b: HTMLElement, label: string) => h('div', {}, b, h('span', {}, label));
    this.live = { time: h('b', {}, '0:00'), dist: h('b', {}, '0.0 mi'), msg: h('p.p', {}, this.status) };
    const L = this.live;
    app.setPanel(h('div.fade', {},
      h('div.live', {}, h('i'), 'RECORDING'),
      h('div.stats.two', {}, cell(L.time, 'Time'), cell(L.dist, 'Distance')),
      L.msg,
      h('div.actions.row', {}, h('button.btn.main', { onclick: () => this.stopRec() }, 'Stop and see my stops')),
      h('button.link', { onclick: () => app.camera.follow() }, 'Center the map on my car')));
    this.tickLive();
  }

  private tickLive(): void {
    if (!this.live || !this.rec) return;
    this.live.time.textContent = fmt.clock((Date.now() - this.started) / 1000);
    this.live.dist.textContent = fmt.mi(this.trackM);
    if (this.cueUntil && Date.now() > this.cueUntil) {
      this.cueUntil = 0;
      this.app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    }
    // hands-free: parked for a few minutes ends the drive
    if (this.auto && Date.now() - this.started > 60_000 && Date.now() - this.lastMove > PARKED_MS) this.stopRec();
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
    void this.show(drive.fixes, false, drive.startedAt).then((ok) => { if (ok) this.remember(drive.startedAt, drive.fixes); });
  }

  private remember(at: number, fixes: readonly Fix[]): void {
    const r = this.report;
    if (!r) return;
    saveDrive({ at, mi: fmt.mi(r.distanceKm * 1000), smooth: this.smoothLine(r), creek: r.hardest.filter((s) => s.drain && s.cls === 'creek').length, fixes: fixes.map(pack) });
  }

  // ---------- loading ----------

  private setBusy(on: boolean): void {
    this.busy = on;
    if (this.here && this.view === 'home') this.home();
  }

  async loadSample(): Promise<void> {
    if (this.busy || this.rec) return;
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      const res = await fetch('data/sample-drive.json');
      if (!res.ok) throw new Error(String(res.status));
      const fixes = (await res.json()) as Fix[];
      if (tok === this.loadTok && !this.rec) await this.show(fixes, true, 0);
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
      const t = fixes[0]?.t ?? Date.now();
      if (tok === this.loadTok && !this.rec && (await this.show(fixes, false, t))) this.remember(t, fixes);
    } catch (e) {
      if (tok === this.loadTok) this.error = e instanceof GpxError ? e.message : "That file couldn't be read as a GPX track.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  /** Opens a saved drive. */
  openSaved(at: number): void {
    const d = savedDrives().find((s) => s.at === at);
    if (!d) return;
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    void this.show(d.fixes.map((a) => ({ t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] })), false, at);
  }

  /** Analyzes a drive; false if it was too short. */
  private async show(fixes: readonly Fix[], sample: boolean, at: number): Promise<boolean> {
    const app = this.app;
    // bring in the county areas the drive passes through, so its stops can be traced
    if (fixes.length) {
      const lon = fixes.map((f) => f.lon), lat = fixes.map((f) => f.lat);
      await app.ensureAreas([Math.min(...lon) - 0.01, Math.min(...lat) - 0.008, Math.max(...lon) + 0.01, Math.max(...lat) + 0.008], 12);
    }
    const report = analyzeDrive(fixes, app.data);
    this.sel = -1;
    if (report.usedFixes < 10) {
      // drop the last drive too, so no old pins outlive their report
      this.error = report.warnings[0] ?? 'This drive is too short to look at.';
      [this.report, this.route, this.pins, this.names] = [null, null, [], []];
      if (this.here) this.home();
      return false;
    }
    this.error = '';
    this.report = report;
    this.sample = sample;
    this.at = at;
    this.route = fixes.map((f) => app.world.toWorld([f.lon, f.lat]));
    this.pins = report.hardest.map((s) => app.world.toWorld(s.lngLat));
    this.names = this.pins.map((p) => this.place(p));
    this.view = 'results';
    // if the person moved to another tab meanwhile, enter() shows this later
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

  private smoothLine(r: DriveReport): string {
    const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length;
    return n ? `${n - hard} of ${n} stops smooth` : 'no full stops';
  }

  // ---------- results: the route on the map, one calm card ----------

  private results(push: boolean): void {
    const app = this.app, r = this.report!;
    this.view = 'results';
    this.sel = -1;
    this.player.stop();
    if (push) app.pushStep();
    app.showStage();
    const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length;
    const creek = r.hardest.filter((s) => s.drain && s.cls === 'creek').length;
    const traced = r.hardest.filter((s) => s.drain && s.cls !== 'unknown').length;
    const say = n === 0 ? 'There were no full stops on this drive.'
      : creek ? `${creek === 1 ? 'One of your hardest stops sends its' : `${creek} of your hardest stops send their`} tire dust into ${creekName(r.hardest.find((s) => s.drain && s.cls === 'creek')!.drain!.receiving)}, where coho salmon live.`
        : traced ? 'None of your hardest stops drain into a salmon creek.'
          : "TireTrail hasn't traced the storm pipes where you stopped yet.";
    const first = r.hardest.findIndex((s) => s.drain && s.cls === 'creek');
    app.setCaption('results', ICON.car(), `<span class="say">${this.sample ? 'Sample drive' : 'Your drive'} · ${fmt.mi(r.distanceKm * 1000)}${this.at ? ' · ' + esc(when(this.at)) : ''}</span>`);
    app.setPanel(h('div.fade', {},
      h('h2.h2', {}, n ? `${n - hard} of your ${n} stops were smooth.` : 'A smooth drive.'),
      h('p.p', {}, say),
      h('div.actions.row', {},
        r.hardest.length ? h('button.btn.main', { onclick: () => this.stopCard(first >= 0 ? first : 0, true) }, first >= 0 ? 'See where it goes' : 'See your hardest stop') : null,
        h('button.btn.quiet', { onclick: () => this.details(true) }, 'More details')),
      h('p.hint', {}, 'Tap a numbered pin to see that stop.'),
      h('button.link', { onclick: () => this.home() }, '‹ Home')));
    app.fitView(this.pins.length ? this.pins : this.route ?? []);
  }

  stopCard(i: number, push: boolean): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.view = 'stop';
    this.sel = i;
    this.player.stop();
    if (push) app.pushStep();
    app.showStage();
    const name = this.names[i] || 'Unnamed street';
    const dest = s.drain ? destination(s.cls, s.drain.receiving) : null;
    app.setCaption(`stop:${i}`, dest ? dest.icon : ICON.x(), `<span class="say">Stop ${i + 1} · <b>${esc(name)}</b></span>`);
    app.setPanel(h('div.fade', {},
      h('h2.h2', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')),
      h('p.p', {}, `From ${fmt.mph(s.entrySpeed)}, you stopped in ${fmt.ft(s.brakingM)}. That wears your tires about ${times(s.wearVsGentle)} as much as a gentle stop.`),
      h('div.actions.row', {},
        s.drain ? h('button.btn.main', { onclick: () => this.watch(i) }, '▶  See it happen') : null,
        h('button.btn.quiet', { onclick: () => this.stopDetails(i, true) }, 'More details')),
      h('button.link', { onclick: () => this.results(false) }, '‹ Back to the drive')));
    app.camera.follow();
    app.camera.flyTo(app.camAt(this.pins[i], 2.2), 800);
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
      end: (d) => h('div.fade', {},
        h('h2.h2', {}, stopAnswer(d.cls, d.receiving)),
        h('div.actions.row', {},
          h('button.btn.main', { onclick: () => this.stopCard(i, false) }, '‹ Back'),
          h('button.btn.quiet', { onclick: () => this.player.replay() }, 'Watch again'))),
    });
  }

  // ---------- more details (pages) ----------

  private details(push: boolean): void {
    const app = this.app, r = this.report!;
    this.view = 'details';
    this.player.stop();
    if (push) app.pushStep();
    const stat = (v: string, label: string) => h('div', {}, h('b', {}, v), h('span', {}, label));
    app.showPage(h('div.wrap.narrow.fade', {},
      h('button.backlink', { onclick: () => this.results(false) }, '‹ Back to the map'),
      h('div.eyebrow', {}, this.sample ? 'SAMPLE DRIVE' : `YOUR DRIVE${this.at ? ' · ' + when(this.at).toUpperCase() : ''}`),
      h('h1.h1', {}, this.smoothLine(r).replace(/^./, (c) => c.toUpperCase()) + '.'),
      h('div.stats', {},
        stat(fmt.mi(r.distanceKm * 1000), 'Distance'),
        stat(fmt.mass(r.dust.mg.typical), 'Tire rubber worn'),
        stat(fmt.pct(r.hardestWearShare), 'From your 3 hardest stops')),
      h('div.eyebrow.gap', {}, 'YOUR HARDEST STOPS'),
      h('div.list', {}, ...r.hardest.map((s, i) => this.item(s, i))),
      h('div.eyebrow.gap', {}, 'TO SHED LESS RUBBER'),
      h('ul.tips', {}, ...r.tips.map((t) => h('li', { html: `${TIP_ICON[t.id]()}<span><b>${esc(t.title)}</b>${esc(t.text)}</span>` }))),
      ...r.warnings.map((w) => h('p.note', {}, w)),
      h('p.note', {}, `Rubber worn is an estimate (${fmt.mass(r.dust.mg.low)} to ${fmt.mass(r.dust.mg.high)}) from how hard you braked and turned, not a measurement.`),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.clear() }, this.sample ? 'Close the sample drive' : 'Close this drive'))));
  }

  private item(s: StopReport, i: number): HTMLElement {
    return h('button.item', { onclick: () => this.stopCard(i, true) },
      h('span.n', { style: `--k:${KIND[s.cls].color}` }, String(i + 1)),
      h('span', {},
        h('span.t', {}, this.names[i] || 'Unnamed street'),
        h('span.s', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')),
        h('span.tags', {}, chip(s.cls))));
  }

  private stopDetails(i: number, push: boolean): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.view = 'stopdetails';
    this.sel = i;
    this.player.stop();
    if (push) app.pushStep();
    const name = this.names[i] || 'Unnamed street';
    const fact = (k: string, v: string) => h('div', {}, h('b', {}, v), h('span', {}, k));
    app.showPage(h('div.wrap.narrow.fade', {},
      h('button.backlink', { onclick: () => this.stopCard(i, false) }, '‹ Back to the map'),
      h('div.eyebrow', {}, `STOP ${i + 1} · ${name.toUpperCase()}`),
      h('h1.h1', {}, stopAnswer(s.drain ? s.cls : null, s.drain?.receiving ?? '')),
      h('p.lead', {}, s.tip),
      h('div.stats', {}, fact('Speed before', fmt.mph(s.entrySpeed)), fact('Stopped in', fmt.ft(s.brakingM)), fact('Wear vs a gentle stop', times(s.wearVsGentle))),
      s.drain ? h('div.eyebrow.gap', {}, 'THE TRIP, STEP BY STEP') : null,
      s.drain ? journeyEl(journey(app, s.drain.index, name, 'Your tires left dust on the road here when you stopped.')) : null));
  }

  private clear(): void {
    this.player.stop();
    [this.report, this.route, this.pins, this.names, this.sel] = [null, null, [], [], -1];
    this.home();
  }

  tap(p: XY): boolean {
    if (this.view !== 'results' && this.view !== 'stop') return false;
    const k = this.app.pinAt(this.pins, p);
    if (k >= 0) this.stopCard(k, true);
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
