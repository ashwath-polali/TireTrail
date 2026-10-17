import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GpxError, parseGPX, writeGPX } from '../src/drive/gpx.ts';

const gpx = (body: string) => `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

describe('GPX', () => {
  test('reads track points with time, and speed/course from GPX 1.0 or extensions', () => {
    const fixes = parseGPX(
      gpx(`<trk><trkseg>
        <trkpt lat="47.17" lon="-122.18"><ele>180</ele><time>2026-10-17T17:00:00Z</time><speed>12.5</speed><course>90</course></trkpt>
        <trkpt lon='-122.1799' lat='47.1701'><time>2026-10-17T17:00:01.000Z</time>
          <extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>12.1</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions></trkpt>
      </trkseg></trk>`),
    );
    assert.equal(fixes.length, 2);
    assert.deepEqual(fixes[0], { t: Date.UTC(2026, 9, 17, 17, 0, 0), lat: 47.17, lon: -122.18, speed: 12.5, heading: 90 });
    assert.equal(fixes[1].speed, 12.1);
    assert.equal(fixes[1].lon, -122.1799);
  });

  test('falls back to route points, and ignores commented-out points', () => {
    const fixes = parseGPX(gpx(`<!-- <trkpt lat="1" lon="1"><time>2020-01-01T00:00:00Z</time></trkpt> -->
      <rte><rtept lat="47.1" lon="-122.2"><time>2026-10-17T17:00:00Z</time></rtept></rte>`));
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].lat, 47.1);
  });

  test('explains files it cannot use', () => {
    assert.throws(() => parseGPX('<kml></kml>'), GpxError);
    assert.throws(() => parseGPX(gpx('<trk><trkseg><trkpt lat="47.1" lon="-122.2"/></trkseg></trk>')), /no timestamps/);
    assert.throws(() => parseGPX(gpx('<trk></trk>')), /no track points/);
  });

  test('writes what it reads', () => {
    const fixes = [
      { t: Date.UTC(2026, 9, 17, 17, 0, 0), lat: 47.1712345, lon: -122.1834567, speed: 13.41, heading: 182.5 },
      { t: Date.UTC(2026, 9, 17, 17, 0, 1), lat: 47.1711, lon: -122.1834, speed: 13.2 },
    ];
    const back = parseGPX(writeGPX(fixes));
    assert.deepEqual(back, fixes);
    const noSpeed = parseGPX(writeGPX(fixes, 'x', { speed: false }));
    assert.equal(noSpeed[0].speed, undefined);
  });
});
