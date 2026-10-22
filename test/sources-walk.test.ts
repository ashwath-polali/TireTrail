// city sources traced by their keys (src/county/sources)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Bundle } from '../src/data/bundle.ts';
import { localProjection } from '../src/geo/geo.ts';
import type { SourceAsset } from '../src/county/source.ts';
import { decide, finishBundle, TREATMENT, waterKey } from '../src/county/sources/decide.ts';
import { GAP_CODE, KeyGraph, SEWER_CODE, toCountyAssets, toTrace } from '../src/county/sources/walk.ts';

const O: [number, number] = [-122.33, 47.61];
const P = localProjection(O);
/** lon/lat x meters east, y meters north of O */
const at = (x: number, y: number): [number, number] => P.toLngLat([x, y]);
const pt = (role: SourceAsset['role'], key: string, x: number, y: number, more: Partial<SourceAsset> = {}): SourceAsset => ({ role, id: key, key, src: 't', coords: [at(x, y)], trust: 'id', ...more });
const ln = (id: string, from: string | undefined, to: string | undefined, a: [number, number], b: [number, number], more: Partial<SourceAsset> = {}): SourceAsset => ({ role: 'pipe', id, src: 't', fromId: from, toId: to, coords: [at(...a), at(...b)], trust: 'id', ...more });

const SRC: SourceAsset[] = [
  pt('drain', 'd1', 0, 0),
  ln('p1', 'd1', 'm1', [0, 0], [50, 0]),
  pt('junction', 'm1', 50, 0),
  ln('p2', 'm1', 'o1', [50, 0], [100, 0]),
  pt('outfall', 'o1', 100, 0, { endHint: 'water', receivingHint: 'Longfellow Creek' }),
  pt('drain', 'd2', 0, 100),
  ln('p3', 'd2', 's1', [0, 100], [40, 100]),
  pt('discharge', 's1', 40, 100, { endHint: 'treatment', system: 'combined' }),
  // a lead with no key at its end, 1 m from where p2 starts
  pt('drain', 'd3', 50, -30),
  ln('p4', 'd3', undefined, [50, -30], [50, -1]),
  pt('drain', 'd4', 500, 500),
  pt('drain', 'd5', 0, 300),
  ln('p5', 'd5', 'x', [0, 300], [30, 300]),
];
const g = new KeyGraph(SRC, P);
const W = { coho: () => null, receiving: () => null, nameFor: () => '' };
const cfg = { owner: "Testville's", sewer: 'a treatment plant' };
const named = (n: string) => waterKey(n) === 'longfellow creek';
const run = (i: number) => {
  const r = g.walk(i);
  return { r, e: decide(r, SRC, g.xy, W, cfg, named) };
};

describe('city sources by key', () => {
  test('a drain follows its keys to the outfall, and a WDFW coho water by name counts as salmon water', () => {
    const { r, e } = run(0);
    assert.equal(r.sink, 'water');
    assert.deepEqual(r.path, [0, 1, 2, 3, 4]);
    assert.ok(Math.abs(r.pipeM - 100) < 0.5);
    assert.equal(e.cls, 'creek');
    assert.equal(e.receiving, 'Longfellow Creek');
  });

  test('street water entering a combined sewer goes to treatment', () => {
    const { r, e } = run(5);
    assert.equal(r.sink, 'sewer');
    assert.equal(e.code, SEWER_CODE);
    assert.equal(e.cls, 'treatment');
    assert.match(e.reason, /combined sewer/);
    assert.equal(toTrace(r, e).sewer, true);
    assert.equal(toTrace(r, e).ending.cls, 'elsewhere');
  });

  test('a keyless line end snaps to a pipe start close by', () => {
    const { r, e } = run(8);
    assert.equal(r.sink, 'water');
    assert.equal(r.snapped, true);
    assert.equal(toTrace(r, e).confidence, 'likely');
  });

  test('no pipe, or pipes that stop, say so instead of guessing', () => {
    assert.equal(run(10).e.code, 'not-connected');
    const gap = run(11);
    assert.equal(gap.r.sink, 'gap');
    assert.equal(gap.e.code, GAP_CODE);
    assert.equal(gap.e.reason, "Then Testville's pipe map has a gap.");
    assert.equal(toTrace(gap.r, gap.e).confidence, 'none');
  });

  test('county assets keep index, id and line', () => {
    const a = toCountyAssets(SRC, P);
    assert.equal(a.length, SRC.length);
    assert.equal(a[1].layer, 'pipe');
    assert.equal(a[0].layer, 'drain');
    assert.equal(a[4].kind, 'outlet');
    assert.equal(new Set(a.map((x) => x.key)).size, a.length);
  });

  test('sewer endings get the treatment class on runs and pieces', () => {
    const b = {
      endings: [{ code: SEWER_CODE, cls: 2 }, { code: 'outfall-creek', cls: 0 }],
      drains: { asset: [0, 1], ending: [0, 1], explicitPaths: {} },
      streets: { pieces: [{ cls: 2 }, { cls: 0 }], runs: { piece: [0, 1], drain: [0, 1], cls: [2, 0], geom: [[0, 0, 10, 10], [0, 0, 5, 5]] } },
    } as unknown as Bundle;
    const by = finishBundle(b, { creek: 1, ground: 0, elsewhere: 1, unknown: 0 }, 1);
    assert.equal(b.endings[0].cls, TREATMENT);
    assert.deepEqual(b.streets.runs.cls, [TREATMENT, 0]);
    assert.equal(b.streets.pieces[0].cls, TREATMENT);
    assert.deepEqual(by, { creek: 1, ground: 0, elsewhere: 0, unknown: 0, treatment: 1 });
  });
});
