/** Warning levels for the live drive: each rule, the cooldowns, and Sunday's drive with a hard brake by Fennel Creek and a speeding stretch */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ALERT, Alerts, brakeCreek, classify, type Alert, type AlertIn } from '../src/drive/coach/alerts.ts';
import { LiveCoach, type Cue, type CueKind } from '../src/drive/coach/live.ts';
import type { Fix } from '../src/drive/types.ts';
import { toRegion } from '../src/salmon/proj.ts';
import { routeTiles } from '../src/salmon/row.ts';
import { SalmonData } from '../src/salmon/tiles.ts';

const MPH = 0.44704;
const cue = (kind: CueKind, say: string, events?: number[]): AlertIn['cue'] => ({ kind, say, events });
const at = (o: Partial<AlertIn> & { cue: AlertIn['cue'] }): AlertIn => ({ now: 100_000, v: 30 * MPH, limitMph: null, ...o });
const brake = (veryHard = false) => ({ kind: 'brake' as const, veryHard });

describe('alert rules', () => {
  test('a very hard brake is serious, a hard brake caution, a fast start caution', () => {
    assert.equal(classify(at({ cue: cue('hard-brake', 'Very hard brake.', [0]), events: [brake(true)] })).level, 'serious');
    assert.equal(classify(at({ cue: cue('hard-brake', 'Hard brake.', [0]), events: [brake()] })).level, 'caution');
    assert.equal(classify(at({ cue: cue('fast-start', 'Fast start.', [0]), events: [{ kind: 'start', veryHard: false }] })).level, 'caution');
  });

  test('a hard brake near a salmon crossing is serious and names it', () => {
    const c = classify(at({ cue: cue('hard-brake', 'Hard brake.', [0]), events: [brake()], brakeCreek: 'Fennel Creek' }));
    assert.deepEqual([c.level, c.kind, c.line], ['serious', 'brake-near-creek', 'Hard brake near Fennel Creek.']);
    assert.equal(classify(at({ cue: cue('hard-brake', 'Very hard brake.', [0]), events: [brake(true)], brakeCreek: 'Fennel Creek' })).line, 'Very hard brake near Fennel Creek.');
  });

  test('speeding: 10 or more over a known limit serious, 5 to 9 caution, no limit plain', () => {
    const sp = cue('speeding', 'Limit 35. Ease off.');
    assert.equal(classify(at({ cue: sp, v: 45 * MPH, limitMph: 35 })).level, 'serious');
    assert.equal(classify(at({ cue: sp, v: 42 * MPH, limitMph: 35 })).level, 'caution');
    assert.equal(classify(at({ cue: sp, v: 39 * MPH, limitMph: 35 })).level, 'normal');
    assert.equal(classify(at({ cue: sp, v: 60 * MPH, limitMph: null })).level, 'normal');
  });

  test('into a salmon crossing too fast: "Slow down for <Creek>." cuts through; at a safe speed the plain line', () => {
    const fish = cue('salmon-ahead', 'Fennel Creek ahead. Coho stream.');
    const fast = classify(at({ cue: fish, v: 45 * MPH }));
    assert.deepEqual([fast.level, fast.kind, fast.line, fast.todo], ['serious', 'creek-fast', 'Slow down for Fennel Creek.', 'Coho stream.']);
    assert.equal(classify(at({ cue: fish, v: 35 * MPH })).level, 'normal');
    // a known limit sets the safe speed: 5 over it
    assert.equal(classify(at({ cue: fish, v: 52 * MPH, limitMph: 50 })).level, 'normal');
    assert.equal(classify(at({ cue: fish, v: 56 * MPH, limitMph: 50 })).level, 'serious');
    assert.equal(classify(at({ cue: cue('salmon-ahead', 'Salmon stream ahead.'), v: 50 * MPH })).line, 'Slow down. Salmon stream ahead.');
  });

  test('a stop or hard-brake spot ahead: caution when approached fast, else plain', () => {
    assert.equal(classify(at({ cue: cue('spot-ahead', 'Hard-brake spot ahead. Ease off.'), v: 40 * MPH })).level, 'caution');
    assert.equal(classify(at({ cue: cue('coast', 'Stop ahead. Coast.'), v: 36 * MPH })).level, 'caution');
    assert.equal(classify(at({ cue: cue('coast', 'Stop ahead. Coast.'), v: 28 * MPH })).level, 'normal');
  });
});

