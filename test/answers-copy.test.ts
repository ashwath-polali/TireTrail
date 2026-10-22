/** answer card words: where the rain goes, why it matters and what to do, per ending; plain names for waters, US units, no dashes */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { Region } from '../src/app/map/region.ts';
import {
  closing, covers, creekName, drainLine, endLabel, ending, feetText, headline, KIND, line, LINE_MAX, list, nearLine, owns, plainWater, roadName, spotName, todo, todoLine, why, whyLine, type Outcome,
} from '../src/app/screens/common.ts';
import { CAT } from '../src/app/map/palette.ts';

const o = (x: Partial<Outcome>): Outcome => ({ cls: 'creek', code: 'outfall-creek', receiving: '', reason: '', lengthM: 300, owner: "the city's", city: true, ...x });
const head = (x: Partial<Outcome>) => headline(o(x));
const w = (x: Partial<Outcome>) => why(o(x));

describe('card words', () => {
  test('salmon stream headlines name the water the way people say it', () => {
    assert.equal(head({ receiving: '' }), 'Rain here ends up in Fennel Creek.');
    assert.equal(head({ receiving: 'Fennel Creek' }), 'Rain here ends up in Fennel Creek.');
    assert.equal(head({ receiving: 'Fennel Creek tributary (unnamed)' }), 'Rain here ends up in a stream that feeds Fennel Creek.');
    assert.equal(head({ receiving: 'Debra Jane Lake' }), 'Rain here reaches Debra Jane Lake, then Fennel Creek.');
    assert.equal(head({ receiving: 'Lake Bonney Outflow' }), 'Rain here reaches Lake Bonney Outflow, then Fennel Creek.');
    assert.equal(head({ receiving: 'Bonney Lake' }), 'Rain here reaches Bonney Lake, then Fennel Creek.');
    assert.equal(head({ receiving: 'Unnamed coho stream' }), 'Rain here ends up in a small salmon stream.');
    assert.equal(head({ receiving: 'Clover Creek' }), 'Rain here ends up in Clover Creek.');
    assert.equal(head({ receiving: 'North Fork Clover Creek Tributary 5' }), 'Rain here ends up in a stream that feeds North Fork Clover Creek.');
    // the county's "most likely" endings say so
    assert.equal(head({ code: 'bridge-creek', receiving: 'Clover Creek', city: false }), 'Rain here most likely drops into Clover Creek.');
    assert.equal(head({ code: 'pipe-end-creek', receiving: 'Clover Creek', city: false }), 'Rain here most likely flows into Clover Creek.');
  });

  test('why a salmon stream matters follows what the data says about coho', () => {
    // Bonney Lake's creeks flow down to where coho spawn; they don't live where the pipes empty
    assert.deepEqual(w({ receiving: 'Fennel Creek' }), { title: 'Coho salmon spawn downstream.', body: '6PPDQ in tire dust can kill coho within hours of a storm.' });
    assert.equal(w({ receiving: 'Fennel Creek', city: false }).title, 'Coho salmon spawn downstream.');
    // county streams carry WDFW's own words
    assert.equal(w({ receiving: 'Clover Creek', city: false, reason: 'Comes out at outfall OF_1, right by Clover Creek. WDFW records coho salmon in this stream.' }).title, 'WDFW records coho salmon in this stream.');
    assert.equal(w({ code: 'downstream-creek', receiving: 'Goodnough Creek', city: false, reason: 'Reaches stream culvert P_1, part of Gooch Creek. Gooch Creek flows about 1.1 miles on into Goodnough Creek, where WDFW records coho salmon.' }).title, 'WDFW records coho salmon downstream.');
    assert.equal(todo(o({}), '214th Ave E'), 'Brake gently on 214th Ave E. Hard brakes leave more tire dust.');
    assert.equal(todo(o({}), ''), 'Brake gently on this street. Hard brakes leave more tire dust.');
    assert.equal(line(o({ receiving: 'Fennel Creek' })), 'Coho salmon spawn downstream. 6PPDQ in tire dust can kill coho within hours of a storm.');
  });

  test('soak-in: soil removes most of the chemical, and how this one soaks in', () => {
    const g = (code: string, owner = "the city's", receiving = '') => w({ cls: 'ground', code, owner, receiving });
    assert.equal(head({ cls: 'ground', code: 'drywell' }), 'Rain here soaks into the ground.');
    assert.equal(g('drywell').title, 'Soil removes most of the tire chemical that harms salmon.');
    assert.equal(g('drywell').body, 'It drains into a dry well, a pit that lets it soak into the ground.');
    for (const c of ['infiltration-pond', 'pond-to-ground', 'pond-to-ground-partial']) assert.equal(g(c).body, 'It drains to a pond built to soak it into the ground.');
    assert.equal(g('infiltration-pond-overflow').body, 'It drains to a pond built to soak it in. In very big storms this pond can overflow.');
    assert.equal(g('infiltration-vault').body, 'It drains to an underground tank that lets it soak into the ground.');
    assert.equal(g('perforated-pipe').body, 'It drains into a pipe with holes that lets it soak into the ground.');
    assert.equal(g('pipe-to-infiltration').body, 'It drains to a spot built to soak it into the ground.');
    assert.equal(g('discharge-point', "Pierce County's").body, 'It drains to a spot Pierce County lists as built to soak water into the ground.');
    assert.equal(g('discharge-by-water', "Pierce County's", 'Canyonfalls Creek').body, 'It drains to a spot built to soak it in, close to Canyonfalls Creek. Some may still reach the water.');
    assert.equal(g('something-new').body, 'It drains to a spot built to soak it into the ground.');
    assert.equal(todo(o({ cls: 'ground', code: 'drywell' }), 'X'), 'Brake gently anyway. It saves your tires.');
    // never "instead of running to a creek", never "safe"
    for (const c of ['drywell', 'infiltration-pond', 'discharge-point', 'discharge-by-water']) assert.doesNotMatch(`${g(c).title} ${g(c).body}`, /instead of|safe/i);
  });

  test('other water: plain names, and why depends on whose data it is', () => {
    const e = (receiving: string, city = false, reason = '', code = 'outfall-elsewhere') => [head({ cls: 'elsewhere', code, receiving, city, reason }), w({ cls: 'elsewhere', code, receiving, city, reason }).title];
    assert.deepEqual(e('Lake Tapps', true), ['Rain here drains to Lake Tapps.', "It doesn't reach Fennel Creek, the salmon stream here."]);
    assert.deepEqual(e('Lake Tapps'), ['Rain here drains to Lake Tapps.', "The state's fish maps don't list it as coho salmon water."]);
    assert.equal(e('an unnamed stream')[0], 'Rain here drains to a small stream.');
    assert.equal(e('an unnamed lake or pond')[0], 'Rain here drains to a small lake or pond.');
    assert.equal(e('unnamed pond or lake', true)[0], 'Rain here drains to a small lake or pond.');
    assert.equal(e('a wetland')[0], 'Rain here drains to a wetland.');
    assert.deepEqual(e('Fennel Creek'), ['Rain here drains to Fennel Creek.', "WDFW doesn't map this part of the creek as coho water."]);
    assert.deepEqual(e('Puget Sound'), ['Rain here drains to Puget Sound.', 'It reaches salt water, not a coho spawning stream.']);
    assert.equal(e('Puget Sound', false, '', 'bridge-elsewhere')[0], 'Rain here most likely drops into Puget Sound.');
    assert.equal(e('Swan Creek', false, "Comes out at outfall OF_2, right by Swan Creek. WDFW maps this stream as reachable by coho salmon. They haven't been confirmed here.")[1], 'WDFW maps this stream as reachable by coho salmon.');
    assert.equal(e('Swan Creek', false, 'Comes out at outfall OF_2. WDFW lists coho salmon in this stream in the past.')[1], 'WDFW lists coho salmon in this stream in the past.');
  });

  test('a treatment plant answer has its own words', () => {
    assert.equal(head({ cls: 'treatment', code: 'combined' }), 'Rain here goes to a sewage treatment plant.');
    assert.equal(w({ cls: 'treatment', code: 'combined' }).title, 'In big storms, some of it can overflow untreated into nearby water.');
    assert.equal(KIND.treatment.chip, 'TREATMENT PLANT');
    assert.equal(KIND.treatment.color, CAT.treatment);
  });

  test('map gaps say how far TireTrail can follow the rain, and why it stops', () => {
    const u = (code: string, lengthM = 326, owner = "the city's", reason = '') => ({ head: head({ cls: 'unknown', code, lengthM, owner, reason }), ...w({ cls: 'unknown', code, lengthM, owner, reason }) });
    assert.deepEqual(u('dead-end'), { head: 'TireTrail can follow this rain for 1,070 ft.', title: "Then the city's map has a gap.", body: 'TireTrail stops there instead of guessing.' });
    assert.equal(u('dead-end', 326, "Pierce County's").title, "Then Pierce County's map has a gap.");
    assert.deepEqual(u('not-connected', 0), { head: "This storm drain isn't connected to any pipe on the map.", title: "So TireTrail can't follow its rain.", body: "It could end up in a creek or soak in. The map doesn't say which." });
    assert.equal(u('dead-end', 4).head, "This storm drain isn't connected to any pipe on the map.");
    assert.equal(headline(o({ cls: 'unknown', code: 'not-connected', lengthM: 0, ditch: true })), "This roadside ditch isn't connected to anything on the map.");
    assert.deepEqual([u('pond-unmapped').title, u('pond-unmapped').body], ['Then it flows into a pond.', "The map doesn't show where the pond drains."]);
    assert.equal(u('pond-other').title, 'Then it flows into a pond.');
    assert.equal(u('outlet-unmapped').title, 'Then it reaches a culvert or ditch.');
    assert.equal(u('gallery-unverified').body, "The city tagged it as a possible soak-in gallery but hasn't confirmed it.");
    assert.equal(u('device-unmapped').title, 'Then it reaches a tank or treatment box.');
    assert.equal(u('detention-unmapped').title, 'Then it reaches a tank or treatment box.');
    assert.equal(u('loop').title, 'Then the pipes on the map loop back on themselves.');
    assert.deepEqual([u('outfall-unknown').title, u('outfall-unknown').body], ['Then the pipes empty out at an outfall.', "The stream or pond it flows into isn't on the map."]);
    // the county's nearest water, without its ids
    assert.equal(u('outfall-unknown', 326, "Pierce County's", "Comes out at outfall DP_27282, but the stream or pond it flows into isn't on the map. The nearest mapped water, an unnamed stream, is about 170 ft away.").body, 'The nearest mapped water, an unnamed stream, is about 170 ft away.');
    assert.equal(u('discharge-unknown', 326, "Pierce County's").title, "Then Pierce County's map ends at a discharge point.");
    assert.deepEqual(u('discharge-probable', 326, "Pierce County's"), { head: 'Rain here probably soaks into the ground.', title: 'The pipes end at a spot Pierce County lists as built to soak water in.', body: "The map doesn't show that part, so TireTrail can't confirm it." });
    assert.equal(u('too-long').title, 'The path is too long to follow.');
    // water handed to another agency arrives as unknown with a reason of its own
    const hand = u('handoff', 326, "King County's", 'The water goes into the state highway drains 12 m from here.');
    assert.deepEqual([hand.head, hand.title], ['TireTrail can follow this rain for 1,070 ft.', 'The water goes into the state highway drains 39 ft from here.']);
    assert.equal(u('handoff', 326, "King County's", 'Hands off to WSDOT at outfall OF_1234.').title, "From there it goes into pipes that aren't on the map TireTrail uses.");
    assert.equal(todo(o({ cls: 'unknown', code: 'dead-end' }), 'X'), 'Brake gently here. Less dust is better wherever it goes.');
  });

  test('no drain says whose map shows none, and never claims there is no drain', () => {
    assert.equal(head({ cls: 'none' }), 'No storm drain is mapped on this stretch.');
    assert.deepEqual(w({ cls: 'none', owner: "the city's" }), { title: "The city's map shows no storm drain within 160 feet of this stretch.", body: "So TireTrail can't tell where its rain goes." });
    assert.equal(w({ cls: 'none', owner: "Pierce County's" }).title, "Pierce County's map shows no storm drain within 160 feet of this stretch.");
  });

  test('near a street, a drain right here, and the card after See it happen', () => {
    assert.equal(nearLine(o({ cls: 'ground' }), '138th St E'), 'Rain on 138th St E soaks into the ground.');
    assert.equal(nearLine(o({ cls: 'creek', receiving: 'Fennel Creek' }), '192nd Ave E'), 'Rain on 192nd Ave E ends up in Fennel Creek.');
    assert.equal(nearLine(o({ cls: 'elsewhere', receiving: 'Lake Tapps' }), 'X'), 'Rain on X drains to Lake Tapps.');
    assert.equal(nearLine(o({ cls: 'unknown' }), 'X'), 'Rain on X reaches a gap in the pipe map.');
    assert.equal(nearLine(o({ cls: 'unknown', code: 'discharge-probable' }), 'X'), 'Rain on X probably soaks into the ground.');
    assert.equal(nearLine(o({ cls: 'none' }), 'X'), 'Rain on X has no mapped drain.');
    assert.equal(drainLine(o({ cls: 'ground' })), 'Its water soaks into the ground.');
    assert.equal(drainLine(o({ cls: 'creek', receiving: 'Fennel Creek' })), 'Its water ends up in Fennel Creek.');
    assert.equal(drainLine(o({ cls: 'unknown', code: 'dead-end' })), 'TireTrail can follow its water for 980 ft. Then the map stops.');
    assert.equal(drainLine(o({ cls: 'unknown', code: 'not-connected', lengthM: 0 })), "It isn't connected to any pipe on the map.");
    const end = ending(o({ receiving: 'Fennel Creek' }), '214th Ave E');
    assert.deepEqual(end, {
      kicker: 'WHERE IT ENDS UP',
      head: 'Tire dust from 214th Ave E travels 980 ft and ends up in Fennel Creek.',
      why: { title: 'Coho salmon spawn downstream.', body: '6PPDQ in tire dust can kill coho within hours of a storm.' },
      todo: 'Brake gently on 214th Ave E. Hard brakes leave more tire dust.',
    });
    assert.equal(ending(o({ cls: 'ground', code: 'drywell' }), 'X').head, 'Rain from X travels 980 ft and soaks into the ground.');
    assert.equal(ending(o({ cls: 'ground', code: 'drywell', lengthM: 1 }), 'X').head, 'Rain from X soaks into the ground.');
    assert.deepEqual([ending(o({ cls: 'unknown', code: 'dead-end', lengthM: 326 }), 'X').kicker, ending(o({ cls: 'unknown', code: 'dead-end', lengthM: 326 }), 'X').head], ['AS FAR AS THE MAP GOES', 'TireTrail followed rain from X for 1,070 ft.']);
    assert.equal(ending(o({ cls: 'unknown', code: 'not-connected', lengthM: 0 }), 'X').head, "TireTrail can't follow rain from X past its storm drain.");
    assert.equal(ending(o({ cls: 'treatment' }), 'X').head, 'Rain from X travels 980 ft and goes to a sewage treatment plant.');
    assert.equal(ending(o({ cls: 'unknown', code: 'discharge-probable' }), 'X').head, 'Rain from X probably soaks into the ground.');
    assert.deepEqual(closing(o({ cls: 'ground', code: 'drywell' }), 'X'), { head: 'Rain from X travels 980 ft and soaks into the ground.', line: 'Soil removes most of the tire chemical that harms salmon. It drains into a dry well, a pit that lets it soak into the ground.' });
  });

  test('no card says coho live where Bonney Lake pipes empty, and none says safe', () => {
    const all: string[] = [];
    for (const receiving of ['', 'Fennel Creek', 'Fennel Creek tributary (unnamed)', 'Debra Jane Lake', 'Lake Bonney Outflow']) {
      for (const code of ['outfall-creek', 'pond-to-creek', 'stream-creek']) {
        const x = o({ receiving, code });
        const e = ending(x, 'X'), y = why(x);
        all.push(headline(x), y.title, y.body, e.head, e.why.title, e.why.body);
      }
    }
    for (const s of all) assert.doesNotMatch(s, /coho salmon live|where coho salmon live|safe/i, s);
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
    assert.equal(roadName('184 Avenue Court East'), '184 Ave Ct E');
    assert.equal(roadName('East Valley Highway East'), 'East Valley Hwy E');
    assert.equal(roadName('Sky Island Drive'), 'Sky Island Dr');
  });

  test('where TireTrail works comes from the data, not a fixed list', () => {
    // each city's county is where its label point lies
    const home: Record<string, string> = { 'Bonney Lake': 'Pierce', Tacoma: 'Pierce', Seattle: 'King' };
    const R = (cities: string[], counties: [string, boolean][]) => ({
      cityMaps: new Set(cities), places: Object.keys(home).map((name) => ({ name, at: name })),
      countyAt: (at: string) => ({ name: home[at] }), counties: counties.map(([name, c]) => ({ name, c })), covered: (c: { c: boolean }) => c.c,
    } as unknown as Region);
    assert.equal(covers(R(['Bonney Lake'], [['Pierce', true], ['King', false]])), 'Pierce County (Bonney Lake and unincorporated areas)');
    assert.equal(covers(R(['Bonney Lake', 'Tacoma', 'Seattle'], [['Pierce', true], ['King', true]])), 'King County (Seattle and unincorporated areas) and Pierce County (Bonney Lake, Tacoma and unincorporated areas)');
    assert.equal(covers(R(['Bonney Lake'], [['Pierce', false], ['King', true]])), 'King County (unincorporated areas) and Pierce County (Bonney Lake)');
    // without the county areas, only the city maps count
    assert.equal(covers(R(['Bonney Lake'], [['Pierce', true]]), false), 'Pierce County (Bonney Lake)');
    // more than 3 cities: counted, so cards stay short
    assert.equal(covers(R(['Bonney Lake', 'Tacoma', 'Seattle', 'Bellevue'], [['Pierce', true], ['King', true]])), '4 cities and unincorporated King and Pierce counties');
    assert.equal(covers(R(['Bonney Lake', 'Tacoma', 'Seattle', 'Bellevue'], [['Pierce', true]]), false), '4 cities');
    // no region: nothing named that isn't known
    assert.equal(covers(null), 'parts of Washington');
  });

  test('card rows: one short line each, the rest behind More, same facts as the long words', () => {
    const all: Partial<Outcome>[] = [
      { receiving: 'Fennel Creek' }, { receiving: 'Clover Creek', city: false, reason: 'WDFW records coho salmon in this stream.' },
      { code: 'downstream-creek', receiving: 'Goodnough Creek', city: false, reason: 'Gooch Creek flows on into Goodnough Creek, where WDFW records coho salmon.' },
      ...['drywell', 'infiltration-pond', 'discharge-point', 'discharge-by-water'].map((code) => ({ cls: 'ground' as const, code, owner: "Pierce County's", receiving: 'Canyonfalls Creek' })),
      { cls: 'elsewhere', receiving: 'Lake Tapps', city: true }, { cls: 'elsewhere', receiving: 'Lake Tapps', city: false }, { cls: 'elsewhere', receiving: 'Puget Sound', city: false },
      { cls: 'elsewhere', receiving: 'Fennel Creek', city: false }, { cls: 'elsewhere', receiving: 'Swan Creek', city: false, reason: 'WDFW maps this stream as reachable by coho salmon.' },
      { cls: 'elsewhere', receiving: 'Swan Creek', city: false, reason: 'WDFW lists coho salmon in this stream in the past.' }, { cls: 'treatment', code: 'combined' },
      ...['dead-end', 'pond-unmapped', 'outlet-unmapped', 'gallery-unverified', 'device-unmapped', 'loop', 'outfall-unknown', 'discharge-unknown', 'discharge-probable', 'too-long', 'handoff'].map((code) => ({ cls: 'unknown' as const, code, owner: "Pierce County's", reason: 'Hands off to WSDOT at outfall OF_1234.' })),
      { cls: 'unknown', code: 'not-connected', lengthM: 0 }, { cls: 'none' }, { cls: 'none', owner: "Pierce County's" },
    ];
    for (const x of all) {
      const y = whyLine(o(x)), t = todoLine(o(x), 'Sumner Buckley Hwy E'), lab = endLabel(o(x));
      for (const s of [y.text, t.text]) assert.ok(s.length <= LINE_MAX, `${x.cls} ${x.code}: ${s}`);
      for (const s of [y.text, y.more, t.text, t.more, lab]) assert.doesNotMatch(s, /coho salmon live|safe|[–—]/i, s);
    }
    // salmon: the short line names what WDFW says, and the kill fact is one tap in
    assert.deepEqual(whyLine(o({ receiving: 'Fennel Creek' })), { text: 'Coho salmon spawn downstream.', more: '6PPDQ in tire dust can kill coho within hours of a storm.' });
    assert.equal(whyLine(o({ receiving: 'Clover Creek', city: false, reason: 'WDFW records coho salmon in this stream.' })).text, 'WDFW records coho in this stream.');
    assert.equal(whyLine(o({ cls: 'elsewhere', receiving: 'Swan Creek', city: false, reason: 'WDFW maps this stream as reachable by coho salmon.' })).text, 'Coho may reach this stream.');
    assert.match(whyLine(o({ cls: 'elsewhere', receiving: 'Swan Creek', city: false, reason: 'WDFW maps this stream as reachable by coho salmon.' })).more, /aren't confirmed/);
    // soak-in keeps how it soaks in behind the tap
    assert.equal(whyLine(o({ cls: 'ground', code: 'drywell' })).more, 'It drains into a dry well, a pit that lets it soak into the ground.');
    // a map gap keeps its full words behind the tap
    assert.deepEqual(whyLine(o({ cls: 'unknown', code: 'dead-end', owner: "Pierce County's" })), { text: 'Then the map has a gap.', more: "Then Pierce County's map has a gap. TireTrail stops there instead of guessing." });
    assert.equal(whyLine(o({ cls: 'unknown', code: 'not-connected', lengthM: 0 })).text, "So TireTrail can't follow its rain.");
    assert.equal(whyLine(o({ cls: 'none' })).more, "The city's map shows no storm drain within 160 feet of this stretch. So TireTrail can't tell where its rain goes.");
    // a long street name falls back to "here"
    assert.deepEqual(todoLine(o({}), '214th Ave E'), { text: 'Brake gently on 214th Ave E.', more: 'Hard brakes leave more tire dust.' });
    assert.equal(todoLine(o({}), 'Sumner Buckley Hwy E').text, 'Brake gently here.');
    assert.equal(todoLine(o({ cls: 'ground', code: 'drywell' }), 'X').text, 'Brake gently anyway.');
    // the end card's label
    assert.equal(endLabel(o({ receiving: 'Debra Jane Lake' })), 'Debra Jane Lake');
    assert.equal(endLabel(o({ receiving: 'Clover Creek Tributary 5' })), 'A stream that feeds Clover Creek');
    assert.equal(endLabel(o({ cls: 'unknown', code: 'discharge-probable' })), 'Probably soaks in');
  });

  test('fix list spots read plainly, with the map id kept for staff', () => {
    assert.deepEqual(spotName('Detention pond PN-M8-51, listed as draining to Fennel Creek, near SR 410 E'), { name: 'Detention pond near SR 410 E', id: 'PN-M8-51' });
    assert.deepEqual(spotName('Culvert PI-J5-2864 where it meets Lake Bonney Outflow, near 79th St E'), { name: 'Culvert near 79th St E', id: 'PI-J5-2864' });
    assert.deepEqual(spotName('A spot with no id'), { name: 'A spot with no id', id: '' });
  });

  test('no em or en dashes in the map tab code', () => {
    const dir = new URL('../src/app/screens/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f === 'map-ui.css' || f === 'story.css').map((f) => new URL(f, dir));
    files.push(new URL('../src/app/icons.ts', import.meta.url));
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /[–—]/, f.pathname);
  });
});
