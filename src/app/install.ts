// Installing TireTrail as an app: Chrome's own one-tap dialog when it offers one, and whether it's installed already.

type InstallEvent = Event & { prompt(): Promise<void>; userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let offer: InstallEvent | null = null;
const KEY = 'tt-installed';

const remember = (): void => { try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked */ } };
const told = (): void => { try { dispatchEvent(new Event('tt:install')); } catch { /* no window */ } };

try {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e as InstallEvent; told(); });
  addEventListener('appinstalled', () => { offer = null; remember(); told(); });
} catch { /* no window */ }

/** Running from a Home Screen or installed icon. */
export function asApp(): boolean {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true; } catch { return false; }
}

/** Installed: running as the app, or installed from this browser before. */
export function installed(): boolean {
  if (asApp()) return true;
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** The browser offered its own install dialog. */
export const canInstall = (): boolean => !!offer;

/** Shows the browser's install dialog. True if the person installed it. */
export async function install(): Promise<boolean> {
  const e = offer;
  if (!e) return false;
  try {
    await e.prompt();
    const r = await e.userChoice;
    offer = null;
    if (r?.outcome === 'accepted') { remember(); told(); return true; }
  } catch { /* dismissed or blocked */ }
  told();
  return false;
}

/** Chrome on Android can say it's already installed, through the manifest's related app. */
export async function checkInstalled(): Promise<boolean> {
  if (installed()) return true;
  try {
    const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<{ platform: string }[]> };
    const apps = (await nav.getInstalledRelatedApps?.()) ?? [];
    if (apps.some((a) => a.platform === 'webapp')) { remember(); return true; }
  } catch { /* not supported */ }
  return false;
}

/** Chrome hides the phone model in the user agent but tells it when asked ("SM-S921U" on a Samsung). */
export async function phoneModel(): Promise<string> {
  try {
    const d = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ model?: string }> } }).userAgentData;
    return (await d?.getHighEntropyValues(['model']))?.model ?? '';
  } catch { return ''; }
}
