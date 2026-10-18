/** shell: county area files and the street-name list load again after a failure */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Areas, RETRY_MS, type AreaInfo } from '../src/app/areas.ts';

const AREA: AreaInfo = { id: 'tehaleh-x', name: 'Tehaleh / Test Rd E', bbox: [-122.2, 47.1, -122.1, 47.2], drains: 3, byClass: {}, bytes: 10 };
const real = globalThis.fetch;
let fail = new Set<string>();
let calls: string[] = [];

beforeEach(() => {
  fail = new Set();
  calls = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (fail.has(String(url))) { fail.delete(String(url)); throw new TypeError('Failed to fetch'); }
    const body = String(url).endsWith('names.json') ? { areas: ['tehaleh-x'], names: [['Test Rd E', 0]] } : { ok: 1 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = real; });

describe('area files', () => {
  test('a failed file is fetched again on the next ask, and its failure is kept until then', async () => {
    let t = 0;
    const a = new Areas(() => t);
    a.list = [AREA];
    fail.add('data/areas/tehaleh-x.json');
    assert.equal(await a.fetch('tehaleh-x'), null);
    assert.ok(a.failed.has('tehaleh-x'));
    // the quiet background loading waits a bit, a person's ask doesn't
    assert.ok(a.resting('tehaleh-x'));
    t = RETRY_MS + 1;
    assert.ok(!a.resting('tehaleh-x'));
    assert.deepEqual(await a.fetch('tehaleh-x'), { ok: 1 });
    assert.ok(!a.failed.has('tehaleh-x'));
    assert.equal(calls.length, 2);
    // a good file is fetched once
    await a.fetch('tehaleh-x');
    assert.equal(calls.length, 2);
    // still listed as missing until it is joined in
    assert.equal(a.missing([-122.3, 47.0, -122.0, 47.3]).length, 1);
  });

  test('a 404 counts as a failure too', async () => {
    const a = new Areas();
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    assert.equal(await a.fetch('gone'), null);
    assert.ok(a.failed.has('gone'));
  });
});

describe('street names', () => {
  test('after names.json fails once, the next search works', async () => {
    const a = new Areas();
    a.list = [AREA];
    fail.add('data/areas/names.json');
    assert.deepEqual(await a.findStreet('test'), []);
    assert.ok(a.searchFailed);
    const hits = await a.findStreet('test');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].place, 'Tehaleh');
    assert.ok(!a.searchFailed);
  });
});
