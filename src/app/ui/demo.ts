// Hidden page (#ui) that shows every part of the UI kit in every tone, for checking the look.
import { h } from '../dom.ts';
import { bars, button, chip, glyph, GLYPHS, hero, insight, meter, panel, salmonSVG, score, scoreTone, screen, sheet, stagger, stat, timeline, toast, TONES, type Tone } from './ui.ts';

const CSS = `
.u-demo .d-sec { display: grid; gap: 16px; }
.u-demo .d-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.phone .u-demo .d-grid { grid-template-columns: 1fr; }
.u-demo .d-nums { display: flex; flex-wrap: wrap; gap: 32px 48px; align-items: flex-end; }
.u-demo .d-map { position: relative; padding: 40px 16px 16px; background: #3c5334 url(art/tut-2-drain.png) center / cover; image-rendering: pixelated; clip-path: var(--n2); }
.u-demo .d-card { --bc: var(--rim); padding: 20px; image-rendering: auto; background: var(--panel); box-shadow: inset 0 0 0 2px var(--bc); clip-path: var(--n2); }
.u-demo .d-glyphs { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
.u-demo .d-glyphs div { display: grid; justify-items: center; gap: 8px; padding: 12px 4px; background: var(--sunk); color: var(--text); font: 500 11px var(--ui); clip-path: var(--n2); }
.u-demo .d-glyphs span { color: var(--text-3); }
`;

const NAME: Record<Tone, string> = { you: 'Your spot', salmon: 'Salmon stream', soak: 'Soaks in', other: 'Other water', money: 'Money', warn: 'Hard brake', plain: 'Plain' };

const section = (title: string, ...kids: (Node | null)[]) =>
  panel([h('div.d-sec', {}, h('p.u-eyebrow', {}, title), ...kids)], { pad: 'l' });

