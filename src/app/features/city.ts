// "Tell your city": one tap opens a short, polite email about the top fix-list spots to the right stormwater team.
import { h } from '../dom.ts';
import { button, toast } from '../ui/ui.ts';
import { byAgency, cityMessage, mailtoUrl, type Agency, type CityItem } from './city-mail.ts';
import './features.css';

export { fromFixList, type CityItem } from './city-mail.ts';

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function send(agency: Agency, items: CityItem[]): void {
  const { subject, body } = cityMessage(agency, items);
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
 * Buttons that email the city (spots inside Bonney Lake) or the county (the rest) about these spots.
 * items: the top fix-list spots; turn FixListEntry ones into items with fromFixList.
 */
export function tellCityButton(items: readonly CityItem[]): HTMLElement {
  const groups = byAgency(items.slice(0, 5));
  const one = groups.length === 1;
  if (!groups.length) return h('div.f-city', { hidden: true });
  return h('div.f-city', {},
    ...groups.map((g) => button(one ? `Tell ${g.agency.short} about ${g.items.length === 1 ? 'this spot' : 'these spots'}` : `Email ${g.agency.short}`, {
      kind: 'secondary', icon: 'arrow', wide: true, onClick: () => send(g.agency, g.items),
    })),
    h('p.u-caption', {}, `Opens your email with a short note to ${groups.map((g) => g.agency.name).join(' and ')}. Read it before you send. It's signed "A TireTrail user".`));
}
