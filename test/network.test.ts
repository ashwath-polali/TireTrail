import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { build, catchBasin, line, link, pipe, pond, square } from './helpers.ts';

describe('links from the city IDs', () => {
  test('from/to IDs become links', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'CB-2', [[0, 0], [30, 0]])],
    });
    assert.equal(link(t, 'CB-1', 'PI-1')?.how, 'id');
    assert.equal(link(t, 'PI-1', 'CB-2')?.how, 'id');
    assert.equal(t.net.stats.inferredLinks, 0);
  });

  test('a line drawn against its IDs is flipped to run downstream', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0])],
      pipe: [pipe('PI-1', 'CB-1', 'CB-2', [[30, 0], [0, 0]])],
    });
    const p = t.net.assets.find((a) => a.key === 'PI-1')!;
    assert.ok(Math.abs(p.line![0][0]) < 1e-6, 'the line now starts at CB-1');
    assert.equal(t.net.stats.linesFlipped, 1);
    assert.equal(link(t, 'CB-1', 'PI-1')?.how, 'id');
  });

  test('a repeated ID resolves to the copy nearest the joint', () => {
    const t = build({
      structure: [catchBasin('CB-9', [0, 0]), catchBasin('CB-9', [100, 0]), catchBasin('CB-2', [130, 0])],
      pipe: [pipe('PI-1', 'CB-9', 'CB-2', [[100, 0], [130, 0]])],
    });
    assert.ok(link(t, 'CB-9#2', 'PI-1'));
    assert.equal(link(t, 'CB-9', 'PI-1'), undefined);
    assert.equal(t.net.stats.duplicateIds, 1);
  });

  test('a pipe without geometry, or with empty geometry, is skipped, not fatal', () => {
    const missing = { ...pipe('PI-X', 'CB-1', '', [[0, 0], [1, 1]]), geometry: null };
    const empty = pipe('PI-Y', 'CB-1', '', []);
    const hollow = { ...pond('PN-Z', 'Retention/Infiltration', square(0, 0, 1)), geometry: { type: 'Polygon' as const, coordinates: [] } };
    const t = build({ structure: [catchBasin('CB-1', [0, 0])], pipe: [missing, empty], pond: [hollow] });
    assert.equal(t.net.stats.skippedNoGeometry, 3);
    assert.equal(t.traces.length, 1);
  });
});

describe('snapping blank ends', () => {
  test('blank ends join the assets they touch within 1.5 m', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0])],
      pipe: [pipe('PI-1', '', '', [[0.5, 0], [29, 0]])],
    });
    assert.deepEqual([link(t, 'CB-1', 'PI-1')?.how, link(t, 'CB-1', 'PI-1')?.gapM], ['snap', 0.5]);
    assert.deepEqual([link(t, 'PI-1', 'CB-2')?.how, link(t, 'PI-1', 'CB-2')?.gapM], ['snap', 1]);
  });

  test('a point beside a line joins it partway along', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0]), catchBasin('CB-3', [15, 1])],
      pipe: [pipe('PI-1', 'CB-1', 'CB-2', [[0, 0], [30, 0]])],
    });
    const l = link(t, 'CB-3', 'PI-1');
    assert.equal(l?.how, 'snap-mid');
    assert.equal(l?.joinAlongM, 15);
  });

  test('a pipe ending inside a pond flows into it', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0])],
      pipe: [pipe('PI-1', 'CB-1', '', [[0, 0], [50, 0]])],
      pond: [pond('PN-1', 'Retention/Infiltration', square(50, 0, 5))],
    });
    assert.equal(link(t, 'PI-1', 'PN-1')?.how, 'snap-pond');
  });
});

describe('bridging dead ends', () => {
  const across = (gap: number) =>
    build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30 + gap, 0])],
      pipe: [pipe('PI-1', 'CB-1', '', [[0, 0], [30, 0]])],
    });

  test('within 5 m, then 10 m, and no farther', () => {
    assert.equal(link(across(4), 'PI-1', 'CB-2')?.how, 'bridge-5m');
    assert.equal(link(across(8), 'PI-1', 'CB-2')?.how, 'bridge-10m');
    assert.equal(link(across(12), 'PI-1', 'CB-2'), undefined);
  });

  test('a pipe stopping within 20 m of a pond discharges into it', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0])],
      pipe: [pipe('PI-1', 'CB-1', '', [[0, 0], [30, 0]])],
      pond: [pond('PN-1', 'Retention/Infiltration', square(50, 0, 5))],
    });
    assert.equal(link(t, 'PI-1', 'PN-1')?.how, 'bridge-pond');
  });

  test('never into its own upstream (that would make a loop)', () => {
    // CB-1 → PI-0 → CB-2 → PI-1, PI-1 bends back to 3 m from CB-1
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [0, 20])],
      pipe: [pipe('PI-0', 'CB-1', 'CB-2', [[0, 0], [0, 20]]), pipe('PI-1', 'CB-2', '', [[0, 20], [3, 20], [3, 0]])],
    });
    assert.equal(link(t, 'PI-1', 'CB-1'), undefined);
    assert.equal(link(t, 'PI-1', 'PI-0'), undefined);
    assert.ok(t.net.stats.rejectedLoopBridges >= 1);
  });
});

describe('network counts', () => {
  test('loops and separate pieces', () => {
    const t = build({
      structure: [catchBasin('CB-1', [0, 0]), catchBasin('CB-2', [30, 0]), catchBasin('CB-7', [500, 500])],
      pipe: [pipe('PI-1', 'CB-1', 'CB-2', [[0, 0], [30, 0]]), pipe('PI-2', 'CB-2', 'CB-1', [[30, 0.2], [0, 0.2]])],
    });
    assert.equal(t.net.stats.loops, 1);
    assert.equal(t.net.stats.assetsInLoops, 4);
    assert.equal(t.net.stats.components, 2);
  });

  test('ditches are lines like pipes', () => {
    const ditch = line({ AssetID: 'CH-1', AssetFromI: 'CB-1', AssetToID: '', AssetToTyp: '', ChannelTyp: 'Man-made', ChannelWid: 24 }, [[0, 0], [40, 0]]);
    const t = build({ structure: [catchBasin('CB-1', [0, 0])], channel: [ditch] });
    assert.equal(link(t, 'CB-1', 'CH-1')?.how, 'id');
    assert.ok(Math.abs(t.net.assets.find((a) => a.key === 'CH-1')!.lengthM - 40) < 1e-6);
  });
});
