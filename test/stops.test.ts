/** stop detection on hand-made speed profiles, car drives due north */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSignals } from '../src/drive/signal.ts';
import { detectStops } from '../src/drive/stops.ts';
import type { Fix } from '../src/drive/types.ts';
import { localProjection } from '../src/geo/geo.ts';

const P = localProjection();

/** samples [seconds, accel] phases each second from v0 */
function profile(v0: number, phases: [number, number][]): Fix[] {
  const fixes: Fix[] = [];
  let v = v0;
  let y = 0;
  let t = 0;
  const push = () => {
    const [lon, lat] = P.toLngLat([0, y]);
    fixes.push({ t: Date.UTC(2026, 9, 17) + t * 1000, lat, lon, speed: v });
  };
  push();
  for (const [secs, a] of phases) {
    // 10 ms steps keep speed and position exact
    for (let k = 0; k < secs * 100; k++) {
      const dv = Math.max(-v, a * 0.01);
      y += (v + dv / 2) * 0.01;
      v += dv;
      if ((k + 1) % 100 === 0) {
        t++;
        push();
      }
    }
  }
  return fixes;
}

describe('stop detection', () => {
  test('a hard stop and a gentle stop are measured', () => {
    const fixes = profile(13.4, [[10, 0], [13.4 / 3, -3], [8, 0], [9, 1.5], [20, 0], [13.4, -1], [8, 0]]);
    const stops = detectStops(buildSignals(fixes));
    assert.equal(stops.length, 2);
    assert.ok(Math.abs(stops[0].peakDecel - 3) < 0.35, `${stops[0].peakDecel}`);
    assert.ok(stops[0].hard);
    assert.ok(Math.abs(stops[1].peakDecel - 1) < 0.2, `${stops[1].peakDecel}`);
    assert.ok(!stops[1].hard);
  });

  test('earlier braking followed by a crawl in traffic is not credited to the final stop', () => {
    // cruise 15 m/s, brake hard to 4, crawl a minute, ease to 0.5 m/s² halt
    const fixes = profile(15, [[10, 0], [11 / 3, -3], [60, 0], [8, -0.5], [10, 0]]);
    const stops = detectStops(buildSignals(fixes));
    assert.equal(stops.length, 1);
    assert.ok(!stops[0].hard, `peak ${stops[0].peakDecel}`);
    assert.ok(stops[0].entrySpeed < 5, `entry ${stops[0].entrySpeed}`);
    assert.ok(stops[0].brakingM < 30, `braking ${stops[0].brakingM} m`);
  });

  test('slowing down without stopping is not a stop', () => {
    const fixes = profile(15, [[10, 0], [4, -2.5], [20, 0], [4, 2], [10, 0]]);
    assert.equal(detectStops(buildSignals(fixes)).length, 0);
  });

  test('a stop must start from driving speed', () => {
    // creeping at 3 m/s in a parking lot is not a stop
    const fixes = profile(3, [[20, 0], [3, -1], [10, 0]]);
    assert.equal(detectStops(buildSignals(fixes)).length, 0);
  });
});
