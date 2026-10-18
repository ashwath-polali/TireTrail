// Start automatically: a website can't watch in the background, so the phone opens TireTrail's #autostart link when it meets the car.
import { h } from '../dom.ts';
import { button, glyph, insight, panel, screen, stagger, timeline, toast, type Tone } from '../ui/ui.ts';
import { autostartLink } from './drive-coach.ts';
import { REC } from './drive-words.ts';

export interface GuideIn {
  /** a phone, which can record */
  canRecord: boolean;
  /** start and stop by itself while TireTrail is open */
  auto: boolean;
  waiting: boolean;
  setAuto(on: boolean): void;
  back(): void;
}

const ico = (name: string, scale = 2) => h('span.u-ico', { 'aria-hidden': 'true', html: glyph(name, scale) });
const steps = (xs: [string, string?][]) => timeline(xs.map(([title, sub], i) => ({ tone: (i === xs.length - 1 ? 'money' : 'you') as Tone, title: `${i + 1}. ${title}`, sub })));

async function copy(text: string, field: HTMLInputElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied.', { icon: 'check' });
  } catch {
    // no clipboard here: select it so a long press copies it
    field.focus();
    field.select();
    toast('Select the link and copy it.', { icon: 'info' });
  }
}

/** The setup guide page. */
export function guidePage(c: GuideIn): HTMLElement {
  const link = autostartLink(location.origin, location.pathname);
  const field = h('input.dv-auto-field', { type: 'text', readonly: '', value: link, 'aria-label': 'Your TireTrail link', spellcheck: 'false' }) as HTMLInputElement;
  field.addEventListener('focus', () => field.select());
  const copyKey = button('Copy link', { kind: 'primary', onClick: () => void copy(link, field) });

  const sw = c.canRecord ? h('section.dv-sec', {},
    h('p.u-eyebrow.dv-label', {}, 'OR, WITH TIRETRAIL ALREADY OPEN'),
    h('button.dv-switch', { type: 'button', role: 'switch', 'aria-checked': String(c.auto), onclick: () => c.setAuto(!c.auto) },
      h('span.dv-knob', { 'aria-hidden': 'true' }, h('i')),
      h('span.dv-switch-text', {}, h('b', {}, 'Start and stop by itself'), h('span', {}, c.waiting ? REC.autoWaiting : REC.autoRules)))) : null;

  const body = h('div.dv-auto', {},
    h('header.dv-auto-head', {},
      h('p.u-eyebrow', {}, 'HANDS-FREE'),
      h('h1.u-title', {}, 'Start automatically when you get in the car'),
      h('p.u-body', {}, "A website can't watch in the background, so TireTrail can't tell when you get in the car by itself."),
      h('p.u-body', {}, 'Your phone can do it: when it connects to your car, it opens this link and TireTrail starts recording.')),
    panel([
      h('p.u-eyebrow.dv-label', {}, 'YOUR LINK'),
      field,
      copyKey,
    ], { pad: 'm' }),
    panel([
      h('div.dv-auto-os', {}, ico('phone', 3), h('h2.dv-auto-h2', {}, 'iPhone')),
      steps([
        ['Copy the link above.'],
        ['Open the Shortcuts app.', 'Tap Automation at the bottom, then the + button.'],
        ['Choose CarPlay, or Bluetooth and your car.', 'Pick Connects (CarPlay) or Is Connected (Bluetooth), then Run Immediately. Tap Next.'],
        ['Tap New Blank Automation, then Add Action.', 'Search for Open URLs and tap it.'],
        ['Tap URL, paste the link, then tap Done.', 'Next time your phone connects to your car, TireTrail opens and starts recording.'],
      ]),
    ], { pad: 'm' }),
    panel([
      h('div.dv-auto-os', {}, ico('phone', 3), h('h2.dv-auto-h2', {}, 'Android')),
      steps([
        ['Copy the link above.'],
        ['On a Samsung phone, open Settings, then Modes and Routines.', 'Tap Routines, then the + button.'],
        ['Under If, add Bluetooth device and pick your car.'],
        ['Under Then, add the action that opens a website, and paste the link.', 'Then tap Save.'],
      ]),
      h('p.u-caption', {}, "Other Android phones: in Google's routines or another automation app, make a routine that opens the link when your phone connects to your car's Bluetooth."),
    ], { pad: 'm' }),
    insight({
      icon: 'record', tone: 'you', title: 'When the link opens, TireTrail starts recording.',
      body: 'Leave it open on screen while you drive. It stops by itself 3 minutes after you park. If it asks for your location the first time, tap Allow, then Start.',
    }),
    sw);
  return screen([
    h('button.u-btn.u-ghost.dv-backlink', { type: 'button', onclick: () => c.back() }, ico('back'), h('span.u-btn-label', {}, 'Back')),
    stagger(body),
  ]);
}

export interface ReadyIn {
  /** watching GPS for the car to move */
  waiting: boolean;
  error: string;
  start(): void;
  cancel(): void;
}

/** Opened by the link, but the location still needs a tap: one big Start key. */
export function readyPage(c: ReadyIn): HTMLElement {
  return screen(h('div.dv-ready', {},
    h('img.dv-ready-car', { src: 'art/icon-car.png', alt: '', width: '96', height: '96', draggable: 'false' }),
    h('p.u-eyebrow', {}, 'READY TO RECORD'),
    h('h1.u-title', {}, 'Tap Start, then drive as usual.'),
    c.error ? insight({ icon: 'warn', tone: 'warn', title: c.error }) : null,
    button('Start', { kind: 'primary', icon: 'record', wide: true, onClick: c.start }),
    c.waiting ? h('p.u-body.dv-ready-note', {}, "Or just drive. It starts by itself once you're going 15 mph.") : null,
    button('Not now', { kind: 'ghost', onClick: c.cancel })));
}
