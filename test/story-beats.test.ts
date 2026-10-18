/** See it happen: the beats, the cameras, the tags and the words */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUNDLE_FORMAT, BUNDLE_VERSION, encodeCoords, type Bundle } from '../src/data/bundle.ts';
import { TireTrailData } from '../src/data/tiretrail.ts';
import { localProjection, type XY } from '../src/geo/geo.ts';
import type { Cam, Tag } from '../src/app/map/render.ts';
import { BEAT, Story, words, tagWords, dest, type StoryInput } from '../src/app/map/story.ts';
import { World } from '../src/app/map/world.ts';

const P = localProjection();
const enc = (pts: XY[]) => encodeCoords(pts.map((p) => P.toLngLat([p[0], -p[1]])));

// a street running east, and a salmon creek 20 m past where the pipes end
function world(): World {
  const bundle = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, credits: [], disclaimer: '', sources: {},
    assets: { key: ['CB-1'], kind: [1], geom: [enc([[0, 0]])] },
    pondShapes: [], next: [-1],
    endings: [{ code: 'outfall-creek', cls: 0, confidence: 0, terminal: 0, exit: 0, receiving: 'Fennel Creek', reason: '' }],
    drains: { asset: [0], ending: [0], explicitPaths: {} },
    streets: {
      pieces: [{ id: 0, name: 'Test Ave E', lengthM: 0, cls: 0, terrainCls: 0, terrainName: '' }],
      runs: { piece: [0], drain: [0], cls: [0], geom: [enc([[-60, 0], [60, 0]])] },
    },
    waters: [{ name: 'Fennel Creek', kind: 'creek', fennel: true, lines: [enc([[220, -200], [220, 200]])], rings: [] }],
    fixList: [], numbers: {},
  } as unknown as Bundle;
  return new World(new TireTrailData(bundle));
}

const W = world();
const street: XY[] = [[-60, 0], [60, 0]];
// 300 m of pipe: south 100 m, then east 200 m, ending 20 m short of the creek
const path: XY[] = [[0, 0], [0, 100], [100, 100], [200, 100]];
const input = (o: Partial<StoryInput> = {}): StoryInput => ({
  path, street, cls: 'creek', code: 'outfall-creek', focusY: 0.55, viewW: 480, viewH: 280, bandH: 240, side: 0,
  name: 'Test Ave E', receiving: 'Fennel Creek', owner: 'city', phone: false, ...o,
});
const FROM: Cam = { x: 5000, y: -3000, mpp: 6 };

/** where p lands on the canvas, art px */
const onCanvas = (inp: StoryInput, cam: Cam, p: XY): XY => [(p[0] - cam.x) / cam.mpp + inp.viewW / 2, (p[1] - cam.y) / cam.mpp + inp.viewH / 2];
/** p sits in the open band: right of the laptop card, between the caption and the card */
function inBand(inp: StoryInput, cam: Cam, p: XY): boolean {
  const [x, y] = onCanvas(inp, cam, p), side = inp.side ?? 0;
  const mid = inp.focusY * inp.viewH;
  return x >= 2 * side - 0.5 && x <= inp.viewW + 0.5 && y >= mid - inp.bandH / 2 - 0.5 && y <= mid + inp.bandH / 2 + 0.5;
}
const strip = (html: string) => html.replace(/<[^>]+>/g, '');

