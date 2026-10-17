import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  dist,
  distanceToPolygons,
  GridIndex,
  localProjection,
  nearestOnPolyline,
  pointAlong,
  pointInPolygon,
  polygonsArea,
  polygonsCentroid,
  slicePolyline,
  type XY,
} from '../src/geo/geo.ts';

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

/** Vincenty inverse, WGS84, meters */
function vincenty([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * rad));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * rad));
  const [sU1, cU1, sU2, cU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lambda = L;
  let sinS = 0;
  let cosS = 0;
  let sigma = 0;
  let cos2a = 0;
  let cos2sm = 0;
  for (let i = 0; i < 100; i++) {
    const sl = Math.sin(lambda);
    const cl = Math.cos(lambda);
    sinS = Math.hypot(cU2 * sl, cU1 * sU2 - sU1 * cU2 * cl);
    cosS = sU1 * sU2 + cU1 * cU2 * cl;
    sigma = Math.atan2(sinS, cosS);
    const sinA = (cU1 * cU2 * sl) / sinS;
    cos2a = 1 - sinA * sinA;
    cos2sm = cos2a === 0 ? 0 : cosS - (2 * sU1 * sU2) / cos2a;
    const C = (f / 16) * cos2a * (4 + f * (4 - 3 * cos2a));
    const next = L + (1 - C) * f * sinA * (sigma + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)));
    if (Math.abs(next - lambda) < 1e-12) break;
    lambda = next;
  }
  const u2 = (cos2a * (a * a - b * b)) / (b * b);
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma =
    B * sinS * (cos2sm + (B / 4) * (cosS * (-1 + 2 * cos2sm * cos2sm) - (B / 6) * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)));
  return b * A * (sigma - dSigma);
}

describe('local projection', () => {
  const P = localProjection();

  test('round-trips lon/lat', () => {
    const [lon, lat] = P.toLngLat(P.toXY([-122.2, 47.19]));
    close(lon, -122.2, 1e-12);
    close(lat, 47.19, 1e-12);
  });

  test('matches the WGS84 ellipsoid distance across the city to within 0.1%', () => {
    for (const [a, b] of [
      [[-122.25, 47.14], [-122.15, 47.2]],
      [[-122.22, 47.13], [-122.22, 47.21]],
      [[-122.26, 47.17], [-122.1, 47.17]],
    ] as [number, number][][]) {
      const truth = vincenty(a, b);
      const flat = dist(P.toXY(a as [number, number]), P.toXY(b as [number, number]));
      assert.ok(Math.abs(flat - truth) / truth < 0.001, `${flat} vs ${truth}`);
    }
  });
});

describe('lines', () => {
  const L: XY[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];

  test('nearest point, distance and distance along', () => {
    const on = nearestOnPolyline([12, 5], L);
    close(on.d, 2);
    close(on.along, 15);
    assert.deepEqual(on.point, [10, 5]);
  });

  test('point along and slices', () => {
    assert.deepEqual(pointAlong(L, 5), [5, 0]);
    assert.deepEqual(pointAlong(L, 99), [10, 10]);
    assert.deepEqual(slicePolyline(L, 5, 15), [
      [5, 0],
      [10, 0],
      [10, 5],
    ]);
  });
});

describe('polygons', () => {
  const outer: XY[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole: XY[] = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
  ];

  test('inside test respects holes', () => {
    assert.equal(pointInPolygon([2, 2], [outer, hole]), true);
    assert.equal(pointInPolygon([5, 5], [outer, hole]), false);
    assert.equal(pointInPolygon([12, 5], [outer, hole]), false);
  });

  test('distance is 0 inside and edge distance outside', () => {
    assert.equal(distanceToPolygons([2, 2], [[outer]]), 0);
    close(distanceToPolygons([13, 5], [[outer]]), 3);
  });

  test('centroid and area', () => {
    assert.deepEqual(polygonsCentroid([[outer]]), [5, 5]);
    close(polygonsArea([[outer, hole]]), 96);
  });
});

describe('grid index', () => {
  test('returns every point within the radius (checked against brute force)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2000 - 1000;
    const pts: XY[] = Array.from({ length: 2000 }, () => [rand(), rand()]);
    const index = new GridIndex<number>(37);
    pts.forEach((p, i) => index.insertPoint(i, p));
    for (let q = 0; q < 50; q++) {
      const c: XY = [rand(), rand()];
      const r = 20 + (q % 5) * 30;
      const got = index.near(c, r).filter((i) => dist(pts[i], c) <= r).sort((a, b) => a - b);
      const want = pts.map((p, i) => [p, i] as const).filter(([p]) => dist(p, c) <= r).map(([, i]) => i);
      assert.deepEqual(got, want);
    }
  });
});
