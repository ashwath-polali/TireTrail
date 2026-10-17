import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { build, catchBasin, line, outfall, pipe, point, pond, square, traceOf } from './helpers.ts';

const basinThenPipe = (to = '', extra = {}) => ({
  structure: [catchBasin('CB-1', [0, 0])],
  pipe: [pipe('PI-1', 'CB-1', to, [[0, 0], [30, 0]], extra)],
});

describe('endings', () => {
  test('an infiltration pond soaks in (ground)', () => {
    const t = build({ ...basinThenPipe('PN-1'), pond: [pond('PN-1', 'Retention/Infiltration', square(40, 0, 8))] });
    const tr = traceOf(t, 'CB-1');
    assert.equal(tr.ending.code, 'infiltration-pond');
    assert.equal(tr.ending.cls, 'ground');
    assert.deepEqual(tr.keys, ['CB-1', 'PI-1', 'PN-1']);
  });

  test('an outfall the research ties to Fennel Creek reaches the creek', () => {
    const t = build(basinThenPipe(), { outfalls: [outfall('PI-1', true, 'Debra Jane Lake', [30, 0])] });
    const tr = traceOf(t, 'CB-1');
    assert.equal(tr.ending.code, 'outfall-creek');
    assert.equal(tr.ending.cls, 'creek');
    assert.equal(tr.ending.receiving, 'Debra Jane Lake');
    assert.equal(tr.confidence, 'high');
  });

  test('an outfall to Lake Tapps goes elsewhere; an unconfirmed one is unknown', () => {
    const tapps = build(basinThenPipe(), { outfalls: [outfall('PI-1', false, 'Lake Tapps', [30, 0])] });
    assert.equal(traceOf(tapps, 'CB-1').ending.cls, 'elsewhere');
    const unsure = build(basinThenPipe(), { outfalls: [outfall('PI-1', null, '', [30, 0])] });
    assert.equal(traceOf(unsure, 'CB-1').ending.code, 'outfall-unknown');
  });

  test('drywells and perforated pipes soak in', () => {
    const dry = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('DW-1', [30, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'DW-1', [[0, 0], [30, 0]])],
    });
    assert.equal(traceOf(dry, 'CB-1').ending.code, 'drywell');
    const perf = build(basinThenPipe('', { PipeWallTy: 'Perforated' }));
    assert.equal(traceOf(perf, 'CB-1').ending.code, 'perforated-pipe');
  });

  test('a pipe ending at Fennel Creek reaches it; 15 m away is the limit', () => {
    const creekAt = (y: number) => ({ fennelCreek: [line({}, [[0, y], [60, y]])] });
    const near = build(basinThenPipe(), { waters: creekAt(12) });
    assert.equal(traceOf(near, 'CB-1').ending.code, 'stream-creek');
    assert.equal(traceOf(near, 'CB-1').confidence, 'likely');
    const far = build(basinThenPipe(), { waters: creekAt(18) });
    assert.equal(traceOf(far, 'CB-1').ending.code, 'dead-end');
  });

  test('only a pipe or ditch end, or an outlet, discharges into nearby water', () => {
    const tributary = { fennelTributaries: [line({ FEATURE_NA: '' }, [[-50, 10], [50, 10]])] };
    // catch basin 10 m from a tributary, nothing downstream: a gap, not the creek
    const lone = build({ structure: [catchBasin('CB-1', [0, 0])] }, { waters: tributary });
    assert.equal(traceOf(lone, 'CB-1').ending.code, 'dead-end');
    const out = build(
      { structure: [catchBasin('CB-1', [0, -30])], outlet: [point({ AssetID: 'OUT-1', OutletType: 'Rip-rap' }, [0, 0])], pipe: [pipe('PI-1', 'CB-1', 'OUT-1', [[0, -30], [0, 0]])] },
      { waters: tributary },
    );
    assert.equal(traceOf(out, 'CB-1').ending.code, 'stream-creek');
  });

  test('"high" confidence needs an outfall reached without any guessed gap', () => {
    const t = build(
      {
        structure: [catchBasin('CB-1', [0, 0])],
        pipe: [pipe('PI-1', 'CB-1', '', [[0, 0], [30, 0]]), pipe('PI-OF', '', '', [[34, 0], [60, 0]])],
      },
      { outfalls: [outfall('PI-OF', true, 'Fennel Creek', [60, 0])] },
    );
    const tr = traceOf(t, 'CB-1');
    assert.equal(tr.ending.code, 'outfall-creek');
    assert.equal(tr.linkCounts['bridge-5m'], 1);
    assert.equal(tr.confidence, 'likely');
  });

  test('an outlet the city leaves unmapped after a detention pond falls back on its listed discharge, an unconfirmed outfall does not', () => {
    const parts = (extraPipe: ReturnType<typeof pipe>) => ({
      structure: [catchBasin('CB-1', [0, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'PN-D', [[0, 0], [30, 0]]), extraPipe],
      pond: [pond('PN-D', 'Detention', square(40, 0, 8), { AssetToID: 'PI-2', AssetToTyp: 'Fennel Creek' })],
    });
    const unconfirmed = build(parts(pipe('PI-2', 'PN-D', '', [[50, 0], [100, 0]])), { outfalls: [outfall('PI-2', null, '', [100, 0])] });
    assert.equal(traceOf(unconfirmed, 'CB-1').ending.code, 'outfall-unknown');
  });

  test('an outlet to an unmapped ditch and a tagged gallery are unknown', () => {
    const outlet = build({
      structure: [catchBasin('CB-1', [0, 0])],
      outlet: [point({ AssetID: 'OUT-1', OutletType: 'Trash Rack' }, [30, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'OUT-1', [[0, 0], [30, 0]])],
    });
    assert.equal(traceOf(outlet, 'CB-1').ending.code, 'outlet-unmapped');
    const gallery = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('MH-1', [30, 0], { StructureT: 'Manhole - Type2', Descriptio: 'GALLERY 3' })],
      pipe: [pipe('PI-1', 'CB-1', 'MH-1', [[0, 0], [30, 0]])],
    });
    assert.equal(traceOf(gallery, 'CB-1').ending.code, 'gallery-unverified');
  });
});

