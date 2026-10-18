// Drive: the home screen. Record a drive (by hand or hands-free), then see your stops on the map
// and where each one's tire dust goes when it rains.
import { analyzeDrive, type DriveReport, type StopReport } from '../../drive/analyze.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { browserDeps, DriveRecorder } from '../../drive/recorder.ts';
import { answered, driveHeadline, driveSummary, smoothLine, stopAnswer, storyEnd, type StopClass } from '../../drive/tips.ts';
import type { Fix } from '../../drive/types.ts';
import { bboxOf, nearestOnPolyline, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { esc, fmt, h } from '../dom.ts';
import { ICON } from '../icons.ts';
import { CAT } from '../map/palette.ts';
import { S, type Pin } from '../map/render.ts';
import { heroScene } from './hero.ts';
import { chip } from './common.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';
import { dropRecording, keepRecording, lostRecording, pack, saveDrive, savedDrives } from './saved.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';

const TIP_ICON: Record<string, () => string> = { 'brake-earlier': () => ICON.brake(), 'slow-into-turns': () => ICON.turn(), 'tire-pressure': () => ICON.gauge() };
const times = (x: number) => `${x < 3 ? x.toFixed(1) : Math.round(x)}×`;
const WAITING = 'Waiting for GPS…';
const GO_MPS = 6.7; // 15 mph: the car is really moving
const PARKED_MS = 3 * 60_000;
/** widest a drive fit goes, so the streets still show */
const FIT_MAX = 40;
/** CSS px the zoom buttons take at the right edge */
const ZOOM_COL = 56;
/** most route points drawn; very long files are simplified down to this */
const ROUTE_MAX = 6000;
const year = (t: number) => new Date(t).getFullYear() !== new Date().getFullYear();
const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', ...(year(t) ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
/** feet up close, miles past 0.2 mi */
const far = (m: number) => (m < 321.9 ? fmt.ft(m) : fmt.mi(m));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** a glyph screen readers skip */
const glyph = (g: string) => h('span', { 'aria-hidden': 'true' }, g);

type View = 'home' | 'recording' | 'still' | 'results' | 'stop' | 'watch' | 'details' | 'stopdetails';
/** Back presses from home: each view keeps one history step per level */
const LEVEL: Record<View, number> = { home: 0, recording: 1, still: 1, results: 1, stop: 2, details: 2, watch: 3, stopdetails: 3 };

// the pin key, in legend order
const PIN_KEY: [StopClass[], string][] = [[['creek'], 'salmon stream'], [['ground'], 'soaks in'], [['elsewhere'], 'other water'], [['treatment'], 'treatment plant'], [['unknown', 'none'], 'no answer yet']];
const BADGE: Record<StopClass, Pin['badge']> = { creek: 'fish', ground: 'soak', elsewhere: 'waves', treatment: 'plant', unknown: 'q', none: 'q' };

// 3x5 digits, as on the map pins
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
const rect = (x: number, y: number, w: number, ht: number, c: string) => `<rect x="${x}" y="${y}" width="${w}" height="${ht}" fill="${c}"/>`;

/** A stop's map pin with its number, as drawn on the map: class color, or hollow for no answer. */
function pinSVG(cls: StopClass, n: number, s = 3): string {
  const ok = answered(cls);
  let px = rect(0, 0, 9, 10, '#1a1712') + (ok ? rect(1, 1, 7, 8, CAT[cls]) : rect(1, 1, 7, 8, '#9aa39d') + rect(2, 2, 5, 6, '#3a413c'));
  px += rect(3, 10, 3, 2, '#1a1712') + rect(4, 12, 1, 1, '#1a1712');
  const d = DIGITS[n % 10];
  for (let k = 0; k < 15; k++) if (d[k] === '1') px += rect(3 + (k % 3), 3 + Math.floor(k / 3), 1, 1, ok ? '#1a1712' : '#eef2ec');
  return `<svg viewBox="0 0 9 13" width="${9 * s}" height="${13 * s}" shape-rendering="crispEdges" aria-hidden="true">${px}</svg>`;
}

/** A small pin for the pin key. */
function keySwatch(cls: StopClass): string {
  const fill = answered(cls) ? rect(1, 1, 5, 5, CAT[cls]) : rect(1, 1, 5, 5, '#9aa39d') + rect(2, 2, 3, 3, '#3a413c');
  return `<svg viewBox="0 0 7 9" width="14" height="18" shape-rendering="crispEdges" aria-hidden="true">${rect(0, 0, 7, 7, '#1a1712')}${fill}${rect(2, 7, 3, 1, '#1a1712')}${rect(3, 8, 1, 1, '#1a1712')}</svg>`;
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
  private pins: XY[] = [];
  private names: string[] = [];
  private trails: { path: XY[]; cls: StopClass }[] = [];
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
  private whereText: string | null = null;
  // recording
  private rec: DriveRecorder | null = null;
  private track: XY[] = [];
  private trackM = 0;
  private started = 0;
  private lastMove = 0;
  /** the fixes so far, packed, so a reload can't lose the drive */
  private packed: (number | null)[][] = [];
  /** a recording that never finished, from before a reload */
  private lost: { at: number; fixes: Fix[] } | null = null;
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
  }

  private get here(): boolean {
    return this.app.tab === 'drive';
  }

  /** True while a drive is being recorded. */
  get recording(): boolean {
    return this.rec !== null;
  }

  enter(): void {
    // our steps are gone (Back used up on another tab): rebuild them for the view
    if (!this.onOurStep()) this.depth = 0;
    if (this.rec) { this.app.camera.follow(); if (this.view === 'still') this.still(); else this.recPanel(); return; }
    if (!this.report) { this.home(); return; }
    switch (this.view) {
      case 'results': case 'watch': this.results(); break;
      case 'stop': this.stopCard(this.sel); break;
      case 'details': this.details(); break;
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
      case 'stop': case 'details': this.results(); return true;
      case 'results': case 'recording': case 'still': this.home(); return true;
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

  private sayTap(s: string): string {
    return this.tapWord() === 'Click' ? s.replace(/\bTap\b/g, 'Click').replace(/\btap\b/g, 'click') : s;
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
    const app = this.app, busy = this.busy;
    this.view = 'home';
    this.player.stop();
    this.level('home');
    // arm first, so the status line below knows whether it's waiting
    if (this.auto) this.arm();
    const last = savedDrives()[0];
    const toggle = h('button.switch', { role: 'switch', 'aria-checked': String(this.auto), onclick: () => this.setAuto(!this.auto) },
      h('span.knob'), h('span', {}, 'Hands-free: start and stop by itself'));
    app.showPage(h('div.home', {},
      h('div.scene', {}, heroScene(), h('canvas.rain', { 'aria-hidden': 'true' })),
      h('div.wrap.narrow.homebox', {},
        h('div.eyebrow', {}, `TIRETRAIL · ${this.where().toUpperCase()}`),
        h('h1.display', {}, 'Drive smoother. Help the salmon.'),
        h('p.lead', {}, 'Save gas, brake safer, and see where your tire dust goes when it rains.'),
        this.error ? h('p.warn', {}, this.sayTap(this.error)) : null,
        this.lost ? h('div.dv-lost', {},
          h('p', {}, 'TireTrail closed while it was recording your last drive.'),
          h('div.actions.row', {},
            h('button.btn.main', { onclick: () => void this.finishLost(), disabled: busy }, 'Finish your last drive'),
            h('button.btn.quiet', { onclick: () => this.dropLost(), disabled: busy }, 'Delete it'))) : null,
        h('div.actions', {},
          h('button.btn.main.big', { onclick: () => void this.startRec(), disabled: busy }, glyph('●'), ' Start a drive'),
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
    this.error = '';
    try { localStorage.setItem('tt-auto', on ? '1' : '0'); } catch { /* storage blocked */ }
    unlockAudio();
    if (!on) this.disarm();
    this.home();
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
    if (!window.isSecureContext) return this.armFail('Hands-free needs GPS, which only works when TireTrail is opened from an https:// address.');
    if (!navigator.geolocation) return this.armFail("This browser can't share its location, so hands-free can't start here.");
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
    }, (e) => {
      // no fix yet is fine; only a refusal turns hands-free off
      if (e.code !== 1) return;
      this.disarm();
      this.armFail(window.self !== window.top ? "This preview can't use GPS, so hands-free can't start here. Try the sample drive." : "Location is off for this page, so hands-free can't start. Turn location on in your browser settings, then switch it on again.");
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
    // an unfinished drive from before goes to My drives, so starting a new one never loses it
    if (this.lost) { const l = this.lost; this.lost = null; void this.keepLost(l); }
    this.loadTok++; // a sample still loading must not replace the recording
    this.error = '';
    this.status = WAITING;
    [this.track, this.trackM, this.started, this.lastMove, this.recent, this.packed] = [[], 0, Date.now(), Date.now(), [], []];
    this.cued.clear();
    this.app.camera.follow();
    const rec = new DriveRecorder(browserDeps(), {
      onState: (s, msg) => {
        if (rec !== this.rec) return;
        if (s === 'denied' || s === 'unsupported') {
          this.endRec();
          // an embedded preview can't ask for location at all
          this.error = s === 'denied' && window.self !== window.top ? "This preview can't use GPS. Try the sample drive, or open a GPX file." : msg ?? '';
          dropRecording();
          if (this.here) this.home();
        } else this.say(s === 'recording' ? 'Drive normally. Keep TireTrail open with the screen on.' : msg ?? this.status);
      },
      onFix: (f) => { if (rec === this.rec) this.addFix(f); },
      onNotice: (_k, m) => { if (rec === this.rec) this.say(m); },
    });
    this.rec = rec;
    addEventListener('beforeunload', this.onUnload);
    this.recPanel();
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
    this.packed.push(pack(f));
    if (this.packed.length % 10 === 0) keepRecording(this.started, this.packed);
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

  /** A soft reminder before a street that drains to a salmon stream, on the Drive tab only. */
  private lookAhead(p: XY, f: Fix, v: number): void {
    const w = this.app.world, prev = this.track[this.track.length - 2];
    if (v < 4 || !this.here) return;
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
      this.app.setCaption(`cue:${run.piece}:${Date.now()}`, ICON.fish(), '<span class="say"><b>Salmon stream drain ahead.</b> Brake gently.</span>');
      chime();
      return;
    }
  }

  /** The recording card. */
  private recPanel(): void {
    const app = this.app;
    this.view = 'recording';
    this.level('recording');
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

  /** Back while recording: the drive keeps going until the person stops it. */
  private still(): void {
    const app = this.app;
    this.view = 'still';
    this.level('still');
    app.showStage();
    app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    app.setPanel(h('div.fade', {},
      h('h2.h2', {}, 'Still recording.'),
      h('p.p', {}, 'TireTrail is still recording your drive. Keep it open with the screen on.'),
      h('div.actions.row', {},
        h('button.btn.main', { onclick: () => this.recPanel() }, 'Keep recording'),
        h('button.btn.quiet', { onclick: () => this.stopRec() }, 'Stop and see my stops'))));
  }

  private tickLive(): void {
    if (!this.rec) return;
    if (this.live) {
      this.live.time.textContent = fmt.clock((Date.now() - this.started) / 1000);
      this.live.dist.textContent = fmt.mi(this.trackM);
    }
    if (this.cueUntil && Date.now() > this.cueUntil) {
      this.cueUntil = 0;
      if (this.here) this.app.setCaption('rec', ICON.car(), '<span class="say">Recording your drive.</span>');
    }
    // hands-free: parked for a few minutes ends the drive
    if (this.auto && Date.now() - this.started > 60_000 && Date.now() - this.lastMove > PARKED_MS) this.stopRec();
  }

  /** Recording is over: no timer, no reload warning. */
  private endRec(): void {
    clearInterval(this.timer);
    this.live = null;
    this.rec = null;
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
    // the results take over the recording's history step; the kept copy goes once the drive is saved
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
    return saveDrive({ at, mi: fmt.mi(r.distanceKm * 1000), smooth: smoothLine(r.stops.length, hard), creek: r.hardest.filter((s) => s.cls === 'creek').length, fixes: fixes.map(pack) });
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

  private async openFile(): Promise<void> {
    const f = this.file.files?.[0];
    this.file.value = '';
    if (!f || this.busy || this.rec) return;
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

  /** Opens a saved drive. False while recording: stop the drive first. */
  openSaved(at: number): boolean {
    if (this.rec) return false;
    const d = savedDrives().find((s) => s.at === at);
    if (!d) return true;
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    void this.show(d.fixes.map((a) => ({ t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] })), false, at, false);
    return true;
  }

  /** Loads the county areas a drive passes through, then reads its stops. */
  private async analyze(fixes: readonly Fix[]): Promise<DriveReport> {
    const app = this.app, box = driveBox(fixes);
    if (box) await app.ensureAreas(box, 12);
    let r = this.read(fixes);
    // a long drive can pass more areas than load at once: make sure each hard stop's own area is in
    let more = false;
    for (const s of r.usedFixes >= 10 ? r.hardest : []) {
      if (s.drain) continue;
      const [x, y] = s.lngLat;
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
    });
  }

  /** Analyzes a drive and shows it; false if it was too short. save: keep it in My drives. */
  private async show(fixes: readonly Fix[], sample: boolean, at: number, save: boolean): Promise<boolean> {
    const app = this.app;
    const report = await this.analyze(fixes);
    this.sel = -1;
    if (report.usedFixes < 10) {
      // drop the last drive too, so no old pins outlive their report
      this.error = report.warnings[0] ?? 'This drive is too short to look at.';
      [this.report, this.route, this.pins, this.names, this.trails] = [null, null, [], [], []];
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
    this.pins = report.hardest.map((s) => w.toWorld(s.lngLat));
    this.names = this.pins.map((p) => this.place(p));
    // where each hard stop's dust goes, for a dotted trail
    this.trails = report.hardest.flatMap((s, k) => (s.hard && s.path?.coords.length ? [{ path: [this.pins[k], ...s.path.coords.map((c) => w.toWorld(c))], cls: s.cls }] : []));
    // ask for the base map near each stop, for road names where there are no traced streets
    for (const [x, y] of this.pins) app.renderer.basemap?.near(x - 40, y - 40, x + 40, y + 40);
    this.view = 'results';
    // if the person moved to another tab meanwhile, enter() shows this later
    if (this.here) this.results();
    return true;
  }

  /** "SR 410 E at 192nd Ave E", the street, or the base map's road; '' if no name is known (yet). */
  private place(p: XY): string {
    const w = this.app.world, r = w.nearestRun(p, 30);
    const name = r ? w.pieceNames[r.piece] : '';
    if (!name) return this.app.renderer.basemap?.roadAt(p[0], p[1], 30) || '';
    let cross = '', best = 70;
    for (const i of w.runsNear(p, 70)) {
      const other = w.pieceNames[w.runs[i].piece];
      if (!other || other === name) continue;
      const d = nearestOnPolyline(p, w.runs[i].line).d;
      if (d < best) [cross, best] = [other, d];
    }
    return cross ? `${name} at ${cross}` : name;
  }

  /** A stop's place name; base map roads load as the map moves, so an empty one is asked again. */
  private nameOf(i: number): string {
    if (!this.names[i] && this.pins[i]) this.names[i] = this.place(this.pins[i]);
    return this.names[i] ?? '';
  }

  // ---------- results: the route on the map, one calm card ----------

  /** Fits points in the open part of the map, no wider than FIT_MAX, clear of the card and the zoom buttons. */
  private fit(pts: XY[]): void {
    const app = this.app, r = app.renderer;
    if (!pts.length || !r.AW) return;
    const bb = bboxOf(pts);
    // CSS px to keep clear: the card on a laptop, the zoom buttons on the right
    const left = app.layout === 'laptop' && app.panel.childElementCount ? (app.panel.parentElement?.offsetWidth ?? 0) + 16 : 0;
    const right = ZOOM_COL;
    const AW = r.AW - (left + right) / S, AH = app.bandH;
    const need = Math.max((bb.maxX - bb.minX) / Math.max(10, AW - 24), (bb.maxY - bb.minY) / Math.max(10, AH - 36));
    const mpp = Math.min(FIT_MAX, Math.max(3, need));
    // pins stand above their points, so aim a little low
    const mid: XY = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2 - 7 * mpp];
    const cam = app.camAt(mid, mpp);
    cam.x = mid[0] - ((left - right) / 2 / S) * mpp;
    app.camera.follow();
    app.camera.flyTo(cam, 900);
  }

  private caption(): void {
    const app = this.app, r = this.report;
    if (!r) return;
    const s = r.hardest[this.sel];
    if (this.view === 'stop' && s) {
      const name = this.nameOf(this.sel);
      app.setCaption(`stop:${this.sel}:${name}`, pinSVG(s.cls, this.sel + 1), `<span class="say">Stop ${this.sel + 1}${name ? ` · <b>${esc(name)}</b>` : ''}</span>`);
    } else app.setCaption('results', ICON.car(), `<span class="say">${this.sample ? 'Sample drive' : 'Your drive'} · ${fmt.mi(r.distanceKm * 1000)}${this.at ? ' · ' + esc(when(this.at)) : ''}</span>`);
  }

  /** "Pin colors: salmon stream · soaks in · no answer yet", only the colors on the map. */
  private pinKey(r: DriveReport): HTMLElement {
    const have = new Set(r.hardest.map((s) => s.cls));
    const rows = PIN_KEY.filter(([cs]) => cs.some((c) => have.has(c)));
    const kids: (Node | string)[] = [];
    rows.forEach(([cs, label], k) => {
      if (k) kids.push(h('span.dv-sep', {}, ' · '));
      kids.push(h('span.dv-pk', { html: `${keySwatch(cs[0])}${label}` }));
    });
    return h('p.dv-key', {}, h('span', {}, 'Pin colors: '), ...kids);
  }

  private results(): void {
    const app = this.app, r = this.report;
    if (!r) { this.home(); return; }
    this.view = 'results';
    this.sel = -1;
    this.player.stop();
    this.level('results');
    app.showStage();
    this.caption();
    const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length, k = r.hardest.length;
    const first = r.hardest.findIndex((s) => s.cls === 'creek');
    app.setPanel(h('div.fade', {},
      h('h2.h2', {}, driveHeadline(n, hard)),
      h('p.p', {}, driveSummary(n, r.hardest.map((s) => ({ cls: s.cls, mapped: s.mapped, receiving: s.drain?.receiving ?? '' })))),
      k ? this.pinKey(r) : null,
      h('div.actions.row', {},
        k ? h('button.btn.main', { onclick: () => this.stopCard(first >= 0 ? first : 0) }, first >= 0 ? 'See where it goes' : n === 1 ? 'See your stop' : 'See your hardest stop') : null,
        h('button.btn.quiet', { onclick: () => this.details() }, 'More details')),
      k ? h('p.hint', {}, `${this.tapWord()} a numbered pin to see that stop.`) : null,
      this.unsaved ? h('p.note', {}, "This drive couldn't be saved on this device.") : null,
      h('button.link', { onclick: () => this.close() }, glyph('‹'), ' Home')));
    this.fit(this.pins.length ? this.pins : this.route ?? []);
  }

  stopCard(i: number, _push = true): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.view = 'stop';
    this.sel = i;
    this.player.stop();
    this.level('stop');
    app.showStage();
    this.caption();
    app.setPanel(h('div.fade', {},
      h('h2.h2', {}, stopAnswer(s.cls, s.drain?.receiving ?? '', s.mapped)),
      h('p.p', {}, `From ${fmt.mph(s.entrySpeed)}, you stopped in ${fmt.ft(s.brakingM)}. That wears your tires about ${times(s.wearVsGentle)} as much as a gentle stop.`),
      h('div.actions.row', {},
        s.drain ? h('button.btn.main', { onclick: () => this.watch(i) }, glyph('▶'), ' See it happen') : null,
        h('button.btn.quiet', { onclick: () => this.stopDetails(i) }, 'More details')),
      h('button.link', { onclick: () => this.close() }, glyph('‹'), ' Back to the drive')));
    app.camera.follow();
    app.camera.flyTo(app.camAt(this.pins[i], 2.2), 800);
  }

  watch(i: number): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s?.drain) return;
    this.view = 'watch';
    this.sel = i;
    this.level('watch');
    app.showStage();
    const name = this.nameOf(i) || 'this street';
    const run = app.world.nearestRun(this.pins[i], 30);
    const local = s.drain.index < this.baseDrains;
    this.player.start({
      drain: s.drain.index,
      street: run?.line ?? null,
      name,
      intro: `Rain washes the tire dust from stop ${i + 1} off <b>${esc(name)}</b>.`,
      end: (d, p) => {
        const e = storyEnd(i + 1, s.cls, d.receiving, d.code, far(p.lengthM), p.lengthM < 10, local);
        return h('div.fade', {},
          h('div.eyebrow', {}, 'THE WHOLE TRIP'),
          h('h2.h2', {}, e.title),
          h('p.p', {}, e.line),
          h('div.actions.row', {},
            h('button.btn.main', { onclick: () => this.close() }, 'Done'),
            h('button.btn.quiet', { onclick: () => this.player.replay() }, 'Watch again')));
      },
    });
  }

  // ---------- more details (pages) ----------

  private details(): void {
    const app = this.app, r = this.report;
    if (!r) { this.home(); return; }
    this.view = 'details';
    this.player.stop();
    this.level('details');
    const n = r.stops.length, hard = r.stops.filter((s) => s.hard).length, k = r.hardest.length;
    const stat = (v: string, label: string) => h('div', {}, h('b', {}, v), h('span', {}, label));
    // every stop is listed when there are 3 or fewer
    const share = k === n ? (n === 1 ? 'From your one stop' : `From your ${n} stops`) : `From your ${k} hardest stops`;
    app.showPage(h('div.wrap.narrow.fade', {},
      h('button.backlink', { onclick: () => this.close() }, glyph('‹'), ' Back to the map'),
      h('div.eyebrow', {}, this.sample ? 'SAMPLE DRIVE' : `YOUR DRIVE${this.at ? ' · ' + when(this.at).toUpperCase() : ''}`),
      h('h1.h1', {}, cap(smoothLine(n, hard)) + '.'),
      h('div.stats', {},
        stat(fmt.mi(r.distanceKm * 1000), 'Distance'),
        stat(fmt.mass(r.dust.mg.typical), 'Tire rubber worn'),
        k ? stat(fmt.pct(r.hardestWearShare), share) : null),
      k ? h('div.eyebrow.gap', {}, k === n ? (n === 1 ? 'YOUR STOP' : 'YOUR STOPS') : 'YOUR HARDEST STOPS') : null,
      k ? h('div.list', {}, ...r.hardest.map((s, i) => this.item(s, i))) : null,
      h('div.eyebrow.gap', {}, 'TO SHED LESS RUBBER'),
      h('ul.tips', {}, ...r.tips.map((t) => h('li', { html: `${TIP_ICON[t.id]()}<span><b>${esc(t.title)}</b>${esc(t.text)}</span>` }))),
      ...r.warnings.map((w) => h('p.note', {}, w)),
      h('p.note', {}, `Rubber worn is an estimate (${fmt.mass(r.dust.mg.low)} to ${fmt.mass(r.dust.mg.high)}) from how hard you braked and turned, not a measurement.`),
      h('div.actions.row', {}, h('button.btn.quiet', { onclick: () => this.clear() }, this.sample ? 'Close the sample drive' : 'Close this drive'))));
  }

  /** A stop's chip; no pipe maps there reads as no pipe data, not "no drain". */
  private chipOf(s: StopReport): HTMLElement {
    const c = chip(s.cls);
    if (!s.mapped) c.textContent = 'NO PIPE DATA';
    return c;
  }

  private item(s: StopReport, i: number): HTMLElement {
    // the number box looks like its pin: class color, or hollow for no answer
    const box = answered(s.cls) ? `--k:${CAT[s.cls]}` : '--k:#3a413c;color:#eef2ec;box-shadow:inset 0 0 0 2px #9aa39d';
    return h('button.item', { onclick: () => this.stopCard(i) },
      h('span.n', { style: box }, String(i + 1)),
      h('span', {},
        h('span.t', {}, this.nameOf(i) || `Stop ${i + 1}`),
        h('span.s', {}, stopAnswer(s.cls, s.drain?.receiving ?? '', s.mapped)),
        h('span.tags', {}, this.chipOf(s))));
  }

  private stopDetails(i: number, _push = true): void {
    const app = this.app, s = this.report?.hardest[i];
    if (!s) return;
    this.view = 'stopdetails';
    this.sel = i;
    this.player.stop();
    this.level('stopdetails');
    const name = this.nameOf(i);
    const fact = (k: string, v: string) => h('div', {}, h('b', {}, v), h('span', {}, k));
    app.showPage(h('div.wrap.narrow.fade', {},
      h('button.backlink', { onclick: () => this.close() }, glyph('‹'), ' Back to the map'),
      h('div.eyebrow', {}, `STOP ${i + 1}${name ? ` · ${name.toUpperCase()}` : ''}`),
      h('h1.h1', {}, stopAnswer(s.cls, s.drain?.receiving ?? '', s.mapped)),
      h('p.lead', {}, s.tip),
      h('div.stats', {}, fact('Speed before', fmt.mph(s.entrySpeed)), fact('Stopped in', fmt.ft(s.brakingM)), fact('Wear vs a gentle stop', times(s.wearVsGentle))),
      s.drain ? h('div.eyebrow.gap', {}, 'THE TRIP, STEP BY STEP') : null,
      s.drain ? journeyEl(journey(app, s.drain.index, name || `Stop ${i + 1}`, 'Your tires left dust on the road here when you stopped.')) : null));
  }

  private clear(): void {
    this.player.stop();
    [this.report, this.route, this.pins, this.names, this.trails, this.sel] = [null, null, [], [], [], -1];
    this.home();
  }

  /** A tap off every pin says what the pins are for. */
  private miss(): void {
    this.app.setCaption('pinhint', ICON.pin(), `<span class="say">${this.tapWord()} a numbered pin to see that stop.</span>`);
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { if (this.here && (this.view === 'results' || this.view === 'stop')) this.caption(); }, 4000);
  }

  tap(p: XY): boolean {
    // a tap during a stop's story skips to its end (once the player can)
    if (this.view === 'watch' && this.player.active) { (this.player as Player & { skipToEnd?: () => void }).skipToEnd?.(); return true; }
    if ((this.view !== 'results' && this.view !== 'stop') || !this.pins.length) return false;
    const k = this.app.pinAt(this.pins, p);
    if (k >= 0) this.stopCard(k);
    else this.miss();
    return true;
  }

  frame(now: number): FrameOut {
    const r = this.report;
    const pins: Pin[] = r ? this.pins.map((at, k) => {
      const c = r.hardest[k]?.cls ?? 'none';
      return { at, n: k + 1, active: k === this.sel, color: CAT[c], hollow: !answered(c), badge: BADGE[c] };
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
    // base map roads arrive as the camera flies in: name the stop once they do
    if (this.view === 'stop' && this.sel >= 0 && !this.names[this.sel] && now - this.nameAt > 600) {
      this.nameAt = now;
      if (this.nameOf(this.sel)) this.caption();
    }
    const muted = this.view !== 'home' && this.view !== 'recording' && this.view !== 'still';
    return { scene: { route: this.route, pins, muted, trails: muted ? this.trails : null } };
  }
}