describe('beats', () => {
  test('run in order with the planned lengths: the whole trip, rain, drain, pipes, end, pull back', () => {
    const s = new Story(W, input(), FROM, 0), b = s.beats;
    assert.equal(b.rain, BEAT.pro);
    assert.equal(b.drain - b.rain, BEAT.zoom + BEAT.rain);
    assert.equal(b.pipes - b.drain, BEAT.dis);
    assert.equal(b.end - b.pipes, 300 * 16);
    assert.equal(b.back - b.end, 1300);
    assert.equal(b.rest - b.back, 1000);
    const steps: number[] = [];
    for (let t = 0; t <= b.rest + 500; t += 50) { const k = s.frame(t).step; if (steps[steps.length - 1] !== k) steps.push(k); }
    assert.deepEqual(steps, [0, 1, 2, 3, 4]);
    assert.equal(s.frame(b.rest + 10).ended, true);
    assert.equal(s.frame(b.rest - 10).ended, false);
  });

  test('travel time is clamped between 2.6 and 6 s', () => {
    const short = new Story(W, input({ path: [[0, 0], [0, 50]] }), FROM, 0).beats;
    assert.equal(short.end - short.pipes, 2600);
    const long = new Story(W, input({ path: [[0, 0], [0, 900]] }), FROM, 0).beats;
    assert.equal(long.end - long.pipes, 6000);
  });

  test('the dissolve runs during beat 2 and fades out on the way back', () => {
    const s = new Story(W, input(), FROM, 0), b = s.beats;
    assert.equal(s.frame(b.drain - 10).scene.dissolve ?? 0, 0);
    const mid = s.frame((b.drain + b.pipes) / 2).scene.dissolve!;
    assert.ok(mid > 0 && mid < 1);
    assert.equal(s.frame(b.pipes + 100).scene.dissolve, 1);
    assert.equal(s.frame(b.rest + 10).scene.dissolve, 0);
  });

  test('the highlight is steady: no blinking clock in any frame', () => {
    const s = new Story(W, input(), FROM, 0);
    for (let t = 0; t < s.beats.rest + 200; t += 100) assert.equal(s.frame(t).scene.flash, undefined);
  });

  test('a path under 2 m skips the whole-trip beat and the travel, so a dry well ends in about 3 s', () => {
    const s = new Story(W, input({ path: [[0, 0]], cls: 'ground', code: 'drywell', receiving: '' }), FROM, 0);
    assert.equal(s.tiny, true);
    assert.equal(s.frame(0).step, 1);
    assert.ok(s.beats.end <= 3100, `step 4 at ${s.beats.end} ms`);
    assert.equal(s.frame(s.beats.end + 1).step, 4);
    for (let t = 0; t < s.beats.rest; t += 50) assert.notEqual(s.frame(t).step, 3);
  });
});

describe('cameras', () => {
  const ends = (s: Story) => [street[0], street[1], path[0], path[path.length - 1]];

  test('the whole trip opens and closes the story, inside the open band', () => {
    for (const side of [0, 70]) {
      const inp = input({ side }), s = new Story(W, inp, FROM, 0);
      for (const t of [BEAT.proFly + 10, s.beats.rest + 10]) {
        const cam = s.frame(t).cam!;
        for (const p of ends(s)) assert.ok(inBand(inp, cam, p), `side ${side} t ${t}: ${p} at ${onCanvas(inp, cam, p)}`);
      }
      // the water is in the end view too
      const w = s.frame(s.beats.rest + 10).scene.ending!.at;
      assert.ok(inBand(inp, s.frame(s.beats.rest + 10).cam!, w));
    }
  });

  test('the prologue glides from where the camera was', () => {
    const s = new Story(W, input(), FROM, 0), c = s.frame(0).cam!;
    assert.ok(Math.abs(c.x - FROM.x) < 1e-6 && Math.abs(c.y - FROM.y) < 1e-6 && Math.abs(c.mpp - FROM.mpp) < 1e-9);
  });

  test('on a laptop the drop stays right of the card while it travels', () => {
    const inp = input({ side: 70 }), s = new Story(W, inp, FROM, 0), b = s.beats;
    for (let t = b.pipes; t < b.end; t += 40) {
      const f = s.frame(t), [x] = onCanvas(inp, f.cam!, f.scene.drop!);
      assert.ok(x >= 2 * 70, `drop at ${x}`);
      assert.ok(Math.abs(x - (inp.viewW / 2 + 70)) < 1e-6);
    }
  });

  test('skipToEnd jumps to the end at once and lands on the whole trip within a second', () => {
    const s = new Story(W, input(), FROM, 0), b = s.beats, now = b.rain + 300;
    const cur = s.frame(now).cam!;
    s.skipToEnd(now, cur);
    const f = s.frame(now + 16);
    assert.equal(f.step, 4);
    assert.ok(f.scene.ending?.rest);
    const done = s.frame(now + BEAT.skip), rest = new Story(W, input(), FROM, 0).frame(1e6).cam!;
    assert.equal(done.ended, true);
    assert.ok(Math.abs(done.cam!.x - rest.x) < 1e-6 && Math.abs(done.cam!.y - rest.y) < 1e-6 && Math.abs(done.cam!.mpp - rest.mpp) < 1e-9);
  });

  test('skipToEnd from under the street fades the dissolve out', () => {
    const s = new Story(W, input(), FROM, 0), now = s.beats.pipes + 500;
    s.skipToEnd(now, s.frame(now).cam!);
    assert.equal(s.frame(now).scene.dissolve, 1);
    assert.equal(s.frame(now + BEAT.skip * .5).scene.dissolve, 0);
  });
});