describe('walking the network', () => {
  test('a detention pond passes water through to what lies beyond it', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'PN-D', [[0, 0], [30, 0]]), pipe('PI-2', 'PN-D', 'PN-I', [[50, 0], [100, 0]])],
      pond: [
        pond('PN-D', 'Detention', square(40, 0, 8), { AssetToID: 'PI-2' }),
        pond('PN-I', 'Retention/Infiltration', square(110, 0, 8)),
      ],
    });
    const tr = traceOf(t, 'CB-1');
    assert.deepEqual(tr.keys, ['CB-1', 'PI-1', 'PN-D', 'PI-2', 'PN-I']);
    assert.equal(tr.ending.code, 'infiltration-pond');
  });

  test("when a detention pond's outlet is unmapped, its recorded discharge decides", () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'PN-D', [[0, 0], [30, 0]]), pipe('PI-2', 'PN-D', '', [[50, 0], [100, 0]])],
      pond: [pond('PN-D', 'Detention', square(40, 0, 8), { AssetToID: 'PI-2', AssetToTyp: 'Fennek Creek' })],
    });
    const tr = traceOf(t, 'CB-1');
    assert.equal(tr.ending.code, 'pond-to-creek-partial');
    assert.equal(tr.ending.cls, 'creek');
    assert.equal(t.net.assets[tr.ending.exit].key, 'PN-D');
    assert.equal(t.net.assets[tr.ending.terminal].key, 'PI-2');
  });

  test('a loop in the city data stops the walk', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'CB-2', [[0, 0], [30, 0]]), pipe('PI-2', 'CB-2', 'CB-1', [[30, 0.2], [0, 0.2]])],
    });
    const tr = traceOf(t, 'CB-1');
    assert.equal(tr.ending.code, 'loop');
    assert.deepEqual(tr.keys, ['CB-1', 'PI-1', 'CB-2', 'PI-2']);
  });

  test('at a junction the walk takes the wider pipe', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('DW-1', [0, 30])],
      pipe: [
        pipe('PI-A', 'CB-1', 'PN-1', [[0, 0], [30, 0]], { PipeWidth: 12 }),
        pipe('PI-B', 'CB-1', 'DW-1', [[0, 0], [0, 30]], { PipeWidth: 24 }),
      ],
      pond: [pond('PN-1', 'Retention/Infiltration', square(40, 0, 8))],
    });
    assert.deepEqual(traceOf(t, 'CB-1').keys, ['CB-1', 'PI-B', 'DW-1']);
  });

  test('reasons use IDs and types, never facility names', () => {
    const t = build({ ...basinThenPipe('PN-1'), pond: [pond('PN-1', 'Retention/Infiltration', square(40, 0, 8), { FacilityNa: 'Acme Plaza' })] });
    const tr = traceOf(t, 'CB-1');
    assert.ok(!tr.ending.reason.includes('Acme'));
    assert.match(tr.ending.reason, /PN-1/);
  });

  test('every drain gets exactly one trace, in asset order', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [100, 0])],
      inlet: [point({ AssetID: 'IC-1', InletType: 'Rip-rap' }, [200, 0])],
    });
    assert.deepEqual(t.traces.map((x) => t.net.assets[x.drain].key), ['CB-1', 'CB-2', 'IC-1']);
  });
});
