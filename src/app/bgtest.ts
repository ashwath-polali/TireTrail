// #bgtest, hidden: one tap starts GPS, the motion sensor, a looping silent sound and a mini window (Picture in Picture)
// with a live pixel HUD. Every fix and every hide or show is logged to this phone, so coming back says what arrived away.
// Expected from the engines' code: WebKit and Blink stop GPS and motion for a hidden page. This checks it on a real phone.
import { addEntry, aways, readLog, span, verdict, type BgEntry, type BgKind } from '../drive/bglog.ts';
import { askMotion } from '../drive/sensor.ts';
import { h } from './dom.ts';
import { button, insight, screen } from './ui/ui.ts';
// @ts-ignore: Vite loads the CSS
import './screens/drive-ui.css';
import './bgtest.css';

const KEY = 'tt-bgtest';
const save = (log: BgEntry[]): void => { try { localStorage.setItem(KEY, JSON.stringify(log)); } catch { /* full or blocked */ } };
const load = (): BgEntry[] => { try { return readLog(localStorage.getItem(KEY)); } catch { return []; } };

/** One second of silence, as a WAV, so the sound can loop. */
function silence(): string {
  const rate = 8000, n = rate, b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
}

type PipVideo = HTMLVideoElement & { webkitSupportsPresentationMode?(m: string): boolean; webkitSetPresentationMode?(m: string): void; autoPictureInPicture?: boolean };

