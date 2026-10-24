import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facilityRole, fwOwner, isGone, structureRole } from '../scripts/sources/federal-way.ts';

test('Federal Way structures: grates take water, solid lids and untyped boxes do not', () => {
  assert.equal(structureRole('T1', 'VANED'), 'drain');
  assert.equal(structureRole('T2', 'HBN'), 'drain');
  assert.equal(structureRole('T1', 'OTHER'), 'drain');
  assert.equal(structureRole('T2', 'RSL'), 'junction');
  assert.equal(structureRole(' ', 'OTHER'), 'junction');
  assert.equal(structureRole('', 'Vaned'), 'drain');
});

test('Federal Way facilities, owners and abandoned assets', () => {
  assert.equal(facilityRole('POND', 'N'), 'facility-hold');
  assert.equal(facilityRole('POND', 'Y'), 'facility-infiltrate');
  assert.equal(facilityRole('DTRNCH', 'N'), 'facility-infiltrate');
  assert.equal(facilityRole('DUMP', 'N'), null);
  assert.equal(facilityRole('LAKE', 'N'), null);
  assert.equal(fwOwner('PUB'), 'public');
  assert.equal(fwOwner('PRI'), 'private');
  assert.equal(fwOwner('DOT'), 'other');
  assert.equal(fwOwner('UNK'), undefined);
  assert.ok(isGone({ MODS: 'ABANDON' }) && isGone({ STATUS: 'Abandoned' }) && !isGone({ MODS: 'NONE', STATUS: null }));
});
