// Drive: home, recording with the voice coach, the drive report on the map, one stretch or hard brake, a learned spot, and See it happen.
// The pages are built in drive-home.ts, drive-sheets.ts and autostart.ts; this file keeps the state and the map.
import { analyzeDrive, type DriveReport } from '../../drive/analyze.ts';
import { enoughDrive, MIN_DRIVE } from '../../drive/enough.ts';
import { canSpeak, isMuted, LiveCoach, playCue, replayDrive, setMuted, speak, stopSpotsFrom, unlockAudio, worstStretches, type Cue, type Replay } from '../../drive/coach/index.ts';
import { makeLog, motionOf, type CueLog, type DriveLog, type Said } from '../../drive/drivelog.ts';
import { GpxError, parseGPX } from '../../drive/gpx.ts';
import { loadLimits, type SpeedLimits } from '../../drive/limits.ts';
import { MotionTrack, type MotionLookup } from '../../drive/motion.ts';
import { browserDeps, DriveRecorder, ParkClock, readLive, type Live, type NoticeKind, type Resume } from '../../drive/recorder.ts';
import { askMotion, MotionSensor, motionState } from '../../drive/sensor.ts';
import { progressOf } from '../../drive/progress.ts';
import { exampleSpots, SPOT_M, spotsFrom, type Spot } from '../../drive/spots.ts';
import { StopWatch } from '../../drive/stopwatch.ts';
import { summarize } from '../../drive/summary.ts';
import { answered, smoothLine, type StopClass } from '../../drive/tips.ts';
import type { Drive, Fix } from '../../drive/types.ts';
import { bboxOf, nearestOnPolyline, type LngLat, type XY } from '../../geo/geo.ts';
import type { App, FrameOut, Screen } from '../app.ts';
import type { Box } from '../areas.ts';
import { openAccount } from '../cloud/account.ts';
import { onAuth, person } from '../cloud/auth.ts';
import { countDrive } from '../cloud/community.ts';
import { shortName } from '../cloud/words.ts';
import { esc, fmt, h } from '../dom.ts';
import { asApp } from '../install.ts';
import { shareButton } from '../features/share.ts';
import { CAT } from '../map/palette.ts';
import type { Pin, Scene } from '../map/render.ts';
import { glyph, salmonSVG, toast } from '../ui/ui.ts';
import { openSetup, readyPage } from './autostart.ts';
import { mapsTip, phoneOf } from './autostart-words.ts';
import { BADGE, BADGE_LABEL, badgeSVG, pinSVG, spotPinSVG } from './drive-art.ts';
import { creekCue, cueView, KIND_COLOR, KIND_LABEL, KIND_TOKEN, keyKinds, stretchAt, stretchLines, stretchMid, type CueView, type StretchLine } from './drive-coach.ts';
import { metersBetween, spotAt, type BrakePin } from './drive-pins.ts';
import { homeView } from './drive-home.ts';
import { coachExtras, forgetLog, logFor, saveLog } from './drive-log.ts';
import { salmonData } from '../../salmon/index.ts';
import { salmonRowWords, salmonTripFor } from '../../salmon/row.ts';
import type { SalmonTrip } from '../../salmon/watch.ts';
import { endCard, recSheet, reportSheet, shortSheet, spotSheet, stillSheet, stopSheet, stretchSheet, type RecSheet } from './drive-sheets.ts';
import { backLine, mph, placeOf, REC, salmonName, SHORT } from './drive-words.ts';
import { journey, journeyEl } from './journey.ts';
import { Player } from './player.ts';
import { getVehicle } from './vehicle.ts';
import { dropRecording, driveSummaries, fillSummaries, forgetDrive, keepRecording, lostRecording, pack, saveDrive, savedDrives, trackOf, unsummarized } from './saved.ts';
// @ts-ignore: Vite loads the CSS
import './drive-ui.css';
// @ts-ignore: Vite loads the CSS
import './drive-coach.css';

const GO_MPS = 6.7; // 15 mph: the car is really moving
/** the voice ask shows only below this, and goes for good once the car passes 5 mph, m/s */
const PARKED_MPS = 0.9, PULLED_OUT_MPS = 2.2;
const PARKED_MS = 3 * 60_000;
/** widest a drive fit goes, so the streets still show */
const FIT_MAX = 40;
/** most route points drawn; very long files are simplified down to this */
const ROUTE_MAX = 6000;

type View = 'home' | 'recording' | 'still' | 'short' | 'results' | 'stop' | 'stretch' | 'spot' | 'watch' | 'stopdetails' | 'ready';
/** Back presses from home: each view keeps one history step per level */
const LEVEL: Record<View, number> = { home: 0, recording: 1, still: 1, short: 1, results: 1, spot: 1, ready: 1, stop: 2, stretch: 2, watch: 3, stopdetails: 3 };
/** no salmon-stream reminder within this long of a coach cue, or of the last one, ms */
const CREEK_QUIET = 20_000, CREEK_EVERY = 180_000;
const CUE_ICON: Record<Cue['kind'], string> = { 'spot-ahead': 'bell', coast: 'stop', speeding: 'gauge', 'hard-brake': 'warn', 'fast-start': 'flame', 'salmon-ahead': 'fish' };

// a drive can start without a tap: the first tap anywhere lets sound play
try { for (const k of ['pointerdown', 'click']) addEventListener(k, unlockAudio, { once: true, passive: true }); } catch { /* no DOM */ }

/** The page has had a tap, so the browser lets it speak. */
function tapped(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return ua?.hasBeenActive ?? false;
}

/** Location permission as the browser reports it; 'prompt' when it can't say. */
async function geoPermission(): Promise<'granted' | 'prompt' | 'denied'> {
  try {
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state;
  } catch { return 'prompt'; }
}

/** How the drive being recorded picks up after a reload; its fixes are kept by saved.ts. */
const LIVE = 'tt-rec-live';
const getLive = (): string | null => { try { return localStorage.getItem(LIVE); } catch { return null; } };
const dropLive = (): void => { try { localStorage.removeItem(LIVE); } catch { /* blocked */ } };
const liveOf = (lost: { at: number; fixes: Fix[] } | null): Live | null => readLive(getLive(), lost, Date.now());

