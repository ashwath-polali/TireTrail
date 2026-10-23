/** tell your city: which agency, and the email */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { inBonneyLake } from '../src/app/features/city-limits.ts';
import { AGENCIES, agencyFor, byAgency, cityCaption, cityKeyLabel, cityMessage, fromFixList, fromSpot, inUnincorporatedPierce, mailtoUrl, useRegion } from '../src/app/features/city-mail.ts';
import { Region } from '../src/app/map/region.ts';
import type { LngLat } from '../src/geo/geo.ts';

const bundle = JSON.parse(readFileSync(new URL('../public/data/tiretrail.json', import.meta.url), 'utf8')) as { fixList: { label: string; receiving: string; drains: number; streetM: number; at: [number, number] }[] };
const fix = bundle.fixList.map((f) => fromFixList({ ...f, lngLat: [f.at[0] / 1e6, f.at[1] / 1e6] as LngLat }));
const region = new Region(JSON.parse(readFileSync(new URL('../public/data/region.json', import.meta.url), 'utf8')));
const at = (lngLat: LngLat) => agencyFor({ place: 'x', why: 'y', lngLat })?.id ?? null;
/** with the county and city outlines loaded, as the app has them */
function withRegion(f: () => void): void {
  useRegion(region);
  try { f(); } finally { useRegion(null); }
}

describe('city limits', () => {
  test('the city fix list is inside Bonney Lake', () => {
    assert.ok(fix.length > 0);
    for (const f of fix) assert.equal(agencyFor(f)?.id, 'bonney-lake', f.place);
  });
  test('Tacoma and county land to the southeast are not', () => {
    assert.equal(inBonneyLake([-122.44, 47.25]), false);
    assert.equal(inBonneyLake([-122.08, 47.12]), false);
  });
});

describe('who gets a note', () => {
  test('unincorporated Pierce County goes to the county', () => withRegion(() => {
    // southeast of Bonney Lake, Spanaway, South Hill, Graham
    for (const p of [[-122.08, 47.12], [-122.434, 47.104], [-122.29, 47.12], [-122.29, 47.05]] as LngLat[]) {
      assert.equal(inUnincorporatedPierce(p), true, String(p));
      assert.equal(at(p), 'pierce-county', String(p));
    }
  }));
  test('spots in any other city or county get no note', () => withRegion(() => {
    // Tacoma, Puyallup and Lakewood (Pierce County cities), Seattle and Bellevue (King County)
    for (const p of [[-122.44, 47.25], [-122.29, 47.19], [-122.52, 47.17], [-122.33, 47.61], [-122.2, 47.61]] as LngLat[]) assert.equal(at(p), null, String(p));
    assert.deepEqual(byAgency([{ place: 'Seattle', why: 'y', lngLat: [-122.33, 47.61] }]), []);
    assert.equal(at([-122.17, 47.17]), 'bonney-lake');
  }));
  test('before the outlines load, only Bonney Lake spots get a note', () => {
    assert.equal(at([-122.08, 47.12]), null);
    assert.equal(at([-122.17, 47.17]), 'bonney-lake');
    assert.equal(agencyFor({ place: 'x', why: 'y' }), null);
  });
});

describe('the email', () => {
  test('lists the spots, says why, signs off with no personal data', () => {
    const { subject, body } = cityMessage(AGENCIES['bonney-lake'], fix.slice(0, 2));
    assert.match(subject, /coho salmon/);
    assert.match(body, /^Hello City of Bonney Lake Public Works, Stormwater,/);
    assert.match(body, /1\. Detention pond PN-M8-51 near SR 410 E \(68 storm drains, 0\.7 mi of street\): it drains to Fennel Creek, which flows down to where coho salmon spawn\./);
    assert.match(body, /2\. Detention pond PN-L5-48 near 192nd Ave E/);
    assert.match(body, /6PPDQ/);
    assert.match(body, /could catch most of it before it reaches the stream/);
    assert.match(body, /A TireTrail user$/);
    assert.doesNotMatch(body, /—|coho salmon live/);
  });
  test('waters in the Fennel Creek system flow down to where coho spawn; other streams say what WDFW maps', () => {
    const f = fix.find((x) => /Lake Bonney Outflow/.test(x.why))!;
    assert.equal(f.why, 'it drains to Lake Bonney Outflow, which flows down to where coho salmon spawn');
    assert.equal(fromSpot({ name: 'x', lngLat: [-122.29, 47.05] }, 'Clover Creek').why, 'it drains to Clover Creek, where WDFW maps coho salmon');
  });
  test('split by agency, city first', () => {
    const g = byAgency([{ place: 'a', why: 'b', inCity: false }, { place: 'c', why: 'd', inCity: true }]);
    assert.deepEqual(g.map((x) => x.agency.id), ['bonney-lake', 'pierce-county']);
  });
  test('hard-brake spots: the note says I often brake hard there, and names the salmon stream', () => {
    const it = fromSpot({ name: 'SR 410 E near 192nd Ave E', lngLat: [-122.17, 47.17] }, 'Fennel Creek');
    assert.deepEqual(it, { place: 'SR 410 E near 192nd Ave E', why: 'it drains to Fennel Creek, which flows down to where coho salmon spawn', lngLat: [-122.17, 47.17] });
    const { body } = cityMessage(AGENCIES['bonney-lake'], [it], 'brakes');
    assert.match(body, /I often brake hard at this spot, which wears tires, and the runoff there drains to salmon streams:/);
    assert.match(body, /1\. SR 410 E near 192nd Ave E: it drains to Fennel Creek, which flows down to where coho salmon spawn\./);
    assert.doesNotMatch(body, /collect runoff from a lot of street|Drivers brake hard/);
    assert.match(body, /A TireTrail user$/);
    // no name: the spot by where it is
    assert.match(fromSpot({ name: '', lngLat: [-122.17, 47.17] }, 'Unnamed stream').place, /^The spot at 47\.17000, -122\.17000$/);
  });
  test('one key says Tell your city; two agencies get one key each', () => {
    assert.equal(cityKeyLabel(AGENCIES['bonney-lake'], false), 'Tell your city');
    assert.equal(cityKeyLabel(AGENCIES['pierce-county'], false), 'Tell the county');
    assert.equal(cityKeyLabel(AGENCIES['pierce-county'], true), 'Email Pierce County');
  });
  test('Bonney Lake has no general stormwater email: its stormwater page and phone, never a staff address', () => {
    const b = AGENCIES['bonney-lake'], pc = AGENCIES['pierce-county'];
    assert.equal(b.email, undefined);
    assert.equal(b.page, 'https://www.bonneylake.gov/291/Stormwater');
    assert.equal(b.phone, '253-447-4319');
    assert.equal(pc.email, 'PCWATER@piercecountywa.gov');
    assert.equal(cityCaption([b]), "Opens Bonney Lake's stormwater page and copies a note for them. Or call 253-447-4319.");
    assert.equal(cityCaption([pc]), 'Opens a note to Pierce County you can read first.');
    assert.equal(cityCaption([b, pc]), "Opens Bonney Lake's stormwater page and copies a note for them. Or call 253-447-4319. Opens a note to Pierce County you can read first.");
  });
  test('mailto is fully encoded', () => {
    const u = mailtoUrl('PCWATER@piercecountywa.gov', 'A & B', 'line one\nline two');
    assert.equal(u, 'mailto:PCWATER@piercecountywa.gov?subject=A%20%26%20B&body=line%20one%0D%0Aline%20two');
  });
});
