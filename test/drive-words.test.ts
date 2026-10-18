/** the words a drive's results use, and the stop classes behind them */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DrainInfo } from '../src/data/tiretrail.ts';
import { analyzeDrive, type DrainLookup } from '../src/drive/analyze.ts';
import { parseGPX, writeGPX } from '../src/drive/gpx.ts';
import {
  driveHeadline, driveSummary, NO_DATA, plainWater, salmonWater, smoothLine, stopAnswer, stopClass, stopTip, storyEnd, type StopClass,
} from '../src/drive/tips.ts';
import type { Fix } from '../src/drive/types.ts';
import { localProjection } from '../src/geo/geo.ts';

const CLASSES: StopClass[] = ['creek', 'ground', 'elsewhere', 'unknown', 'none', 'treatment'];
const RECEIVING = ['', 'Fennel Creek', 'Fennel Creek tributary (unnamed)', 'Debra Jane Lake', 'Lake Bonney Outflow', 'Unnamed coho stream',
  'North Fork Clover Creek Tributary 5', 'Swan Creek', 'an unnamed stream', 'an unnamed lake or pond', 'Lake Tapps', 'Church Lake/Lake Tapps'];
const DASHES = /[–—]/;

/** Every string the drive words can make, for blanket checks. */
function everything(): string[] {
  const out: string[] = [];
  for (const cls of CLASSES) for (const r of RECEIVING) for (const mapped of [true, false]) {
    out.push(stopAnswer(cls, r, mapped), stopTip(cls, true, r, 'outfall-creek', mapped), stopTip(cls, false, r, 'downstream-creek', mapped));
    for (const short of [true, false]) for (const local of [true, false]) { const e = storyEnd(3, cls, r, 'dead-end', '1,070 ft', short, local); out.push(e.title, e.line); }
  }
  for (let n = 0; n <= 6; n++) for (let hard = 0; hard <= n; hard++) out.push(driveHeadline(n, hard), smoothLine(n, hard));
  return out;
}

