// GPX read/write. Regex reader instead of an XML lib, so it runs the same in browsers and Node.
// Reads <trkpt> (else <rtept>) with <time>, plus speed/course if present.
import type { Fix } from './types.ts';

export class GpxError extends Error {}

const attr = (tag: string, name: string): number => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(tag);
  return m ? Number.parseFloat(m[1]) : Number.NaN;
};

// tag with or without a namespace prefix
const child = (body: string, name: string): string | null => {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w.-]+:)?${name}>`).exec(body);
  return m ? m[1].trim() : null;
};

export function parseGPX(xml: string): Fix[] {
  if (!/<gpx[\s>]/.test(xml)) throw new GpxError("This doesn't look like a GPX file.");
  // drop xml comments, they can hide points
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const tagName of ['trkpt', 'rtept']) {
    const re = new RegExp(`<${tagName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tagName}>)`, 'g');
    const fixes: Fix[] = [];
    let missingTime = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const lat = attr(m[1], 'lat');
      const lon = attr(m[1], 'lon');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const body = m[2] ?? '';
      const time = child(body, 'time');
      const t = time ? Date.parse(time) : Number.NaN;
      if (!Number.isFinite(t)) {
        missingTime++;
        continue;
      }
      const speed = child(body, 'speed');
      const course = child(body, 'course');
      const fix: Fix = { t, lat, lon };
      if (speed !== null && Number.isFinite(Number.parseFloat(speed))) fix.speed = Number.parseFloat(speed);
      if (course !== null && Number.isFinite(Number.parseFloat(course))) fix.heading = Number.parseFloat(course);
      fixes.push(fix);
    }
    if (fixes.length) return fixes;
    if (missingTime) throw new GpxError('This GPX file has no timestamps, so speeds and stops can\'t be worked out.');
  }
  throw new GpxError('This GPX file has no track points.');
}

// speed/course go in Garmin TrackPointExtension
export function writeGPX(fixes: readonly Fix[], name = 'TireTrail drive', opts: { speed?: boolean } = {}): string {
  const withSpeed = opts.speed ?? true;
  const pts = fixes
    .map((f) => {
      const ext: string[] = [];
      if (withSpeed && typeof f.speed === 'number') ext.push(`<gpxtpx:speed>${f.speed.toFixed(2)}</gpxtpx:speed>`);
      if (withSpeed && typeof f.heading === 'number') ext.push(`<gpxtpx:course>${f.heading.toFixed(1)}</gpxtpx:course>`);
      const extensions = ext.length ? `<extensions><gpxtpx:TrackPointExtension>${ext.join('')}</gpxtpx:TrackPointExtension></extensions>` : '';
      return `<trkpt lat="${f.lat.toFixed(7)}" lon="${f.lon.toFixed(7)}"><time>${new Date(f.t).toISOString()}</time>${extensions}</trkpt>`;
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="TireTrail" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">',
    `<trk><name>${name.replace(/[<&>]/g, '')}</name><trkseg>`,
    pts,
    '</trkseg></trk>',
    '</gpx>',
  ].join('\n');
}
