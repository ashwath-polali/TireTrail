// Drive: home, recording, the drive report on the map, one hard brake, a learned spot, and See it happen.
// The pages are built in drive-home.ts and drive-sheets.ts; this file keeps the state and the map.
import { analyzeDrive, type DriveReport } from '../../drive/analyze.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { loadLimits, type SpeedLimits } from '../../drive/limits.ts';
import { browserDeps, DriveRecorder, type NoticeKind } from '../../drive/recorder.ts';
import { exampleSpots, SpotAlarm, spotsFrom, type Spot } from '../../drive/spots.ts';
import { summarize } from '../../drive/summary.ts';
import { answered, smoothLine } from '../../drive/tips.ts';
import type { Fix } from '../../drive/types.ts';
import { bboxOf, nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { esc, fmt, h } from '../dom.ts';
import { CAT } from '../map/palette.ts';
import type { Pin } from '../map/render.ts';
import { glyph } from '../ui/ui.ts';
import { BADGE, pinSVG, spotPinSVG } from './drive-art.ts';
import { spotAt, type BrakePin } from './drive-pins.ts';
import { homeView } from './drive-home.ts';
import { endCard, recSheet, reportSheet, speedSheet, spotSheet, stillSheet, stopSheet, type RecSheet } from './drive-sheets.ts';
import { mph, placeOf, REC } from './drive-words.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';
import { dropRecording, driveSummaries, fillSummaries, forgetDrive, keepRecording, lostRecording, pack, saveDrive, savedDrives } from './saved.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';

const GO_MPS = 6.7; // 15 mph: the car is really moving
const PARKED_MS = 3 * 60_000;
/** widest a drive fit goes, so the streets still show */
const FIT_MAX = 40;
/** most route points drawn; very long files are simplified down to this */
const ROUTE_MAX = 6000;

type View = 'home' | 'recording' | 'still' | 'results' | 'stop' | 'speed' | 'spot' | 'watch' | 'stopdetails';
/** Back presses from home: each view keeps one history step per level */
const LEVEL: Record<View, number> = { home: 0, recording: 1, still: 1, results: 1, spot: 1, stop: 2, speed: 2, watch: 3, stopdetails: 3 };

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
// hands-free can start without a tap: the first tap anywhere unlocks the chime
try { addEventListener('pointerdown', unlockAudio, { once: true, passive: true }); } catch { /* no DOM */ }

/** The lon/lat box around a drive, padded. Loops, so a long file can't overflow the stack. */
function driveBox(fixes: readonly Fix[]): Box | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of fixes) {
    if (!Number.isFinite(f.lon) || !Number.isFinite(f.lat)) continue;
    if (f.lon < w) w = f.lon;
    if (f.lon > e) e = f.lon;
    if (f.lat < s) s = f.lat;
    if (f.lat > n) n = f.lat;
  }
  return w <= e ? [w - 0.01, s - 0.008, e + 0.01, n + 0.008] : null;
}

