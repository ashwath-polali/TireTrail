// The account entry (top bar on a laptop, tab bar on a phone), the account sheet, and a small card for My drives.
import { h } from '../dom.ts';
import { bitmapSVG } from '../ui/glyphs.ts';
import { button, calm, glyph, insight, sheet, stat, toast } from '../ui/ui.ts';
import { authPhase, onAuth, person, prepare, signIn, signOut, wasSignedIn, type CloudError } from './auth.ts';
import { deleteCloudData, onSync, startSync, stopSync, syncNow, syncView } from './sync.ts';
import { agoWords, drivesWord, shortName, signInWords } from './words.ts';
import './cloud.css';

export const VALUE_LINE = 'Back up your progress and take your hard-brake spots to a new phone.';
export const PRIVACY_LINE = 'Your score, drive summaries and hard-brake spots back up to your Google account. Full GPS tracks stay on this phone.';

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
const G_MARK = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

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
      say("Your backup was deleted on another device, so you're signed out here. Your drives stay on this phone.", false);
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

/** The account button for the app's nav: right of the laptop top bar, the last cell of the phone tab bar. */
export function accountEntry(): HTMLElement {
  boot();
  const b = h('button.acct', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => openAccount(b) }) as HTMLButtonElement;
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
  onAuth(draw);
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
  let error = '', confirming = false, working = false;

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
    ];
  };

  const signedIn = () => {
    const p = person()!, v = syncView(p.uid), offline = authPhase() === 'failed';
    const last = v.busy && !v.last ? 'Syncing…' : agoWords(v.last, Date.now());
    const status = v.busy ? 'Backing up…' : offline ? "Offline. Your drives back up when you're online again." : v.waiting ? "Can't reach the backup right now. TireTrail will try again soon." : '';
    if (confirming) {
      return [
        insight({ icon: 'trash', tone: 'warn', title: 'Delete your cloud backup?', body: "This deletes your drive summaries and hard-brake spots from your Google account and signs you out. Your drives stay on this phone. This can't be undone." }),
        h('div.cloud-acts', {},
          keyed(button(working ? 'Deleting…' : 'Delete', { kind: 'danger', onClick: () => void wipe() }), 'yes'),
          keyed(button('Keep it', { kind: 'secondary', onClick: () => { confirming = false; draw(); } }), 'no')),
      ];
    }
    return [
      p.name && p.email ? h('p.u-body.cloud-email', {}, p.email) : null,
      h('div.u-grid2', {}, stat('Last synced', last, { tone: v.waiting || offline ? 'warn' : 'plain' }), stat('Backed up', drivesWord(v.count))),
      status ? h('div.u-row.cloud-status', {}, h('p.cloud-note', { role: 'status' }, status),
        (v.waiting || offline) && !v.busy ? keyed(button('Sync now', { kind: 'ghost', onClick: () => { if (offline) void prepare(); else syncNow(); } }), 'sync') : null) : null,
      privacy(),
      h('div.cloud-stack', {},
        keyed(button('Sign out', { kind: 'secondary', wide: true, onClick: () => void out() }), 'out'),
        keyed(button('Delete my cloud data', { kind: 'ghost', icon: 'trash', onClick: () => { confirming = true; draw(); } }), 'del')),
    ];
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
    box.replaceChildren(sheet(p && !checking ? signedIn() : checking ? [h('p.u-body', {}, 'Checking your sign-in…'), privacy()] : signedOut(),
      { eyebrow: 'Account', title, onClose: close }));
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
  // "Last synced" keeps counting
  const tick = window.setInterval(draw, 30_000);
  host.append(layer);
  open = { close };
  draw();
}

const keyed = (el: HTMLElement, k: string) => { el.dataset.k = k; return el; };

function privacy(): HTMLElement {
  return h('div.cloud-privacy', {}, h('span.cloud-privacy-ico', { 'aria-hidden': 'true', html: glyph('phone') }), h('p', {}, PRIVACY_LINE));
}

// ---------- the card for My drives ----------

/** A one-line backup card: sign in when signed out, last synced when signed in. Updates itself while on screen. */
export function accountCard(): HTMLElement {
  boot();
  const el = h('div.cloud-card');
  let seen = false;
  const draw = () => {
    if (seen && !el.isConnected) { stopA(); stopB(); return; }
    if (el.isConnected) seen = true;
    const p = person(), v = syncView(p?.uid ?? null);
    el.replaceChildren(p
      ? insight({ icon: personSVG(3), tone: 'money', title: `Backed up to ${p.email || p.name}`, body: `${drivesWord(v.count)} · last synced ${agoWords(v.last, Date.now()).toLowerCase()}`, action: { label: 'Account', onClick: () => openAccount() } })
      : insight({ icon: personSVG(3), tone: 'you', title: 'Back up your drives', body: VALUE_LINE, action: { label: 'Sign in with Google', onClick: () => openAccount() } }));
  };
  const stopA = onAuth(draw), stopB = onSync(draw);
  draw();
  return el;
}
