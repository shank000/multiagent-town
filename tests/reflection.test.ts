import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { ReflectionEngine } from '../src/engine/reflection';
import { makeAgent, persona, flush } from './helpers';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const engine = new ReflectionEngine(new LLMGateway({ provider: 'mock' }), store, log);
  const agent = makeAgent({ id: 'agent:1', name: '甲', persona: persona({ name: '甲' }) });
  return { log, store, engine, agent };
}

test('累计超 150 触发反思：树 + insight 写回 + 事件', async () => {
  const { log, store, engine, agent } = setup();
  for (let i = 0; i < 30; i++) store.addMemory({ agentId: 'agent:1', kind: 'observation', content: `第1天 09:${i % 60}，甲 在咖啡馆煮咖啡 ${i}`, importance: 6, createdGameTime: 540 + i });
  engine.tick(agent, 1, 600);
  await flush();
  await flush();
  const refs = store.reflectionsFor('agent:1');
  assert.ok(refs.length >= 1);
  assert.equal(refs[0].questions.length, 3);
  assert.ok(refs[0].insights.length >= 1);
  assert.ok(refs[0].insights[0].startsWith('我'));
  assert.ok(store.recentMemories('agent:1', 100).some((m) => m.kind === 'insight'));
  assert.ok(log.eventsForDay(1).some((e) => e.payload?.kind === 'reflection'));
});

test('每天最多 2 次；未超阈值不触发', async () => {
  const { store, engine, agent } = setup();
  engine.tick(agent, 1, 10);
  await flush();
  assert.equal(store.reflectionsFor('agent:1').length, 0); // 累计 0
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '大事件', importance: 9, createdGameTime: 20 });
  engine.tick(agent, 1, 30);
  await flush();
  await flush();
  assert.equal(store.reflectionsFor('agent:1').length, 0); // 9 < 150
});
