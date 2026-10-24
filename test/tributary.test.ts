/** tributary names: "X Creek Tributary 5" feeds X Creek; "West Tributary" is a stream's own name */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tributaryOf } from '../src/trace/tributary.ts';

describe('tributaryOf', () => {
  test('names the water a numbered or unnamed tributary feeds', () => {
    assert.equal(tributaryOf('Clover Creek Tributary 7'), 'Clover Creek');
    assert.equal(tributaryOf('North Fork Clover Creek Tributary 5'), 'North Fork Clover Creek');
    assert.equal(tributaryOf('Fennel Creek tributary (unnamed)'), 'Fennel Creek');
    assert.equal(tributaryOf('Green River Tributary'), 'Green River');
  });
  test('keeps a stream whose own name has Tributary in it', () => {
    assert.equal(tributaryOf('West Tributary'), null);
    assert.equal(tributaryOf('Kelsey Creek West Tributary'), null);
    assert.equal(tributaryOf('Tributary 0123'), null);
    assert.equal(tributaryOf('Swan Creek'), null);
  });
});
