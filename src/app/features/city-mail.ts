// Words and addresses for "Tell your city". No DOM, so tests can run it. No personal data goes in the message.
import { localProjection, type LngLat, type XY } from '../../geo/geo.ts';
import type { Region } from '../map/region.ts';
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
  /** set to skip the map check: true for Bonney Lake, false for unincorporated Pierce County */
  inCity?: boolean;
}

export interface Agency {
  id: 'bonney-lake' | 'pierce-county';
  name: string;
  short: string;
  /** a general public email; when missing, form or page is used */
  email?: string;
  form?: string;
  /** the official contact page, opened when there is no general email or form */
  page?: string;
  /** the phone number that page lists */
  phone?: string;
  /** the official page the contact came from */
  source: string;
}

export const AGENCIES: Record<Agency['id'], Agency> = {
  // No general stormwater email: "Email Stormwater" goes to one staff member. Contact Us on https://www.bonneylake.gov/291/Stormwater
  // lists 253-447-4319, as does the Public Works directory, https://www.bonneylake.gov/directory.aspx?DID=37 (both checked Oct 22 2026)
  'bonney-lake': { id: 'bonney-lake', name: 'City of Bonney Lake Public Works, Stormwater', short: 'Bonney Lake', page: 'https://www.bonneylake.gov/291/Stormwater', phone: '253-447-4319', source: 'https://www.bonneylake.gov/291/Stormwater' },
  // Surface Water Management Division on the Public Works directory, https://www.piercecountywa.gov/7334/PPW-Directory (checked Oct 22 2026)
  'pierce-county': { id: 'pierce-county', name: 'Pierce County Surface Water Management', short: 'Pierce County', email: 'PCWATER@piercecountywa.gov', source: 'https://www.piercecountywa.gov/7334/PPW-Directory' },
};

// the county and city outlines (region.json), set by the app; until then only Bonney Lake spots get a note
let region: Region | null = null;
export function useRegion(r: Region | null): void { region = r; }

const P = localProjection();

/** In Pierce County and outside every city's limits, by the region map's outlines. */
export function inUnincorporatedPierce(p: LngLat, R: Region | null = region): boolean {
  if (!R) return false;
  const q = P.toXY(p), at: XY = [q[0], -q[1]];
  return R.countyAt(at)?.name === 'Pierce' && !R.placeAt(at);
}

/** Spots inside Bonney Lake go to the city, spots in unincorporated Pierce County to the county. Anywhere else, no one. */
export function agencyFor(it: CityItem): Agency | null {
  if (it.inCity !== undefined) return AGENCIES[it.inCity ? 'bonney-lake' : 'pierce-county'];
  if (!it.lngLat) return null;
  if (inBonneyLake(it.lngLat)) return AGENCIES['bonney-lake'];
  return inUnincorporatedPierce(it.lngLat) ? AGENCIES['pierce-county'] : null;
}

/** Items grouped by agency, city first. Spots no agency here covers are left out. */
export function byAgency(items: readonly CityItem[]): { agency: Agency; items: CityItem[] }[] {
  const out: { agency: Agency; items: CityItem[] }[] = [];
  for (const it of items) {
    const a = agencyFor(it);
    if (!a) continue;
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

/** The line under the keys: what a tap does, in the keys' order (the city first). */
export function cityCaption(agencies: readonly Agency[]): string {
  const mail = agencies.filter((a) => a.email || a.form).map((a) => a.short);
  return [
    ...agencies.filter((a) => !a.email && !a.form && a.page).map((a) => `Opens ${a.short}'s stormwater page and copies a note for them.${a.phone ? ` Or call ${a.phone}.` : ''}`),
    mail.length ? `Opens a note to ${mail.join(' and ')} you can read first.` : '',
  ].filter(Boolean).join(' ');
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
    ? `I use TireTrail, an app that helps drivers brake gently and follows storm drains through public pipe maps. I often brake hard at ${one ? 'this spot' : 'these spots'}, which wears tires, and the runoff there drains to salmon streams:`
    : `I use TireTrail, an app that follows storm drains through public pipe maps to see where street runoff goes. ${one ? 'This spot collects' : 'These spots collect'} runoff from a lot of street:`;
  const body = [
    `Hello ${agency.name},`,
    '',
    intro,
    '',
    list,
    '',
    `Tire dust in that runoff carries a chemical called 6PPDQ, which can kill coho salmon within hours of a storm. A filter or rain garden at ${one ? 'this spot' : 'these spots'} could catch most of it before it reaches the stream. Could you consider ${one ? 'it' : 'them'} for stormwater treatment?`,
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

/** "it drains to Fennel Creek, which flows down to where coho salmon spawn": WDFW has coho only in lower Fennel Creek */
function salmonWhy(receiving: string): string {
  const w = salmonWater(receiving);
  return w.kind === 'unnamed' ? 'it drains to a small salmon stream'
    : w.kind === 'named' ? `it drains to ${w.name}, where WDFW maps coho salmon`
      : `it drains to ${w.name}, which flows down to where coho salmon spawn`;
}

/** mailto: with a subject and body, encoded so every mail app reads it. */
export function mailtoUrl(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`;
}
