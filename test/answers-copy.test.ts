/** answer card words: exact copy per ending, plain names for waters, US units, no dashes */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { Region } from '../src/app/map/region.ts';
import {
  closing, covers, creekName, drainLine, feetText, headline, KIND, line, list, nearLine, owns, plainWater, type Outcome,
} from '../src/app/screens/common.ts';
import { CAT } from '../src/app/map/palette.ts';

const o = (x: Partial<Outcome>): Outcome => ({ cls: 'creek', code: 'outfall-creek', receiving: '', reason: '', lengthM: 300, owner: "the city's", city: true, ...x });
const head = (x: Partial<Outcome>) => headline(o(x));
const ln = (x: Partial<Outcome>) => line(o(x));

describe('card words', () => {
  test('salmon stream headlines name the water the way people say it', () => {
    assert.equal(head({ receiving: '' }), 'Rain here ends up in Fennel Creek.');
    assert.equal(head({ receiving: 'Fennel Creek' }), 'Rain here ends up in Fennel Creek.');
    assert.equal(head({ receiving: 'Fennel Creek tributary (unnamed)' }), 'Rain here ends up in a stream that feeds Fennel Creek.');
    assert.equal(head({ receiving: 'Debra Jane Lake' }), 'Rain here reaches Debra Jane Lake, which drains to Fennel Creek.');
    assert.equal(head({ receiving: 'Lake Bonney Outflow' }), 'Rain here reaches Lake Bonney Outflow, which drains to Fennel Creek.');
    assert.equal(head({ receiving: 'Bonney Lake' }), 'Rain here reaches Bonney Lake, which drains to Fennel Creek.');
    assert.equal(head({ receiving: 'Unnamed coho stream' }), 'Rain here ends up in a small salmon stream with no name on the map.');
    assert.equal(head({ receiving: 'Clover Creek' }), 'Rain here ends up in Clover Creek.');
    assert.equal(head({ receiving: 'North Fork Clover Creek Tributary 5' }), 'Rain here ends up in a stream that feeds North Fork Clover Creek.');
    assert.equal(ln({}), 'Coho salmon live there. A chemical from tire dust can kill them within hours of a storm.');
    assert.equal(ln({ code: 'downstream-creek', receiving: 'Swan Creek' }), 'It reaches a smaller stream first, which runs into Swan Creek. Coho salmon live there.');
  });

  test('soak-in lines follow the ending', () => {
    const g = (code: string, owner = "the city's", reason = '') => ln({ cls: 'ground', code, owner, reason });
    assert.equal(head({ cls: 'ground', code: 'drywell' }), 'Rain here soaks into the ground.');
    assert.equal(g('drywell'), 'It runs into a dry well, a pit that lets water sink into the soil.');
    for (const c of ['infiltration-pond', 'pond-to-ground', 'pond-to-ground-partial']) assert.equal(g(c), 'It runs into a pond built to let water soak into the soil.');
    assert.equal(g('infiltration-pond-overflow'), 'It runs into a pond built to let water soak in. In very big storms the pond can overflow.');
    assert.equal(g('infiltration-vault'), 'It runs into an underground tank that lets water soak into the soil.');
    assert.equal(g('perforated-pipe'), 'It runs into a pipe with holes that lets water soak into the soil.');
    assert.equal(g('pipe-to-infiltration'), 'It runs to a spot built to let water soak into the soil.');
    assert.equal(g('discharge-point', "Pierce County's"), "Pierce County's map shows the pipes ending at a spot built to let water soak in.");
    assert.equal(g('something-new'), 'The soil filters it instead of the water running to a creek.');
  });

  test('other water: plain names, and the line depends on whose data it is', () => {
    const e = (receiving: string, city = false) => [head({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving, city }), ln({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving, city })];
    assert.deepEqual(e('Lake Tapps', true), ['Rain here drains to Lake Tapps.', "It doesn't flow on to Fennel Creek, the salmon stream TireTrail follows here."]);
    assert.deepEqual(e('Lake Tapps'), ['Rain here drains to Lake Tapps.', "The state's fish maps don't list it as coho salmon habitat."]);
    assert.equal(e('an unnamed stream')[0], 'Rain here drains to a small stream with no name on the map.');
    assert.equal(e('an unnamed lake or pond')[0], 'Rain here drains to a small lake or pond with no name on the map.');
    assert.equal(e('unnamed pond or lake', true)[0], 'Rain here drains to a small lake or pond with no name on the map.');
    assert.deepEqual(e('Fennel Creek'), ['Rain here drains to Fennel Creek.', "The county's fish map doesn't list this part of the creek as coho habitat."]);
  });

  test('a treatment plant answer has its own words', () => {
    assert.equal(head({ cls: 'treatment', code: 'combined' }), 'Rain here goes to a sewage treatment plant.');
    assert.equal(ln({ cls: 'treatment', code: 'combined' }), 'In big storms, some of it can overflow untreated into nearby water.');
    assert.equal(KIND.treatment.chip, 'TREATMENT PLANT');
    assert.equal(KIND.treatment.color, CAT.treatment);
  });

  test('map gaps say how far TireTrail can follow the rain, and why it stops', () => {
    const u = (code: string, lengthM = 326, owner = "the city's", reason = '') => [head({ cls: 'unknown', code, lengthM, owner, reason }), ln({ cls: 'unknown', code, lengthM, owner, reason })];
    assert.deepEqual(u('dead-end'), ['TireTrail can follow this rain for 1,070 ft. Then the pipe map has a gap.', "The pipe it flows into just ends on the city's map. TireTrail stops there instead of guessing."]);
    assert.equal(u('dead-end', 326, "Pierce County's")[1], "The pipe it flows into just ends on Pierce County's map. TireTrail stops there instead of guessing.");
    assert.deepEqual(u('not-connected', 0), ["This storm drain isn't connected to any pipe on the map.", "TireTrail can't follow it any farther."]);
    assert.equal(u('dead-end', 4)[0], "This storm drain isn't connected to any pipe on the map.");
    assert.equal(u('pond-unmapped')[1], "It reaches a pond, but the map doesn't show where the pond drains.");
    assert.equal(u('pond-other')[1], "It reaches a pond, but the map doesn't show where the pond drains.");
    assert.equal(u('outlet-unmapped')[1], "It reaches a culvert or ditch whose next stop isn't mapped.");
    assert.equal(u('gallery-unverified')[1], "It reaches an underground spot that may let water soak in, but the city hasn't confirmed it.");
    assert.equal(u('device-unmapped')[1], "It reaches a tank or treatment box whose outlet isn't mapped.");
    assert.equal(u('detention-unmapped')[1], "It reaches a tank or treatment box whose outlet isn't mapped.");
    assert.equal(u('loop')[1], "The pipes on the map loop back on themselves here, so the direction isn't clear.");
    assert.equal(u('outfall-unknown')[1], "It leaves the pipes at an outfall, but the map doesn't say which water it flows into.");
    assert.equal(u('discharge-unknown', 326, "Pierce County's")[1], "Pierce County's map ends at a discharge point and doesn't say where the water goes next.");
    assert.equal(u('too-long')[1], 'The path is too long to follow.');
    // water handed to another agency arrives as unknown with a reason of its own
    const hand = u('handoff', 326, "King County's", 'The water goes into the state highway drains 12 m from here.');
    assert.deepEqual(hand, ['TireTrail can follow this rain for 1,070 ft. Then the pipe map stops.', 'The water goes into the state highway drains 39 ft from here.']);
    assert.equal(u('handoff', 326, "King County's", 'Hands off to WSDOT at outfall OF_1234.')[1], "From there it goes into pipes that aren't on the map TireTrail uses.");
  });

  test('no drain says whose map shows none', () => {
    assert.equal(head({ cls: 'none' }), 'No storm drain is mapped on this stretch.');
    assert.equal(ln({ cls: 'none', owner: "the city's" }), "The city's map shows no drain within 160 feet, so rain runs off the side of the road here. TireTrail can't follow it.");
    assert.equal(ln({ cls: 'none', owner: "Pierce County's" }), "Pierce County's map shows no drain within 160 feet, so rain runs off the side of the road here. TireTrail can't follow it.");
  });

  test('near a street, a drain right here, and the card after See it happen', () => {
    assert.equal(nearLine(o({ cls: 'ground' }), '138th St E'), 'Rain on 138th St E soaks into the ground.');
    assert.equal(nearLine(o({ cls: 'creek', receiving: 'Fennel Creek' }), '192nd Ave E'), 'Rain on 192nd Ave E ends up in Fennel Creek.');
    assert.equal(nearLine(o({ cls: 'elsewhere', receiving: 'Lake Tapps' }), 'X'), 'Rain on X drains to Lake Tapps.');
    assert.equal(nearLine(o({ cls: 'unknown' }), 'X'), 'Rain on X reaches a gap in the pipe map.');
    assert.equal(nearLine(o({ cls: 'none' }), 'X'), 'Rain on X has no mapped drain.');
    assert.equal(drainLine(o({ cls: 'ground' })), 'Its water soaks into the ground.');
    assert.equal(drainLine(o({ cls: 'creek', receiving: 'Fennel Creek' })), 'Its water ends up in Fennel Creek.');
    assert.equal(drainLine(o({ cls: 'unknown' })), 'The pipe map loses track of its water.');
    assert.deepEqual(closing(o({ receiving: 'Fennel Creek' }), '214th Ave E'), {
      head: 'This is where tire dust from 214th Ave E ends up.',
      line: 'In Fennel Creek, a chemical from tire dust can kill coho salmon within hours of a storm. Braking gently leaves less dust behind.',
    });
    assert.deepEqual(closing(o({ cls: 'ground', code: 'drywell' }), 'X'), { head: 'Rain from X soaks into the ground.', line: 'The soil filters it instead of the water running to a creek.' });
    assert.deepEqual(closing(o({ cls: 'unknown', code: 'dead-end', lengthM: 326 }), 'X'), { head: 'TireTrail followed rain from X for 1,070 ft.', line: "Then the city's pipe map has a gap, so it stops instead of guessing." });
    assert.equal(closing(o({ cls: 'treatment' }), 'X').head, 'Rain from X goes to a sewage treatment plant.');
  });

  test('plain water names, meters said in feet, and lists', () => {
    assert.equal(plainWater('Clover Creek Tributary 7'), 'a stream that feeds Clover Creek');
    assert.equal(plainWater('Church Lake/Lake Tapps'), 'Church Lake and Lake Tapps');
    assert.equal(creekName(''), 'Fennel Creek');
    assert.equal(creekName('Unnamed coho stream'), 'a small salmon stream');
    assert.equal(feetText('Leaves the pipes 1 m from a stream, about 50 m on, 500 m in all.'), 'Leaves the pipes 3 ft from a stream, about 160 ft on, 1,640 ft in all.');
    assert.equal(feetText('Catch basin CB-M6-17'), 'Catch basin CB-M6-17');
    assert.equal(list(['A']), 'A');
    assert.equal(list(['A', 'B', 'C']), 'A, B and C');
    assert.equal(owns('Sumner'), "Sumner's");
    assert.equal(owns('Des Moines'), "Des Moines'");
  });

  test('where TireTrail works comes from the data, not a fixed list', () => {
    const R = (cities: string[], counties: [string, boolean][]) => ({ cityMaps: new Set(cities), counties: counties.map(([name, c]) => ({ name, c })), covered: (c: { c: boolean }) => c.c } as unknown as Region);
    assert.equal(covers(R(['Bonney Lake'], [['Pierce', true], ['King', false]])), 'Bonney Lake and unincorporated Pierce County');
    assert.equal(covers(R(['Bonney Lake', 'Tacoma', 'Seattle'], [['Pierce', true], ['King', true]])), 'Bonney Lake, Tacoma, Seattle and unincorporated Pierce and King counties');
    assert.equal(covers(null), 'Bonney Lake and unincorporated Pierce County');
  });

  test('no em or en dashes in the map tab code', () => {
    const dir = new URL('../src/app/screens/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, dir));
    files.push(new URL('../src/app/icons.ts', import.meta.url));
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /[–—]/, f.pathname);
  });
});
