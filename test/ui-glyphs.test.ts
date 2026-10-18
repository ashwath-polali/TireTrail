/** the pixel icons: well-formed bitmaps that turn into crisp SVG */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bitmapPath, bitmapSize, bitmapSVG, glyph, GLYPHS, salmonSVG } from '../src/app/ui/glyphs.ts';

describe('bitmaps', () => {
  test('one rect per run of lit pixels', () => {
    assert.equal(bitmapPath(['XX.X']), 'M0 0h2v1h-2zM3 0h1v1h-1z');
    assert.equal(bitmapPath(['..', '.X']), 'M1 1h1v1h-1z');
    assert.equal(bitmapPath(['oo'], 'o'), 'M0 0h2v1h-2z');
  });
  test('size is the widest row by the row count', () => {
    assert.deepEqual(bitmapSize(['XXX', 'X']), [3, 2]);
  });
  test('svg is scaled by whole pixels and drawn crisp', () => {
    const svg = bitmapSVG(['XX', 'XX'], 3);
    assert.match(svg, /viewBox="0 0 2 2" width="6" height="6"/);
    assert.match(svg, /shape-rendering="crispEdges"/);
    assert.match(svg, /aria-hidden="true"/);
  });
  test('a half-lit color gets its opacity', () => {
    assert.match(bitmapSVG(['o'], 2, { o: ['currentColor', 0.45] }), /fill-opacity="0.45"/);
  });
});

describe('the icon set', () => {
  test('every icon draws in currentColor on a grid no bigger than 13 by 9', () => {
    for (const name of GLYPHS) {
      const svg = glyph(name);
      assert.ok(svg.startsWith('<svg class="u-g"'), name);
      const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
      assert.ok(m, name);
      const [w, h] = [Number(m![1]), Number(m![2])];
      assert.ok(w >= 4 && w <= 13 && h >= 4 && h <= 9, `${name} is ${w}x${h}`);
      assert.match(svg, /fill="currentColor"/, name);
    }
  });
  test('the shell and kit icons exist', () => {
    for (const name of ['car', 'list', 'map', 'home', 'plus', 'minus', 'x', 'arrow', 'chevron', 'laptop', 'phone', 'check', 'play', 'bell', 'fish', 'soak', 'wave', 'gas', 'stop', 'info']) {
      assert.ok(GLYPHS.includes(name as never), name);
    }
  });
  test('an unknown name draws nothing', () => {
    assert.equal(glyph('nope'), '');
  });
  test('the brand salmon has its own colors, not currentColor', () => {
    const s = salmonSVG(2);
    assert.match(s, /width="32" height="14"/);
    assert.doesNotMatch(s, /currentColor/);
  });
});
