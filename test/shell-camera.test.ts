/** shell: camera taps, limits and flights, with a fake canvas and pointer events */
import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import type { XY } from '../src/geo/geo.ts';
import { CameraCtl, capMpp, EDGE, GHOST, inBox, SLOP, TAP_MS, type Box, type Open } from '../src/app/map/camera.ts';
import type { Cam, Renderer } from '../src/app/map/render.ts';

const US: Box = { x0: 0, y0: 0, x1: 4000, y1: 3000 };

// a 300 x 600 CSS px canvas at 3 CSS px per art px, drawn at its own size
function rig(start: Cam = { x: 0, y: 0, mpp: 2 }) {
  const on = new Map<string, (e: unknown) => void>();
  const el = { addEventListener: (k: string, f: (e: unknown) => void) => on.set(k, f), setPointerCapture: () => {} } as unknown as HTMLElement;
  const canvas = { offsetWidth: 300, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 600 }) };
  const r = {
    AW: 100, AH: 200, canvas,
    toWorld: (c: Cam, x: number, y: number): XY => [c.x + (x / 3 - 50) * c.mpp, c.y + (y / 3 - 100) * c.mpp],
  } as unknown as Renderer;
  const taps: XY[] = [];
  const cam = new CameraCtl(el, r, start, (p) => taps.push(p), () => now);
  const ev = (type: string, x: number, y: number, pointerType = 'touch', pointerId = 1) => on.get(type)!({ type, clientX: x, clientY: y, pointerType, pointerId, preventDefault() {} });
  return { cam, taps, ev };
}

let now = 0;
const clock = mock.method(performance, 'now', () => now);

describe('taps', () => {
  test('a finger can slide 9 px and press 700 ms and still tap', () => {
    const { taps, ev } = rig();
    now = 1000;
    ev('pointerdown', 100, 100);
    ev('pointermove', 105, 102);
    ev('pointermove', 109, 100);
    now = 1700;
    ev('pointerup', 109, 100);
    assert.equal(taps.length, 1);
    assert.ok(SLOP.touch >= 10 && TAP_MS >= 800);
  });

  test('a mouse that moves more than 6 px drags instead', () => {
    const { cam, taps, ev } = rig();
    now = 0;
    ev('pointerdown', 100, 100, 'mouse');
    ev('pointermove', 108, 100, 'mouse');
    ev('pointerup', 108, 100, 'mouse');
    assert.equal(taps.length, 0);
    assert.ok(cam.userMoved);
  });

  test('a press longer than the limit is not a tap, and a cancelled press never is', () => {
    const { taps, ev } = rig();
    now = 0;
    ev('pointerdown', 50, 50);
    now = TAP_MS + 1;
    ev('pointerup', 50, 50);
    now = 2000;
    ev('pointerdown', 50, 50);
    ev('pointercancel', 50, 50);
    assert.equal(taps.length, 0);
  });

  test("the browser's click right after a map tap is a ghost; a later or farther one is real", () => {
    const { cam, ev } = rig();
    now = 5000;
    ev('pointerdown', 200, 300);
    ev('pointerup', 200, 300);
    const click = (x: number, y: number, detail = 1) => ({ clientX: x, clientY: y, detail }) as MouseEvent;
    now = 5000 + GHOST.ms - 50;
    assert.ok(cam.ghost(click(210, 310)));
    assert.ok(!cam.ghost(click(200 + GHOST.px, 300)));
    // a keyboard click has no pointer
    assert.ok(!cam.ghost(click(200, 300, 0)));
    now = 5000 + GHOST.ms + 1;
    assert.ok(!cam.ghost(click(200, 300)));
  });
});

describe('limits', () => {
  test('far out the open part stays over the box (up to a 4% edge), and is centered where it is wider', () => {
    const o: Open = { cx: 10, cy: -5, w: 100, h: 60 };
    // view 1000 x 600 m at mpp 10: free to move east and west, pinned near the box edges
    const [x] = inBox(-9999, 1500, 10, US, o);
    assert.ok(Math.abs(x + o.cx * 10 - 500 - (US.x0 - EDGE * 1000)) < 1e-9);
    const [x2] = inBox(9999, 1500, 10, US, o);
    assert.ok(Math.abs(x2 + o.cx * 10 + 500 - (US.x1 + EDGE * 1000)) < 1e-9);
    // at mpp 100 the view is 10000 m wide: the box sits in its middle
    const [x3, y3] = inBox(123, 456, 100, US, o);
    assert.equal(x3 + o.cx * 100, 2000);
    assert.equal(y3 + o.cy * 100, 1500);
  });

  test('the widest zoom fills 92% of a tall open area with the box height, else fits the whole box', () => {
    const tall: Open = { cx: 0, cy: 0, w: 100, h: 300 };
    assert.equal(capMpp(US, tall), 3000 / (300 * 0.92));
    const wide: Open = { cx: 0, cy: 0, w: 400, h: 200 };
    const m = capMpp(US, wide);
    assert.ok(400 * m >= 4000 && 200 * m >= 3000);
    assert.ok(Math.abs(Math.max(4000 / (400 * m), 3000 / (200 * m)) - 0.92) < 1e-9);
  });

  test('up close a flight lands in the wander box, unless the camera is already farther out', () => {
    const { cam } = rig({ x: 0, y: 0, mpp: 6 });
    cam.wander = { x0: -100, y0: -100, x1: 100, y1: 100 };
    assert.deepEqual(cam.clampTarget(500, 50, 6), [100, 50]);
    // far out, only the country counts
    assert.deepEqual(cam.clampTarget(500, 50, 30), [500, 50]);
    cam.cam = { x: 300, y: 0, mpp: 6 };
    assert.deepEqual(cam.clampTarget(250, 0, 6), [250, 0]);
    assert.deepEqual(cam.clampTarget(400, 0, 6), [300, 0]);
  });

  test('a still camera far out settles inside the limits; up close it is left alone', () => {
    const { cam } = rig({ x: -5000, y: 1500, mpp: 50 });
    cam.limit = US;
    cam.maxMpp = 40;
    cam.settle();
    assert.equal(cam.cam.mpp, 40);
    // the view is as wide as the box: it may slide only by the edge
    assert.ok(Math.abs(cam.cam.x - (2000 - EDGE * 100 * 40)) < 1e-9);
    cam.cam = { x: -5000, y: 0, mpp: 6 };
    cam.settle();
    assert.equal(cam.cam.x, -5000);
  });
});

describe('flights', () => {
  test('a flight lands exactly on its target', () => {
    const { cam } = rig({ x: 0, y: 0, mpp: 400 });
    now = 0;
    cam.flyTo({ x: 1234.5, y: -77, mpp: 6 }, 800);
    cam.tick(400);
    assert.ok(cam.flying);
    cam.tick(800);
    assert.deepEqual(cam.cam, { x: 1234.5, y: -77, mpp: 6 });
    assert.ok(!cam.flying);
  });

  test('the Home button takes the camera from a playing story', () => {
    const { cam } = rig();
    cam.goTo({ x: 10, y: 10, mpp: 6 });
    assert.ok(cam.userMoved && cam.flying);
  });

  test('with less motion asked for, flights jump', () => {
    const { cam } = rig();
    Object.defineProperty(cam, 'calm', { get: () => true });
    cam.flyTo({ x: 9, y: 9, mpp: 3 });
    assert.ok(!cam.flying);
    assert.deepEqual(cam.cam, { x: 9, y: 9, mpp: 3 });
  });
});

after(() => clock.mock.restore());
