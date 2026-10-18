// Start by itself: the phone opens TireTrail when it meets the car. Words and steps only, no DOM, so tests run it.
// Steps come from Apple, Samsung and MacroDroid how-tos; where a step isn't confirmed, say less.

export type Phone = 'iphone' | 'samsung' | 'android';
/** The browser this page runs in, which decides how to install. */
export type Browser = 'safari' | 'samsung' | 'chrome' | 'other';

/** The shared TireTrail shortcut on iCloud. Empty until it exists; then iPhone setup is one tap shorter. */
export const IOS_SHORTCUT_URL = '';

/** What a step's main key does. */
export type StepAct = 'shortcut' | 'copy-shortcuts' | 'shortcuts' | 'install' | 'play' | 'copy';

export interface SetupStep {
  /** stable name, so the step survives a reload */
  id: string;
  title: string;
  line: string;
  /** glyph names for the small picture, left to right */
  art: string[];
  /** a short numbered list, read in one look before switching apps */
  list?: string[];
  act?: StepAct;
  /** the last step: wait for the car, or ask */
  test?: 'watch' | 'ask';
  /** small notes under the step, one line each */
  notes?: string[];
}

/** A guess from the browser: an iPhone or iPad, a Samsung, some Android (Samsung or not), or null. */
export function phoneOf(ua: string, touchPoints = 0): Phone | null {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iphone';
  if (/SamsungBrowser|SAMSUNG|\bSM-[A-Z0-9]/.test(ua)) return 'samsung';
  if (/Android/.test(ua)) return 'android';
  return null;
}

/** Chrome's model hint ("SM-S921U") tells a Samsung apart. */
export const samsungModel = (model: string | undefined): boolean => /^SM-/i.test(model ?? '');

export function browserOf(ua: string): Browser {
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Android/.test(ua)) return /Chrome\//.test(ua) && !/Edg|OPR|Firefox|DuckDuckGo|; wv\)/.test(ua) ? 'chrome' : 'other';
  if (/iPhone|iPad|iPod|Macintosh/.test(ua)) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'other' : 'safari';
  return 'other';
}

/** Chrome hides the model, so a plain Android guess still asks Samsung or not. */
export const mustAsk = (guess: Phone | null, picked: Phone | null): boolean => !picked && (guess === null || guess === 'android');

const HOW: Record<Phone, string> = {
  iphone: 'About 2 minutes, parked, in the Shortcuts app.',
  samsung: 'About 2 minutes, parked, in Modes and Routines.',
  android: 'About 3 minutes, parked, with the free MacroDroid app.',
};

/** The first step: what to do and how long it takes. The reason is one short note. */
export function introStep(p: Phone | null, shortcut = IOS_SHORTCUT_URL): SetupStep {
  return {
    id: 'intro',
    title: 'Have your car open TireTrail',
    line: !p ? 'About 2 minutes, parked.' : p === 'iphone' && shortcut ? 'About a minute, parked, in the Shortcuts app.' : HOW[p],
    art: ['car', 'wave', 'phone'],
    notes: ["Websites can't start on their own, so your phone opens it."],
  };
}

export const PICK = { title: 'Which phone is this?', android: 'Is it a Samsung Galaxy?' } as const;

/** How to install from the browser this page is in. canPrompt: the browser offered its own install dialog. */
export function installLine(b: Browser, canPrompt: boolean): string {
  if (canPrompt) return 'One tap adds TireTrail to your apps.';
  if (b === 'samsung') return 'Tap the menu at the bottom right, then Add page to, then Home screen.';
  if (b === 'chrome') return 'Tap the three dots at the top, then Install app or Add to Home screen.';
  return 'Open this page in Chrome, then tap the three dots and Install app.';
}

const IOS_TAP = ['Tap Automation, then +', 'Pick CarPlay, or Bluetooth and your car', 'Pick Connects, Run Immediately, Next'];

function iphoneSteps(shortcut: string): SetupStep[] {
  if (shortcut) {
    return [
      { id: 'ios-add', title: 'Add the TireTrail shortcut', line: 'Tap Add Shortcut, then come back here.', art: ['plus', 'phone'], act: 'shortcut' },
      { id: 'ios-run', title: 'Have your car run it', line: 'In Shortcuts:', art: ['car', 'play'], act: 'shortcuts', list: [...IOS_TAP, 'Pick the TireTrail shortcut, then Done'] },
    ];
  }
  return [{
    id: 'ios-auto', title: 'Set it up in Shortcuts', line: 'Tap the key below. Then in Shortcuts:', art: ['link', 'phone'], act: 'copy-shortcuts',
    list: [...IOS_TAP, 'Tap New Blank Automation, Add Action', 'Pick Open URLs, paste the link, Done'],
  }];
}

function samsungSteps(o: { installed?: boolean; browser?: Browser; canPrompt?: boolean }): SetupStep[] {
  const install: SetupStep = { id: 'install', title: 'Install TireTrail', line: installLine(o.browser ?? 'chrome', !!o.canPrompt), art: ['down', 'phone'], act: 'install' };
  const routine: SetupStep = {
    id: 'routine', title: 'Make a routine', line: 'Open Settings, then Modes and Routines. Then:', art: ['bt', 'car'],
    list: ['Tap Routines, then +', 'Under If, pick Bluetooth device and your car', 'Under Then, pick Open an app, then TireTrail', 'Tap Save and call it TireTrail'],
  };
  return o.installed ? [routine] : [install, routine];
}