export function bgTest(host: HTMLElement): void {
  host.querySelector('.splash')?.remove();
  let log = load();
  let on = false, watchId: number | null = null, fixes = 0, speed: number | null = null, motionN = 0, motionAt = 0, lock: { release(): Promise<void> } | null = null;
  const put = (k: BgKind, more: Partial<BgEntry> = {}) => { addEntry(log, { t: Date.now(), k, ...more }); save(log); };
  put('boot', { v: navigator.userAgent.slice(0, 120) });

  // the mini window's picture: drawn on a timer, since frames stop when hidden
  const cv = h('canvas.bg-hud', { width: '320', height: '180', 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const ctx = cv.getContext('2d');
  const awayNow = () => aways(log).at(-1);
  const draw = () => {
    if (!ctx) return;
    ctx.fillStyle = '#0b0f0d'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = on ? '#e3503f' : '#5a6b64'; ctx.fillRect(16, 18, 12, 12);
    ctx.fillStyle = '#f1ece4'; ctx.font = '400 20px Silkscreen, monospace'; ctx.textBaseline = 'top';
    ctx.fillText(on ? 'REC TEST' : 'READY', 40, 14);
    ctx.font = '400 44px Silkscreen, monospace';
    ctx.fillText(speed == null ? '--' : String(Math.round(speed * 2.237)), 16, 56);
    ctx.fillText(String(fixes), 176, 56);
    ctx.font = '400 16px Silkscreen, monospace'; ctx.fillStyle = '#9fb3aa';
    ctx.fillText('MPH', 16, 112); ctx.fillText('FIXES', 176, 112);
    ctx.fillText(new Date().toLocaleTimeString('en-US', { hour12: false }), 16, 150);
  };
  const video = h('video.bg-video', { muted: '', playsinline: '', autoplay: '', autopictureinpicture: '', 'aria-hidden': 'true' }) as PipVideo;
  video.muted = true;
  let stream: MediaStream | null = null;
  try { stream = cv.captureStream?.(4) ?? null; } catch { stream = null; }
  if (stream) { video.srcObject = stream; video.autoPictureInPicture = true; void video.play().catch(() => {}); }
  video.addEventListener('enterpictureinpicture', () => put('pip-on'));
  video.addEventListener('leavepictureinpicture', () => put('pip-off'));
  video.addEventListener('webkitpresentationmodechanged', () => put('note', { v: `mode ${(video as unknown as { webkitPresentationMode?: string }).webkitPresentationMode}` }));
  const audio = h('audio', { loop: '', preload: 'auto' }) as HTMLAudioElement;
  audio.src = silence();
  audio.addEventListener('playing', () => put('audio-on'));
  audio.addEventListener('pause', () => put('audio-off'));

  const pip = (): void => {
    try {
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        void video.requestPictureInPicture().catch((e: Error) => { put('note', { v: `pip ${e.name}` }); render(); });
      } else if (video.webkitSupportsPresentationMode?.('picture-in-picture')) video.webkitSetPresentationMode!('picture-in-picture');
      else put('note', { v: 'pip none' });
    } catch (e) { put('note', { v: `pip ${(e as Error).name}` }); }
  };

  const onMotion = () => {
    motionN++;
    const t = Date.now();
    if (t - motionAt >= 1000) { put('motion', { n: motionN }); [motionN, motionAt] = [0, t]; }
  };

  // all in the tap: the mini window and the motion ask need it
  const start = () => {
    if (on) return;
    on = true;
    pip();
    void audio.play().catch((e: Error) => put('note', { v: `audio ${e.name}` }));
    void askMotion().then((s) => put('note', { v: `motion ${s}` }));
    addEventListener('devicemotion', onMotion);
    watchId = navigator.geolocation?.watchPosition((p) => {
      fixes++;
      speed = p.coords.speed;
      put('fix', { g: p.timestamp, n: p.coords.speed ?? undefined, v: document.visibilityState });
      draw();
      tick();
    }, (e) => put('note', { v: `gps error ${e.code}` }), { enableHighAccuracy: true, maximumAge: 0 }) ?? null;
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    wl?.request('screen').then((l) => { lock = l; put('lock'); }).catch(() => put('note', { v: 'no lock' }));
    put('start');
    render();
  };
  const stop = () => {
    if (!on) return;
    on = false;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    removeEventListener('devicemotion', onMotion);
    audio.pause();
    void lock?.release().catch(() => {});
    lock = null;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    put('stop');
    render();
  };

  const nums = h('div.dv-rec-nums.bg-nums');
  const result = h('div.bg-result');
  const list = h('ol.bg-log');
  const keys = h('div.bg-keys');
  const tick = () => {
    const a = awayNow();
    const cell = (k: string, v: string) => h('div.dv-rec-num', {}, h('span.dv-rec-k', {}, k), h('b.dv-rec-big', {}, v));
    nums.replaceChildren(cell('FIXES', String(fixes)), cell('AWAY', a ? span((a.to ?? Date.now()) - a.from) : '0:00'),
      cell('FIXES AWAY', a ? String(a.fixes) : '0'), cell('MOTION AWAY', a ? String(a.motion) : '0'));
  };
  const render = () => {
    tick();
    const a = awayNow();
    result.replaceChildren(insight({
      icon: a && a.to !== null && (a.fixes || a.gpsFixes) ? 'check' : 'info',
      title: verdict(a),
      body: a && a.to !== null ? `Away ${span(a.to - a.from)}. ${a.fixes} fixes came in, ${a.gpsFixes} taken while away.${a.reloaded ? ' The page reloaded.' : ''}` : undefined,
    }));
    const pipNote = [...log].reverse().find((e) => e.k === 'note' && e.v?.startsWith('pip'));
    keys.replaceChildren(
      on ? button('Stop test', { kind: 'secondary', icon: 'end', wide: true, onClick: stop }) : button('Start test', { kind: 'primary', icon: 'record', wide: true, onClick: start }),
      on && !document.pictureInPictureElement ? button(pipNote ? 'Try the mini window again' : 'Open the mini window', { kind: 'secondary', icon: 'phone', wide: true, onClick: pip }) : '',
      button('Copy log', { kind: 'ghost', onClick: () => void navigator.clipboard?.writeText(JSON.stringify(log)).catch(() => {}) }),
      button('Clear log', { kind: 'ghost', onClick: () => { log = []; save(log); render(); } }));
    const t0 = log[0]?.t ?? 0;
    list.replaceChildren(...log.filter((e) => e.k !== 'motion').slice(-24).reverse().map((e) =>
      h('li', {}, h('b', {}, span(e.t - t0)), ` ${e.k}${e.v ? ` ${e.v}` : ''}${e.g ? ` gps ${span(e.g - t0)}` : ''}`)));
  };

  addEventListener('visibilitychange', () => { put(document.visibilityState === 'hidden' ? 'hidden' : 'visible'); render(); });
  addEventListener('pagehide', () => put('pagehide'));
  addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) put('pageshow'); });
  document.addEventListener('freeze', () => put('freeze'));
  document.addEventListener('resume', () => put('resume'));
  setInterval(() => { draw(); if (document.visibilityState === 'visible') tick(); }, 500);

  host.replaceChildren(h('div.bg-page', {}, screen([
    h('p.u-eyebrow', {}, 'BACKGROUND TEST'),
    h('h1.u-title', {}, 'Does it record behind Maps?'),
    h('ol.bg-steps', {}, h('li', {}, 'Go outside. Tap Start test, allow what it asks.'), h('li', {}, 'Open Maps for 2 minutes. Keep walking.'), h('li', {}, 'Come back here.')),
    keys, result, nums, h('div.bg-hud-box', {}, cv, video), list,
  ])));
  draw();
  render();
}
