/** map labels: placing them on a fake page (caps, the UI, tags, hiding, when to place again) */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type LngLat, type XY } from '../src/geo/geo.ts';
import { CAT, PICK } from '../src/app/map/palette.ts';
import type { Cam, Renderer, Tag } from '../src/app/map/render.ts';
import { World } from '../src/app/map/world.ts';

// a few page pieces, just enough for the labels
class El {
  className = '';
  textContent = '';
  innerHTML = '';
  readonly kids: El[] = [];
  readonly dataset: Record<string, string> = {};
  writes = 0;
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void };
  constructor() {
    const self = this, s: Record<string, unknown> = { setProperty(k: string, v: string) { s[k] = v; } };
    this.style = new Proxy(s, { set(t, k, v) { if (t[k as string] !== v) self.writes++; t[k as string] = v; return true; } }) as El['style'];
  }
  append(...xs: (El | string)[]): void { for (const x of xs) if (typeof x === 'string') this.textContent += x; else this.kids.push(x); }
  remove(): void { /* gone */ }
  get text(): string { return this.textContent + this.kids.map((k) => k.text).join(' '); }
  get shown(): boolean { return this.style.display !== 'none'; }
  /** where the label sits (its anchor), from its transform */
  get at(): XY { const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(this.style.transform)!; return [Number(m[1]), Number(m[2])]; }
}
(globalThis as { document?: unknown }).document = { createElement: () => new El() };

registerHooks({ load: (url, ctx, next) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, ctx)) });
const { Labels } = await import('../src/app/map/labels.ts');

const P = localProjection();
const ll = (p: XY): LngLat => P.toLngLat([p[0], -p[1]]);
const enc = (pts: XY[]) => encodeCoords(pts.map(ll));

