/** share card words: only what the report says */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { moneyLine, salmonLine, shareFacts, spotLine } from '../src/app/features/share-facts.ts';
import type { DriveReport } from '../src/drive/analyze.ts';

const usd = (typical: number) => ({ low: typical / 2, typical, high: typical * 2 });
const brake = (o: Record<string, unknown> = {}) => ({ rate: 3.5, name: '', salmon: false, receiving: '', cls: 'ground', mapped: true, ...o });
const report = (o: Record<string, unknown> = {}) => ({
  score: { score: 82 }, money: { gas: usd(0), tires: usd(0) }, brakes: [], stops: [{ hard: false }, { hard: false }], ...o,
}) as unknown as DriveReport;

describe('share card words', () => {
  test('money', () => {
    assert.equal(moneyLine(report()), 'No extra gas or tire wear from speeding or hard stops.');
    assert.equal(moneyLine(report({ money: { gas: usd(0.03), tires: usd(0.02), year: { total: usd(26.9) } } })), 'Driving like this costs about $25 a year in extra gas and tire wear (estimate).');
    assert.equal(moneyLine(report({ money: { gas: usd(0), tires: usd(0.004), year: { total: usd(1) } } })), 'Driving like this costs under $5 a year in extra tire wear from hard stops (estimate).');
    assert.equal(moneyLine(report({ money: { gas: usd(0.01), tires: usd(0), year: null } })), 'Smoother driving saves gas from speeding.');
    for (const g of [0.004, 0.03, 0.5]) assert.ok(!/¢/.test(moneyLine(report({ money: { gas: usd(g), tires: usd(0), year: { total: usd(g * 3000) } } }))));
  });

  test('the hardest brake by its street', () => {
    assert.equal(spotLine(report()), 'No hard brakes on this drive.');
    assert.equal(spotLine(report({ brakes: [brake({ rate: 3.2, name: 'Main St E' }), brake({ rate: 4.4, name: '192nd Ave E' })] })), 'Hardest brake: 192nd Ave E');
  });

  test('salmon line from the drains only', () => {
    assert.equal(salmonLine(report()), 'All 2 stops were gentle. Gentle stops leave less tire dust to wash into salmon streams.');
    assert.equal(salmonLine(report({ brakes: [brake({ salmon: true, cls: 'creek', receiving: 'Fennel Creek' })] })), 'Rain from 1 hard brake on this drive runs to Fennel Creek, where coho salmon live.');
    assert.equal(salmonLine(report({ brakes: [brake({ salmon: true, cls: 'creek', receiving: 'Lake Bonney Outflow' }), brake({ salmon: true, cls: 'creek', receiving: 'Fennel Creek' })] })),
      'Rain from 2 hard brakes on this drive runs toward Fennel Creek, where coho salmon live.');
    assert.equal(salmonLine(report({ stops: [{ hard: true }], brakes: [brake()] })), 'None of the hard brakes drain to a salmon stream.');
    assert.equal(salmonLine(report({ stops: [{ hard: true }], brakes: [brake({ cls: 'unknown' })] })), 'Gentle stops leave less tire dust to wash into salmon streams.');
  });

  test('a date, no time', () => {
    const f = shareFacts(report(), new Date(2026, 9, 17, 18, 42).getTime());
    assert.equal(f.date, 'Oct 17, 2026');
    assert.equal(f.score, 82);
  });
});
