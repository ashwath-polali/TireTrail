// The account entry (top bar on a laptop, tab bar on a phone), the account sheet, and a small card for My drives.
import { h } from '../dom.ts';
import { bitmapSVG } from '../ui/glyphs.ts';
import { button, calm, glyph, insight, sheet, stat, toast } from '../ui/ui.ts';
import { authPhase, onAuth, person, prepare, signIn, signOut, wasSignedIn, type CloudError } from './auth.ts';
import { allSummaries, forgetAllDrives, savedDrives } from '../screens/saved.ts';
import { vehiclePicker } from '../screens/vehicle.ts';
import { deleteCloudData, detachPhone, onSync, startSync, stopSync, syncNow, syncView } from './sync.ts';
import { agoWords, drivesWord, shortName, signInWords } from './words.ts';
import './cloud.css';

export const VALUE_LINE = 'Back up your drives and see them on any device.';
export const PRIVACY_LINE = 'The first and last 300 m of every route are left out.';

/** opens the file picker for a drive file; My drives sets it */
let pickFile: (() => void) | null = null;
export function onPickFile(fn: () => void): void { pickFile = fn; }

/** How it works and About, which the app sets once it's up */
let menu: { guide(): void; about(): void } | null = null;
export function onMenu(m: { guide(): void; about(): void }): void { menu = m; }

const PERSON = [
  '...XXX...',
  '..XXXXX..',
  '..XXXXX..',
  '..XXXXX..',
  '...XXX...',
  '.........',
  '.XXXXXXX.',
  'XXXXXXXXX',
  'XXXXXXXXX',
];
const personSVG = (scale = 2) => bitmapSVG(PERSON, scale);

// Google's mark, as Google gives it
export const G_MARK = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

const say = (msg: string, ok = true) => toast(msg, { icon: ok ? 'check' : 'warn', ms: ok ? 2800 : 5000 });

// ---------- sign-in and sync wiring ----------

let booted = false;
/** the uid sync runs for */
let syncing: string | null = null;
/** the person just tapped the Google button */
let tapped = false;

function wire(): void {
  if (syncing && person()?.uid !== syncing) { stopSync(); syncing = null; }
  const p = person();
  if (!p || authPhase() !== 'ready' || syncing === p.uid) return;
  syncing = p.uid;
  const first = tapped;
  tapped = false;
  startSync(p.uid, {
    said: say,
    wiped: () => {
      void signOut();
      say("Your backup was deleted on another device, so you're signed out. Drives here stay.", false);
    },
  }, first);
}

function boot(): void {
  if (booted) return;
  booted = true;
  onAuth(wire);
  // signed in last time: load Firebase once the page has settled
  if (wasSignedIn()) {
    const go = () => void prepare();
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 2500 });
    else setTimeout(go, 1200);
  }
  addEventListener('online', () => { if (authPhase() === 'failed' && wasSignedIn()) void prepare(); });
}

// ---------- the entry ----------

/** The account button: right of the laptop top bar (cls 'acct'), and the top of My drives on a phone (cls 'my-acct'). */
export function accountEntry(cls = 'acct'): HTMLElement {
  boot();
  const b = h(`button.${cls}`, { type: 'button', 'aria-haspopup': 'dialog', onclick: () => openAccount(b) }) as HTMLButtonElement;
  const draw = () => {
    const p = person();
    const ico = p
      ? h('span.acct-ico', { 'aria-hidden': 'true' }, h('span.acct-tile', {}, (shortName(p.name, p.email)[0] ?? '?').toUpperCase()))
      : h('span.acct-ico', { 'aria-hidden': 'true', html: personSVG() });
    b.replaceChildren(ico, h('span.acct-word', {}, p ? shortName(p.name, p.email) : 'Sign in'));
    b.setAttribute('aria-label', p ? `Account: ${p.email || p.name}` : 'Sign in to back up your drives');
    b.classList.toggle('in', !!p);
  };
  draw();
  const stop = onAuth(() => { if (b.isConnected || cls === 'acct') draw(); else stop(); });
  return b;
}

// ---------- the sheet ----------

let open: { close: () => void } | null = null;

