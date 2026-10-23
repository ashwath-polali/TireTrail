// "Tell your city": one tap opens a short, polite note about the top fix-list spots for the right stormwater team.
import { h } from '../dom.ts';
import { button, toast } from '../ui/ui.ts';
import { byAgency, cityCaption, cityKeyLabel, cityMessage, mailtoUrl, type Agency, type CityItem, type CityKind } from './city-mail.ts';
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
    return;
  }
  // no general email or form: open their contact page, with the note on the clipboard and their phone number
  if (agency.page) {
    // copy first, while this page still has focus
    const copied = copy(`${subject}\n\n${body}`), call = agency.phone ? `, or call ${agency.phone}` : '';
    window.open(agency.page, '_blank', 'noopener');
    void copied.then((ok) => toast(`${ok ? 'The note is copied.' : "Couldn't copy the note."} Their page is open${call}.`, { icon: ok ? 'check' : 'warn' }));
  }
}

/**
 * One key for the city (spots inside Bonney Lake) or the county (spots in unincorporated Pierce County); two when both.
 * Spots anywhere else get no key. items: the top spots (fromFixList or fromSpot). kind: what the spots are, for the note's words.
 */
export function tellCityButton(items: readonly CityItem[], kind: CityKind = 'drains'): HTMLElement {
  const groups = byAgency(items.slice(0, 5)), many = groups.length > 1;
  if (!groups.length) return h('div.f-city', { hidden: true });
  return h('div.f-city', {},
    h('div.f-city-keys', {}, ...groups.map((g) => button(cityKeyLabel(g.agency, many), {
      kind: 'secondary', icon: 'arrow', wide: true, onClick: () => send(g.agency, g.items, kind),
    }))),
    h('p.u-caption', {}, cityCaption(groups.map((g) => g.agency))));
}
