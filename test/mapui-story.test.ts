/** See it happen's captions: fixed for roadside ditches, whose water it is, and where coho really are */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { narrate, type Outcome } from '../src/app/screens/common.ts';

const o = (x: Partial<Outcome & { name: string; pipes: number; ditches: number; curb: boolean; tiny: boolean; calm: boolean; intro: string }> = {}) =>
  narrate({ cls: 'creek', code: 'outfall-creek', receiving: 'Fennel Creek', reason: '', lengthM: 300, owner: "the city's", city: true, name: '214th Ave E', pipes: 4, ditches: 0, curb: true, ...x });

describe('story captions', () => {
  test('Bonney Lake creeks end where the water goes, and say coho spawn farther down', () => {
    assert.equal(o().end, 'It reaches <b>Fennel Creek</b>. Coho salmon spawn farther down the creek.');
    assert.equal(o({ code: 'pond-to-creek' }).end, 'It flows into a pond, then on to <b>Fennel Creek</b>. Coho salmon spawn farther down the creek.');
    assert.equal(o({ receiving: 'Fennel Creek tributary (unnamed)', code: 'stream-creek' }).end, 'It reaches a stream that feeds <b>Fennel Creek</b>. Coho salmon spawn farther down Fennel Creek.');
    assert.equal(o({ receiving: 'Debra Jane Lake' }).end, 'It reaches <b>Debra Jane Lake</b>, which drains to Fennel Creek. Coho salmon spawn farther down Fennel Creek.');
  });

  test('county creeks say what WDFW records', () => {
    const c = { city: false, curb: false };
    assert.equal(o({ ...c, receiving: 'Clover Creek', reason: 'Comes out at outfall OF_1, right by Clover Creek. WDFW records coho salmon in this stream.' }).end, 'It reaches <b>Clover Creek</b>. WDFW records coho salmon there.');
    assert.equal(o({ ...c, code: 'downstream-creek', receiving: 'Goodnough Creek', reason: 'Gooch Creek flows about 1.1 miles on into Goodnough Creek, where WDFW records coho salmon.' }).end, 'It reaches a smaller stream that runs into <b>Goodnough Creek</b>. WDFW records coho salmon downstream.');
    assert.equal(o({ ...c, code: 'bridge-creek', receiving: 'Clover Creek', reason: 'WDFW records coho salmon in this stream.' }).end, 'It drops through the bridge drain into <b>Clover Creek</b>. WDFW records coho salmon there.');
    assert.equal(o({ ...c, code: 'pipe-end-creek', receiving: 'Clover Creek', reason: 'WDFW records coho salmon in this stream.' }).end, 'The map stops just short of <b>Clover Creek</b>. It most likely flows in. WDFW records coho salmon there.');
  });

  test('other endings', () => {
    assert.equal(o({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving: 'Lake Tapps' }).end, 'It ends up in <b>Lake Tapps</b>.');
    assert.equal(o({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving: 'an unnamed stream' }).end, 'It ends up in <b>a small stream</b>.');
    assert.equal(o({ cls: 'ground', code: 'drywell', receiving: '' }).end, 'It soaks into the soil here.');
    assert.equal(o({ cls: 'ground', code: 'infiltration-pond', receiving: '' }).end, 'It flows into a pond built to soak it into the ground.');
    assert.equal(o({ cls: 'ground', code: 'drywell', receiving: '', tiny: true }).end, 'It soaks into the ground right at the drain.');
    assert.equal(o({ cls: 'unknown', code: 'dead-end', receiving: '' }).end, 'Here the pipe map stops, so TireTrail stops too.');
    assert.equal(o({ cls: 'treatment', code: 'combined', receiving: '' }).end, 'It joins a sewer pipe that goes to a sewage treatment plant.');
  });

  test('the drain, the pipes and the steps: storm drains at the curb only in Bonney Lake, roadside ditches above ground', () => {
    assert.equal(o().rain, 'Rain washes tire dust off <b>214th Ave E</b> toward the storm drain at the curb.');
    assert.equal(o({ curb: false }).rain, 'Rain washes tire dust off <b>214th Ave E</b> toward the storm drain.');
    assert.equal(o().drain, "It pours into the storm drain. Now you're looking under the street.");
    assert.equal(o().pipes, 'Gray tubes are storm pipes. The blue dot is the rain, running downhill.');
    assert.deepEqual(o().steps, ['Rain washes tire dust off 214th Ave E', 'It pours into a storm drain', 'It runs through the storm pipes', 'Where it ends up']);
    const d = o({ ditch: true, pipes: 0, ditches: 3, curb: false });
    assert.equal(d.rain, 'Rain washes tire dust off <b>214th Ave E</b> into the roadside ditch.');
    assert.equal(d.drain, 'It runs along the roadside ditch, downhill.');
    assert.equal(d.pipes, 'The blue dot is the rain, running downhill through the roadside ditches.');
    assert.deepEqual(d.steps.slice(1, 3), ['It runs into a roadside ditch', 'It runs through the roadside ditches']);
    assert.equal(o({ ditches: 2 }).steps[2], 'It runs through the storm pipes and ditches');
    // a drive stop keeps its own first line; reduced motion never claims a view under the street
    assert.equal(o({ intro: 'Rain washes the tire dust from stop 2 off <b>Main St</b>.' }).rain, 'Rain washes the tire dust from stop 2 off <b>Main St</b>.');
    const calm = o({ calm: true });
    assert.doesNotMatch(calm.drain + calm.pipes, /looking under|blue dot/i);
  });

  test('names are escaped, and nothing says coho live where Bonney Lake pipes empty', () => {
    assert.ok(o({ name: 'A<b>' }).rain.includes('A&#60;b&#62;'));
    for (const receiving of ['Fennel Creek', 'Fennel Creek tributary (unnamed)', 'Lake Bonney Outflow', 'Debra Jane Lake']) {
      for (const code of ['outfall-creek', 'pond-to-creek', 'stream-creek']) assert.doesNotMatch(o({ receiving, code }).end, /coho salmon live|where coho salmon live/);
    }
  });
});