describe('stop words', () => {
  test('county salmon stream stops name their own water, never Fennel Creek (B7)', () => {
    for (const r of ['North Fork Clover Creek Tributary 5', 'Swan Creek', 'Clover Creek']) {
      const tip = stopTip('creek', true, r, 'outfall-creek');
      assert.match(tip, new RegExp(`goes to ${r}, where coho salmon live\\.`));
      assert.doesNotMatch(tip, /Fennel/);
      assert.equal(stopAnswer('creek', r), `Its tire dust ends up in ${r}.`);
    }
    assert.equal(stopTip('creek', false, 'Swan Creek', 'downstream-creek'), "This stop's rubber reaches a smaller stream first, which runs into Swan Creek, where coho salmon live.");
    assert.equal(stopTip('creek', false, 'Unnamed coho stream', 'outfall-creek'), "This stop's rubber goes to a small stream where coho salmon live.");
  });

  test('Bonney Lake salmon stream stops lead to Fennel Creek, honestly', () => {
    assert.equal(stopAnswer('creek', ''), 'Its tire dust ends up in Fennel Creek.');
    assert.equal(stopAnswer('creek', 'Fennel Creek tributary (unnamed)'), 'Its tire dust ends up in a stream that feeds Fennel Creek.');
    assert.equal(stopAnswer('creek', 'Debra Jane Lake'), 'Its tire dust reaches Debra Jane Lake, which drains to Fennel Creek.');
    assert.match(stopTip('creek', true, 'Fennel Creek tributary (unnamed)'), /down a small stream into Fennel Creek, where coho salmon live\. Brake earlier here\.$/);
    assert.equal(salmonWater('Lake Bonney Outflow').coho, 'Fennel Creek');
  });

  test('unknown stops say "the pipe map", never "the city\'s" (B8)', () => {
    assert.equal(stopTip('unknown', false, ''), "The pipe map doesn't show where this one goes.");
    for (const s of everything()) assert.doesNotMatch(s, /city's/, s);
  });

  test('stops where TireTrail has no pipe maps say so (B16)', () => {
    assert.equal(stopAnswer('none', '', false), NO_DATA);
    assert.equal(stopTip('none', true, '', '', false), `${NO_DATA} Brake earlier here.`);
    assert.equal(stopAnswer('none', '', true), 'No storm drain is mapped near this stop.');
  });

  test('treatment plant stops get their own words', () => {
    assert.equal(stopAnswer('treatment'), 'Its tire dust goes to a sewage treatment plant.');
    assert.match(stopTip('treatment', false, ''), /sewage treatment plant\. In big storms, some of it can overflow untreated into nearby water\.$/);
    const e = storyEnd(2, 'treatment', '', 'combined', '', false, false);
    assert.equal(e.title, 'Rain from stop 2 goes to a sewage treatment plant.');
    assert.equal(e.line, 'In big storms, some of it can overflow untreated into nearby water.');
  });

  test('unnamed water reads plainly', () => {
    assert.equal(plainWater('an unnamed stream'), 'a small stream with no name on the map');
    assert.equal(plainWater('an unnamed lake or pond'), 'a small lake or pond with no name on the map');
    assert.equal(plainWater('unnamed stream'), 'a small stream with no name on the map');
    assert.equal(plainWater(''), 'other water');
  });

  test('class names the app does not know read as unknown', () => {
    assert.equal(stopClass('treatment'), 'treatment');
    assert.equal(stopClass(undefined), 'unknown');
    assert.equal(stopClass('sewer'), 'unknown');
  });

  test('no dashes, and every sentence ends with a period', () => {
    for (const s of everything()) {
      assert.doesNotMatch(s, DASHES, s);
      if (/\s/.test(s) && !/^\d/.test(s) && !/stops? smooth$|full stops$|hard stop$|smooth stop$/.test(s)) assert.match(s, /[.]$/, s);
    }
  });
});

describe('drive results words', () => {
  test('one-stop and no-stop drives read right (B48)', () => {
    assert.equal(driveHeadline(1, 1), 'Your only stop was a hard one.');
    assert.equal(driveHeadline(1, 0), 'Your only stop was smooth.');
    assert.equal(driveHeadline(0, 0), 'A smooth drive.');
    assert.equal(driveHeadline(6, 3), '3 of your 6 stops were smooth.');
    assert.equal(driveHeadline(2, 0), 'Both of your stops were smooth.');
    assert.equal(driveHeadline(4, 4), 'None of your 4 stops were smooth.');
    assert.equal(smoothLine(1, 1), '1 hard stop');
    assert.equal(smoothLine(5, 2), '3 of 5 stops smooth');
    assert.equal(driveSummary(0, []), 'There were no full stops on this drive.');
  });

  test('gaps, missing drains and missing data each get their own line (B17)', () => {
    const s = (cls: StopClass, mapped = true, receiving = '') => ({ cls, mapped, receiving });
    assert.equal(driveSummary(6, [s('unknown'), s('none'), s('none')]), 'The pipe maps lose track of where your hardest stops drain.');
    assert.equal(driveSummary(6, [s('none'), s('none'), s('none', false)]), 'No storm drains are mapped near your hardest stops.');
    assert.equal(driveSummary(6, [s('none', false), s('none', false), s('none', false)]), NO_DATA);
    assert.equal(driveSummary(1, [s('unknown')]), 'The pipe map loses track of where your stop drains.');
    assert.equal(driveSummary(1, [s('none')]), 'No storm drain is mapped near your stop.');
  });

  test('salmon stream lines count and name the water', () => {
    const s = (receiving: string) => ({ cls: 'creek' as StopClass, mapped: true, receiving });
    const g = { cls: 'ground' as StopClass, mapped: true, receiving: '' };
    assert.equal(driveSummary(6, [g, s('Fennel Creek'), g]), 'One of your hardest stops sends its tire dust into Fennel Creek, where coho salmon live.');
    assert.equal(driveSummary(1, [s('Swan Creek')]), 'Your stop sends its tire dust into Swan Creek, where coho salmon live.');
    assert.equal(driveSummary(2, [s('Swan Creek'), s('Swan Creek')]), 'Both of your stops send their tire dust into Swan Creek, where coho salmon live.');
    assert.equal(driveSummary(6, [s('Swan Creek'), s('Clover Creek'), g]), '2 of your hardest stops send their tire dust into streams where coho salmon live.');
    assert.equal(driveSummary(6, [s('Debra Jane Lake'), g, g]), 'One of your hardest stops sends its tire dust toward Fennel Creek, where coho salmon live.');
  });

  test('answers without a salmon stream say only what is known', () => {
    const g = { cls: 'ground' as StopClass, mapped: true, receiving: '' }, u = { cls: 'unknown' as StopClass, mapped: true, receiving: '' };
    assert.equal(driveSummary(6, [g, g, g]), 'None of your hardest stops drain to a salmon stream.');
    assert.equal(driveSummary(6, [g, u, u]), "The one stop TireTrail could follow doesn't drain to a salmon stream.");
  });

  test('the end of a stop story says "stop n" in place of the street', () => {
    assert.equal(storyEnd(3, 'creek', 'Fennel Creek', 'outfall-creek', '', false, true).title, 'This is where tire dust from stop 3 ends up.');
    assert.equal(storyEnd(1, 'unknown', '', 'dead-end', '1,070 ft', false, true).title, 'TireTrail followed rain from stop 1 for 1,070 ft.');
    assert.equal(storyEnd(1, 'unknown', '', 'not-connected', '0 ft', true, true).title, "The storm drain at stop 1 isn't connected to any pipe on the map.");
    assert.equal(storyEnd(1, 'elsewhere', 'Lake Tapps', 'outfall-elsewhere', '', false, true).line, "It doesn't flow on to Fennel Creek, the salmon stream TireTrail follows here.");
    assert.equal(storyEnd(1, 'elsewhere', 'Lake Tapps', 'outfall-elsewhere', '', false, false).line, "The state's fish maps don't list it as coho salmon habitat.");
  });
});

// a drive due east at 1 Hz: speed up, cruise, brake hard to a stop, wait, again
const P = localProjection();
function eastDrive(stops: number, t0 = Date.UTC(2026, 9, 17, 17)): Fix[] {
  const fixes: Fix[] = [];
  let x = 0, v = 0, t = 0;
  const step = (a: number, secs: number) => {
    for (let k = 0; k < secs; k++) {
      v = Math.max(0, Math.min(15, v + a));
      x += v;
      const [lon, lat] = P.toLngLat([x, 0]);
      fixes.push({ t: t0 + t * 1000, lat, lon, speed: v, accuracy: 5 });
      t++;
    }
  };
  for (let s = 0; s < stops; s++) { step(3, 6); step(0, 25); step(-3, 6); step(0, 12); }
  return fixes;
}

const drain = (cls: string): DrainInfo => ({ index: 0, id: 'CB-1', lngLat: [0, 0], cls: cls as DrainInfo['cls'], code: 'dead-end', confidence: 'high', receiving: '', reason: '', terminalId: '', exitId: '' });
const lookup = (cls: string | null): DrainLookup => ({
  nearestDrain: () => (cls ? { drain: drain(cls), distanceM: 10 } : null),
  path: () => ({ drain: 0, assets: ['CB-1'], coords: [[0, 0]], lengthM: 0 }),
});

describe('drive analysis classes', () => {
  test('a drain class only the map knows (treatment) comes through clsOf', () => {
    const r = analyzeDrive(eastDrive(2), lookup('weird'), { clsOf: () => 'treatment' });
    assert.ok(r.hardest.length > 0);
    for (const s of r.hardest) { assert.equal(s.cls, 'treatment'); assert.match(s.tip, /treatment plant/); }
  });

  test('an unknown drain class reads as unknown, not as a crash', () => {
    const r = analyzeDrive(eastDrive(1), lookup('weird'));
    assert.equal(r.hardest[0].cls, 'unknown');
  });

  test('no drain where nothing is traced: no pipe data, not "no drain"', () => {
    const out = analyzeDrive(eastDrive(1), lookup(null), { covered: () => false });
    assert.equal(out.hardest[0].cls, 'none');
    assert.equal(out.hardest[0].mapped, false);
    assert.match(out.hardest[0].tip, /doesn't have pipe maps where you stopped/);
    const inside = analyzeDrive(eastDrive(1), lookup(null), { covered: () => true });
    assert.equal(inside.hardest[0].mapped, true);
  });

  test('a 150,000 point GPX file reads and analyzes (B22)', () => {
    const fixes = eastDrive(3062);
    assert.ok(fixes.length >= 150_000, String(fixes.length));
    const read = parseGPX(writeGPX(fixes));
    assert.equal(read.length, fixes.length);
    const r = analyzeDrive(read, lookup('ground'));
    assert.ok(r.usedFixes >= 150_000 && r.hardest.length === 3, `${r.usedFixes} fixes, ${r.hardest.length} hardest`);
  });
});
