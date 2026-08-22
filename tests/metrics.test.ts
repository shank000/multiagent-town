import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyMatrix,
  hubConcentration,
  matrixPersistence,
  metricsOf,
  partnerHhi,
  type Choice,
} from '../src/engine/metrics';

const ids = ['a', 'b', 'c', 'd'];

test('rolling partner HHI distinguishes uniform and concentrated outgoing choices', () => {
  const uniform = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 1, from: 'a', to: 'c' },
  ], ids);
  const concentrated = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 1, from: 'a', to: 'b' },
  ], ids);

  assert.deepEqual(partnerHhi(uniform, ids.length), [0.5]);
  assert.deepEqual(partnerHhi(concentrated, ids.length), [1]);
  assert.deepEqual(partnerHhi(new Map(), ids.length), []);
});

test('rolling partner HHI pools directed choices inside the requested window', () => {
  const byDay = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 2, from: 'a', to: 'c' },
  ], ids);

  assert.deepEqual(partnerHhi(byDay, ids.length, 2), [1, 0.5]);
  assert.deepEqual(partnerHhi(byDay, ids.length, 1), [1, 1]);
});

test('adjacent-day directed matrix persistence is one for identical and negative for disjoint patterns', () => {
  const identical = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 1, from: 'c', to: 'd' },
    { day: 2, from: 'a', to: 'b' },
    { day: 2, from: 'c', to: 'd' },
  ], ids);
  const disjoint = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 2, from: 'c', to: 'd' },
  ], ids);

  assert.deepEqual(matrixPersistence(identical, ids.length), [1]);
  assert.ok(matrixPersistence(disjoint, ids.length)[0] < 0);
});

test('matrix persistence handles empty, single-day, gaps, and zero variance deterministically', () => {
  assert.deepEqual(matrixPersistence(new Map(), ids.length), []);
  assert.deepEqual(matrixPersistence(new Map([[1, new Map([['0:1', 1]])]]), ids.length), []);
  assert.deepEqual(matrixPersistence(new Map([
    [1, new Map([['0:1', 1]])],
    [3, new Map([['0:1', 1]])],
  ]), ids.length), []);

  const constant = new Map<number, Map<string, number>>([
    [1, new Map([['0:1', 1], ['0:2', 1], ['1:0', 1], ['1:2', 1], ['2:0', 1], ['2:1', 1]])],
    [2, new Map([['0:1', 1], ['0:2', 1], ['1:0', 1], ['1:2', 1], ['2:0', 1], ['2:1', 1]])],
  ]);
  assert.deepEqual(matrixPersistence(constant, 3), [1]);
});

test('weighted in-degree hub concentration distinguishes a star from balanced attention', () => {
  const star = dailyMatrix([
    { day: 1, from: 'b', to: 'a' },
    { day: 1, from: 'c', to: 'a' },
    { day: 1, from: 'd', to: 'a' },
  ], ids);
  const balanced = dailyMatrix([
    { day: 1, from: 'a', to: 'b' },
    { day: 1, from: 'b', to: 'c' },
    { day: 1, from: 'c', to: 'd' },
    { day: 1, from: 'd', to: 'a' },
  ], ids);

  assert.deepEqual(hubConcentration(star, ids.length), [1]);
  assert.deepEqual(hubConcentration(balanced, ids.length), [0]);
  assert.deepEqual(hubConcentration(new Map([[1, new Map()]]), ids.length), [0]);
  assert.deepEqual(hubConcentration(new Map([[1, new Map([['0:0', 1]])]]), 1), [0]);
});

test('metricsOf adds concentration metrics without changing existing result keys', () => {
  const choices: Choice[] = [
    { day: 1, from: 'a', to: 'b' },
    { day: 2, from: 'a', to: 'b' },
  ];
  const metrics = metricsOf(choices, ids);

  assert.deepEqual(metrics.repeat, [1]);
  assert.ok(Array.isArray(metrics.recip));
  assert.ok(Array.isArray(metrics.clus));
  assert.ok(Array.isArray(metrics.div));
  assert.deepEqual(metrics.hhi, [1, 1]);
  assert.deepEqual(metrics.persistence, [1]);
  assert.deepEqual(metrics.hub, [1, 1]);
  assert.equal(metrics.pairs.get('0:1'), 2);
});