describe('scenes and tags', () => {
  const texts = (tags: Tag[] | null | undefined) => (tags ?? []).map((t) => t.text);

  test('the whole-trip beat draws the trip and names the street and the creek', () => {
    const s = new Story(W, input(), FROM, 0), f = s.frame(200);
    assert.ok(f.scene.trip);
    assert.equal(f.scene.trip!.end, 'salmon');
    assert.deepEqual(texts(f.scene.tags), ['Test Ave E', 'Fennel Creek']);
    assert.equal(f.scene.tags![1].fish, true);
  });

  test('beat 1 names the storm drain at the drain', () => {
    const s = new Story(W, input(), FROM, 0), f = s.frame(s.beats.rain + 1500);
    const drain = f.scene.tags!.find((t) => t.text === 'storm drain')!;
    assert.deepEqual(drain.at, path[0]);
    assert.equal(drain.tone, 'drain');
  });

  test('underground, things are named as the drop reaches them and gone 1.6 s later', () => {
    const marks = [{ kind: 'pipe' as const, at: path[0], mid: [0, 50] as XY }, { kind: 'manhole' as const, at: path[1] }, { kind: 'pipe' as const, at: path[1] }, { kind: 'outfall' as const, at: path[3] }];
    const s = new Story(W, input({ marks }), FROM, 0), b = s.beats;
    const at = (t: number) => texts(s.frame(t).scene.tags);
    assert.deepEqual(at(b.pipes + 50), ['Test Ave E is above', 'pipe']);
    assert.deepEqual(at(b.pipes + BEAT.tag + 50).includes('pipe'), false);
    let first = -1;
    for (let t = b.pipes; t < b.end; t += 20) if (first < 0 && at(t).includes('manhole, where pipes meet')) first = t;
    // the manhole is 100 m into 300 m of pipe
    const prog = (k: number) => s.frame(k).prog;
    assert.ok(first > 0 && Math.abs(prog(first) - 1 / 3) < 0.02, `manhole named at prog ${prog(first)}`);
    assert.ok(at(b.end + 200).includes('outfall, where the pipe empties'));
  });

  test('at rest: the steps are numbered, the ending stays, the street is lit again', () => {
    const marks = [{ kind: 'pipe' as const, at: path[0] }, { kind: 'tank' as const, at: path[2] }];
    const s = new Story(W, input({ marks }), FROM, 0), f = s.frame(s.beats.rest + 100);
    assert.deepEqual(f.scene.tags!.map((t) => `${t.n} ${t.text}`), ['1 Test Ave E', '2 storm drain', '3 980 ft of pipe', '4 underground tank', '5 Fennel Creek']);
    assert.deepEqual(f.scene.ending && { kind: f.scene.ending.kind, rest: f.scene.ending.rest }, { kind: 'salmon', rest: true });
    assert.deepEqual(f.scene.highlight, street);
    assert.ok(f.scene.trail && f.scene.trail.prog === 1);
  });

  test('a soak ending rests as a wet patch, and the gap ending as its marker', () => {
    const soak = new Story(W, input({ cls: 'ground', code: 'perforated-pipe', receiving: '' }), FROM, 0).frame(1e6).scene;
    assert.equal(soak.ending?.kind, 'soak');
    assert.ok(soak.ending!.rest && soak.ending!.t > 0 && soak.ending!.t < 1);
    assert.equal(soak.tags!.at(-1)!.text, 'soaks in here');
    const gap = new Story(W, input({ cls: 'unknown', code: 'dead-end', receiving: '' }), FROM, 0).frame(1e6).scene;
    assert.equal(gap.ending?.kind, 'stop');
    assert.equal(gap.tags!.at(-1)!.text, 'map stops here');
  });

  test('the sewer ending has no end mark but its own tag', () => {
    const s = new Story(W, input({ cls: 'treatment', code: 'combined-sewer', receiving: '' }), FROM, 0);
    assert.equal(s.frame(1e6).scene.ending, null);
    assert.equal(s.frame(200).scene.trip!.end, 'plant');
    const last = s.frame(1e6).scene.tags!.at(-1)!;
    assert.deepEqual([last.text, last.tone], ['sewer pipe to a treatment plant', 'treatment']);
  });

  test('phones get the short tag words', () => {
    const f = new Story(W, input({ phone: true }), FROM, 0).frame(1e6);
    assert.deepEqual(texts(f.scene.tags), ['Test Ave E', 'drain', 'pipes', 'Fennel Creek']);
  });

  test('a story with no street still numbers the rest', () => {
    const f = new Story(W, input({ street: null }), FROM, 0).frame(1e6);
    assert.deepEqual(f.scene.tags!.map((t) => t.n), [1, 2, 3]);
  });
});

