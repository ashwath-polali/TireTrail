/** real Bonney Lake data checks */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { loadAnswerKey, loadInputs, type Inputs } from '../scripts/lib/inputs.ts';
import { compareWithKey } from '../src/trace/agreement.ts';
import { analyzeCity, type CityResult } from '../src/trace/city.ts';
import { text } from '../src/trace/geojson.ts';

let inputs: Inputs;
let city: CityResult;

before(() => {
  inputs = loadInputs();
  city = analyzeCity(inputs);
});

describe('real network', () => {
  test('every drain is traced, and the counts are in the expected range', () => {
    const s = city.net.stats;
    assert.equal(s.drains, 3524);
    assert.equal(city.traces.length, 3524);
    assert.equal(s.skippedNoGeometry, 2);
    assert.ok(s.links > 10000 && s.inferredLinks > 500, `links ${s.links}, inferred ${s.inferredLinks}`);
    assert.ok(s.components > 400 && s.components < 700, `components ${s.components}`);
    assert.ok(s.loops > 20 && s.loops < 80, `loops ${s.loops}`);
    const unknown = city.traces.filter((t) => t.ending.cls === 'unknown').length / city.traces.length;
    assert.ok(unknown > 0.35 && unknown < 0.6, `unknown share ${unknown}`);
  });

  test('agrees with the independent answer key on at least 85% of drains (3 colors)', () => {
    const a = compareWithKey(city.net, city.traces, loadAnswerKey(), city.projection);
    assert.equal(a.unmatched, 0);
    assert.ok(a.colorAgreement >= 0.85, `agreement ${a.colorAgreement}`);
  });

  test('the trace is deterministic', () => {
    const again = analyzeCity(inputs);
    const sig = (c: CityResult) => JSON.stringify(c.traces.map((t) => [t.path, t.ending.code, t.ending.exit]));
    assert.equal(sig(again), sig(city));
    assert.deepEqual(again.fixList, city.fixList);
  });
});

describe('streets and fix list', () => {
  test('at least 90% of street pieces get a class', () => {
    const classified = city.streets.pieces.filter((p) => p.cls).length;
    assert.ok(classified / inputs.streets.features.length >= 0.9);
    // runs tile each piece exactly
    for (const p of city.streets.pieces) {
      const total = p.runs.reduce((s, r) => s + city.streets.runs[r].lengthM, 0);
      assert.ok(Math.abs(total - p.lengthM) < 1e-6);
    }
  });

  test('the fix list is five creek-bound endings, ranked by street length', () => {
    const f = city.fixList;
    assert.equal(f.length, 5);
    for (let i = 1; i < f.length; i++) assert.ok(f[i - 1].streetM >= f[i].streetM);
    for (const item of f) {
      const feeding = city.traces.filter((t) => t.ending.exit === item.exit);
      assert.ok(feeding.length > 0 && feeding.every((t) => t.ending.cls === 'creek'), item.label);
    }
  });

  test('no facility or business name appears in any label or reason', () => {
    const generic = new Set(['pond', 'detention', 'retention', 'infiltration', 'swale', 'facility', 'the', 'and', 'of', 'vault', '-', '/']);
    const names = inputs.storm.pond.features
      .map((f) => text(f.properties.FacilityNa))
      .filter((n) => n && n.toLowerCase().split(/[\s/]+/).some((w) => !generic.has(w)));
    assert.ok(names.length > 10, 'the pond layer has facility names to check against');
    const texts = [...city.fixList.map((f) => f.label), ...city.traces.map((t) => t.ending.reason)];
    for (const name of names) assert.ok(!texts.some((s) => s.includes(name)), name);
  });
});