const ANDROID: SetupStep[] = [
  { id: 'play', title: 'Get MacroDroid', line: "It's free. Open it once and allow what it asks.", art: ['down', 'phone'], act: 'play' },
  {
    id: 'macro', title: 'Make a macro', line: 'Tap the key below. Then in MacroDroid:', art: ['bt', 'link'], act: 'copy',
    list: ['Tap Add Macro, then + by Triggers', 'Connectivity, Bluetooth Event, Device Connected', 'Pick your car', 'Add the action Open Website, paste the link', 'Name it TireTrail and save'],
  },
];

/** Every drive after setup: said once, on the test step. */
export const EACH_DRIVE = 'Before you pull out, tap the screen once so the voice can talk.';
export const ON_SCREEN = "Keep TireTrail on screen. It can't record behind Maps.";
/** Shortcuts opens Safari, which keeps its own drives apart from a Home Screen icon. */
export const SAFARI_NOTE = 'It opens in Safari. Sign in there to keep drives with your Home Screen icon.';
export const OTHER_WAYS = 'Before you drive, say "Hey Siri, TireTrail", or set the Action button or Back Tap to it.';

/**
 * The last step. Watch when the link opens in this browser; ask when it can't be seen from here
 * (Samsung opens the installed app, and an iPhone Home Screen icon keeps its storage apart from Safari).
 */
export function testStep(p: Phone, o: { app?: boolean } = {}): SetupStep {
  const ask = p === 'samsung' || (p === 'iphone' && !!o.app);
  return {
    id: 'test',
    title: 'Test it',
    line: ask ? 'Parked, turn your car off and on. Did TireTrail open?' : 'Parked, turn your car off and on. TireTrail should open.',
    art: ['car', 'phone'],
    test: ask ? 'ask' : 'watch',
    notes: [EACH_DRIVE, ON_SCREEN, ...(p === 'iphone' ? [SAFARI_NOTE] : [])],
  };
}

/** What "Not yet" says, so the next try works. */
export const NOT_YET: Record<Phone, string> = {
  iphone: 'Check it says Run Immediately, then try again.',
  samsung: 'Check the routine is turned on, then try again.',
  android: 'Check the macro is turned on, then try again.',
};

export interface StepOpts {
  /** running from a Home Screen or installed icon */
  app?: boolean;
  /** TireTrail is installed, so the install step goes */
  installed?: boolean;
  browser?: Browser;
  /** the browser offered its own install dialog */
  canPrompt?: boolean;
  /** the iCloud shortcut, when there is one */
  shortcut?: string;
}

/** Every step for a phone: what to do first, the steps, the test last. */
export function stepsFor(p: Phone, o: StepOpts = {}): SetupStep[] {
  const shortcut = o.shortcut ?? IOS_SHORTCUT_URL;
  const xs = p === 'iphone' ? iphoneSteps(shortcut) : p === 'samsung' ? samsungSteps(o) : ANDROID;
  return [introStep(p, shortcut), ...xs, testStep(p, o)];
}

/** "8:02 AM" today, "yesterday 8:02 AM", else "Oct 14". */
export function whenWord(t: number, now = Date.now()): string {
  const d = new Date(t), n = new Date(now), y = new Date(now);
  y.setDate(n.getDate() - 1);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (same(d, n)) return time;
  if (same(d, y)) return `yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Gray when off, yellow when on but the phone can't open TireTrail yet, green once it has. */
export type AutoState = 'off' | 'setup' | 'ok';

export const autoState = (on: boolean, okAt: number | null): AutoState => (!on ? 'off' : okAt ? 'ok' : 'setup');

/** The line under the switch. `act` is the part that reads as a link. okAt: when the car last opened TireTrail. */
export function autoStatus(o: { on: boolean; okAt: number | null; now?: number }): { text: string; act?: string; when?: string } {
  const s = autoState(o.on, o.okAt);
  if (s === 'off') return { text: 'Off. Have your phone open TireTrail in your car.' };
  if (s === 'setup') return { text: 'Starts when TireTrail is open.', act: 'Finish setup' };
  return { text: 'Opens by itself in your car', when: `last time ${whenWord(o.okAt!, o.now)}` };
}

/** What the test step shows: still waiting, or when it worked. */
export function testWord(okAt: number | null, since: number, now = Date.now()): { done: boolean; text: string } {
  return okAt && okAt >= since ? { done: true, text: `Opened by itself at ${whenWord(okAt, now)}.` } : { done: false, text: 'Waiting for your car…' };
}

/** A test counts for half an hour after the test step is shown. */
export const TEST_MS = 30 * 60_000;
/** A half-done setup reopens after a reload for this long. */
export const RESUME_MS = 6 * 3600_000;

export interface Progress { p: Phone; id: string; since: number; at: number; acted: string[] }

/** The saved step, if it's recent and still makes sense. */
export function readProgress(raw: string | null, now = Date.now()): Progress | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Progress>;
    if (!v || !['iphone', 'samsung', 'android'].includes(v.p as string) || typeof v.id !== 'string') return null;
    if (typeof v.at !== 'number' || now - v.at > RESUME_MS || v.at > now + 60_000) return null;
    return { p: v.p as Phone, id: v.id, since: typeof v.since === 'number' ? v.since : 0, at: v.at, acted: Array.isArray(v.acted) ? v.acted.filter((x) => typeof x === 'string') : [] };
  } catch { return null; }
}