describe('reduced motion', () => {
  test('four still steps on one camera, with no dissolve', () => {
    const s = new Story(W, input({ side: 70 }), FROM, 0), cams = [1, 2, 3, 4].map((k) => s.still(k));
    assert.deepEqual(cams.map((f) => f.step), [1, 2, 3, 4]);
    for (const f of cams) {
      assert.deepEqual(f.cam, cams[0].cam);
      assert.equal(f.scene.dissolve ?? 0, 0);
      assert.equal(f.scene.rain, undefined);
      assert.equal(f.scene.drop, undefined);
    }
    assert.equal(cams[2].scene.trail?.prog, 1);
    assert.ok(cams[3].scene.ending?.rest);
    assert.ok(cams[3].scene.tags!.every((t) => t.n));
  });
});

describe('words', () => {
  const w = (o: Partial<Parameters<typeof words>[0]>) => words({ name: '214th Ave E', cls: 'creek', code: 'outfall-creek', receiving: 'Fennel Creek', lengthM: 548.6, owner: 'city', ...o });
  const plain = (o: Partial<Parameters<typeof words>[0]>) => { const x = w(o); return { pro: strip(x.pro), rain: strip(x.rain), drain: x.drain, pipes: x.pipes, end: strip(x.end) }; };

  test('the planned captions, salmon stream', () => {
    assert.deepEqual(plain({}), {
      pro: 'From 214th Ave E to Fennel Creek: about 1,800 ft.',
      rain: 'Rain washes tire dust off 214th Ave E toward the storm drain at the curb.',
      drain: "It pours into the storm drain. Now you're looking under the street.",
      pipes: 'Gray tubes are storm pipes. The blue dot is the rain, running downhill.',
      end: 'It reaches Fennel Creek, where coho salmon live.',
    });
    assert.equal(plain({ code: 'pond-to-creek' }).end, 'It flows into a pond, then on to Fennel Creek, where coho salmon live.');
  });

  test('the whole-trip line for a map gap and a soak', () => {
    assert.equal(plain({ cls: 'unknown', code: 'dead-end', receiving: '', lengthM: 326.1 }).pro, 'From 214th Ave E, TireTrail can follow the rain 1,070 ft.');
    assert.equal(plain({ cls: 'ground', code: 'drywell', receiving: '', lengthM: 365.8 }).pro, 'From 214th Ave E to where it soaks in: about 1,200 ft.');
    assert.equal(plain({ lengthM: 4000 }).pro, 'From 214th Ave E to Fennel Creek: about 2.5 mi.');
  });

  test('endings by kind', () => {
    assert.equal(plain({ cls: 'ground', code: 'drywell', receiving: '', tiny: true }).end, 'It soaks into the ground right at the drain.');
    assert.equal(plain({ cls: 'ground', code: 'infiltration-pond', receiving: '' }).end, 'It flows into a pond built to let it soak into the ground.');
    assert.equal(plain({ cls: 'ground', code: 'perforated-pipe', receiving: '' }).end, 'It soaks into the ground here.');
    assert.equal(plain({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving: 'Lake Tapps' }).end, 'It ends up in Lake Tapps.');
    assert.equal(plain({ cls: 'unknown', code: 'dead-end', receiving: '' }).end, 'Here the pipe map stops, so TireTrail stops too.');
    assert.equal(plain({ cls: 'treatment', code: 'combined', receiving: '' }).end, 'It joins a sewer pipe that goes to a sewage treatment plant.');
  });

  test('salmon claims only where coho live', () => {
    assert.equal(plain({ receiving: 'Fennel Creek tributary (unnamed)', code: 'stream-creek' }).end, 'It reaches a stream that feeds Fennel Creek, where coho salmon live.');
    assert.equal(plain({ receiving: 'Debra Jane Lake' }).end, 'It reaches Debra Jane Lake, which drains to Fennel Creek.');
    assert.equal(plain({ receiving: 'Unnamed coho stream' }).end, 'It reaches a small salmon stream with no name on the map.');
    assert.equal(plain({ receiving: 'Puyallup River' }).end, 'It reaches Puyallup River, where coho salmon live.');
    assert.equal(plain({ receiving: 'White River', code: 'downstream-creek' }).end, 'It reaches a smaller stream that runs into White River, where coho salmon live.');
    assert.equal(plain({ cls: 'elsewhere', code: 'outfall-elsewhere', receiving: 'Fennel Creek' }).end, 'It ends up in Fennel Creek.');
    assert.equal(dest('creek', 'stream-creek', 'Debra Jane Lake').fish, false);
    assert.equal(dest('creek', 'outfall-creek', 'Fennel Creek').fish, true);
  });

  test('unnamed water gets plain words', () => {
    assert.equal(plain({ cls: 'elsewhere', code: 'stream-elsewhere', receiving: 'unnamed stream' }).end, 'It ends up in a small stream with no name on the map.');
    assert.equal(plain({ cls: 'elsewhere', code: 'stream-elsewhere', receiving: 'an unnamed lake or pond' }).end, 'It ends up in a small lake or pond with no name on the map.');
    assert.equal(plain({ cls: 'elsewhere', code: 'stream-elsewhere', receiving: '' }).end, 'It ends up in other water nearby.');
  });

  test('the step list names whose pipes', () => {
    assert.equal(w({}).steps[2], "It runs through the city's pipes");
    assert.equal(w({ owner: 'county' }).steps[2], "It runs through the county's pipes");
    assert.equal(w({ owner: null }).steps[2], 'It runs through the storm pipes');
    assert.deepEqual([w({}).steps[0], w({}).steps[1], w({}).steps[3]], ['Rain washes tire dust off 214th Ave E', 'It pours into a storm drain', 'Where it ends up']);
  });

  test('reduced motion never claims a view under the street', () => {
    const c = w({ calm: true });
    assert.ok(!/looking under|blue dot/i.test(c.drain + c.pipes));
  });

  test('a drive stop keeps its own first line', () => {
    assert.equal(w({ intro: 'Rain washes the tire dust from stop 2 off <b>Main St</b>.' }).rain, 'Rain washes the tire dust from stop 2 off <b>Main St</b>.');
  });

  test('names are escaped in the captions', () => {
    assert.ok(w({ name: 'A<b>' }).rain.includes('A&#60;b&#62;'));
  });

  test('the pond hop tag names whose map says so', () => {
    assert.equal(tagWords({ name: 'X', cls: 'creek', code: 'pond-to-creek', receiving: 'Fennel Creek', lengthM: 10, owner: 'county' }).hop, 'the county lists this pond as draining here');
    assert.equal(tagWords({ name: 'X', cls: 'creek', code: 'outfall-creek', receiving: 'Fennel Creek', lengthM: 10 }).hop, null);
  });

  test('no em or en dashes anywhere the story speaks', () => {
    const all: string[] = [];
    for (const cls of ['creek', 'ground', 'elsewhere', 'unknown', 'treatment']) for (const code of ['outfall-creek', 'pond-to-creek', 'drywell', 'downstream-creek']) {
      for (const calm of [false, true]) { const x = w({ cls, code, calm }); all.push(x.pro, x.rain, x.drain, x.pipes, x.end, ...x.steps); }
      for (const phone of [false, true]) { const t = tagWords({ name: 'X', cls, code, receiving: 'Fennel Creek', lengthM: 100, phone }); all.push(t.street, t.drain, t.pipe, t.above, t.hop ?? '', t.dest.text, ...Object.values(t.marks)); }
    }
    for (const s of all) assert.ok(!/[–—]/.test(s), s);
  });
});