/** Opens the account sheet over the page. from gets focus back when it closes. */
export function openAccount(from?: HTMLElement | null): void {
  boot();
  if (open) return;
  // the sheet is where sign-in starts, so Firebase loads now
  if (authPhase() === 'idle' || authPhase() === 'failed') void prepare();
  const host = document.querySelector<HTMLElement>('.frame') ?? document.body;
  const back = from ?? (document.activeElement as HTMLElement | null);
  const box = h('div.u-panel.u-raised.u-pad-l.cloud-box', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cloud-title' });
  const layer = h('div.cloud-layer' + (calm() ? '' : '.cloud-in'), {}, h('div.cloud-scrim', { onclick: () => close() }), box);
  let error = '', working = false;
  /** which delete is waiting for a yes */
  let confirming: 'cloud' | 'phone' | null = null;

  const close = () => {
    layer.remove();
    stopA();
    stopB();
    clearInterval(tick);
    open = null;
    if (back?.isConnected) back.focus();
  };

  const signedOut = () => {
    const ph = authPhase();
    const go = button(ph === 'loading' ? 'Loading Google sign-in…' : 'Sign in with Google', {
      kind: 'secondary', icon: G_MARK, wide: true,
      onClick: () => {
        if (working) return;
        error = '';
        working = tapped = true;
        draw();
        // straight from the tap, so the browser allows the window
        signIn().then(() => { working = false; close(); }, (e: CloudError) => {
          working = tapped = false;
          const m = signInWords(e.code);
          error = m ?? '';
          if (m) say(m, false);
          if (open) draw();
        });
      },
    });
    go.dataset.k = 'google';
    if (ph === 'loading' || working) go.setAttribute('disabled', '');
    return [
      h('p.u-body', {}, VALUE_LINE),
      privacy(),
      ph === 'failed'
        ? h('div.cloud-stack', {},
          h('p.cloud-note', { role: 'alert' }, "Can't reach Google right now. Check your connection, then try again."),
          keyed(button('Try again', { kind: 'secondary', wide: true, onClick: () => void prepare() }), 'retry'))
        : go,
      error ? h('p.cloud-note', { role: 'alert' }, error) : null,
      car(),
      fileKey(),
      phoneKey(),
      more(),
    ];
  };

  // what you drive changes the tire dust estimate; set once here
  const car = () => h('section.cloud-car', { 'aria-label': 'What do you drive?' },
    h('p.cloud-car-h', {}, 'What do you drive?'),
    vehiclePicker(() => dispatchEvent(new CustomEvent('tt:car'))),
    h('p.cloud-car-note', {}, 'Heavier cars and EVs shed more tire dust.'));

  // How it works and About, out of the main screens
  const more = () => (menu ? h('div.cloud-more', {},
    keyed(button('How it works', { kind: 'ghost', icon: 'play', onClick: () => { const m = menu; close(); m?.guide(); } }), 'guide'),
    keyed(button('About TireTrail', { kind: 'ghost', icon: 'info', onClick: () => { const m = menu; close(); m?.about(); } }), 'about')) : null);

  const ask = (title: string, body: string, yes: string, go: () => void) => [
    insight({ icon: 'trash', tone: 'warn', title, body }),
    h('div.cloud-acts', {},
      keyed(button(working ? 'Deleting…' : yes, { kind: 'danger', onClick: go }), 'yes'),
      keyed(button('Keep it', { kind: 'secondary', onClick: () => { confirming = null; draw(); } }), 'no')),
  ];

  const askPhone = () => ask('Delete drives on this phone?',
    person() ? 'Signs you out. Your backup stays in your account.' : 'Every drive and spot here goes for good.',
    'Delete', () => void wipePhone());

  const signedIn = () => {
    const p = person()!, v = syncView(p.uid), offline = authPhase() === 'failed';
    const last = v.busy && !v.last ? 'Backing up…' : agoWords(v.last, Date.now());
    const status = v.busy ? 'Backing up…' : offline ? "Offline. Your drives back up when you're online again." : v.waiting ? "Can't reach the backup right now. TireTrail will try again soon." : '';
    if (confirming === 'cloud') return ask('Delete your backup for good?', 'Every drive and route in your account goes. Drives here stay.', 'Delete', () => void wipe());
    if (confirming === 'phone') return askPhone();
    return [
      p.name && p.email ? h('p.u-body.cloud-email', {}, p.email) : null,
      h('div.u-grid2', {}, stat('Last backup', last, { tone: v.waiting || offline ? 'warn' : 'plain' }), stat('Backed up', drivesWord(v.count))),
      status ? h('div.u-row.cloud-status', {}, h('p.cloud-note', { role: 'status' }, status),
        (v.waiting || offline) && !v.busy ? keyed(button('Back up now', { kind: 'ghost', onClick: () => { if (offline) void prepare(); else syncNow(); } }), 'sync') : null) : null,
      privacy(),
      keyed(button('Sign out', { kind: 'secondary', wide: true, onClick: () => void out() }), 'out'),
      car(),
      fileKey(),
      h('div.cloud-stack.cloud-dels', {},
        keyed(button('Delete my data', { kind: 'ghost', icon: 'trash', onClick: () => { confirming = 'cloud'; draw(); } }), 'del'),
        phoneKey()),
      more(),
    ];
  };

  // a drive from a file (a track another app saved), kept out of the main screens
  const fileKey = () => (pickFile ? keyed(button('Add a drive from a file', { kind: 'ghost', icon: 'up', onClick: () => { const go = pickFile; close(); go?.(); } }), 'file') : null);

  // only when this phone has drives
  const phoneKey = () => (allSummaries().length || savedDrives().length
    ? keyed(button('Delete drives on this phone', { kind: 'ghost', icon: 'trash', onClick: () => { confirming = 'phone'; draw(); } }), 'del-phone')
    : null);

  const wipePhone = async () => {
    if (working) return;
    working = true;
    draw();
    const was = !!person();
    try {
      if (was) {
        syncing = null;
        await detachPhone();
      }
      forgetAllDrives();
      dispatchEvent(new CustomEvent('tt:drives'));
      if (was) await signOut().catch(() => {});
      say(was ? 'Drives on this phone deleted. Your backup stays.' : 'Drives on this phone deleted.');
      close();
    } catch {
      working = false;
      confirming = null;
      say("Couldn't delete the drives. Try again.", false);
      if (open) draw();
    }
  };

  const out = async () => {
    stopSync();
    syncing = null;
    try { await signOut(); say('Signed out. Your drives stay on this phone.'); } catch { say("Couldn't sign out. Try again.", false); }
    close();
  };

  const wipe = async () => {
    const p = person();
    if (!p || working) return;
    working = true;
    draw();
    syncing = null;
    try {
      await deleteCloudData(p.uid);
      await signOut();
      say('Cloud data deleted. Your drives stay on this phone.');
      close();
    } catch {
      working = false;
      say("Couldn't delete your cloud data. Check your connection, then try again.", false);
      wire();
      if (open) draw();
    }
  };

  const draw = () => {
    const k = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-k]')?.dataset.k;
    const p = person(), ph = authPhase(), checking = !!p && (ph === 'idle' || ph === 'loading');
    const title = p ? p.name || p.email || 'Your account' : 'Sign in';
    const body = confirming === 'phone' && !p ? askPhone() : p && !checking ? signedIn() : checking ? [h('p.u-body', {}, 'Checking your sign-in…'), privacy()] : signedOut();
    box.replaceChildren(sheet(body,
      { title, onClose: close }));
    box.querySelector('.u-sheet-title')?.setAttribute('id', 'cloud-title');
    const again = k ? box.querySelector<HTMLElement>(`[data-k="${k}"]`) : null;
    (again ?? (layer.contains(document.activeElement) ? null : box.querySelector<HTMLElement>('button:not([disabled])')))?.focus();
  };

  layer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // keep Tab inside the sheet
    const f = [...box.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });

  const stopA = onAuth(() => { if (!working || !person()) draw(); });
  const stopB = onSync(draw);
  // "Last backup" keeps counting
  const tick = window.setInterval(draw, 30_000);
  host.append(layer);
  open = { close };
  draw();
}

const keyed = (el: HTMLElement, k: string) => { el.dataset.k = k; return el; };

function privacy(): HTMLElement {
  return h('div.cloud-privacy', {}, h('span.cloud-privacy-ico', { 'aria-hidden': 'true', html: glyph('phone') }), h('p', {}, PRIVACY_LINE));
}