/** Douglas-Peucker: keeps the points that bend the line by more than tol meters. */
function simplify(pts: XY[], tol: number): XY[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n), t2 = tol * tol, stack = [0, n - 1];
  keep[0] = keep[n - 1] = 1;
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const t = L2 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L2)) : 0;
      const ex = ax + t * dx - pts[i][0], ey = ay + t * dy - pts[i][1], d = ex * ex + ey * ey;
      if (d > bd) [best, bd] = [i, d];
    }
    if (best > 0) { keep[best] = 1; stack.push(a, best, best, b); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** The route to draw: within a meter and a half of the real one, and short enough to draw every frame. */
function routeLine(pts: XY[]): XY[] {
  let tol = 1.5, out = simplify(pts, tol);
  while (out.length > ROUTE_MAX) out = simplify(out, (tol *= 2));
  return out;
}

export class DriveScreen implements Screen {
  private readonly app: App;
  private readonly player: Player;
  private readonly file: HTMLInputElement;
  /** drains in Bonney Lake's own file come first */
  private readonly baseDrains: number;
  private view: View = 'home';
  private report: DriveReport | null = null;
  private sample = false;
  private at = 0;
  private route: XY[] | null = null;
  private pins: BrakePin[] = [];
  private trails: { path: XY[]; cls: BrakePin['b']['cls'] }[] = [];
  /** the learned spots, for reminders on the report */
  private spots: Spot[] = [];
  private spot: Spot | null = null;
  private sel = -1;
  private error = '';
  /** the last drive couldn't be saved on this device */
  private unsaved = false;
  /** bumps on every load, so a slow one that finishes late is dropped */
  private loadTok = 0;
  private busy = false;
  /** history steps this screen pushed that are still there */
  private depth = 0;
  /** when a jump back over several steps began; its own popstate is skipped */
  private jumpAt = 0;
  private hintTimer = 0;
  private nameAt = 0;
  private shownAt = 0;
  private whereText: string | null = null;
  private limits: SpeedLimits | null = null;
  private migrated = false;
  // recording
  private rec: DriveRecorder | null = null;
  private track: XY[] = [];
  private trackM = 0;
  private lastFixT = 0;
  private started = 0;
  private lastMove = 0;
  /** started by itself (hands-free) */
  private autoStarted = false;
  /** the fixes so far, packed, so a reload can't lose the drive */
  private packed: (number | null)[][] = [];
  /** a recording that never finished, from before a reload */
  private lost: { at: number; fixes: Fix[] } | null = null;
  /** the last 15 s of fixes, for phones that don't report speed */
  private recent: { t: number; p: XY }[] = [];
  private timer = 0;
  private status: string = REC.waiting;
  private live: RecSheet | null = null;
  private alarm: SpotAlarm | null = null;
  private cueUntil = 0;
  private areaAt = 0;
  private cued = new Map<number, number>();
  // hands-free: watch for the car to start moving while the page is open
  private auto = false;
  private watchId: number | null = null;
  private fastSince = 0;
  private lastPos: { t: number; p: XY } | null = null;
  private lock: { release(): Promise<void> } | null = null;

  constructor(app: App) {
    this.app = app;
    this.player = new Player(app);
    this.baseDrains = app.data.drainCount;
    this.file = h('input', { type: 'file', accept: '.gpx,application/gpx+xml' }) as HTMLInputElement;
    this.file.addEventListener('change', () => void this.openFile());
    try { this.auto = localStorage.getItem('tt-auto') === '1'; } catch { /* storage blocked */ }
    this.lost = lostRecording();
    if (this.lost && this.lost.fixes.length < 10) { this.lost = null; dropRecording(); }
    // the phone may close the page without warning: keep what's recorded
    addEventListener('pagehide', () => { if (this.rec) keepRecording(this.started, this.packed); });
    void loadLimits().then((l) => { this.limits = l; });
  }

  private get here(): boolean {
    return this.app.tab === 'drive';
  }

  /** True while a drive is being recorded. */
  get recording(): boolean {
    return this.rec !== null;
  }

  /** This device can record a drive (phones and tablets); laptops get the sample first. */
  get canRecord(): boolean {
    return this.app.touch;
  }

  enter(): void {
    // our steps are gone (Back used up on another tab): rebuild them for the view
    if (!this.onOurStep()) this.depth = 0;
    if (this.rec) { this.app.camera.follow(); if (this.view === 'still') this.still(); else this.recPanel(); return; }
    if (this.view === 'spot' && this.spot) { this.showSpot(this.spot); return; }
    if (!this.report) { this.home(); return; }
    switch (this.view) {
      case 'results': case 'watch': this.results(); break;
      case 'stop': this.stopCard(this.sel); break;
      case 'speed': this.speedCard(this.sel); break;
      case 'stopdetails': this.stopDetails(this.sel); break;
      default: this.home();
    }
  }

  leave(): void {
    this.player.stop();
    if (this.view === 'watch') this.view = 'stop';
    clearTimeout(this.hintTimer);
    this.disarm();
  }

  /** The phone's Back (and every in-app back link, through history). */
  back(): boolean {
    if (this.jumpAt && Date.now() - this.jumpAt < 3000) { this.jumpAt = 0; return true; }
    this.jumpAt = 0;
    if (this.depth > 0) this.depth--;
    if (this.rec) { this.still(); return true; }
    switch (this.view) {
      case 'watch': case 'stopdetails': this.stopCard(this.sel); return true;
      case 'stop': case 'speed': this.results(); return true;
      case 'results': case 'recording': case 'still': case 'spot': this.home(); return true;
      default: return false;
    }
  }

  relayout(): void {
    if (this.view === 'watch') this.player.relayout();
    else this.enter();
  }

  // ---------- history ----------

  private onOurStep(): boolean {
    try { return this.depth > 0 && !!(history.state as { tt?: number } | null)?.tt; } catch { return false; }
  }

  /** Keeps one history step per level of the view: pushes going in, jumps back over the rest going out. */
  private level(v: View): void {
    const want = LEVEL[v];
    if (this.depth > want) {
      if (this.onOurStep()) {
        this.jumpAt = Date.now();
        history.go(want - this.depth);
      }
      this.depth = want;
    }
    while (this.depth < want) { this.app.pushStep(); this.depth++; }
  }

  /** In-app back: goes through history while our step is on top, so the phone's Back stays in step. */
  private close(): void {
    if (this.onOurStep()) history.back();
    else { this.depth = 0; this.back(); }
  }

  /** "Tap" on phones, "Click" with a mouse on a laptop. */
  private tapWord(): string {
    return this.app.layout === 'laptop' && !matchMedia('(any-pointer: coarse)').matches ? 'Click' : 'Tap';
  }

  // ---------- home ----------

  /** "Pierce County, WA": the counties the traced area covers (coverage.json), so new counties show up on their own. */
  private where(): string {
    if (this.whereText !== null) return this.whereText;
    const reg = this.app.region;
    const names = reg ? reg.counties.filter((c) => reg.covered(c)).map((c) => c.name).sort() : [];
    return (this.whereText = names.length === 1 ? `${names[0]} County, WA` : names.length === 2 ? `${names[0]} and ${names[1]} counties, WA` : 'Washington');
  }

  home(): void {
    if (this.rec) { this.recPanel(); return; }
    const app = this.app;
    this.view = 'home';
    this.spot = null;
    this.player.stop();
    this.level('home');
    // arm first, so the page knows whether it's waiting
    if (this.auto && this.canRecord) this.arm();
    this.ensureSummaries();
    const sums = driveSummaries();
    app.showPage(homeView({
      app,
      where: this.where(),
      canRecord: this.canRecord,
      busy: this.busy,
      error: this.error ? this.sayTap(this.error) : '',
      lost: !!this.lost,
      auto: this.auto,
      waiting: this.auto && this.watchId !== null,
      sums,
      spots: spotsFrom(sums),
      start: () => void this.startRec(),
      sample: () => void this.loadSample(),
      setAuto: (on) => this.setAuto(on),
      finishLost: () => void this.finishLost(),
      dropLost: () => this.dropLost(),
      openSpot: (s) => this.showSpot(s),
      openLast: () => { const d = savedDrives()[0]; if (d) this.openSaved(d.at); },
      file: this.file,
    }));
  }

  private sayTap(s: string): string {
    return this.tapWord() === 'Click' ? s.replace(/\bTap\b/g, 'Click').replace(/\btap\b/g, 'click') : s;
  }

  private setAuto(on: boolean): void {
    this.auto = on;
    this.error = '';
    try { localStorage.setItem('tt-auto', on ? '1' : '0'); } catch { /* storage blocked */ }
    unlockAudio();
    if (!on) this.disarm();
    this.home();
  }

  /** Old drives saved before summaries get one, once, so progress and spots include them. */
  ensureSummaries(): void {
    if (this.migrated) return;
    this.migrated = true;
    try {
      fillSummaries((fixes, d) => {
        const r = this.read(fixes);
        return r.usedFixes >= 10 ? summarize(r, d.at) : null;
      });
    } catch { /* an old drive that can't be read stays as it is */ }
  }

  // ---------- hands-free ----------

  /** Hands-free can't work here: turn it off, and say why once. */
  private armFail(msg: string): void {
    this.auto = false;
    this.error = msg;
    try { localStorage.setItem('tt-auto', '0'); } catch { /* storage blocked */ }
  }

  /** Watches speed while the page is open; starts recording once the car is really moving. */
  private arm(): void {
    if (this.watchId !== null || this.rec) return;
    if (!window.isSecureContext) return this.armFail('Start and stop by itself needs GPS, which only works when TireTrail is opened from an https:// address.');
    if (!navigator.geolocation) return this.armFail("This browser can't share its location, so TireTrail can't start by itself here.");
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
        if (t - this.fastSince >= 8000) { this.disarm(); void this.startRec(true); }
      } else this.fastSince = 0;
    }, (e) => {
      // no fix yet is fine; only a refusal turns it off
      if (e.code !== 1) return;
      this.disarm();
      this.armFail(window.self !== window.top ? "This preview can't use GPS. Try the sample drive." : 'TireTrail needs your location to start by itself. Turn on location for this site, then switch it on again.');
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

  private readonly onUnload = (e: BeforeUnloadEvent): void => {
    if (!this.rec) return;
    keepRecording(this.started, this.packed);
    // ask before a reload or a closed tab ends the drive
    e.preventDefault();
    e.returnValue = '';
  };

  private async startRec(byItself = false): Promise<void> {
    if (this.busy) return;
    if (!window.isSecureContext) {
      this.error = 'GPS only works when TireTrail is opened from an https:// address. Try the sample drive.';
      this.home();
      return;
    }
    unlockAudio();
    this.disarm();
    this.stopRecorder();
    // an unfinished drive from before goes to My drives, so starting a new one never loses it
    if (this.lost) { const l = this.lost; this.lost = null; void this.keepLost(l); }
    this.loadTok++; // a sample still loading must not replace the recording
    this.error = '';
    this.status = REC.waiting;
    this.autoStarted = byItself;
    [this.track, this.trackM, this.lastFixT, this.started, this.lastMove, this.recent, this.packed] = [[], 0, 0, Date.now(), Date.now(), [], []];
    this.cued.clear();
    this.cueUntil = 0;
    // warn before the places this driver keeps braking hard
    this.alarm = new SpotAlarm(spotsFrom(driveSummaries()));
    this.app.camera.follow();
    const rec = new DriveRecorder(browserDeps(), {
      onState: (s, msg) => {
        if (rec !== this.rec) return;
        if (s === 'denied' || s === 'unsupported') {
          this.endRec();
          // an embedded preview can't ask for location at all
          this.error = s === 'denied'
            ? (window.self !== window.top ? "This preview can't use GPS. Try the sample drive." : 'TireTrail needs your location to record a drive. Turn on location for this site, then tap Start again.')
            : msg ?? '';
          dropRecording();
          if (this.here) this.home();
        } else if (s === 'recording') this.say(this.autoStarted ? REC.byItself : REC.byHand);
      },
      onFix: (f) => { if (rec === this.rec) this.addFix(f); },
      onNotice: (k, m) => { if (rec === this.rec) this.notice(k, m); },
    });
    this.rec = rec;
    addEventListener('beforeunload', this.onUnload);
    this.recPanel();
    this.timer = window.setInterval(() => this.tickLive(), 1000);
    await rec.start();
  }

  /** The recorder's notices, in short words. */
  private notice(k: NoticeKind, fallback: string): void {
    const m = k === 'paused' ? REC.paused : k === 'signal-lost' ? REC.signal : k === 'no-wake-lock' ? REC.noLock : k === 'gps-timeout' ? REC.waiting
      : k === 'resumed' ? (this.autoStarted ? REC.byItself : REC.byHand) : fallback;
    this.say(m);
  }

  private say(msg: string): void {
    this.status = msg;
    if (this.cueUntil) return;
    if (this.here && (this.view === 'recording' || this.view === 'still')) this.app.setCaption(`rec:${msg}`, glyph('car'), `<span class="say">${esc(msg)}</span>`);
  }

  private addFix(f: Fix): void {
    if (f.t - this.areaAt > 20_000) {
      this.areaAt = f.t;
      void this.app.ensureAreas([f.lon - 0.02, f.lat - 0.015, f.lon + 0.02, f.lat + 0.015], 2);
    }
    this.packed.push(pack(f));
    if (this.packed.length % 10 === 0) keepRecording(this.started, this.packed);
    const p = this.app.world.toWorld([f.lon, f.lat]);
    const last = this.track[this.track.length - 1];
    const v = this.speedOf(f, p);
    // miles from speed when the phone gives it, as the report counts them; GPS wobble while parked isn't distance
    const dt = this.lastFixT ? (f.t - this.lastFixT) / 1000 : 0;
    if (f.speed != null && dt > 0 && dt <= 5) this.trackM += f.speed * dt;
    else if (last && v > 1) this.trackM += Math.hypot(p[0] - last[0], p[1] - last[1]);
    this.lastFixT = f.t;
    this.track.push(p);
    if (v > 2) this.lastMove = Date.now();
    if (!this.warnSpot(f)) this.lookAhead(p, f, v);
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

  /** A learned hard-stop spot coming up: chime and say so, big. True if it warned. */
  private warnSpot(f: Fix): boolean {
    const s = this.alarm?.check(f);
    if (!s) return false;
    this.cue('spot', REC.spot, REC.spotDo, s.name);
    return true;
  }

  /** A soft reminder before a street that drains to a salmon stream (or, in Bonney Lake, to the Fennel Creek system). */
  private lookAhead(p: XY, f: Fix, v: number): void {
    const w = this.app.world, prev = this.track[this.track.length - 2];
    if (v < 4 || !this.here || this.cueUntil) return;
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
      // county creeks are WDFW-documented coho streams; Bonney Lake's are the Fennel Creek system upstream of them
      const county = run.drain >= this.baseDrains;
      this.cue('creek', county ? REC.salmon : REC.creek, REC.creekDo, '');
      return;
    }
  }

  /** Shows a warning for 8 s, in the caption and big on the card, with the chime. */
  private cue(kind: 'spot' | 'creek', head: string, todo: string, name: string): void {
    this.cueUntil = Date.now() + 8000;
    const icon = kind === 'spot' ? glyph('bell', 3) : glyph('fish', 3);
    if (this.here) this.app.setCaption(`cue:${kind}:${Date.now()}`, icon, `<span class="say dv-cue-say"><b>${esc(head)}</b> ${esc(todo)}</span>`);
    this.live?.warn(kind, head, todo, name);
    chime();
  }

  /** The recording card. */
  private recPanel(): void {
    const app = this.app;
    this.view = 'recording';
    this.level('recording');
    app.showStage();
    this.live = recSheet({ autoStarted: this.autoStarted, end: () => this.stopRec(), center: () => app.camera.follow() });
    app.setPanel(this.live.el);
    const msg = this.status;
    this.status = '';
    this.say(msg);
    this.tickLive();
  }

  /** Back while recording: the drive keeps going until the person ends it. */
  private still(): void {
    const app = this.app;
    this.view = 'still';
    this.level('still');
    app.showStage();
    this.live = null;
    app.setPanel(stillSheet({ keep: () => this.recPanel(), end: () => this.stopRec() }));
  }

  private tickLive(): void {
    if (!this.rec) return;
    this.live?.set((Date.now() - this.started) / 1000, this.trackM, this.rec.fixes.length > 0);
    if (this.cueUntil && Date.now() > this.cueUntil) {
      this.cueUntil = 0;
      this.live?.calm();
      const msg = this.status;
      this.status = '';
      this.say(msg);
    }
    // hands-free: parked for a few minutes ends the drive
    if (this.auto && this.autoStarted && Date.now() - this.started > 60_000 && Date.now() - this.lastMove > PARKED_MS) this.stopRec();
  }

  /** Recording is over: no timer, no reload warning. */
  private endRec(): void {
    clearInterval(this.timer);
    this.live = null;
    this.rec = null;
    this.alarm = null;
    this.cueUntil = 0;
    removeEventListener('beforeunload', this.onUnload);
  }

  private stopRecorder(): void {
    if (!this.rec) return;
    const old = this.rec;
    this.endRec();
    old.stop();
  }

  private stopRec(): void {
    if (!this.rec) return;
    const old = this.rec;
    keepRecording(this.started, this.packed);
    this.endRec();
    const drive = old.stop();
    // the report takes over the recording's history step; the kept copy goes once the drive is saved
    void this.show(drive.fixes, false, drive.startedAt, true).finally(() => { if (!this.rec) dropRecording(); });
  }

  private async finishLost(): Promise<void> {
    const l = this.lost;
    if (!l || this.busy || this.rec) return;
    this.lost = null;
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      await this.show(l.fixes, false, l.at, true);
      dropRecording();
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  private dropLost(): void {
    this.lost = null;
    dropRecording();
    this.home();
  }

  /** Saves an unfinished drive to My drives without showing it. */
  private async keepLost(l: { at: number; fixes: Fix[] }): Promise<void> {
    const r = await this.analyze(l.fixes);
    if (r.usedFixes >= 10) this.save(r, l.at, l.fixes);
  }

  private save(r: DriveReport, at: number, fixes: readonly Fix[]): boolean {
    const hard = r.stops.filter((s) => s.hard).length;
    return saveDrive({ at, mi: fmt.mi(r.distanceKm * 1000), smooth: smoothLine(r.stops.length, hard), creek: r.brakes.filter((b) => b.salmon).length, fixes: fixes.map(pack) }, summarize(r, at));
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
      if (tok === this.loadTok && !this.rec) await this.show(fixes, true, 0, false);
    } catch {
      if (tok === this.loadTok) this.error = "The sample drive didn't load. Check the connection and try again.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  /** Opens the file picker for a GPX track. */
  pickFile(): void {
    if (!this.busy && !this.rec) this.file.click();
  }

  private async openFile(): Promise<void> {
    const f = this.file.files?.[0];
    this.file.value = '';
    if (!f || this.busy || this.rec) return;
    if (!this.here) this.app.setTab('drive');
    const tok = ++this.loadTok;
    this.setBusy(true);
    try {
      const fixes = parseGPX(await f.text());
      if (tok === this.loadTok && !this.rec) await this.show(fixes, false, fixes[0]?.t ?? Date.now(), true);
    } catch (e) {
      if (tok === this.loadTok) this.error = e instanceof GpxError ? e.message : "That file couldn't be read as a GPX track.";
    } finally {
      if (tok === this.loadTok) this.setBusy(false);
    }
  }

  /** Opens a saved drive. False while recording: end the drive first. */
  openSaved(at: number): boolean {
    if (this.rec) return false;
    const d = savedDrives().find((s) => s.at === at);
    if (!d) return true;
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    void this.show(d.fixes.map((a) => ({ t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] })), false, at, false);
    return true;
  }

  /** Loads the county areas a drive passes through, then reads it. */
  private async analyze(fixes: readonly Fix[]): Promise<DriveReport> {
    const app = this.app, box = driveBox(fixes);
    this.limits ??= await loadLimits();
    if (box) await app.ensureAreas(box, 12);
    let r = this.read(fixes);
    // a long drive can pass more areas than load at once: make sure each hard brake's own area is in
    let more = false;
    for (const b of r.usedFixes >= 10 ? r.brakes : []) {
      if (b.cls !== 'none' || !b.mapped) continue;
      const [x, y] = b.lngLat;
      more = (await app.ensureAreas([x - 0.003, y - 0.002, x + 0.003, y + 0.002], 2)) || more;
    }
    if (more) r = this.read(fixes);
    return r;
  }

  private read(fixes: readonly Fix[]): DriveReport {
    const app = this.app, w = app.world;
    return analyzeDrive(fixes, app.data, {
      clsOf: (d) => w.drainCls(d.index),
      covered: (ll) => { const p = w.toWorld(ll); return !!w.nearestRun(p, 300) || !!app.region?.inCoverage(p); },
      limits: this.limits,
      nameOf: (ll) => this.place(w.toWorld(ll)),
    });
  }

  /** Analyzes a drive and shows its report; false if it was too short. save: keep it in My drives. */
  private async show(fixes: readonly Fix[], sample: boolean, at: number, save: boolean): Promise<boolean> {
    const app = this.app;
    const report = await this.analyze(fixes);
    this.sel = -1;
    if (report.usedFixes < 10) {
      // drop the last drive too, so no old pins outlive their report
      this.error = report.warnings[0] ?? 'This drive is too short to look at.';
      [this.report, this.route, this.pins, this.trails] = [null, null, [], []];
      if (this.here) this.home();
      return false;
    }
    this.error = '';
    this.report = report;
    this.sample = sample;
    this.at = at;
    this.unsaved = save && !this.save(report, at, fixes);
    const w = app.world;
    this.route = routeLine(fixes.map((f) => w.toWorld([f.lon, f.lat])));
    this.pins = this.brakePins(report);
    this.spots = sample ? exampleSpots(report) : spotsFrom(driveSummaries());
    // where each hard brake's dust goes, for a dotted trail
    this.trails = this.pins.flatMap((p) => {
      const path = p.drain !== null ? app.data.path(p.drain) : null;
      return path?.coords.length ? [{ path: [p.at, ...path.coords.map((c) => w.toWorld(c))], cls: p.b.cls }] : [];
    });
    // ask for the base map near each brake, for road names where there are no traced streets
    for (const p of this.pins) app.renderer.basemap?.near(p.at[0] - 40, p.at[1] - 40, p.at[0] + 40, p.at[1] + 40);
    this.shownAt = performance.now();
    this.view = 'results';
    // if the person moved to another tab meanwhile, enter() shows this later
    if (this.here) this.results();
    return true;
  }

  /** Every hard brake as a pin, in the order driven; one that ended in a stop sits at the stop. */
  private brakePins(r: DriveReport): BrakePin[] {
    const app = this.app, w = app.world;
    return r.brakes.map((e, k): BrakePin => {
      const st = e.stop >= 0 ? r.hardStops.find((s) => s.index === e.stop) ?? null : null;
      const ll = st ? st.lngLat : e.lngLat;
      let drain = st?.drain ?? null;
      if (!st) drain = app.data.nearestDrain(ll, 50)?.drain ?? null;
      const path = drain ? app.data.path(drain.index) : null;
      const at = w.toWorld(ll);
      return {
        b: {
          n: k + 1,
          stopped: !!st,
          mphPerS: e.mphPerS,
          fromMph: mph(e.fromMps),
          entryMph: st ? mph(st.entrySpeed) : 0,
          brakingFt: st ? Math.round((st.brakingM * 3.28084) / 10) * 10 : 0,
          soonerS: st?.soonerS ?? 0,
          gentleFt: st?.gentleFt ?? 0,
          veryHard: e.veryHard,
          cls: drain ? w.drainCls(drain.index) : e.cls,
          receiving: drain?.receiving ?? e.receiving,
          code: drain?.code ?? '',
          mapped: e.mapped,
          lengthM: path?.lengthM ?? 0,
          local: drain ? drain.index < this.baseDrains : true,
          place: e.name || this.place(at),
        },
        at,
        lngLat: ll,
        heading: st?.heading ?? e.heading,
        drain: drain?.index ?? null,
      };
    });
  }

  /** "SR 410 E at 192nd Ave E", the street, or the base map's road; '' if no name is known (yet). */
  private place(p: XY): string {
    const w = this.app.world, r = w.nearestRun(p, 30);
    const name = r ? w.pieceNames[r.piece] : '';
    if (!name) return this.app.renderer.basemap?.roadAt(p[0], p[1], 30) || '';
    // the nearest other street: "at" it when close, "near" it a little farther off
    let cross = '', best = 250;
    for (const i of w.runsNear(p, 250)) {
      const other = w.pieceNames[w.runs[i].piece];
      if (!other || other === name) continue;
      const d = nearestOnPolyline(p, w.runs[i].line).d;
      if (d < best) [cross, best] = [other, d];
    }
    return cross ? `${name} ${best <= 70 ? 'at' : 'near'} ${cross}` : name;
  }

  /** Base map roads load as the map moves: fill in names that were missing. True if any arrived. */
  private fillNames(): boolean {
    let got = false;
    for (const p of this.pins) {
      if (p.b.place) continue;
      const name = this.place(p.at);
      if (name) { p.b.place = name; got = true; }
    }
    return got;
  }

  // ---------- the report: the route on the map, the sheet beside or below ----------

  /** Fits the whole route if it fits the street map, else the pins, clear of the card and the zoom keys. */
  private fitDrive(): void {
    const app = this.app, pins = this.pins.map((p) => p.at), all = [...(this.route ?? []), ...pins];
    if (!all.length || !app.renderer.AW) return;
    const o = app.openArea();
    const need = (pts: XY[]) => { const bb = bboxOf(pts); return Math.max((bb.maxX - bb.minX) / Math.max(10, o.w - 24), (bb.maxY - bb.minY) / Math.max(10, o.h - 36)); };
    const pts = need(all) <= FIT_MAX || !pins.length ? all : pins;
    app.fitView(pts);
  }

  private caption(): void {
    const app = this.app, r = this.report;
    if (!r) return;
    const p = this.pins[this.sel];
    if (this.view === 'stop' && p) {
      app.setCaption(`stop:${this.sel}:${p.b.place}`, pinSVG(p.b.cls, p.b.n), `<span class="say">${p.b.stopped ? 'Hard stop' : 'Hard brake'} ${p.b.n} of ${this.pins.length}${p.b.place ? ` · <b>${esc(p.b.place)}</b>` : ''}</span>`);
    } else {
      const mi = fmt.mi(r.distanceKm * 1000), n = this.pins.length;
      app.setCaption(`results:${n}`, glyph('route', 3), `<span class="say"><b>${this.sample ? 'Sample drive' : 'Your drive'}</b> · ${mi} · ${n ? `${n} hard ${n === 1 ? 'brake' : 'brakes'}` : 'no hard brakes'}</span>`);
    }
  }

  private results(quiet = false): void {
    const app = this.app, r = this.report;
    if (!r) { this.home(); return; }
    this.view = 'results';
    this.sel = -1;
    this.player.stop();
    this.level('results');
    app.showStage();
    this.caption();
    app.setPanel(reportSheet({
      app,
      report: r,
      sample: this.sample,
      at: this.at,
      pins: this.pins,
      spots: this.spots,
      unsaved: this.unsaved,
      quiet,
      openStop: (i) => this.stopCard(i),
      openSpeed: (i) => this.speedCard(i),
      watch: (i) => this.watch(i),
      close: () => this.close(),
      remove: this.sample ? null : () => this.removeDrive(),
    }), false, quiet);
    if (!quiet) this.fitDrive();
  }

  stopCard(i: number, _push = true): void {
    const app = this.app, p = this.pins[i];
    if (!p) return;
    this.view = 'stop';
    this.sel = i;
    this.player.stop();
    this.level('stop');
    app.showStage();
    this.caption();
    app.setPanel(stopSheet({
      app,
      pin: p,
      total: this.pins.length,
      sample: this.sample,
      spot: this.sample ? null : spotAt(this.spots, p.lngLat, p.heading),
      watch: p.drain !== null ? () => this.watch(i) : null,
      steps: p.drain !== null ? () => this.stopDetails(i) : null,
      prev: i > 0 ? () => this.stopCard(i - 1) : null,
      next: i < this.pins.length - 1 ? () => this.stopCard(i + 1) : null,
      back: () => this.close(),
    }));
    app.camera.follow();
    app.camera.flyTo(app.camAt(p.at, 2.2), 800);
  }

  /** One stretch over the speed limit: the stretch alone on the map, why it matters and what to do. */
  speedCard(i: number): void {
    const app = this.app, r = this.report, st = r?.speeding.stretches[i];
    if (!r || !st) return;
    this.view = 'speed';
    this.sel = i;
    this.player.stop();
    this.level('speed');
    app.showStage();
    const gas = r.speeding.gasSteps > 0 ? (r.money.gas.typical * st.gasSteps) / r.speeding.gasSteps : 0;
    app.setCaption(`speed:${i}`, glyph('gauge', 3), `<span class="say">Over the speed limit${st.road ? ` · <b>${esc(st.road)}</b>` : ''}</span>`);
    app.setPanel(speedSheet({ limitMph: st.limitMph, topMph: st.topMph, miles: st.miles, road: st.road, gas, back: () => this.close() }));
    const path = st.path.map((c) => app.world.toWorld(c));
    if (path.length) app.fitView(path, { min: 2.2 });
  }

  watch(i: number): void {
    const app = this.app, p = this.pins[i];
    if (!p || p.drain === null) return;
    this.view = 'watch';
    this.sel = i;
    this.level('watch');
    app.showStage();
    const name = p.b.place || 'this street';
    const run = app.world.nearestRun(p.at, 30);
    this.player.start({
      drain: p.drain,
      street: run?.line ?? null,
      name,
      intro: `Rain washes the tire dust from your ${p.b.stopped ? 'stop' : 'hard brake'} off <b>${esc(name)}</b>.`,
      end: () => endCard({ b: p.b, done: () => this.close(), again: () => this.player.replay() }),
    });
  }

  /** The step-by-step trip of one hard brake's rain, as a page. */
  private stopDetails(i: number, _push = true): void {
    const app = this.app, p = this.pins[i];
    if (!p || p.drain === null) return;
    this.view = 'stopdetails';
    this.sel = i;
    this.player.stop();
    this.level('stopdetails');
    const name = placeOf(p.b);
    app.showPage(h('div.u-screen.dv-steps', {},
      h('button.u-btn.u-ghost.dv-backlink', { type: 'button', onclick: () => this.close() }, h('span.u-ico', { 'aria-hidden': 'true', html: glyph('back') }), h('span.u-btn-label', {}, 'Back to the map')),
      h('header.dv-steps-head', {},
        h('p.u-eyebrow', {}, `${p.b.stopped ? 'HARD STOP' : 'HARD BRAKE'} ${p.b.n} · ${name.toUpperCase()}`),
        h('h1.u-title', {}, 'Where its rain goes, step by step')),
      journeyEl(journey(app, p.drain, name, 'Your tires left dust on the road here when you braked.'))));
  }

  /** A learned spot on the map: why it matters and what to do there. */
  showSpot(s: Spot): boolean {
    if (this.rec) return false;
    const app = this.app;
    if (app.tab !== 'drive') app.setTab('drive');
    this.player.stop();
    this.spot = s;
    this.view = 'spot';
    this.level('spot');
    app.showStage();
    const at = app.world.toWorld(s.lngLat);
    const near = app.data.nearestDrain(s.lngLat, 50);
    app.setCaption(`spot:${s.id}`, spotPinSVG(), `<span class="say">Your hard-brake spot${s.name ? ` · <b>${esc(s.name)}</b>` : ''}</span>`);
    app.setPanel(spotSheet({
      spot: s,
      name: s.name || this.place(at),
      drain: near ? { cls: app.world.drainCls(near.drain.index), receiving: near.drain.receiving, code: near.drain.code, lengthM: app.data.path(near.drain.index).lengthM, local: near.drain.index < this.baseDrains } : null,
      mapped: !!near || !!app.world.nearestRun(at, 300) || !!app.region?.inCoverage(at),
      done: () => this.close(),
    }));
    app.camera.follow();
    app.camera.flyTo(app.camAt(at, 2.2), 800);
    return true;
  }

  /** Deletes the open saved drive (the sheet asked first). */
  private removeDrive(): void {
    if (this.sample || !this.at) return;
    forgetDrive(this.at);
    this.player.stop();
    [this.report, this.route, this.pins, this.trails, this.sel] = [null, null, [], [], -1];
    this.close();
  }

  /** A tap off every pin says what the pins are for. */
  private miss(): void {
    this.app.setCaption('pinhint', glyph('pin', 3), `<span class="say">${this.tapWord()} a numbered pin to see that hard brake.</span>`);
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { if (this.here && (this.view === 'results' || this.view === 'stop')) this.caption(); }, 4000);
  }

  tap(p: XY): boolean {
    // a tap during a story skips to its end
    if (this.view === 'watch' && this.player.active) { this.player.skipToEnd(); return true; }
    if ((this.view !== 'results' && this.view !== 'stop') || !this.pins.length) return false;
    const k = this.app.pinAt(this.pins.map((q) => q.at), p);
    if (k >= 0) this.stopCard(k);
    else this.miss();
    return true;
  }

  frame(now: number): FrameOut {
    const pins: Pin[] = this.report ? this.pins.map((q, k) => {
      const c = q.b.cls;
      return { at: q.at, n: q.b.n, active: k === this.sel, color: CAT[c], hollow: !answered(c), badge: BADGE[c] };
    }) : [];
    const f = this.player.frame(now);
    if (f) {
      const under = (f.scene.dissolve ?? 0) > 0;
      return { ...f, scene: { ...f.scene, muted: true, route: under ? null : this.route, pins: under ? [] : pins } };
    }
    if (this.rec) {
      const last = this.track[this.track.length - 1] ?? null;
      return { scene: { route: this.track.length > 1 ? this.track : null, car: last }, cam: last ? this.app.camAt(last, 2) : null };
    }
    if (this.view === 'speed' && this.report) {
      // the stretch alone, drawn as the route, so it stands out
      const st = this.report.speeding.stretches[this.sel];
      return { scene: { route: st ? st.path.map((c) => this.app.world.toWorld(c)) : null, muted: true } };
    }
    if (this.view === 'spot' && this.spot) {
      // an amber flag with how many hard brakes happened here, and the badge for where its rain goes
      const s = this.spot;
      return { scene: { pins: [{ at: this.app.world.toWorld(s.lngLat), n: Math.min(9, s.count), active: true, color: '#ffd166', badge: BADGE[s.cls] }], muted: true } };
    }
    // base map roads arrive as the camera flies in: name the brakes once they do
    if ((this.view === 'results' || this.view === 'stop') && now - this.nameAt > 600 && performance.now() - this.shownAt < 15_000 && this.pins.some((q) => !q.b.place)) {
      this.nameAt = now;
      if (this.fillNames()) {
        if (this.view === 'stop') this.stopCard(this.sel);
        else this.results(true);
      }
    }
    const muted = this.view !== 'home' && this.view !== 'recording' && this.view !== 'still';
    return { scene: { route: this.route, pins, muted, trails: muted ? this.trails : null } };
  }
}
