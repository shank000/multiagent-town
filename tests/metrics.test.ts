import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyMatrix,
  hubConcentration,
  matrixPersistence,
  metricsOf,
  partnerHhi,
  reciprocity,
  reciprocityObservations,
  reciprocityRate,
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

test('windowed directed matrix persistence is one for identical and negative for disjoint patterns', () => {
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

  assert.deepEqual(matrixPersistence(identical, ids.length, 1), [1]);
  assert.ok(matrixPersistence(disjoint, ids.length, 1)[0] < 0);
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
  assert.deepEqual(matrixPersistence(constant, 3, 1), [1]);
});

test('reciprocity includes zero-reciprocity days and normalizes by equal-candidate chance', () => {
  const choices: Choice[] = [
    { day: 1, from: 'a', to: 'b' }, { day: 1, from: 'b', to: 'c' },
    { day: 1, from: 'c', to: 'd' }, { day: 1, from: 'd', to: 'a' },
    { day: 2, from: 'a', to: 'b' }, { day: 2, from: 'b', to: 'c' },
    { day: 2, from: 'c', to: 'd' }, { day: 2, from: 'd', to: 'a' },
    { day: 3, from: 'a', to: 'd' }, { day: 3, from: 'b', to: 'a' },
    { day: 3, from: 'c', to: 'b' }, { day: 3, from: 'd', to: 'c' },
  ];
  assert.deepEqual(reciprocityRate(choices), [0, 1]);
  assert.deepEqual(reciprocity(choices), [0, 3]);
  assert.deepEqual(reciprocityObservations(choices), [
    { day: 2, observedRate: 0, equalCandidateBaseline: 1 / 3, baselineRatio: 0 },
    { day: 3, observedRate: 1, equalCandidateBaseline: 1 / 3, baselineRatio: 3 },
  ]);
});

test('metric timelines preserve calendar days and expose the two-window eligibility state', () => {
  const firstThirteenDays: Choice[] = Array.from({ length: 13 }, (_, index) => ({
    day: index + 1,
    from: 'a',
    to: index % 2 === 0 ? 'b' : 'c',
  }));
  const pending = metricsOf(firstThirteenDays, ids);
  assert.deepEqual(pending.persistence, []);
  assert.equal(pending.availability.persistence.state, 'awaiting_window');
  assert.equal(pending.availability.persistence.requiredConsecutiveChoiceDays, 14);
  assert.equal(pending.availability.persistence.longestConsecutiveChoiceDays, 13);

  const ready = metricsOf([...firstThirteenDays, { day: 14, from: 'a', to: 'b' }], ids);
  assert.equal(ready.persistence.length, 1);
  assert.deepEqual(ready.seriesDays.persistence, [14]);
  assert.equal(ready.availability.persistence.state, 'ready');

  const gap = metricsOf([
    { day: 1, from: 'a', to: 'b' },
    { day: 3, from: 'a', to: 'b' },
    { day: 4, from: 'a', to: 'b' },
  ], ids);
  assert.deepEqual(gap.seriesDays.repeat, [4]);
  assert.deepEqual(gap.repeat, [1]);
});

test('directed repeat rate does not compare across missing calendar days', () => {
  const choices: Choice[] = [
    { day: 1, from: 'a', to: 'b' },
    { day: 3, from: 'a', to: 'b' },
  ];
  assert.deepEqual(metricsOf(choices, ['a', 'b']).repeat, []);
});

test('metrics exclude unknown, self-directed, and invalid-day choices from every series', () => {
  const metrics = metricsOf([
    { day: 1, from: 'a', to: 'b' },
    { day: 1, from: 'a', to: 'a' },
    { day: 1, from: 'outside', to: 'b' },
    { day: 0, from: 'b', to: 'a' },
  ], ids);
  assert.deepEqual(metrics.seriesDays.clus, [1]);
  assert.deepEqual(Object.fromEntries(metrics.pairs), { '0:1': 1 });
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
  assert.deepEqual(metrics.recipRate, []);
  assert.deepEqual(metrics.recipBaseline, []);
  assert.ok(Array.isArray(metrics.recip));
  assert.ok(Array.isArray(metrics.clus));
  assert.ok(Array.isArray(metrics.div));
  assert.deepEqual(metrics.hhi, [1, 1]);
  assert.deepEqual(metrics.persistence, []);
  assert.deepEqual(metrics.hub, [1, 1]);
  assert.equal(metrics.pairs.get('0:1'), 2);
});
