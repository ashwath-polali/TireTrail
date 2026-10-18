// "Tell your city": one tap opens a short, polite email about the top fix-list spots to the right stormwater team.
import { h } from '../dom.ts';
import { button, toast } from '../ui/ui.ts';
import { byAgency, cityKeyLabel, cityMessage, mailtoUrl, type Agency, type CityItem, type CityKind } from './city-mail.ts';
import './features.css';

export { fromFixList, fromSpot, type CityItem } from './city-mail.ts';

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function send(agency: Agency, items: CityItem[], kind: CityKind): void {
  const { subject, body } = cityMessage(agency, items, kind);
  if (agency.email) {
    location.href = mailtoUrl(agency.email, subject, body);
    return;
  }
  // only a web form: open it and put the note on the clipboard
  if (agency.form) {
    window.open(agency.form, '_blank', 'noopener');
    void copy(`${subject}\n\n${body}`).then((ok) => toast(ok ? 'The note is copied. Paste it into their form.' : "Couldn't copy the note. Their form is open.", { icon: ok ? 'check' : 'warn' }));
  }
}

/**
 * One key that emails the city (spots inside Bonney Lake) or the county (the rest) about these spots; two when both.
 * items: the top spots (fromFixList or fromSpot). kind: what the spots are, for the note's words.
 */
export function tellCityButton(items: readonly CityItem[], kind: CityKind = 'drains'): HTMLElement {
  const groups = byAgency(items.slice(0, 5)), many = groups.length > 1;
  if (!groups.length) return h('div.f-city', { hidden: true });
  return h('div.f-city', {},
    h('div.f-city-keys', {}, ...groups.map((g) => button(cityKeyLabel(g.agency, many), {
      kind: 'secondary', icon: 'arrow', wide: true, onClick: () => send(g.agency, g.items, kind),
    }))),
    h('p.u-caption', {}, `Opens a note to ${groups.map((g) => g.agency.short).join(' and ')} you can read first.`));
}
