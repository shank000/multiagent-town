import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { RumorTracker } from '../src/engine/rumors';

test('谣言种子与传播链', () => {
  const db = openDb(':memory:');
  const r = new RumorTracker(db);
  const id = r.seed('agent:林晚晴', '湖边埋着宝藏', 600);
  r.spread('agent:林晚晴', 'agent:周岚', id, '湖边埋着宝藏', 700);
  r.spread('agent:周岚', 'agent:陈默', id, '听说湖边埋着宝藏（转述）', 800);
  assert.equal(r.carriersOf(id).length, 3);
  assert.deepEqual(r.carriedBy('agent:陈默').map((x) => x.content), ['湖边埋着宝藏（转述）']);
  assert.equal(r.rows().length, 3); // 种子 + 两次传播
});

test('未传播时 carriers 仅源头', () => {
  const db = openDb(':memory:');
  const r = new RumorTracker(db);
  const id = r.seed('agent:a', 'x', 1);
  assert.deepEqual(r.carriersOf(id), ['agent:a']);
});