/** A stretch kind's color square, for the caption. */
const swatch = (k: StretchLine['kind']) => `<span class="dv-swatch" data-kind="${k}" aria-hidden="true"></span>`;

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
  /** drains in Bonney Lake's own file come first: below this index is Bonney Lake's map */
  readonly baseDrains: number;
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
  /** gentle stops on the report's drive whose rain reaches a salmon stream */
  private gentleSalmon = 0;
  /** salmon streams the report's drive crossed, once their tiles load */
  private streams: SalmonTrip | null = null;
  /** the drive (its start time) opened from another device's backup */
  private fromBackup: number | null = null;
  /** the drive that was too short to score: miles and seconds */
  private shortOf: { mi: number; sec: number } | null = null;
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
  private limits: SpeedLimits | null = null;
  private migrated = false;
  // recording
  private rec: DriveRecorder | null = null;
  private track: XY[] = [];
  private trackM = 0;
  private lastFixT = 0;
  private started = 0;
  /** parked time on screen, toward ending by itself */
  private park = new ParkClock();
  /** the Maps line, once per phone, the first time recording comes back from a pause */
  private tip = '';
  /** a drive whose page reloaded behind another app: it picks up as the same drive */
  private away: { lost: { at: number; fixes: Fix[] }; live: Live } | null = null;
  /** started by itself (hands-free) */
  private autoStarted = false;
  /** ends by itself once parked: started by itself, or started by hand with the switch on */
  private autoEnds = false;
  /** the fixes so far, packed, so a reload can't lose the drive */
  private packed: (number | null)[][] = [];
  /** a recording that never finished, from before a reload */
  private lost: { at: number; fixes: Fix[] } | null = null;
  /** the last 15 s of fixes, for phones that don't report speed */
  private recent: { t: number; p: XY }[] = [];
  private timer = 0;
  private status: string = REC.waiting;
  private live: RecSheet | null = null;
  /** the voice coach: learned spots, usual stops and posted limits */
  private coach: LiveCoach | null = null;
  /** started without a tap, so the browser won't let it speak yet */
  private voiceLocked = false;
  /** started by itself and the voice or motion sensor still need one tap: asked only while parked */
  private needsTap = false;
  /** the car has pulled out (past 5 mph) this drive: never ask for a tap again */
  private moved = false;
  /** the phone's motion sensor, while recording */
  private mtrack: MotionTrack | null = null;
  private sensor: MotionSensor | null = null;
  /** what the voice said or would have said, this drive; evIdx: the coach's events */
  private cueLog: (CueLog & { evIdx?: number[] })[] = [];
  private seenEvents = 0;
  /** the "recording again" line shows until then, ms */
  private noteUntil = 0;
  // the report's drive: its readings and its log (pauses, what was said, motion)
  private fixes: readonly Fix[] = [];
  private log: DriveLog | null = null;
  private gapLines: XY[][] = [];
  private lastCueAt = 0;
  private lastCreekAt = 0;
  private cueUntil = 0;
  private areaAt = 0;
  private cued = new Map<number, number>();
  /** gentle stops above salmon streams this drive */
  private stops = new StopWatch();
  private fish = 0;
  // the report's replay: colored stretches, as lines, and the worst few
  private replay: Replay | null = null;
  private lines: StretchLine[] = [];
  private worst: number[] = [];
  private colors: Record<string, string> | null = null;
  private drawn: { key: string; list: NonNullable<Scene['replay']> } = { key: '', list: [] };
  /** who is signed in, so home redraws only when that changes */
  private who = '';
  /** the report's share key */
  private share: HTMLElement | null = null;
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
    // opened from its Home Screen icon (its own storage on iPhone): Start by itself is on until turned off
    try { const v = localStorage.getItem('tt-auto'); this.auto = v === '1' || (v === null && asApp()); } catch { /* storage blocked */ }
    this.lost = lostRecording();
    // the phone reloaded the page behind Maps mid drive: the same drive goes on
    const live = liveOf(this.lost);
    if (this.lost && live) this.away = { lost: this.lost, live };
    else dropLive();
    if (!this.away && this.lost && this.lost.fixes.length < MIN_DRIVE.fixes) { this.lost = null; dropRecording(); }
    // the phone may close the page without warning: keep what's recorded
    addEventListener('pagehide', () => { if (this.rec) this.keepLive(); });
    void loadLimits().then((l) => { this.limits = l; });
    // home follows sign-in and drives that come back from the backup, live
    this.who = person()?.uid ?? '';
    onAuth(() => {
      const who = person()?.uid ?? '';
      if (who === this.who) return;
      this.who = who;
      this.redrawHome();
    });
    addEventListener('tt:drives', () => this.redrawHome());
  }

  /** Redraws home if it's showing. */
  private redrawHome(): void {
    if (this.here && this.view === 'home' && !this.rec && this.app.tab === 'drive') this.home();
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
    if (this.view === 'ready') { this.ready(); return; }
    if (this.view === 'short' && this.shortOf) { this.short(); return; }
    if (!this.report) { this.home(); return; }
    switch (this.view) {
      case 'results': case 'watch': this.results(); break;
      case 'stop': this.stopCard(this.sel); break;
      case 'stretch': this.stretchCard(this.sel); break;
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
      case 'stop': case 'stretch': this.results(); return true;
      case 'results': case 'recording': case 'still': case 'short': case 'spot': case 'ready': this.home(); return true;
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

  home(): void {
    if (this.rec) { this.recPanel(); return; }
    const app = this.app;
    // a short drive's route goes with its sheet
    if (this.view === 'short') [this.route, this.shortOf] = [null, null];
    this.view = 'home';
    this.spot = null;
    this.player.stop();
    this.level('home');
    // arm first, so the page knows whether it's waiting
    if (this.auto && this.canRecord) this.arm();
    else this.disarm();
    this.ensureSummaries();
    const p = person();
    app.showPage(homeView({
      app,
      where: 'Washington',
      canRecord: this.canRecord,
      busy: this.busy,
      error: this.error ? this.sayTap(this.error) : '',
      lost: !!this.lost,
      auto: this.auto,
      who: p ? shortName(p.name, p.email) : null,
      start: () => void this.startRec(),
      sample: () => void this.loadSample(),
      finishLost: () => void this.finishLost(),
      dropLost: () => this.dropLost(),
      signIn: (from) => openAccount(from),
      setAuto: (on) => this.setAuto(on),
      setup: () => this.guide(),
      file: this.file,
    }));
  }

  /** Every "Start a drive" key outside home: records right away on a phone, from this tap; a laptop gets home and its phone code. */
  startDrive(): void {
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    if (this.rec) { this.recPanel(); return; }
    if (!this.canRecord) { this.home(); return; }
    void this.startRec();
  }

  private sayTap(s: string): string {
    return this.tapWord() === 'Click' ? s.replace(/\bTap\b/g, 'Click').replace(/\btap\b/g, 'click') : s;
  }

  private setAuto(on: boolean): void {
    this.auto = on;
    this.error = '';
    try { localStorage.setItem('tt-auto', on ? '1' : '0'); } catch { /* storage blocked */ }
    unlockAudio();
    if (on && this.canRecord) this.arm(); else this.disarm();
    this.redrawHome();
  }

  // ---------- start automatically ----------

  /** The setup that has the phone open TireTrail when it connects to the car. */
  guide(): void {
    if (this.rec) { this.recPanel(); return; }
    openSetup({ onClose: () => this.redrawHome() });
  }

  /** The #autostart link: record right away when location is already allowed, else wait for the car with one big Start key. byCar false: the icon's "Start a drive". */
  async autostart(byCar = true): Promise<void> {
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    if (this.rec) return;
    if ((await geoPermission()) === 'granted') {
      void this.startRec(true);
      // the person chose it from the icon, so it doesn't say "Started by itself"
      if (!byCar) this.autoStarted = false;
      return;
    }
    this.arm();
    this.ready();
  }

  /** Opened by the link, waiting for a tap (or for the car to move). */
  private ready(): void {
    if (this.rec) { this.recPanel(); return; }
    this.view = 'ready';
    this.player.stop();
    this.level('ready');
    this.app.showPage(readyPage({
      waiting: this.watchId !== null,
      error: this.error ? this.sayTap(this.error) : '',
      start: () => void this.startRec(false, true),
      cancel: () => { this.disarm(); this.close(); },
    }));
  }

  /**
   * Old drives saved before summaries get one, once, so progress and spots include them.
   * Waits for the speed limits, so their speeding counts too; the page redraws when they're in.
   */
  ensureSummaries(): void {
    if (this.migrated || !unsummarized().length) return;
    this.migrated = true;
    void loadLimits().then((l) => {
      this.limits ??= l;
      let n = 0;
      try {
        n = fillSummaries((fixes, d) => {
          const r = this.read(fixes);
          return enoughDrive(r) ? summarize(r, d.at, { fixes, nameOf: this.streetOf }) : null;
        });
      } catch { /* an old drive that can't be read stays as it is */ }
      if (!n || this.rec) return;
      if (this.app.tab === 'drives') this.app.screens.drives.enter();
      else if (this.here && this.view === 'home') this.home();
    });
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
        if (t - this.fastSince >= 8000) { this.disarm(); void this.startRec(true, true, true); }
      } else this.fastSince = 0;
    }, (e) => {
      // no fix yet is fine; only a refusal turns it off
      if (e.code !== 1) return;
      this.disarm();
      this.armFail(window.self !== window.top ? "This preview can't find your location. Try the sample drive." : 'TireTrail needs your location to start by itself. Turn on location for this site, then try again.');
      if (this.here && (this.view === 'home' || this.view === 'ready')) this.enter();
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

  /** Keeps the drive so far, and how to pick it up again, in case the phone reloads the page. */
  private keepLive(): void {
    keepRecording(this.started, this.packed);
    try { localStorage.setItem(LIVE, JSON.stringify({ at: this.started, auto: this.autoStarted, ends: this.autoEnds, gaps: [...(this.rec?.gapList ?? [])] } satisfies Live)); } catch { /* full or blocked */ }
  }

  /** On boot: a drive the phone reloaded mid way picks up by itself, as the same drive. */
  comeBack(): boolean {
    const a = this.away;
    this.away = null;
    if (!a || this.rec || !this.canRecord) return false;
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    this.lost = null;
    void this.startRec(true, a.live.ends, false, { fixes: a.lost.fixes, gaps: a.live.gaps, startedAt: a.lost.at, auto: a.live.auto });
    return true;
  }

  private readonly onUnload = (e: BeforeUnloadEvent): void => {
    if (!this.rec) return;
    this.keepLive();
    // ask before a reload or a closed tab ends the drive
    e.preventDefault();
    e.returnValue = '';
  };

  /**
   * byItself: started without a tap. endsByItself: stops 3 minutes after parking. moving: the car is already driving.
   * resume: the same drive again after the page reloaded; auto: it had started by itself.
   */
  private async startRec(byItself = false, endsByItself = byItself || this.auto, moving = false, resume?: Resume & { auto: boolean }): Promise<void> {
    // a tap: the iPhone asks for the motion sensor now, before anything waits
    const motionAsk = byItself ? null : askMotion();
    if (this.busy) return;
    if (!window.isSecureContext) {
      this.error = 'Recording needs the secure https:// address of TireTrail. Try the sample drive.';
      this.home();
      return;
    }
    unlockAudio();
    // without a tap the browser won't speak yet; a tap on Start also says the drive has begun
    this.voiceLocked = byItself && !tapped();
    const motionAskable = typeof (globalThis as { DeviceMotionEvent?: { requestPermission?: unknown } }).DeviceMotionEvent?.requestPermission === 'function';
    this.needsTap = byItself && (this.voiceLocked || (motionAskable && motionState() !== 'on'));
    this.moved = moving;
    this.disarm();
    this.stopRecorder();
    // an unfinished drive from before goes to My drives, so starting a new one never loses it
    if (this.lost) { const l = this.lost; this.lost = null; void this.keepLost(l); }
    this.loadTok++; // a sample still loading must not replace the recording
    this.error = '';
    this.status = REC.waiting;
    this.autoStarted = resume ? resume.auto : byItself;
    this.autoEnds = endsByItself;
    [this.track, this.trackM, this.lastFixT, this.started, this.recent, this.packed] = [[], 0, 0, resume?.startedAt ?? Date.now(), [], []];
    this.park = new ParkClock();
    // the line and the miles so far, from before the reload
    for (const f of resume?.fixes ?? []) { this.onTrack(f); this.packed.push(pack(f)); }
    this.cued.clear();
    [this.cueUntil, this.lastCueAt, this.lastCreekAt, this.noteUntil, this.seenEvents, this.cueLog] = [0, 0, 0, 0, 0, []];
    const away = resume?.fixes.at(-1);
    if (away) {
      [this.status, this.noteUntil] = [backLine(Date.now() - away.t), Date.now() + 12_000];
      this.mapsTip();
    }
    [this.stops, this.fish] = [new StopWatch(), 0];
    // the motion sensor, for steadier hard brakes; GPS alone without it
    this.mtrack = new MotionTrack();
    this.sensor = new MotionSensor(this.mtrack);
    this.sensor.start();
    void motionAsk?.then((st) => { if (st === 'on') this.sensor?.restart(); });
    // the voice coach: where this driver brakes hard, usual stops, posted limits
    const sums = driveSummaries();
    this.coach = new LiveCoach({ spots: spotsFrom(sums), stopSpots: stopSpotsFrom(sums), limits: this.limits, motion: this.mtrack, salmon: salmonData });
    if (!this.limits) void loadLimits().then((l) => { if (l) this.coach?.setInput({ limits: l }); });
    if (!byItself) this.talk(REC.byHand);
    if (this.needsTap) for (const k of ['click', 'touchend']) addEventListener(k, this.onFirstTap, { passive: true });
    this.app.camera.follow();
    const rec = new DriveRecorder(browserDeps(), {
      onState: (s, msg) => {
        if (rec !== this.rec) return;
        if (s === 'denied' || s === 'unsupported') {
          this.endRec();
          // an embedded preview can't ask for location at all
          this.error = s === 'denied'
            ? (window.self !== window.top ? "This preview can't find your location. Try the sample drive." : 'TireTrail needs your location to record a drive. Turn on location for this site, then tap Start again.')
            : msg ?? '';
          dropRecording();
          if (this.here) this.home();
        } else if (s === 'recording' && !this.noteUntil) this.say(this.autoStarted ? REC.byItself : REC.byHand);
      },
      onFix: (f) => { if (rec === this.rec) this.addFix(f); },
      onNotice: (k, m) => { if (rec === this.rec) this.notice(k, m); },
    });
    this.rec = rec;
    addEventListener('beforeunload', this.onUnload);
    this.recPanel();
    this.timer = window.setInterval(() => this.tickLive(), 1000);
    this.keepLive();
    await rec.start(resume);
  }

  /** Back from a pause mid drive: one line on using Maps at the same time, the first time on this phone. */
  private mapsTip(): void {
    try {
      if (localStorage.getItem('tt-maps-tip')) return;
      localStorage.setItem('tt-maps-tip', '1');
    } catch { return; }
    this.tip = mapsTip(phoneOf(navigator.userAgent, navigator.maxTouchPoints || 0));
    this.showTip();
  }

  private showTip(): void {
    const el = this.live?.el;
    if (!this.tip || !el || el.querySelector('.dv-rec-tip')) return;
    el.append(h('p.u-caption.dv-rec-note.dv-rec-tip', { role: 'status' }, h('span.u-ico', { 'aria-hidden': 'true', html: glyph('map') }), h('span', {}, this.tip)));
  }

  /** The first tap after starting by itself (parked): now the voice can speak and the motion sensor can be asked for. */
  private readonly onFirstTap = (e?: Event): void => {
    // a tap on the voice switch is the switch's to handle
    if ((e?.target as Element | null)?.closest?.('.dv-voice')) return;
    for (const k of ['click', 'touchend']) removeEventListener(k, this.onFirstTap);
    if (!this.rec || !this.needsTap) return;
    // the iPhone's motion ask has to come first in the tap
    void askMotion().then((st) => { if (st === 'on') this.sensor?.restart(); });
    unlockAudio();
    const was = this.voiceLocked;
    [this.voiceLocked, this.needsTap] = [false, false];
    this.live?.ask(false);
    this.live?.voice(isMuted(), false);
    if (was && !isMuted()) this.talk(REC.voiceOn);
  };

  /** Says a line of our own, so the coach waits for it. */
  private talk(text: string): void {
    if (speak(text)) this.coach?.spoke(text, Date.now());
  }

  /** What became of a line: said out loud, muted, not allowed yet, or no speech here. */
  private said(): Said {
    return isMuted() ? 'muted' : this.voiceLocked ? 'locked' : !canSpeak() ? 'silent' : 'said';
  }

  /** The recorder's notices, in short words. */
  private notice(k: NoticeKind, fallback: string): void {
    let m = k === 'paused' ? REC.paused : k === 'signal-lost' ? REC.signal : k === 'no-wake-lock' ? REC.noLock : k === 'gps-timeout' ? REC.waiting
      : k === 'resumed' ? (this.autoStarted ? REC.byItself : REC.byHand) : fallback;
    // back after a pause: say once how long wasn't recorded
    const g = k === 'resumed' ? this.rec?.gapList.at(-1) : undefined;
    if (g && g.reason === 'hidden' && g.to - g.from >= 5000) {
      m = backLine(g.to - g.from);
      this.noteUntil = Date.now() + 12_000;
      this.mapsTip();
    }
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
    if (this.packed.length % 10 === 0) this.keepLive();
    const { p, v } = this.onTrack(f);
    if (v > 2) this.park.moved();
    // the voice ask: only while parked, gone for good once the car pulls out
    if (v >= PULLED_OUT_MPS) this.moved = true;
    this.live?.ask(this.needsTap && !this.moved && v < PARKED_MPS);
    const cue = this.coach?.update(f, Date.now()) ?? null;
    this.newEvents();
    if (cue) this.giveCue(cue, f.t);
    else this.lookAhead(p, f, v);
    if (this.stops.update(f.t, v)?.gentle) this.gentleStop([f.lon, f.lat]);
    this.tickLive();
  }

  /** Adds a fix to the drawn line and the miles. Its spot on the map, and its speed in m/s. */
  private onTrack(f: Fix): { p: XY; v: number } {
    const p = this.app.world.toWorld([f.lon, f.lat]);
    const last = this.track[this.track.length - 1];
    const v = this.speedOf(f, p);
    // miles from speed when the phone gives it, as the report counts them; GPS wobble while parked isn't distance
    const dt = this.lastFixT ? (f.t - this.lastFixT) / 1000 : 0;
    if (f.speed != null && dt > 0 && dt <= 5) this.trackM += f.speed * dt;
    else if (last && v > 1) this.trackM += Math.hypot(p[0] - last[0], p[1] - last[1]);
    this.lastFixT = f.t;
    this.track.push(p);
    return { p, v };
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

  /** Hard brakes and fast starts the coach just found: keep the sensor's full-rate window, and count the brake. */
  private newEvents(): void {
    const evs = this.coach?.events ?? [];
    for (; this.seenEvents < evs.length; this.seenEvents++) {
      const e = evs[this.seenEvents];
      this.mtrack?.mark(e.t);
      if (e.kind === 'brake') this.stops.hard(e.t);
    }
  }

  /** A gentle stop: if its rain reaches a salmon stream, count it and say so on screen for a moment. Never spoken. */
  private gentleStop(ll: LngLat): void {
    const d = this.app.data.nearestDrain(ll, 50);
    if (!d || this.app.world.drainCls(d.drain.index) !== 'creek') return;
    this.live?.salmon(++this.fish);
    if (this.cueUntil || !this.here || (this.view !== 'recording' && this.view !== 'still')) return;
    const name = salmonName(d.drain.receiving, d.drain.index < this.baseDrains);
    this.cueUntil = Date.now() + 4000;
    this.app.setCaption(`fish:${this.fish}`, salmonSVG(2), `<span class="say dv-flash">Gentle stop. Rain here drains to <b>${esc(name)}</b></span>`);
  }

  /** A coach cue: spoken words or a tone, and the words big on screen for a few seconds. */
  private giveCue(c: Cue, ft: number): void {
    const said = this.said();
    if (said === 'said') playCue(c);
    // logged on the readings' clock, so it lines up with the report
    this.cueLog.push({ at: ft, kind: c.kind, say: c.say, said, evIdx: c.events });
    if (c.say) this.lastCueAt = Date.now();
    this.showCue(cueView(c), glyph(CUE_ICON[c.kind], 3), c.kind);
  }

  /** One large caption over the map until v.ms has passed. */
  private showCue(v: CueView, icon: string, key: string): void {
    this.cueUntil = Date.now() + v.ms;
    if (this.here && (this.view === 'recording' || this.view === 'still')) {
      this.app.setCaption(`cue:${key}:${Date.now()}`, icon, `<span class="say dv-cue-big" data-tone="${v.tone}"><b>${esc(v.head)}</b> <span>${esc(v.todo)}</span></span>`);
    }
  }

  /** A soft reminder before a street that drains to a salmon stream (or, in Bonney Lake, to the Fennel Creek system). */
  private lookAhead(p: XY, f: Fix, v: number): void {
    const w = this.app.world, prev = this.track[this.track.length - 2];
    const now = Date.now();
    // quieter than the coach: never near one of its cues, and at most every few minutes
    if (v < 4 || !this.here || this.cueUntil || now - this.lastCueAt < CREEK_QUIET || now - this.lastCreekAt < CREEK_EVERY || !(this.coach?.quiet(now) ?? true)) return;
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
      const c = creekCue(run.drain >= this.baseDrains);
      this.lastCreekAt = now;
      const said = this.said();
      if (said === 'said') this.talk(c.say);
      this.cueLog.push({ at: f.t, kind: 'creek', say: c.say, said });
      this.showCue(c.view, glyph('fish', 3), 'creek');
      return;
    }
  }

  /** The recording card. */
  private recPanel(): void {
    const app = this.app;
    this.view = 'recording';
    this.level('recording');
    app.showStage();
    this.live = recSheet({ autoEnds: this.autoEnds, muted: isMuted(), locked: this.voiceLocked, end: () => this.stopRec(), toggleVoice: () => this.toggleVoice(), unlock: () => this.onFirstTap() });
    app.setPanel(this.live.el);
    const last = this.rec?.fixes.at(-1);
    this.live.ask(this.needsTap && !this.moved && !!last && (last.speed ?? 0) < PARKED_MPS);
    this.live.salmon(this.fish);
    this.showTip();
    const msg = this.status;
    this.status = '';
    this.say(msg);
    this.tickLive();
  }

  /** The voice switch: saved on this phone; turning it on says so, which also lets the browser speak. */
  private toggleVoice(): void {
    // a tap: the motion sensor can be asked for too
    if (this.needsTap) void askMotion().then((st) => { if (st === 'on') this.sensor?.restart(); });
    const muted = !isMuted();
    setMuted(muted);
    unlockAudio();
    [this.voiceLocked, this.needsTap] = [false, false];
    this.live?.ask(false);
    if (!muted) this.talk(REC.voiceOn);
    this.live?.voice(muted, false);
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
    // the phone may drop the screen lock, or the GPS may go quiet after an app switch: ask again
    this.rec.check();
    if (this.noteUntil && Date.now() > this.noteUntil) {
      this.noteUntil = 0;
      if (this.status.startsWith('Recording again.')) this.status = this.autoStarted ? REC.byItself : REC.byHand;
      if (!this.cueUntil) { const msg = this.status; this.status = ''; this.say(msg); }
    }
    if (this.cueUntil && Date.now() > this.cueUntil) {
      this.cueUntil = 0;
      const msg = this.status;
      this.status = '';
      this.say(msg);
    }
    // hands-free: parked for a few minutes on screen ends the drive; time behind Maps never counts
    const parked = this.park.tick(Date.now(), document.visibilityState !== 'hidden');
    if (this.autoEnds && Date.now() - this.started > 60_000 && parked > PARKED_MS) this.stopRec(true);
  }

  /** Recording is over: no timer, no reload warning, no sensor. */
  private endRec(): void {
    clearInterval(this.timer);
    this.live = null;
    this.rec = null;
    this.coach = null;
    this.sensor?.stop();
    [this.sensor, this.mtrack] = [null, null];
    this.cueUntil = 0;
    this.needsTap = false;
    this.tip = '';
    dropLive();
    removeEventListener('beforeunload', this.onUnload);
    for (const k of ['click', 'touchend']) removeEventListener(k, this.onFirstTap);
  }

  /** The drive's log, as it ends: pauses, what was said (with the events each line covered), the motion summary. */
  private takeLog(drive: Drive): DriveLog {
    const coach = this.coach, track = this.mtrack;
    const events = coach?.finish() ?? [];
    this.sensor?.stop();
    const cues: CueLog[] = this.cueLog.map(({ evIdx, ...c }) => (evIdx ? { ...c, ev: evIdx.map((k) => ({ kind: events[k].kind, t: events[k].peakT })) } : c));
    const st = motionState(), sensor = track?.count ? 'on' : st === 'denied' ? 'denied' : 'none';
    return makeLog(drive.startedAt, drive.gaps, cues, sensor, track?.seconds ?? [], track?.windows ?? []);
  }

  private stopRecorder(): void {
    if (!this.rec) return;
    const old = this.rec;
    this.endRec();
    old.stop();
  }

  /** byItself: parked long enough, not a tap on End drive. */
  private stopRec(byItself = false): void {
    if (!this.rec) return;
    const old = this.rec, sec = (Date.now() - this.started) / 1000;
    keepRecording(this.started, this.packed);
    const drive = old.stop(), log = this.takeLog(drive);
    this.endRec();
    // the report takes over the recording's history step; the kept copy goes once the drive is saved
    void this.show(drive.fixes, false, drive.startedAt, true, { quiet: byItself, sec, log }).finally(() => { if (!this.rec) dropRecording(); });
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
    if (enoughDrive(r)) this.save(r, l.at, l.fixes);
  }

  /** Keeps a drive in My drives, with what the coach needs, and counts it for all TireTrail drivers (signed in only). */
  private save(r: DriveReport, at: number, fixes: readonly Fix[]): boolean {
    const hard = r.stops.filter((s) => s.hard).length;
    const ok = saveDrive({ at, mi: fmt.mi(r.distanceKm * 1000), smooth: smoothLine(r.stops.length, hard), creek: r.brakes.filter((b) => b.salmon).length, fixes: fixes.map(pack) }, summarize(r, at, { fixes, nameOf: this.streetOf }));
    if (ok) countDrive(at, r, this.clsAt);
    return ok;
  }

  /** A place at a point, with its cross street: "SR 410 E near 95th St E"; '' if none. */
  private readonly nameOf = (ll: LngLat): string => this.place(this.app.world.toWorld(ll));

  /** Just the street at a point, so saved drives tally the same street together: "SR 410 E"; '' if none. */
  private readonly streetOf = (ll: LngLat): string => {
    const w = this.app.world, p = w.toWorld(ll), r = w.nearestRun(p, 30);
    return (r ? w.pieceNames[r.piece] : '') || this.app.renderer.basemap?.roadAt(p[0], p[1], 30) || '';
  };

  /** Where rain at a point goes: its nearest drain's answer. */
  private readonly clsAt = (ll: LngLat): StopClass => {
    const d = this.app.data.nearestDrain(ll, 50);
    return d ? this.app.world.drainCls(d.drain.index) : 'none';
  };

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
    if (this.busy || this.rec) return;
    // some browsers only open a picker that is on the page
    if (!this.file.isConnected) document.body.append(this.file);
    this.file.click();
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
    const d = trackOf(at);
    if (!d) return true;
    // a route from the backup has its first and last 300 m left out
    this.fromBackup = savedDrives().some((x) => x.at === at) ? null : at;
    if (this.app.tab !== 'drive') this.app.setTab('drive');
    void this.show(d.fixes.map((a) => ({ t: a[0]!, lat: a[1]!, lon: a[2]!, speed: a[3], accuracy: a[4] })), false, at, false);
    return true;
  }

  /** Loads the county areas a drive passes through, then reads it. */
  private async analyze(fixes: readonly Fix[], motion: MotionLookup | null = null): Promise<DriveReport> {
    const app = this.app, box = driveBox(fixes);
    this.limits ??= await loadLimits();
    if (box) await app.ensureAreas(box, 12);
    let r = this.read(fixes, motion);
    // a long drive can pass more areas than load at once: make sure each hard brake's own area is in
    let more = false;
    for (const b of enoughDrive(r) ? r.brakes : []) {
      if (b.cls !== 'none' || !b.mapped) continue;
      const [x, y] = b.lngLat;
      more = (await app.ensureAreas([x - 0.003, y - 0.002, x + 0.003, y + 0.002], 2)) || more;
    }
    if (more) r = this.read(fixes, motion);
    return r;
  }

  private read(fixes: readonly Fix[], motion: MotionLookup | null = null): DriveReport {
    const app = this.app, w = app.world;
    return analyzeDrive(fixes, app.data, {
      clsOf: (d) => w.drainCls(d.index),
      covered: (ll) => { const p = w.toWorld(ll); return !!w.nearestRun(p, 300) || !!app.region?.inCoverage(p); },
      limits: this.limits,
      nameOf: (ll) => this.place(w.toWorld(ll)),
      motion,
      vehicle: getVehicle(),
    });
  }

  /**
   * Analyzes a drive and shows its report; false if it was too short to score.
   * save: keep it in My drives. end.quiet: it ended by itself, so a short one goes with a toast. end.sec: how long the timer ran.
   */
  private async show(fixes: readonly Fix[], sample: boolean, at: number, save: boolean, end: { quiet?: boolean; sec?: number; log?: DriveLog } = {}): Promise<boolean> {
    const app = this.app;
    // what the drive kept beyond its route: just recorded, or saved on this phone
    const log = sample ? null : end.log ?? logFor(at), motion = motionOf(log);
    const report = await this.analyze(fixes, motion);
    this.sel = -1;
    this.error = '';
    if (!sample && !enoughDrive(report)) {
      // not saved or counted; drop the last drive too, so no old pins outlive their report
      [this.report, this.route, this.pins, this.trails] = [null, null, [], []];
      this.dropReplay();
      if (end.quiet) {
        toast(SHORT.toast, { icon: 'info', ms: 4000 });
        this.view = 'home';
        if (this.here) this.home();
        return false;
      }
      this.route = routeLine(fixes.map((f) => app.world.toWorld([f.lon, f.lat])));
      this.shortOf = { mi: report.miles, sec: Math.max(report.durationS, end.sec ?? 0) };
      this.view = 'short';
      if (this.here) this.short();
      return false;
    }
    this.report = report;
    this.sample = sample;
    this.at = at;
    [this.fixes, this.log] = [fixes, log];
    const before = save ? spotsFrom(driveSummaries()) : [];
    this.unsaved = save && !this.save(report, at, fixes);
    if (save && !this.unsaved && end.log) saveLog(end.log);
    this.gentleSalmon = report.stops.filter((s) => !s.hard && this.clsAt(s.lngLat) === 'creek').length;
    const w = app.world;
    this.route = routeLine(fixes.map((f) => w.toWorld([f.lon, f.lat])));
    this.pins = this.brakePins(report);
    this.spots = sample ? exampleSpots(report) : spotsFrom(driveSummaries());
    this.makeReplay(fixes, motion);
    // made once per drive: the picture starts drawing now, so the share opens right from the tap
    const ends = fixes.length ? [fixes[0], fixes[fixes.length - 1]].map((f): [number, number] => [f.lon, f.lat]) : [];
    this.share = sample ? null : shareButton(report, { at, label: 'Share', ends });
    // salmon streams crossed: the same fixes and hard brakes as the report; the report and the share card follow once known
    this.streams = null;
    void salmonTripFor(fixes, report.brakes.map((b) => b.lngLat)).then((t) => {
      if (!t || this.fixes !== fixes) return;
      this.streams = t;
      if (!salmonRowWords(t)) return;
      if (!sample && t.streams.length) this.share = shareButton(report, { at, label: 'Share', ends, crossings: t.streams });
      if (this.here && this.view === 'results') this.results(true);
    }).catch(() => {});
    if (save && !this.unsaved) this.cheer(report, before);
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

  /** A just-saved drive taught TireTrail a new spot, or kept a streak going: say so for a moment. */
  private cheer(r: DriveReport, before: readonly Spot[]): void {
    const fresh = this.spots.filter((s) => !before.some((b) => metersBetween(b.lngLat, s.lngLat) <= SPOT_M));
    if (fresh.length) {
      toast(fresh.length === 1 ? "New hard-brake spot learned. You'll hear a warning there next time." : `${fresh.length} new hard-brake spots learned. You'll hear a warning there next time.`, { icon: 'bell', ms: 6000 });
      return;
    }
    if (r.brakes.length) return;
    const streak = progressOf(driveSummaries()).streak;
    if (streak >= 2) toast(`${streak} drives in a row with no hard brakes.`, { icon: 'trophy', ms: 5000 });
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
    // room on the right for each pin's badge (it sits about 16 art px right of the pin)
    const k = need(pts);
    app.fitView([...pts, ...pins.map((p): XY => [p[0] + 18 * k, p[1]])]);
  }

  private caption(): void {
    const app = this.app, r = this.report;
    if (!r) return;
    const p = this.pins[this.sel], st = this.replay?.stretches[this.sel];
    if (this.view === 'stop' && p) {
      app.setCaption(`stop:${this.sel}:${p.b.place}`, pinSVG(p.b.cls, p.b.n), `<span class="say">Hard brake ${p.b.n} of ${this.pins.length}${p.b.place ? ` · <b>${esc(p.b.place)}</b>` : ''}</span>`);
    } else if (this.view === 'stretch' && st) {
      app.setCaption(`stretch:${this.sel}`, swatch(st.kind), `<span class="say"><b>${KIND_LABEL[st.kind]}</b>${st.road ? ` · ${esc(st.road)}` : ''}</span>`);
    } else if (this.replay) {
      // the key: only the colors this drive has, then what its pin badges mean
      const kinds = keyKinds(this.replay);
      const gap = this.gapLines.length ? '<span class="dv-key-i dv-key-gap"><i aria-hidden="true"></i>Not recorded</span>' : '';
      const badges = [...new Set(this.pins.map((q) => BADGE[q.b.cls]).filter((b) => !!b))];
      const row2 = badges.length ? `<span class="dv-key-row dv-key-badges">${badges.map((b) => `<span class="dv-key-i dv-key-b">${badgeSVG(b!, 2)}${BADGE_LABEL[b!]}</span>`).join('')}</span>` : '';
      app.setCaption(`key:${kinds.join()}:${badges.join()}:${!!gap}`, glyph('route', 3), `<span class="say dv-key" aria-label="Map key"><span class="dv-key-row">${kinds.map((k) => `<span class="dv-key-i" data-kind="${k}"><i aria-hidden="true"></i>${KIND_LABEL[k]}</span>`).join('')}${gap}</span>${row2}</span>`);
    } else {
      const mi = fmt.mi(r.distanceKm * 1000), n = this.pins.length;
      app.setCaption(`results:${n}`, glyph('route', 3), `<span class="say"><b>${this.sample ? 'Sample drive' : 'Your drive'}</b> · ${mi} · ${n ? `${n} hard ${n === 1 ? 'brake' : 'brakes'}` : 'no hard brakes'}</span>`);
    }
  }

  private results(quiet = false, openDetails = false): void {
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
      worst: this.worst.map((i) => ({ s: this.replay!.stretches[i], i })),
      gentleSalmon: this.gentleSalmon,
      streams: this.streams,
      trimmed: this.fromBackup === this.at,
      openStretch: (i) => this.stretchCard(i),
      watch: (i) => this.watch(i),
      close: () => this.close(),
      remove: this.sample ? null : () => this.removeDrive(),
      share: this.share,
      extras: coachExtras({ report: r, fixes: this.fixes, log: this.log, at: this.at, sample: this.sample, place: (ll) => this.place(app.world.toWorld(ll)) }),
      // the picked car changes the grams, so figure the drive again (parked: the report only shows after a drive)
      onVehicle: () => { this.report = this.read(this.fixes, motionOf(this.log)); this.results(true, true); },
      openDetails,
    }), false, quiet);
    if (!quiet) this.fitDrive();
  }

  /** A drive too short to score, ended by hand: its route, what it was and one OK. */
  private short(): void {
    const app = this.app, sh = this.shortOf;
    if (!sh) { this.home(); return; }
    this.view = 'short';
    this.player.stop();
    this.level('short');
    app.showStage();
    app.setCaption('short', glyph('route', 3), '<span class="say">Your short drive</span>');
    app.setPanel(shortSheet({ mi: sh.mi, sec: sh.sec, ok: () => this.close() }));
    this.fitDrive();
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

  /** One stretch of the replay: picked out on the map, what happened, what to do and what it cost. */
  stretchCard(i: number): void {
    const app = this.app, r = this.replay, st = r?.stretches[i];
    if (!r || !st || !this.report) return;
    this.view = 'stretch';
    this.sel = i;
    this.player.stop();
    this.level('stretch');
    app.showStage();
    this.caption();
    const k = this.worst.indexOf(i);
    // a hard brake here has a pin, and the pin knows where its rain goes
    const mid = stretchMid(r, st);
    const pin = st.kind === 'hard' ? this.pins.findIndex((p) => metersBetween(p.lngLat, mid) <= 80) : -1;
    app.setPanel(stretchSheet({
      s: st,
      pos: k >= 0 ? { n: k + 1, of: this.worst.length } : null,
      prev: k > 0 ? () => this.stretchCard(this.worst[k - 1]) : null,
      next: k >= 0 && k < this.worst.length - 1 ? () => this.stretchCard(this.worst[k + 1]) : null,
      rain: pin >= 0 ? { b: this.pins[pin].b, open: () => this.stopCard(pin) } : null,
      back: () => this.close(),
    }));
    const line = this.lines.find((l) => l.i === i);
    if (line?.path.length) app.fitView(line.path, { min: 2.2 });
  }

  // ---------- the replay ----------

  private makeReplay(fixes: readonly Fix[], motion: MotionLookup | null = null): void {
    const w = this.app.world;
    try {
      this.replay = replayDrive(fixes, { limits: this.limits, nameOf: this.nameOf, motion });
    } catch { this.dropReplay(); return; }
    this.lines = stretchLines(this.replay, (ll) => w.toWorld(ll));
    const r = this.replay;
    // where recording paused: a dashed line across
    this.gapLines = r.breaks.filter((b) => b > 0).map((b) => [w.toWorld(r.points[b - 1]), w.toWorld(r.points[b])]);
    this.worst = worstStretches(r, 3).map((s) => r.stretches.indexOf(s));
    this.drawn.key = '';
  }

  private dropReplay(): void {
    [this.replay, this.lines, this.worst, this.gapLines] = [null, [], [], []];
    this.drawn.key = '';
  }

  /** The kinds' colors, from the design tokens. */
  private kindColor(k: StretchLine['kind']): string {
    if (!this.colors) {
      const css = getComputedStyle(document.documentElement);
      this.colors = Object.fromEntries((Object.keys(KIND_TOKEN) as StretchLine['kind'][]).map((key) => [key, css.getPropertyValue(KIND_TOKEN[key]).trim() || KIND_COLOR[key]]));
    }
    return this.colors[k] ?? KIND_COLOR[k];
  }

  /** The replay as the map draws it; the picked stretch last, on top. */
  private replayScene(): NonNullable<Scene['replay']> {
    const hi = this.view === 'stretch' ? this.sel : -1, key = `${this.lines.length}:${hi}`;
    if (this.drawn.key === key) return this.drawn.list;
    const list: NonNullable<Scene['replay']> = this.lines.map((l) => ({ path: l.path, color: this.kindColor(l.kind), dot: l.kind !== 'smooth', hi: l.i === hi }));
    list.sort((a, b) => Number(a.hi) - Number(b.hi));
    const gray = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#8f877a';
    list.unshift(...this.gapLines.map((path) => ({ path, color: gray, gap: true })));
    this.drawn = { key, list };
    return list;
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
        h('p.u-eyebrow', {}, `HARD BRAKE ${p.b.n} · ${name.toUpperCase()}`),
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
    forgetLog(this.at);
    this.player.stop();
    [this.report, this.route, this.pins, this.trails, this.sel] = [null, null, [], [], -1];
    this.dropReplay();
    this.close();
  }

  /** A tap off every pin says what the pins are for. */
  private miss(): void {
    this.app.setCaption('pinhint', glyph('pin', 3), `<span class="say">${this.tapWord()} the colored route or a numbered pin to see what happened there.</span>`);
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => { if (this.here && (this.view === 'results' || this.view === 'stop' || this.view === 'stretch')) this.caption(); }, 4000);
  }

  tap(p: XY): boolean {
    // a tap during a story skips to its end
    if (this.view === 'watch' && this.player.active) { this.player.skipToEnd(); return true; }
    if (this.view !== 'results' && this.view !== 'stop' && this.view !== 'stretch') return false;
    if (!this.pins.length && !this.lines.length) return false;
    const k = this.app.pinAt(this.pins.map((q) => q.at), p);
    if (k >= 0) { this.stopCard(k); return true; }
    // then the colored route: an event near the tap first, else the smooth road under it
    const i = stretchAt(this.lines, p, this.app.camera.cam.mpp);
    if (i >= 0) this.stretchCard(i);
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
    // the report draws the drive in colored stretches; without a replay, the plain route
    const replay = this.lines.length && this.report ? this.replayScene() : null;
    return { scene: { route: replay ? null : this.route, replay, pins, muted, trails: muted ? this.trails : null } };
  }
}
