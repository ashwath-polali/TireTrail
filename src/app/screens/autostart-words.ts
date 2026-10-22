// Start by itself: the phone opens TireTrail when it meets the car. Words and steps only, no DOM, so tests run it.
// Steps come from Apple, Samsung, Chrome and MacroDroid how-tos; where a step isn't confirmed, say less.

export type Phone = 'iphone' | 'samsung' | 'android';
/** How the phone opens TireTrail: its own car trigger, a tap on an NFC sticker, or MacroDroid. */
export type Way = 'car' | 'sticker' | 'macro';
/** The browser this page runs in, which decides how to install. */
export type Browser = 'safari' | 'samsung' | 'chrome' | 'other';

/** The shared TireTrail shortcut on iCloud. Empty until it exists; then iPhone setup is one tap shorter. */
export const IOS_SHORTCUT_URL = '';

/** What a step's main key does. */
export type StepAct = 'shortcut' | 'copy-shortcuts' | 'shortcuts' | 'install' | 'play' | 'copy' | 'nfc';

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
  /** a question that opens to a short list, for the few who need it */
  more?: { q: string; list: string[]; note?: string };
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

/** The ways a phone can open TireTrail, the one to lead with first. nfc: this browser can write a sticker. */
export function waysFor(p: Phone, nfc = false): Way[] {
  if (p === 'iphone') return ['car'];
  const tap: Way[] = nfc ? ['sticker'] : [];
  return p === 'samsung' ? ['car', ...tap, 'macro'] : [...tap, 'macro'];
}

/** The key under Other ways that switches to a way. */
export const WAY_KEY: Record<Way, string> = { car: 'Use a Samsung routine', sticker: 'Tap a sticker to start', macro: 'Use MacroDroid' };

const HOW: Record<Phone, string> = {
  iphone: 'About 2 minutes, parked, in the Shortcuts app.',
  samsung: 'About 2 minutes, parked, in Modes and Routines.',
  android: 'About 3 minutes, parked, with the free MacroDroid app.',
};