export function uiDemo(): HTMLElement {
  if (!document.getElementById('u-demo-css')) document.head.append(h('style', { id: 'u-demo-css' }, CSS));
  const say = (m: string) => () => toast(m, { icon: 'check' });

  const page = screen([
    hero({ eyebrow: 'UI kit', title: 'Premium pixel', sub: 'Every part the screens are built from, in every color. Press anything that stands up.', art: 'hero' }),

    h('div.d-grid', {},
      section('Type',
        h('p.u-eyebrow', {}, 'Eyebrow label'),
        h('h2.u-title', {}, 'Ease off at Main Street'),
        h('p.u-body', {}, 'You braked hard here on 3 of your last 5 drives. Start slowing at the gas station.'),
        h('p.u-caption', {}, 'An estimate from 5 saved drives'),
        h('div.u-big', {}, '82')),
      section('Buttons',
        button('Start a drive', { icon: 'record', onClick: say('Drive started'), wide: true }),
        h('div.u-row', {},
          button('Try the sample', { kind: 'secondary', icon: 'play', onClick: say('Sample drive') }),
          button('Not now', { kind: 'ghost', onClick: say('Not now') })),
        h('div.u-row', {},
          button('Delete drive', { kind: 'danger', icon: 'trash', onClick: say('Deleted') }),
          button('See it happen', { kind: 'primary', icon: 'play', onClick: say('Story') })))),

    section('Chips', h('div.u-row', {}, ...TONES.map((t) => chip(NAME[t], t)))),

    h('div.d-grid', {},
      section('Scoreboard numbers',
        h('div.d-nums', {},
          score(0.42, { prefix: '$', decimals: 2, tone: 'money', countUp: true, label: 'Gas lost', caption: 'About, this drive' }),
          score(235, { prefix: '$', suffix: '/yr', tone: 'money', countUp: true, label: 'A year' }),
          score(3, { tone: 'warn', countUp: true, label: 'Hard brakes' }),
          score(12.4, { decimals: 1, suffix: 'mi', label: 'Driven' }))),
      section('Meters',
        meter(82, 100, { blocks: 20, tone: scoreTone(82), label: 'Smooth score' }),
        meter(64, 100, { blocks: 20, tone: scoreTone(64), label: 'Last week' }),
        meter(38, 100, { blocks: 10, tone: scoreTone(38), label: 'First drive' }),
        meter(2, 5, { blocks: 5, tone: 'salmon', label: 'Stops to salmon streams' }),
        meter(7, 10, { tone: 'plain', label: 'Plain' }))),

    section('Stats',
      h('div.u-grid3', {},
        stat('Hard brakes', '3', { tone: 'warn', hint: '2 fewer than last time' }),
        stat('Gas lost', '$0.42', { tone: 'money', hint: 'About, from speeding' }),
        stat('To salmon streams', '2 of 3', { tone: 'salmon' })),
      h('div.u-grid3', {},
        stat('Soaks in', '1', { tone: 'soak' }),
        stat('Other water', '0', { tone: 'other' }),
        stat('Your spots', '4', { tone: 'you' }))),

    section('Insights', ...TONES.map((t) => insight(INSIGHT[t]())),
      insight({ icon: '<img src="art/icon-salmon.png" width="40" height="40" alt="">', tone: 'salmon', title: 'With pixel art in the tile', body: 'Pass an img or svg string as the icon.' })),

    h('div.d-grid', {},
      section('Block charts',
        bars([5, 4, 6, 3, 3, 2, 1], { labels: ['Oct 1', 'Oct 3', 'Oct 5', 'Oct 8', 'Oct 10', 'Oct 13', 'Today'], tone: 'warn' }),
        bars([0.9, 0.7, 0.8, 0.5, 0.6, 0.4, 0.42, 0.3, 0.35, 0.2, 0.25, 0.18], { labels: ['Sep 2', ...Array(10).fill(''), 'Today'], tone: 'money', highlightLast: 2 }),
        bars([62, 68, 71, 75, 82], { labels: ['1', '2', '3', '4', '5'], tone: 'you' })),
      section('Timeline',
        timeline([
          { tone: 'you', title: 'Your hard brake', sub: 'Main Street at 184th Ave', onClick: say('Stop') },
          { tone: 'plain', title: 'Storm drain', sub: 'The grate at the curb' },
          { tone: 'plain', title: 'Pipe under the street', sub: '640 ft, downhill' },
          { tone: 'salmon', title: 'Fennel Creek', sub: 'Flows down to where coho salmon spawn' },
        ]),
        timeline([
          { tone: 'plain', title: 'Storm drain' },
          { tone: 'soak', title: 'Soaks into the ground', sub: 'A pond built to let rain soak in' },
        ]))),

    h('div.d-grid', {},
      section('Panels',
        panel([h('p.u-body', {}, 'Plain panel.')]),
        panel([h('p.u-body', {}, 'Inset panel, small padding.')], { tone: 'inset', pad: 's' }),
        panel([h('p.u-body', {}, 'Raised panel. It stands up.')], { tone: 'raised' }),
        panel([h('div.u-spread', {}, h('p.u-body', {}, 'A panel you can press.'), h('span', { html: glyph('chevron'), style: 'color: var(--text-2)' }))], { onClick: say('Panel pressed') })),
      section('Sheet',
        h('div.d-map', {},
          h('div.d-card', {},
            sheet([
              h('p.u-body', {}, 'Rain on this street flows down to where coho salmon spawn.'),
              h('div.u-row', {}, chip('Salmon stream', 'salmon'), chip('0.3 mi of pipe')),
            ], {
              eyebrow: 'Where the rain goes', title: 'Sumner Buckley Hwy', onClose: say('Closed'),
              actions: [button('See it happen', { icon: 'play', onClick: say('Story') }), button('More details', { kind: 'secondary', onClick: say('Details') })],
            }))))),

    section('Toast', h('div.u-row', {},
      button('Show a toast', { kind: 'secondary', icon: 'bell', onClick: () => toast('Hard-brake spot ahead. Ease off.', { icon: 'bell' }) }),
      button('Saved', { kind: 'ghost', icon: 'check', onClick: () => toast('Drive saved', { icon: 'check' }) }))),

    section('Pixel icons',
      h('div.d-glyphs', {}, h('div', {}, h('span', { html: salmonSVG(3) }), 'brand'), ...GLYPHS.map((g) => h('div', {}, h('span', { html: glyph(g, 3), style: 'color: var(--text)' }), g)))),
  ], { wide: true });
  page.classList.add('u-demo');
  return stagger(page);
}

const INSIGHT: Record<Tone, () => Parameters<typeof insight>[0]> = {
  you: () => ({ icon: 'bell', tone: 'you', title: 'Hard-brake spot ahead. Ease off.', body: 'You braked hard here on 3 of your last 5 drives. TireTrail tells you before you reach it.', action: { label: 'See the spot', onClick: () => toast('Spot') } }),
  salmon: () => ({ icon: 'fish', tone: 'salmon', title: 'This rain flows down to where coho salmon spawn', body: 'Tire dust from hard brakes here washes into Fennel Creek. 6PPDQ in it can kill coho salmon within hours of a storm.', action: { label: 'Brake gently here', onClick: () => toast('Tip') } }),
  soak: () => ({ icon: 'soak', tone: 'soak', title: 'Rain here drains to a pond built to soak it into the ground', body: 'Soil holds back most of the tire chemical that harms salmon.' }),
  other: () => ({ icon: 'wave', tone: 'other', title: 'Rain here goes to other water', body: 'A lake or stream where no coho salmon are mapped.' }),
  money: () => ({ icon: 'gas', tone: 'money', title: 'About $0.42 of gas lost to speeding', body: 'Going over the limit costs gas. Each 5 mph over 50 lowers fuel economy about 7%.', action: { label: 'Where you sped', onClick: () => toast('Speed') } }),
  warn: () => ({ icon: 'stop', tone: 'warn', title: '3 hard brakes this drive', body: 'Slowing 7 mph or more in one second counts as a hard brake. Start slowing sooner.' }),
  plain: () => ({ icon: 'info', tone: 'plain', title: 'No storm drain is mapped here', body: "The city map has a gap here, so TireTrail can't say where this rain goes." }),
};
