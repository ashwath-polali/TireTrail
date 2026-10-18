// Start by itself: the phone opens TireTrail when it meets the car. Words and steps only, no DOM, so tests run it.
// Steps come from Apple, Samsung and MacroDroid how-tos; where a step isn't confirmed, say less.

export type Phone = 'iphone' | 'samsung' | 'android';

/** What the setup step does besides Next. */
export type StepAct = 'copy' | 'copy-shortcuts' | 'install' | 'play' | 'opened';

export interface SetupStep {
  title: string;
  line: string;
  /** glyph names for the small picture, left to right */
  art: string[];
  act?: StepAct;
}

/** A guess from the browser: an iPhone or iPad, a Samsung, some Android (Samsung or not), or null. */
export function phoneOf(ua: string, touchPoints = 0): Phone | null {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iphone';
  if (/SamsungBrowser|SAMSUNG|\bSM-[A-Z0-9]/.test(ua)) return 'samsung';
  if (/Android/.test(ua)) return 'android';
  return null;
}

/** Chrome hides the model, so a plain Android guess still asks Samsung or not. */
export const mustAsk = (guess: Phone | null, picked: Phone | null): boolean => !picked && (guess === null || guess === 'android');

export const INTRO: SetupStep = {
  title: 'Your phone opens TireTrail',
  line: "Phones don't let websites run in the background, so your phone opens it in the car.",
  art: ['car', 'wave', 'phone'],
};

export const PICK = { title: 'Which phone is this?', android: 'Is it a Samsung Galaxy?' } as const;

const STEPS: Record<Phone, SetupStep[]> = {
  iphone: [
    { title: 'Copy the link, open Shortcuts', line: "Shortcuts is already on your iPhone. Tap Automation at the bottom.", art: ['link', 'phone'], act: 'copy-shortcuts' },
    { title: 'Tap + and pick CarPlay', line: 'No CarPlay? Pick Bluetooth, then choose your car.', art: ['plus', 'car'] },
    { title: 'Pick Connects, then Run Immediately', line: 'Then tap Next.', art: ['car', 'play'] },
    { title: 'Tap New Blank Automation, then Add Action', line: 'Search for Open URLs and tap it.', art: ['plus', 'search'] },
    { title: 'Paste the TireTrail link, tap Done', line: 'Lost the link? Copy it again here.', art: ['link', 'check'], act: 'copy' },
  ],
  samsung: [
    { title: 'Install TireTrail from Chrome first', line: 'In Chrome, tap the three dots, then Install app.', art: ['down', 'phone'], act: 'install' },
    { title: 'Open Settings, then Modes and Routines', line: 'Tap Routines at the bottom, then the + button.', art: ['gear', 'plus'] },
    { title: 'Under If, pick Bluetooth device', line: "Choose your car's Bluetooth, then tap Done.", art: ['bt', 'car'] },
    { title: 'Under Then, pick Open an app', line: 'Tap Open an app or do an app action, then TireTrail.', art: ['play', 'phone'] },
    { title: 'Tap Save and name it', line: "Call it TireTrail. You're done.", art: ['check'] },
  ],
  android: [
    { title: 'Get MacroDroid from the Play Store', line: "It's free. Allow what it asks for.", art: ['down', 'phone'], act: 'play' },
    { title: 'Tap Add Macro, then add a trigger', line: 'Connectivity, then Bluetooth Event, then Device Connected.', art: ['plus', 'bt'] },
    { title: "Pick your car's Bluetooth", line: 'It is the name your car shows when pairing.', art: ['bt', 'car'] },
    { title: 'Add the action Open Website', line: 'Search the list for it, then paste the TireTrail link.', art: ['link', 'search'], act: 'copy' },
    { title: 'Name it TireTrail and save', line: 'Now it opens every time you get in.', art: ['check'] },
  ],
};

/** A Home Screen web app keeps its own storage apart from Safari, where Shortcuts opens the link. */
export const SAFARI: SetupStep = {
  title: 'Sign in on Safari too',
  line: 'Your car opens TireTrail in Safari. Sign in there so drives stay together.',
  art: ['phone', 'check'],
};

/** The last step. Samsung opens the app, not the link, so it asks instead of noticing. */
export function testStep(p: Phone): SetupStep {
  return p === 'samsung'
    ? { title: 'Test it', line: 'Parked, turn your car off and on. Did TireTrail open?', art: ['car', 'phone'], act: 'opened' }
    : { title: 'Test it', line: 'Parked, turn your car off and on. TireTrail should open.', art: ['car', 'phone'] };
}

/**
 * Every step for a phone, test last. app: running from a Home Screen icon.
 * installed: Samsung already has TireTrail installed, so that step goes.
 */
export function stepsFor(p: Phone, o: { app?: boolean; installed?: boolean } = {}): SetupStep[] {
  let xs = STEPS[p];
  if (p === 'samsung' && o.installed) xs = xs.filter((s) => s.act !== 'install');
  return [INTRO, ...xs, ...(p === 'iphone' && o.app ? [SAFARI] : []), testStep(p)];
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

/** The one line under the switch. okAt: when the car last opened TireTrail. */
export function autoStatus(o: { on: boolean; okAt: number | null; now?: number }): string {
  if (!o.on) return 'Off. Records your drives without a tap.';
  if (o.okAt) return `Opens by itself in your car · last time ${whenWord(o.okAt, o.now)}`;
  return 'On while TireTrail is open. Set up your car';
}

/** What the test step shows: still waiting, or when it worked. */
export function testWord(okAt: number | null, since: number, now = Date.now()): { done: boolean; text: string } {
  return okAt && okAt >= since ? { done: true, text: `It works. Opened at ${whenWord(okAt, now)}.` } : { done: false, text: 'Waiting for your car…' };
}

/** A test counts for half an hour after the test step is shown. */
export const TEST_MS = 30 * 60_000;
