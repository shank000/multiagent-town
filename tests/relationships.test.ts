import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { RelationshipStore } from '../src/store/relationships';

function setup() {
  const db = openDb(':memory:');
  return { db, store: new RelationshipStore(db) };
}

test('有向关系：A→B 与 B→A 分存', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { affectionDelta: 0.1 });
  const ab = store.getOrCreate('agent:a', 'agent:b');
  const ba = store.getOrCreate('agent:b', 'agent:a');
  assert.equal(ab.affection, 0.1);
  assert.equal(ba.affection, 0);
});

test('delta 夹紧 ±0.2、值夹紧 -1..1', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { affectionDelta: 0.5 }); // 夹到 0.2
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 0.2);
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 });
  store.update('agent:a', 'agent:b', { affectionDelta: 0.2 }); // 累计 1.2 → 夹 1
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 1);
  store.update('agent:a', 'agent:b', { affectionDelta: -2 }); // 夹 -0.2 → 0.8
  assert.equal(store.getOrCreate('agent:a', 'agent:b').affection, 0.8);
});

test('knowledge 叙事层追加并截断 20 条', () => {
  const { store } = setup();
  for (let i = 0; i < 25; i++) store.update('agent:a', 'agent:b', { knowledge: [`条目${i}`] });
  const r = store.getOrCreate('agent:a', 'agent:b');
  assert.equal(r.knowledge.length, 20);
  assert.equal(r.knowledge[19], '条目24'); // 保留最新
});

test('allFor 与 allPairs', () => {
  const { store } = setup();
  store.update('agent:a', 'agent:b', { respectDelta: 0.1 });
  store.update('agent:c', 'agent:a', { affectionDelta: 0.1 });
  assert.equal(store.allFor('agent:a').length, 1); // 出边：A 对他人的看法
  assert.equal(store.allPairs().length, 2);
});
