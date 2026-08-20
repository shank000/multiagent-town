import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { MemoryStore, shingles, keywordSimilarity } from '../src/store/memory';

function setup() {
  const db = openDb(':memory:');
  return { db, store: new MemoryStore(db) };
}

test('记忆写入/截断/计数', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'x'.repeat(300), importance: 6, createdGameTime: 10 });
  assert.equal(store.countFor('agent:1'), 1);
  assert.equal(store.recentMemories('agent:1', 1)[0].content.length, 200);
});

test('检索按三因子排序并更新 last_access', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在咖啡馆煮咖啡招待客人', importance: 5, createdGameTime: 100 });
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在公园散步看湖', importance: 5, createdGameTime: 200 });
  // 重要度同样为 5：验证关键词相关性而非重要性主导排序
  store.addMemory({ agentId: 'agent:1', kind: 'plan', content: '筹备湖畔派对邀请大家', importance: 5, createdGameTime: 300 });
  const top = store.retrieve('agent:1', '咖啡馆煮咖啡', 300, 20);
  assert.equal(top.length, 3);
  assert.equal(top[0].content, '在咖啡馆煮咖啡招待客人'); // 关键词相关 + 最近
  assert.equal(top[0].lastAccessGameTime, 300);
});

test('importance 累计器读写清零', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'a', importance: 6, createdGameTime: 1 });
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'b', importance: 9, createdGameTime: 2 });
  assert.equal(store.accumulator('agent:1'), 15);
  store.resetAccumulator('agent:1');
  assert.equal(store.accumulator('agent:1'), 0);
});

test('反思树与 insight 提取', () => {
  const { store } = setup();
  store.addReflection({ agentId: 'agent:1', parentId: null, depth: 0, questions: ['q1'], insights: ['我最近常去咖啡馆。', '我喜欢观察客人。'], evidenceIds: ['m1'], triggerScore: 160, createdGameTime: 50 });
  const refs = store.reflectionsFor('agent:1');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].depth, 0);
  assert.deepEqual(store.recentInsights('agent:1', 2), ['我最近常去咖啡馆。', '我喜欢观察客人。']);
});

test('计划 upsert 与对话消息', () => {
  const { store } = setup();
  store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营。', hourly: [{ time: '09:00', action: '开店', location: '咖啡馆吧台' }], status: 'active', createdGameTime: 300 });
  store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营。', hourly: [{ time: '10:00', action: '煮咖啡', location: '咖啡馆吧台' }], status: 'active', createdGameTime: 420 });
  const plan = store.planFor('agent:1', 1)!;
  assert.equal(plan.hourly.length, 1); // upsert 覆盖
  assert.equal(plan.hourly[0].action, '煮咖啡');
  store.addMessage({ eventId: null, fromAgent: 'agent:1', toAgent: 'agent:2', content: '你好呀！', gameTime: 30 });
  assert.equal(store.messagesFor('agent:2').length, 1);
});

test('shingles 与关键词相似度', () => {
  assert.ok(keywordSimilarity('咖啡馆煮咖啡', '在咖啡馆煮咖啡招待客人') > 0.3);
  assert.equal(keywordSimilarity('咖啡馆', '书店看书'), 0);
  assert.deepEqual(shingles('ab'), ['ab']);
});
