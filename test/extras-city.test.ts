/** tell your city: which agency, and the email */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { inBonneyLake } from '../src/app/features/city-limits.ts';
import { AGENCIES, agencyFor, byAgency, cityMessage, fromFixList, mailtoUrl } from '../src/app/features/city-mail.ts';
import type { LngLat } from '../src/geo/geo.ts';

const bundle = JSON.parse(readFileSync(new URL('../public/data/tiretrail.json', import.meta.url), 'utf8')) as { fixList: { label: string; receiving: string; drains: number; streetM: number; at: [number, number] }[] };
const fix = bundle.fixList.map((f) => fromFixList({ ...f, lngLat: [f.at[0] / 1e6, f.at[1] / 1e6] as LngLat }));

describe('city limits', () => {
  test('the city fix list is inside Bonney Lake', () => {
    assert.ok(fix.length > 0);
    for (const f of fix) assert.equal(agencyFor(f).id, 'bonney-lake', f.place);
  });
  test('Tacoma and county land to the southeast are not', () => {
    assert.equal(inBonneyLake([-122.44, 47.25]), false);
    assert.equal(inBonneyLake([-122.08, 47.12]), false);
    assert.equal(agencyFor({ place: 'x', why: 'y', lngLat: [-122.08, 47.12] }).id, 'pierce-county');
  });
});

describe('the email', () => {
  test('lists the spots, says why, signs off with no personal data', () => {
    const { subject, body } = cityMessage(AGENCIES['bonney-lake'], fix.slice(0, 2));
    assert.match(subject, /coho salmon/);
    assert.match(body, /^Hello City of Bonney Lake Public Works, Stormwater,/);
    assert.match(body, /1\. Detention pond PN-M8-51 near SR 410 E \(68 storm drains, 0\.7 mi of street\): it drains to Fennel Creek, where coho salmon live\./);
    assert.match(body, /2\. Detention pond PN-L5-48 near 192nd Ave E/);
    assert.match(body, /6PPD-quinone/);
    assert.match(body, /A TireTrail user$/);
    assert.doesNotMatch(body, /—/);
  });
  test('waters that flow on to Fennel Creek say so', () => {
    const f = fix.find((x) => /Lake Bonney Outflow/.test(x.why))!;
    assert.equal(f.why, 'it drains to Lake Bonney Outflow, which flows on to Fennel Creek, where coho salmon live');
  });
  test('split by agency, city first', () => {
    const g = byAgency([{ place: 'a', why: 'b', inCity: false }, { place: 'c', why: 'd', inCity: true }]);
    assert.deepEqual(g.map((x) => x.agency.id), ['bonney-lake', 'pierce-county']);
  });
  test('mailto is fully encoded', () => {
    const u = mailtoUrl('PCWATER@piercecountywa.gov', 'A & B', 'line one\nline two');
    assert.equal(u, 'mailto:PCWATER@piercecountywa.gov?subject=A%20%26%20B&body=line%20one%0D%0Aline%20two');
  });
});
