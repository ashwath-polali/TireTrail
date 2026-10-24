/** the county overview file, and areas joining the world one at a time */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import type { Bundle } from '../src/data/bundle.ts';
import { mergeBundles } from '../src/data/merge.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { BoxGrid, Overview, OVERVIEW_FORMAT, World, type OverviewFile } from '../src/app/map/world.ts';

// labels.ts pulls in its stylesheet; node has nothing to do with it
registerHooks({ load: (url, ctx, next) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, ctx)) });
const { buildNames, streetGroups } = await import('../src/app/map/labels.ts');

const path = (f: string) => new URL(`../public/data/${f}`, import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(path(f), 'utf8'));
const index = read('areas/index.json') as { id: string; drains: number; bytes: number }[];
const file = read('overview.json') as OverviewFile;
const home = read('tiretrail.json') as Bundle;
// two smallish areas with streets, so the test stays quick
const picks = index.filter((a) => a.drains > 50 && a.bytes < 400000).slice(0, 2).map((a) => a.id);
const area = (id: string) => read(`areas/${id}.json`) as Bundle;
const td = (b: Bundle) => new TireTrailData(b);

describe('overview.json', () => {
  test('one light file holds every area, in index order', () => {
    assert.equal(file.format, OVERVIEW_FORMAT);
    assert.equal(file.version, 1);
    assert.deepEqual(file.areas, ['', ...index.map((a) => a.id)]);
    assert.equal(file.per.length, file.areas.length);
    assert.equal(file.per.reduce((s, k) => s + k, 0), file.n.length);
    assert.equal(file.cls.length, file.n.length);
    assert.match(file.cls, /^[0-9]*$/);
    assert.equal(file.xy.length, 2 * file.n.reduce((s, k) => s + k, 0));
    assert.ok(file.n.every((k) => k >= 2));
    // 2.51 MiB with Kent (about 1 MB gzipped); 3 MiB leaves room for a few more cities
    assert.ok(statSync(path('overview.json')).size <= 3 * 1024 * 1024, 'about 3 MB or less');
  });

  test('its Bonney Lake streets lie on the town\'s own streets', () => {
    const w = new World(td(home)), ov = new Overview(file, (p) => w.toWorld(p));
    let checked = 0;
    for (let k = 0; k < file.per[0]; k += 7) {
      for (let o = ov.start[k]; o < ov.start[k + 1]; o++) {
        assert.ok(w.nearestRun([ov.pts[2 * o], ov.pts[2 * o + 1]], 2), `overview run ${k} strays from the streets`);
        checked++;
      }
    }
    assert.ok(checked > 100);
  });

  test('runs of an area drop out of the missing list once it loads', () => {
    const w = new World(td(home)), ov = new Overview(file, (p) => w.toWorld(p));
    const ai = file.areas.indexOf(picks[0]);
    const k = ov.area.indexOf(ai);
    assert.ok(k >= 0);
    const x = ov.pts[2 * ov.start[k]], y = ov.pts[2 * ov.start[k] + 1];
    const near = () => ov.missingIn(x - 50, y - 50, x + 50, y + 50).filter((q) => ov.area[q] === ai);
    assert.ok(near().includes(k));
    // Bonney Lake is built in
    assert.equal(ov.missingIn(-1e5, -1e5, 1e5, 1e5).filter((q) => ov.area[q] === 0).length, 0);
    ov.markLoaded(picks[0]);
    assert.equal(near().length, 0);
  });

  test('a file that isn\'t one is turned away', () => {
    const tw = (p: [number, number]): [number, number] => [p[0], p[1]];
    assert.equal(Overview.read(null, tw), null);
    assert.equal(Overview.read({ ...file, format: 'x' }, tw), null);
    assert.equal(Overview.read({ ...file, cls: '1' }, tw), null);
  });
});

describe('BoxGrid', () => {
  test('finds each box that meets the query once', () => {
    const g = new BoxGrid(100), boxes: number[][] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) {
      const x = rnd() * 2000 - 1000, y = rnd() * 2000 - 1000, b = [x, y, x + rnd() * 300, y + rnd() * 300];
      boxes.push(b);
      g.insert(i, b[0], b[1], b[2], b[3]);
    }
    for (let q = 0; q < 50; q++) {
      const x = rnd() * 2000 - 1000, y = rnd() * 2000 - 1000, Q = [x, y, x + rnd() * 600, y + rnd() * 600];
      const got = g.query(Q[0], Q[1], Q[2], Q[3]).sort((a, b) => a - b);
      const want = boxes.map((b, i) => (b[2] >= Q[0] && b[0] <= Q[2] && b[3] >= Q[1] && b[1] <= Q[3] ? i : -1)).filter((i) => i >= 0);
      assert.deepEqual(got, want);
    }
  });
});

describe('areas join one at a time', () => {
  const merged = mergeBundles(mergeBundles(home, area(picks[0])), area(picks[1]));
  const whole = new World(td(merged));

  test('the world built up step by step matches one built at once', () => {
    const w = new World(td(home));
    const at = whole.runs[whole.runs.length - 1].line[0];
    // a tile drawn before the area arrives is drawn again after
    const before = w.groundAt(at[0], at[1]);
    const first = w.add(td(mergeBundles(home, area(picks[0]))));
    assert.equal(first, home.streets.runs.geom.length);
    w.add(td(merged));
    for (const k of ['runs', 'pipes', 'waters', 'drains', 'ponds', 'pieceNames'] as const) assert.equal(w[k].length, whole[k].length, k);
    assert.deepEqual(w.bounds, whole.bounds);
    assert.equal(w.groundAt(at[0], at[1]), whole.groundAt(at[0], at[1]));
    assert.notEqual(before, undefined);
    const B = whole.bounds;
    assert.deepEqual(w.runsIn(B.x0, B.y0, B.x1, B.y1).sort((a, b) => a - b), whole.runsIn(B.x0, B.y0, B.x1, B.y1).sort((a, b) => a - b));
    for (let i = 0; i < whole.runs.length; i += 97) {
      const p = whole.runs[i].line[0];
      assert.equal(w.runAtDrawn(p, 20)?.i, whole.runAtDrawn(p, 20)?.i);
      assert.equal(w.nearestRun(p, 30)?.i, whole.nearestRun(p, 30)?.i);
    }
  });

  test('street names grow with the new runs only', () => {
    const w = new World(td(home));
    const st0 = streetGroups(w), n0 = st0.x.length, g0 = st0.groups.length;
    const first = w.add(td(merged));
    const st = streetGroups(w, first, st0);
    assert.ok(st.x.length > n0 && st.groups.length > g0);
    assert.equal(st.runG.length, w.runs.length);
    for (let i = 0; i < w.runs.length; i++) {
      const name = w.pieceNames[w.runs[i].piece];
      if (st.runG[i] >= 0) assert.equal(st.groups[st.runG[i]].text, name);
      else assert.ok(!name || /^unnamed/i.test(name));
    }
    // every anchor sits in the grid once
    const seen = new Set<number>();
    for (const l of st.cells.values()) for (const i of l) { assert.ok(!seen.has(i)); seen.add(i); }
    assert.equal(seen.size, st.x.length);
  });

  test('water names taken in step by step match the whole set', () => {
    const w = new World(td(home)), names = buildNames(w, null, null);
    w.add(td(merged));
    names.waters!.add(0);
    const step = names.waters!.list().map((c) => c.text).sort();
    const once = buildNames(whole, null, null).water.map((c) => c.text).sort();
    assert.deepEqual(step, once);
  });
});
