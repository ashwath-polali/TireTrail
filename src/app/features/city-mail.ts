// Words and addresses for "Tell your city". No DOM, so tests can run it. No personal data goes in the message.
import type { LngLat } from '../../geo/geo.ts';
import { salmonWater } from '../../drive/tips.ts';
import { inBonneyLake } from './city-limits.ts';

export interface CityItem {
  /** where it is, e.g. "Detention pond PN-L5-48 near 192nd Ave E" */
  place: string;
  /** why it matters, e.g. "drains to Fennel Creek" */
  why: string;
  drains?: number;
  /** meters of street that drain there */
  streetM?: number;
  lngLat?: LngLat;
  /** set to skip the city-limits check */
  inCity?: boolean;
}

export interface Agency {
  id: 'bonney-lake' | 'pierce-county';
  name: string;
  short: string;
  /** public email; when missing, form is used */
  email?: string;
  form?: string;
  /** the official page the contact came from */
  source: string;
}

export const AGENCIES: Record<Agency['id'], Agency> = {
  // "Email Stormwater" on the Public Works / Stormwater directory, https://www.bonneylake.gov/directory.aspx?DID=37 (checked Oct 2026)
  'bonney-lake': { id: 'bonney-lake', name: 'City of Bonney Lake Public Works, Stormwater', short: 'Bonney Lake', email: 'hoffb@bonneylake.gov', source: 'https://www.bonneylake.gov/directory.aspx?DID=37' },
  // Surface Water on the Public Works directory, https://www.piercecountywa.gov/7334/PPW-Directory (checked Oct 2026)
  'pierce-county': { id: 'pierce-county', name: 'Pierce County Surface Water Management', short: 'Pierce County', email: 'PCWATER@piercecountywa.gov', source: 'https://www.piercecountywa.gov/7334/PPW-Directory' },
};

/** Spots inside Bonney Lake go to the city; the rest to the county. */
export const agencyFor = (it: CityItem): Agency =>
  AGENCIES[(it.inCity ?? (it.lngLat ? inBonneyLake(it.lngLat) : true)) ? 'bonney-lake' : 'pierce-county'];

/** Items grouped by agency, city first. */
export function byAgency(items: readonly CityItem[]): { agency: Agency; items: CityItem[] }[] {
  const out: { agency: Agency; items: CityItem[] }[] = [];
  for (const it of items) {
    const a = agencyFor(it);
    const g = out.find((x) => x.agency.id === a.id);
    if (g) g.items.push(it);
    else out.push({ agency: a, items: [it] });
  }
  return out.sort((a, b) => (a.agency.id === 'bonney-lake' ? -1 : b.agency.id === 'bonney-lake' ? 1 : 0));
}

/** The key's label: "Tell your city" for one agency, "Email Pierce County" when there are two. */
export function cityKeyLabel(a: Agency, many: boolean): string {
  if (many) return `Email ${a.short}`;
  return a.id === 'bonney-lake' ? 'Tell your city' : 'Tell the county';
}

const miles = (m: number) => { const v = m / 1609.344; return v < 0.1 ? `${Math.round(m * 3.28084).toLocaleString('en-US')} ft` : `${v < 10 ? v.toFixed(1) : Math.round(v)} mi`; };

function size(it: CityItem): string {
  const p: string[] = [];
  if (it.drains) p.push(`${it.drains} storm drain${it.drains === 1 ? '' : 's'}`);
  if (it.streetM) p.push(`${miles(it.streetM)} of street`);
  return p.length ? ` (${p.join(', ')})` : '';
}

/** what the spots are: storm drain spots from the Fix list, or places drivers brake hard */
export type CityKind = 'drains' | 'brakes';

/** The email: short, polite, plain. */
export function cityMessage(agency: Agency, items: readonly CityItem[], kind: CityKind = 'drains'): { subject: string; body: string } {
  const one = items.length === 1;
  const list = items.map((it, i) => `${i + 1}. ${it.place}${size(it)}: ${it.why.replace(/\.?$/, '.')}`).join('\n');
  const intro = kind === 'brakes'
    ? `I use TireTrail, an app that helps drivers brake gently and follows storm drains through public pipe maps. Drivers brake hard at ${one ? 'this spot' : 'these spots'}, which wears tires, and the runoff there drains to salmon streams:`
    : `I use TireTrail, an app that follows storm drains through public pipe maps to see where street runoff goes. ${one ? 'This spot collects' : 'These spots collect'} runoff from a lot of street:`;
  const body = [
    `Hello ${agency.name},`,
    '',
    intro,
    '',
    list,
    '',
    `Tire dust in that runoff carries a chemical called 6PPDQ, which can kill coho salmon within hours of a storm. A filter or rain garden at ${one ? 'this spot' : 'these spots'} would catch it before it reaches the stream. Could you consider ${one ? 'it' : 'them'} for stormwater treatment?`,
    '',
    'Thank you,',
    'A TireTrail user',
  ].join('\n');
  return { subject: one ? 'A storm drain spot that could protect coho salmon' : 'Storm drain spots that could protect coho salmon', body };
}

/** A fix-list spot as a city item: "Detention pond PN-L5-48 near 192nd Ave E", and where it drains. */
export function fromFixList(f: { label: string; receiving: string; drains: number; streetM: number; lngLat: LngLat }): CityItem {
  const near = /near (.+)$/.exec(f.label)?.[1];
  return { place: `${f.label.split(', ')[0]}${near ? ` near ${near}` : ''}`, why: salmonWhy(f.receiving), drains: f.drains, streetM: f.streetM, lngLat: f.lngLat };
}

/** A hard-brake spot as a city item: its street, and the salmon stream its runoff reaches. */
export function fromSpot(s: { name: string; lngLat: LngLat }, receiving: string): CityItem {
  const place = s.name || `The spot at ${s.lngLat[1].toFixed(5)}, ${s.lngLat[0].toFixed(5)}`;
  return { place, why: salmonWhy(receiving), lngLat: s.lngLat };
}

/** "it drains to Fennel Creek, where coho salmon live" */
function salmonWhy(receiving: string): string {
  const w = salmonWater(receiving);
  return w.kind === 'unnamed' ? 'it drains to a small salmon stream'
    : w.kind === 'fennel' || w.kind === 'named' ? `it drains to ${w.name}, where coho salmon live`
      : `it drains to ${w.name}, which flows on to ${w.coho}, where coho salmon live`;
}

/** mailto: with a subject and body, encoded so every mail app reads it. */
export function mailtoUrl(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`;
}
