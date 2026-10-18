/** street search: one shared collator sorts the same as localeCompare did, numbers in number order */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Run, World } from '../src/app/map/world.ts';
import { StreetIndex, type StreetHit } from '../src/app/screens/streets.ts';

// only what StreetIndex reads: each run's piece and index, and the piece names
function index(streets: [name: string, place: string][]): StreetIndex {
  const runs = streets.map((_, i) => ({ i, piece: i, line: [[0, 0], [10, 0]], drain: null, k: 0 }) as unknown as Run);
  return new StreetIndex({ runs, pieceNames: streets.map((s) => s[0]) } as unknown as World, (run) => streets[run][1]);
}
const hits = (idx: StreetIndex) => (idx as unknown as { hits: StreetHit[] }).hits;

const STREETS: [string, string][] = [
  ['214th Ave E', 'Tehaleh'], ['10th St E', 'Bonney Lake'], ['2nd St E', 'Bonney Lake'], ['214th Ave E', 'Bonney Lake'],
  ['Main St', 'Sumner'], ['main st', 'Buckley'], ['192nd Ave E', 'Bonney Lake'], ['19th St E', 'Lake Tapps'], ['Église Rd', 'Orting'],
  ['Elm St', 'Orting'], ['SR 410', 'Bonney Lake'], ['SR 162', 'Orting'], ['96th St E', 'Puyallup'], ['96th St E', 'Alderton'], ['96th St E', 'South Hill'],
];

describe('street search order', () => {
  test('names in order with numbers counted as numbers, then by place', () => {
    const all = hits(index(STREETS)).map((h) => h.key);
    assert.deepEqual(all.slice(0, 7), ['2nd St E|Bonney Lake', '10th St E|Bonney Lake', '19th St E|Lake Tapps', '96th St E|Alderton', '96th St E|Puyallup', '96th St E|South Hill', '192nd Ave E|Bonney Lake']);
    assert.deepEqual(all.slice(7, 9), ['214th Ave E|Bonney Lake', '214th Ave E|Tehaleh']);
    assert.ok(all.indexOf('SR 162|Orting') < all.indexOf('SR 410|Bonney Lake'));
  });

  test('the same order the old per-call localeCompare sort gave', () => {
    const all = hits(index(STREETS));
    const old = [...all].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || a.place.localeCompare(b.place));
    assert.deepEqual(all, old);
  });

  test('search still puts names that start with the words first', () => {
    const idx = index(STREETS);
    assert.deepEqual(idx.search('214').map((h) => h.key), ['214th Ave E|Bonney Lake', '214th Ave E|Tehaleh']);
    assert.deepEqual(idx.search('96th Street East', 2).map((h) => h.key), ['96th St E|Alderton', '96th St E|Puyallup']);
    assert.deepEqual(idx.search('st e').map((h) => h.name), ['2nd St E', '10th St E', '19th St E', '96th St E', '96th St E', '96th St E']);
    assert.deepEqual(idx.search('main').map((h) => h.key), ['main st|Buckley', 'Main St|Sumner']);
  });
});