describe('alert pacing', () => {
  const moving = (a: Alerts, now: number) => a.fix(now, 30 * MPH);
  const hard = (now: number, near: string | null = null): AlertIn => at({ now, cue: cue('hard-brake', 'Hard brake.', [0]), events: [brake()], brakeCreek: near });

  test('serious: flash, double chime, cut, rank 4, a 600 ms pulse; caution: a 2 s glow, no chime', () => {
    const a = new Alerts();
    moving(a, 0);
    const s = a.take(hard(1000, 'Fennel Creek'));
    assert.deepEqual([s.level, s.flash, s.chime, s.cut, s.rank, s.edgeMs], ['serious', true, true, true, 4, ALERT.pulseMs]);
    moving(a, 60_000);
    const c = a.take(hard(60_000));
    assert.deepEqual([c.level, c.flash, c.chime, c.cut, c.edgeMs], ['caution', true, false, false, ALERT.glowMs]);
  });

  test('the same kind again inside its cooldown shows plain', () => {
    const a = new Alerts();
    moving(a, 0);
    assert.equal(a.take(hard(1000)).level, 'caution');
    moving(a, 20_000);
    assert.equal(a.take(hard(20_000)).level, 'normal');
    moving(a, 47_000);
    assert.equal(a.take(hard(47_000)).level, 'caution');
  });

  test('the edge flashes at most once per 15 s; a louder alert still raises the level, without a chime', () => {
    const a = new Alerts();
    moving(a, 0);
    assert.equal(a.take(at({ now: 1000, cue: cue('fast-start', 'Fast start.') })).flash, true);
    moving(a, 8000);
    const s = a.take(hard(8000, 'Fennel Creek'));
    assert.deepEqual([s.level, s.flash, s.chime, s.cut, s.edgeMs], ['serious', false, false, true, 0]);
    moving(a, 30_000);
    assert.equal(a.take(at({ now: 30_000, cue: cue('speeding', 'Limit 35. Ease off.'), v: 42 * MPH, limitMph: 35 })).flash, true);
  });

  test('one alert at a time: a caution while a serious one holds shows plain', () => {
    const a = new Alerts();
    moving(a, 0);
    assert.equal(a.take(hard(1000, 'Fennel Creek')).level, 'serious');
    moving(a, 4000);
    assert.equal(a.take(at({ now: 4000, cue: cue('fast-start', 'Fast start.') })).level, 'normal');
  });

  test('nothing while parked', () => {
    const a = new Alerts();
    a.fix(0, 30 * MPH);
    for (let t = 1000; t <= 20_000; t += 1000) a.fix(t, 0);
    assert.ok(a.parked(20_000));
    assert.equal(a.take(hard(20_000, 'Fennel Creek')).level, 'normal');
    // a hard brake into a stop, a moment later, still counts
    a.fix(30_000, 25 * MPH);
    a.fix(33_000, 0);
    assert.equal(a.take(hard(33_000)).level, 'caution');
    assert.equal(new Alerts().take(hard(1000)).level, 'normal');
  });
});

// Sunday's drive (coach-sunday.test.ts), on the real salmon tiles, with the live drive's glue: coach, then alerts
const FX = JSON.parse(readFileSync(new URL('./fixtures/sunday-route.json', import.meta.url), 'utf8')) as { fixes: [number, number, number, number, number | null][] };
const T0 = Date.UTC(2026, 9, 25, 19);
/** posted 35 mph everywhere on the route (the plain drive tops out at 35) */
const LIMIT = { at: () => ({ mph: 35, ref: '', name: 'McCutcheon Rd E' }) };

