/** "What do you drive?" follows the signed-in person: the newest pick wins, here or in the backup */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { carFields, carPlan, cloudCar, keepCar, localCar } from '../src/app/cloud/car.ts';
import { useStorage } from './engine-helpers.ts';

describe('the car pick, synced', () => {
  beforeEach(() => useStorage(10_000));

  test('kept on this phone with when it was picked', () => {
    assert.equal(localCar(), null);
    keepCar({ car: 'suv', at: 5 }, true);
    assert.deepEqual(localCar(), { car: 'suv', at: 5 });
    // picked before syncing: no time
    localStorage.removeItem('tt-vehicle-at');
    assert.deepEqual(localCar(), { car: 'suv', at: 0 });
    localStorage.setItem('tt-vehicle', 'boat');
    assert.equal(localCar(), null);
  });

  test('the profile holds car and carAt; anything else is no pick', () => {
    assert.deepEqual(carFields({ car: 'ev', at: 9 }), { car: 'ev', carAt: 9 });
    assert.deepEqual(cloudCar({ car: 'ev', carAt: 9, drives: 3 }), { car: 'ev', at: 9 });
    assert.deepEqual(cloudCar({ car: 'pickup' }), { car: 'pickup', at: 0 });
    assert.equal(cloudCar({ car: 'tank', carAt: 9 }), null);
    assert.equal(cloudCar(null), null);
  });

  test('the newest pick wins; a second device takes the first one\'s car', () => {
    const a = { car: 'suv', at: 200 } as const, b = { car: 'small', at: 100 } as const;
    assert.deepEqual(carPlan(a, null), { send: a });
    assert.deepEqual(carPlan(a, b), { send: a });
    assert.deepEqual(carPlan(b, a), { keep: a });
    assert.deepEqual(carPlan(null, a), { keep: a });
    assert.deepEqual(carPlan(a, a), {});
    assert.deepEqual(carPlan(null, null), {});
    // an old pick with no time goes up once, then loses to any timed pick
    const old = { car: 'pickup', at: 0 } as const;
    assert.deepEqual(carPlan(old, null), { send: old });
    assert.deepEqual(carPlan(old, old), {});
    assert.deepEqual(carPlan(old, b), { keep: b });
    // same time, different car: the backup's wins, so devices agree
    assert.deepEqual(carPlan({ car: 'car', at: 0 }, old), { keep: old });
  });
});