/** a grid of named streets 120 m apart, 3 km each way, and two creeks */
function grid(): World {
  const runs: [string, XY[]][] = [];
  for (let k = 0; k < 25; k++) {
    runs.push([`${100 + k}th Ave E`, [[k * 120, 0], [k * 120, 3000]]]);
    runs.push([`${40 + k}th St E`, [[0, k * 120], [3000, k * 120]]]);
  }
  const names = runs.map((r) => r[0]);
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: [], kind: [], geom: [] }, pondShapes: [], next: [], endings: [],
    drains: { asset: [], ending: [], explicitPaths: {} },
    streets: {
      pieces: names.map((name, id) => ({ id, name, lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' })),
      runs: { piece: runs.map((_, i) => i), drain: runs.map(() => -1), cls: runs.map(() => 4), geom: runs.map((r) => enc(r[1])) },
    },
    waters: [
      { name: 'Lake Bonney Outflow', kind: 'creek', fennel: true, lines: [enc([[1500, 1300], [1500, 1700]])], rings: [] },
      { name: 'Test Creek', kind: 'creek', fennel: true, lines: [enc([[60, 60], [2900, 2900]])], rings: [] },
    ],
    fixList: [], numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

const W = grid();
type Rect = [number, number, number, number];
/** a map stage W x H css px with a caption, a card and zoom buttons */
function stage(phone: boolean, w = phone ? 390 : 1440, h = phone ? 780 : 840) {
  const ui: [string, Rect][] = phone
    ? [['caption', [12, 12, w - 12, 92]], ['sheet', [0, h - 300, w, h]], ['zoom', [w - 58, h - 420, w - 12, h - 312]]]
    : [['caption', [16, 16, 560, 76]], ['sheet', [16, h - 240, 416, h - 16]], ['zoom', [w - 62, h - 110, w - 16, h - 16]]];
  const kids: El[] = [];
  const els = ui.map(([cls, [x0, y0, x1, y1]]) => ({ classList: { contains: (c: string) => c === cls }, getBoundingClientRect: () => ({ left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 }) }));
  const stageEl = { querySelectorAll: () => els };
  const box = {
    append: (e: El) => kids.push(e),
    closest: (s: string) => (s === '.phone' ? (phone ? {} : null) : s === '.stage' ? stageEl : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h }),
    offsetWidth: w,
    offsetHeight: h,
  };
  const r = {
    AW: w / 3, AH: h / 3, lastScene: {} as { tags?: Tag[] }, basemap: null,
    toWorld(cam: Cam, x: number, y: number): XY {
      const m = cam.mpp, vx = Math.round(cam.x / m) * m - (this.AW / 2) * m, vy = Math.round(cam.y / m) * m - (this.AH / 2) * m;
      return [vx + (x / 3) * m, vy + (y / 3) * m];
    },
  };
  const labels = new Labels(box as unknown as HTMLElement, W, null, null);
  const update = (cam: Cam, hide = false) => labels.update(cam, r as unknown as Renderer, hide, []);
  return { kids, ui: ui.map((u) => u[1]), r, update, labels, shown: () => kids.filter((k) => k.shown) };
}
const mid = (mpp: number): Cam => ({ x: 1500, y: 1500, mpp });
// the size the labels guess for 12.5 px text when nothing can measure it
const est = (t: string): [number, number] => [Math.ceil(t.length * 12.5 * .58) + 6, 19];
const hit = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

describe('street names', () => {
  test('never under the caption, the card or the zoom buttons', () => {
    for (const phone of [false, true]) for (const m of [1.5, 2.6, 4, 8]) {
      const s = stage(phone);
      s.update(mid(m));
      const streets = s.shown().filter((k) => k.className === 'maplabel ml-street');
      assert.ok(streets.length > 0, `${phone} ${m}`);
      for (const k of streets) {
        const [x, y] = k.at, [w, h] = est(k.text);
        for (const u of s.ui) assert.ok(!hit([x - w / 2, y - h / 2, x + w / 2, y + h / 2], u), `${k.text} at ${x},${y} mpp ${m}`);
      }
    }
  });

  test('caps per zoom: 22 / 12 up close, 14 / 8 to mpp 5, 8 / 5 to 12, none past 12', () => {
    const count = (phone: boolean, m: number) => { const s = stage(phone); s.update(mid(m)); return s.shown().filter((k) => k.className.includes('ml-street')).length; };
    for (const [m, lap, ph] of [[2, 22, 12], [4, 14, 8], [8, 8, 5], [11, 8, 5]]) {
      const a = count(false, m), b = count(true, m);
      assert.ok(a > 0 && a <= lap, `laptop mpp ${m}: ${a}`);
      assert.ok(b > 0 && b <= ph, `phone mpp ${m}: ${b}`);
    }
    assert.equal(count(false, 13), 0);
  });

  test('one label per street, and labels never overlap each other', () => {
    const s = stage(false);
    s.update(mid(2));
    const streets = s.shown().filter((k) => k.className.includes('ml-street'));
    assert.equal(new Set(streets.map((k) => k.text)).size, streets.length);
    const boxes = streets.map((k) => { const [x, y] = k.at, [w, h] = est(k.text); return [x - w / 2, y - h / 2, x + w / 2, y + h / 2] as Rect; });
    boxes.forEach((a, i) => boxes.forEach((b, j) => assert.ok(i === j || !hit(a, b), `${streets[i].text} / ${streets[j].text}`)));
  });

  test('a name already up stays put while the map pans a little', () => {
    const s = stage(false);
    s.update(mid(2));
    const before = new Map(s.shown().filter((k) => k.className.includes('ml-street')).map((k) => [k.text, k.at]));
    s.update({ x: 1500 + 6, y: 1500 + 4, mpp: 2 });
    let same = 0;
    for (const k of s.shown().filter((e) => e.className.includes('ml-street'))) {
      const b = before.get(k.text);
      // the map moved 9 px left and 6 px up; the name moved with it
      if (b && Math.abs(k.at[0] - (b[0] - 9)) <= 1 && Math.abs(k.at[1] - (b[1] - 6)) <= 1) same++;
    }
    assert.ok(same >= before.size - 2, `${same} of ${before.size}`);
  });
});

describe('water names', () => {
  test('outflows only up close', () => {
    const s = stage(false);
    s.update(mid(6));
    assert.ok(!s.shown().some((k) => k.text.includes('Outflow')));
    assert.ok(s.shown().some((k) => k.className === 'maplabel ml-water' && k.text.includes('Test Creek')));
    s.update(mid(2));
    assert.ok(s.shown().some((k) => k.text.includes('Lake Bonney Outflow')));
  });

  test('a creek is named up close even when the view falls between its usual anchors', () => {
    // 2 km along Test Creek, 125 m from the nearest of its every-250 m anchors
    const s = stage(true);
    s.update({ x: 1474, y: 1474, mpp: 1 });
    assert.ok(s.shown().some((k) => k.text.includes('Test Creek')));
  });
});

describe('tags', () => {
  const tags: Tag[] = [
    { at: [1500, 1450], text: '112th Ave E', tone: 'street' },
    { at: [1540, 1470], text: 'storm drain', tone: 'drain' },
    { at: [1580, 1500], text: 'pipes under the street', tone: 'pipe' },
    { at: [1460, 1520], text: 'pond', tone: 'pond' },
    { at: [1620, 1540], text: 'Test Creek', tone: 'creek', fish: true },
    { at: [1420, 1420], text: 'manhole, where pipes meet', tone: 'plain' },
  ];

  test('placed first, inside the open band, at most 5 on a laptop, destination and street first', () => {
    const s = stage(false);
    s.r.lastScene = { tags };
    s.update(mid(4));
    const shown = s.shown().filter((k) => k.className === 'maplabel ml-tag');
    assert.equal(shown.length, 5);
    assert.ok(shown.some((k) => k.text.includes('Test Creek')) && shown.some((k) => k.text.includes('112th Ave E')));
    for (const k of shown) assert.ok(['r', 'l', 't', 'b'].includes(k.dataset.side));
    const creek = shown.find((k) => k.text.includes('Test Creek'))!, street = shown.find((k) => k.text.includes('112th'))!;
    assert.equal(creek.style['--ml-tone'], CAT.creek);
    assert.equal(street.style['--ml-tone'], PICK.band);
    assert.ok(creek.innerHTML.includes('ml-fish'));
  });

  test('phones: 3 tags in short words', () => {
    const s = stage(true);
    s.r.lastScene = { tags };
    s.update(mid(4));
    const shown = s.shown().filter((k) => k.className === 'maplabel ml-tag');
    assert.equal(shown.length, 3);
    assert.ok(shown.some((k) => k.text === 'drain'));
  });

  test('shown even while names are hidden; street names keep 40 px away', () => {
    const s = stage(false);
    s.r.lastScene = { tags };
    s.update(mid(4), true);
    assert.equal(s.shown().filter((k) => k.className === 'maplabel ml-tag').length, 5);
    assert.equal(s.shown().filter((k) => k.className !== 'maplabel ml-tag').length, 0);
    s.update(mid(4));
    const tagEls = s.shown().filter((k) => k.className === 'maplabel ml-tag');
    for (const k of s.shown().filter((e) => e.className.includes('ml-street'))) {
      const [x, y] = k.at;
      for (const t of tagEls) assert.ok(Math.hypot(x - t.at[0], y - t.at[1]) > 40, `${k.text} next to ${t.text}`);
    }
  });

  test('numbered end tags all show, with their numbers', () => {
    const s = stage(true);
    s.r.lastScene = { tags: tags.slice(0, 5).map((t, i) => ({ ...t, n: t.tone === 'creek' ? undefined : i + 1 })) };
    s.update(mid(4));
    const shown = s.shown().filter((k) => k.className === 'maplabel ml-tag');
    assert.ok(shown.length >= 4);
    assert.ok(shown.filter((k) => k.innerHTML.includes('ml-tag-n')).length >= 3);
  });
});

describe('placing again', () => {
  test('nothing is touched when nothing moved; one art px of panning places again', () => {
    const s = stage(false);
    s.update(mid(2));
    const writes = () => s.kids.reduce((n, k) => n + k.writes, 0);
    const w0 = writes();
    s.update(mid(2));
    s.update({ ...mid(2), x: 1500.4 });
    assert.equal(writes(), w0);
    s.update({ ...mid(2), x: 1502 });
    assert.ok(writes() > w0);
  });

  test('every label is a map label with its own kind class', () => {
    const s = stage(false);
    for (const m of [2, 6]) s.update(mid(m));
    s.r.lastScene = { tags: [{ at: [1500, 1500], text: '112th Ave E', tone: 'street' }] };
    s.update(mid(2));
    for (const k of s.kids) assert.match(k.className, /^maplabel ml-(street|water|town|hood|place|region|city|peak|sea|tag|nomap)( ml-here)?$/);
  });
});