function sunday(edit: (mph: number[]) => void = () => {}): Fix[] {
  const mph = FX.fixes.map((f) => (f[3] ?? 0) / MPH);
  edit(mph);
  return FX.fixes.map(([t, lat, lon, , heading], i) => ({ t: T0 + t * 1000, lat, lon, speed: mph[i] * MPH, heading, accuracy: 5 }) as Fix);
}

/** speeds from t0 s: a ramp of at most 5 mph a second up to top, held, and back down to the drive's own */
function stretch(mph: number[], t0: number, s: number, top: number): void {
  for (let i = t0, v = mph[t0]; i < t0 + s; i++) mph[i] = v = Math.min(top, v + 5);
  for (let i = t0 + s, v = top; v > mph[i]; i++) mph[i] = v = Math.max(mph[i], v - 5);
}

async function drive(fixes: Fix[]): Promise<{ alerts: Alert[]; cues: Cue[]; coach: LiveCoach }> {
  const data = new SalmonData(new URL('../public/data/salmon/', import.meta.url).href, async (u) => JSON.parse(readFileSync(new URL(u), 'utf8')));
  await data.some(routeTiles(fixes.map((f) => toRegion([f.lon, f.lat]))));
  const coach = new LiveCoach({ salmon: data, limits: LIMIT }), alerts = new Alerts(), out: Alert[] = [], cues: Cue[] = [];
  for (const f of fixes) {
    const c = coach.update(f, f.t);
    alerts.fix(f.t, f.speed ?? 0);
    if (!c) continue;
    cues.push(c);
    out.push(alerts.take({ cue: c, now: f.t, v: f.speed ?? 0, limitMph: 35, events: coach.events, brakeCreek: brakeCreek(coach, c) }));
  }
  return { alerts: out, cues, coach };
}

describe("alerts on Sunday's drive", () => {
  test('the plain drive: the five creek lines, all normal, nothing flashes', async () => {
    const { alerts } = await drive(sunday());
    assert.deepEqual(alerts.map((a) => [a.level, a.line]), ['Fennel Creek', 'Canyonfalls Creek', 'Canyonfalls Creek', 'Fennel Creek', 'Fennel Creek'].map((n) => ['normal', `${n} ahead. Coho stream.`]));
    assert.ok(alerts.every((a) => !a.flash && !a.chime && !a.cut));
  });

  test('a hard brake just past Fennel Creek is serious; 7 over is caution; 13 over is serious; the creeks stay normal', async () => {
    const fixes = sunday((mph) => {
      // 42 mph on the way out, long before the creeks
      stretch(mph, 200, 16, 42);
      // a hard brake (about 8 mph lost in a second) 3 s past the Fennel Creek crossing (383 s)
      mph.splice(386, 4, 28, 20, 14, 14);
      // 48 mph on the way back, after the last creek
      stretch(mph, 700, 16, 48);
    });
    const { alerts, coach } = await drive(fixes);
    const loud = alerts.filter((a) => a.level !== 'normal');
    assert.deepEqual(loud.map((a) => [a.level, a.kind, a.line]), [
      ['caution', 'speeding', 'Limit 35. Ease off.'],
      ['serious', 'brake-near-creek', 'Hard brake near Fennel Creek.'],
      ['serious', 'speeding', 'Limit 35. Ease off.'],
    ], alerts.map((a) => `${(a.at - T0) / 1000}s ${a.level} ${a.line}`).join(' | '));
    assert.ok(loud.every((a) => a.flash));
    assert.deepEqual(loud.map((a) => a.chime), [false, true, true]);
    // the brake really was hard, not very hard, and the creek lines are still said plain
    assert.ok(coach.events.some((e) => e.kind === 'brake' && !e.veryHard));
    assert.equal(alerts.filter((a) => a.cue === 'salmon-ahead' && a.level === 'normal').length, 5);
  });
});