/** The first step: what to do and how long it takes. The reason is one short note. */
export function introStep(p: Phone | null, shortcut = IOS_SHORTCUT_URL, way: Way = 'car'): SetupStep {
  if (p && p !== 'iphone' && way === 'sticker') {
    return {
      id: 'intro', title: 'Tap your phone on a sticker', line: 'About a minute, parked, with a blank NFC sticker.', art: ['phone', 'wave', 'tag'],
      notes: ['NTAG213 stickers work. Online shops sell them in packs.'],
    };
  }
  const how = !p ? 'About 2 minutes, parked.'
    : p === 'iphone' ? (shortcut ? 'About a minute, parked, in the Shortcuts app.' : HOW.iphone)
      : HOW[way === 'macro' ? 'android' : p];
  return {
    id: 'intro',
    title: 'Have your car open TireTrail',
    line: how,
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

// ---------- the easy way: open it, then drive ----------

/** What leads the setup: no automation, just open TireTrail; it records once the car does 15 mph for 8 s. */
export const EASY = {
  title: 'Open TireTrail when you get in',
  line: 'It starts by itself once you drive.',
  note: 'Allow location when it asks.',
  other: 'Or have your car open it for you.',
  key: 'Set it up with your car',
} as const;

/**
 * Adding the icon, one line per browser. iOS 26 Safari: "Tap the More button, then tap Share ... tap Add to Home Screen"
 * (Apple, iPhone User Guide for iOS 26, "Add a website icon to your Home Screen").
 */
export function addLine(b: Browser, p: Phone | null, canPrompt = false): string {
  if (canPrompt) return 'Tap Install TireTrail below.';
  if (b === 'safari') return 'Add it to your Home Screen: tap •••, Share, Add to Home Screen.';
  if (b === 'samsung') return 'Add it: the menu at the bottom right, Add page to, Home screen.';
  if (b === 'chrome') return 'Add it: the three dots at the top, then Add to Home screen.';
  return p === 'iphone' ? 'Open this page in Safari, then add it to your Home Screen.' : 'Open this page in Chrome, then add it to your Home screen.';
}

/** The easy way's steps: add the icon (unless it's running from one), open it parked, drive. */
export function easySteps(b: Browser, p: Phone | null, o: { app?: boolean; canPrompt?: boolean } = {}): string[] {
  return [...(o.app ? [] : [addLine(b, p, o.canPrompt)]), 'Each drive, parked: open TireTrail.', 'Drive. It ends by itself 3 min after you park.'];
}

/**
 * Safari asks for location by default, and a page the car opens can't answer that by itself.
 * Per site: the page menu left of the address, Website Settings (Apple, iPhone User Guide); for every site: Settings, Apps, Safari.
 */
const IOS_LOCATION: SetupStep = {
  id: 'ios-loc', title: 'Let it use your location', line: 'So it can record without a tap. In Safari, on this page:', art: ['pin', 'check'],
  list: ['Tap the icon left of the address', 'Tap Website Settings', 'Set Location to Allow'],
  notes: ['Or for every site: Settings, Apps, Safari, Location, Allow.'],
};

const IOS_TAP =['Tap Automation, then +', 'Pick CarPlay, or Bluetooth and your car', 'Pick Connects, Run Immediately, Next'];
/** No CarPlay or car Bluetooth: Driving Focus turns on when the iPhone senses driving, and its automation can run at once. */
export const IOS_DRIVING: NonNullable<SetupStep['more']> = {
  q: 'No CarPlay or car Bluetooth?',
  list: ['Settings, Focus, Driving: pick Automatically', 'In Shortcuts, pick Driving, not CarPlay', 'Pick When Turning On, Run Immediately'],
  note: "It opens after you start. Don't touch the phone while moving.",
};
/** With the shared shortcut, Back Tap can run it too. */
export const BACK_TAP = 'You can also start it with Back Tap: Settings, Accessibility, Touch, Back Tap.';
/** iPhone's other way: the same automation, started by any NFC sticker. */
export const IOS_STICKER = 'Have an NFC sticker? Make the same automation, but pick NFC and scan it.';

function iphoneSteps(shortcut: string): SetupStep[] {
  if (shortcut) {
    return [
      IOS_LOCATION,
      { id: 'ios-add', title: 'Add the TireTrail shortcut', line: 'Tap Get Shortcut, then Add Shortcut. Then come back here.', art: ['plus', 'phone'], act: 'shortcut' },
      { id: 'ios-run', title: 'Have your car run it', line: 'In Shortcuts:', art: ['car', 'play'], act: 'shortcuts', list: [...IOS_TAP, 'Pick the TireTrail shortcut, then Done'], more: IOS_DRIVING, notes: [BACK_TAP] },
    ];
  }
  return [IOS_LOCATION, {
    id: 'ios-auto', title: 'Set it up in Shortcuts', line: 'Tap the key below. Then in Shortcuts:', art: ['link', 'phone'], act: 'copy-shortcuts',
    list: [...IOS_TAP, 'Tap New Blank Automation, Add Action', 'Pick Open URLs, paste the link, Done'], more: IOS_DRIVING,
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

/** Chrome on Android writes the link to a blank sticker from this page (Web NFC). A tap on it then opens TireTrail. */
const STICKER: SetupStep[] = [{
  id: 'sticker', title: 'Write the sticker', line: 'Tap the key, then hold the sticker to the back of your phone.', art: ['tag', 'phone'], act: 'nfc',
  notes: ['Put it where the back of your phone rests in the mount. Not on metal.'],
}];

/** What the sticker key says while it writes, when it's done, and when it can't. */
export const STICKER_SAID = {
  wait: 'Waiting for the sticker…',
  ok: 'Sticker ready. Now stick it on your car mount.',
  blocked: 'NFC was blocked. Allow it for this site, or try another sticker.',
  fail: "Couldn't write it. Check NFC is on in Settings, then try again.",
  slow: 'No sticker found. Tap the key and try again.',
} as const;

/**
 * Maps at the same time, said once when recording comes back from a pause. A hidden page gets no GPS
 * (WebKit and Chromium both stop it), but Maps keeps talking from the background. Android split screen
 * and Samsung pop-up view keep both apps on screen (Android multi-window: both stay visible).
 */
export function mapsTip(p: Phone | null): string {
  if (p === 'samsung') return 'Using Maps? Put both in split screen or pop-up view.';
  if (p === 'android') return 'Using Maps? Put both in split screen.';
  return 'Using Maps? Start your route there first, then come back here. Maps keeps talking.';
}

/** Every drive after setup: said once, on the test step. */
export const EACH_DRIVE = 'Before you pull out, tap the screen once so the voice can talk.';
export const ON_SCREEN = "Keep TireTrail on screen. It can't record behind Maps.";
/** Shortcuts opens Safari, which keeps its own drives apart from a Home Screen icon. */
export const SAFARI_NOTE = 'It opens in Safari. Sign in there to keep drives with your Home Screen icon.';
export const OTHER_WAYS = 'Before you drive, you can also set the Action button or Back Tap to run it.';

/**
 * The last step. Watch when the link opens in this browser; ask when it can't be seen from here
 * (Samsung opens the installed app or its own browser, and an iPhone Home Screen icon keeps its storage apart from Safari).
 */
export function testStep(p: Phone, o: { app?: boolean; way?: Way } = {}): SetupStep {
  const way = o.way ?? waysFor(p)[0];
  const tap = way === 'sticker';
  const ask = (p === 'samsung' && way !== 'macro') || (p === 'iphone' && !!o.app);
  return {
    id: 'test',
    title: 'Test it',
    line: `${tap ? 'Unlock your phone, then tap it on the sticker.' : 'Parked, turn your car off and on.'} ${ask ? 'Did TireTrail open?' : 'TireTrail should open.'}`,
    art: tap ? ['tag', 'phone'] : ['car', 'phone'],
    test: ask ? 'ask' : 'watch',
    notes: [
      ...(tap ? ['If your phone shows a link to open, tap it.'] : []),
      ...(p === 'iphone' ? ['Using Driving? Turn it on in Control Center to test.'] : []),
      EACH_DRIVE, ON_SCREEN, ...(p === 'iphone' ? [SAFARI_NOTE] : []),
    ],
  };
}

/** What "Not yet" says, so the next try works. */
export const NOT_YET: Record<Phone, string> = {
  iphone: 'Check it says Run Immediately, then try again.',
  samsung: 'Check the routine is turned on, then try again.',
  android: 'Check the macro is turned on, then try again.',
};
export const NOT_YET_STICKER = 'Check NFC is on in Settings, then tap again.';

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
  /** this browser can write an NFC sticker */
  nfc?: boolean;
  /** the way picked under Other ways; else the first */
  way?: Way;
}

/** The way in use: the one picked, if this phone has it, else the one to lead with. */
export function wayOf(p: Phone, o: Pick<StepOpts, 'nfc' | 'way'> = {}): Way {
  const ws = waysFor(p, o.nfc);
  return o.way && ws.includes(o.way) ? o.way : ws[0];
}

/** Every step for a phone: what to do first, the steps, the test last. */
export function stepsFor(p: Phone, o: StepOpts = {}): SetupStep[] {
  const shortcut = o.shortcut ?? IOS_SHORTCUT_URL, way = wayOf(p, o);
  const xs = p === 'iphone' ? iphoneSteps(shortcut) : way === 'sticker' ? STICKER : way === 'macro' ? ANDROID : samsungSteps(o);
  return [introStep(p, shortcut, way), ...xs, testStep(p, { app: o.app, way })];
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
export function autoStatus(o: { on: boolean; okAt: number | null; now?: number; way?: Way | null }): { text: string; act?: string; when?: string } {
  const s = autoState(o.on, o.okAt);
  if (s === 'off') return { text: 'Off. Turn on to record when you drive.' };
  if (s === 'setup') return { text: 'Open TireTrail, then just drive.', act: 'How' };
  return { text: o.way === 'sticker' ? 'Opens when you tap the sticker' : 'Opens by itself in your car', when: `last time ${whenWord(o.okAt!, o.now)}` };
}

/** What the test says once it worked, here and in the tab the link opened. */
export function worksWords(way: Way | null): { title: string; line: string } {
  return way === 'sticker'
    ? { title: 'It works. The sticker opened TireTrail.', line: 'Next time, tap the sticker and TireTrail opens and records.' }
    : { title: 'It works. TireTrail opened by itself.', line: 'Next time you get in, TireTrail opens and records as you drive.' };
}

/** What the test step shows: still waiting, or when it worked. */
export function testWord(okAt: number | null, since: number, now = Date.now(), way: Way | null = null): { done: boolean; text: string } {
  if (okAt && okAt >= since) return { done: true, text: `${way === 'sticker' ? 'Opened' : 'Opened by itself'} at ${whenWord(okAt, now)}.` };
  return { done: false, text: way === 'sticker' ? 'Waiting for the tap…' : 'Waiting for your car…' };
}

/** A test counts for half an hour after the test step is shown. */
export const TEST_MS = 30 * 60_000;
/** A half-done setup reopens after a reload for this long. */
export const RESUME_MS = 6 * 3600_000;

export interface Progress { p: Phone; w?: Way; id: string; since: number; at: number; acted: string[] }

/** The saved step, if it's recent and still makes sense. */
export function readProgress(raw: string | null, now = Date.now()): Progress | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Progress>;
    if (!v || !['iphone', 'samsung', 'android'].includes(v.p as string) || typeof v.id !== 'string') return null;
    if (typeof v.at !== 'number' || now - v.at > RESUME_MS || v.at > now + 60_000) return null;
    const w = ['car', 'sticker', 'macro'].includes(v.w as string) ? v.w : undefined;
    return {
      p: v.p as Phone, ...(w ? { w } : {}), id: v.id, since: typeof v.since === 'number' ? v.since : 0, at: v.at,
      acted: Array.isArray(v.acted) ? v.acted.filter((x) => typeof x === 'string') : [],
    };
  } catch { return null; }
}
