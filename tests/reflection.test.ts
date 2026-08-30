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
  assert.equal(refs[0].kind, 'triggered');
  assert.equal(refs[0].day, 1);
  assert.equal(refs[0].questions.length, 3);
  assert.ok(refs[0].insights.length >= 1);
  assert.ok(refs[0].insights[0].startsWith('我'));
  assert.ok(refs[0].diary.includes('咖啡馆'));
  assert.ok(refs[0].guidance.length >= 2);
  assert.ok(refs[0].beliefs.length >= 1);
  assert.ok(refs[0].evidenceIds.length >= 1);
  assert.ok(refs[0].mindState.stress >= 0 && refs[0].mindState.stress <= 1);
  assert.ok(store.recentMemories('agent:1', 100).some((m) => m.kind === 'insight'));
  const event = log.eventsForDay(1).find((e) => e.payload?.kind === 'reflection');
  assert.ok(event);
  assert.equal(event.payload?.reflectionKind, 'triggered');
  assert.ok(Array.isArray(event.payload?.evidenceIds));
});

test('日终日记按天取证、幂等写入，并把心态与行为指引结构化保存', async () => {
  const { store, engine, agent } = setup();
  store.addMemory({ id: 'day1-good', agentId: agent.id, kind: 'observation', content: '第1天 我顺利完成了咖啡馆工作并帮助朋友。', importance: 8, createdGameTime: 600 });
  store.addMemory({ id: 'day2-later', agentId: agent.id, kind: 'observation', content: '第2天 这条证据不属于昨天。', importance: 9, createdGameTime: 1500 });

  await Promise.all([
    engine.summarizeDay(agent, 1, 1439),
    engine.summarizeDay(agent, 1, 1439),
  ]);
  await engine.drain();

  const daily = store.dailyReflectionFor(agent.id, 1);
  assert.ok(daily);
  assert.equal(store.reflectionsFor(agent.id).filter((record) => record.kind === 'daily' && record.day === 1).length, 1);
  assert.ok(daily.diary.includes('咖啡馆'));
  assert.ok(!daily.diary.includes('不属于昨天'));
  assert.ok(daily.evidenceIds.includes('day1-good'));
  assert.ok(!daily.evidenceIds.includes('day2-later'));
  assert.ok(daily.guidance.some((item) => item.includes(agent.persona.occupation)));
  assert.equal(store.accumulator(agent.id), 0, '反思生成的日记/洞察不应递归触发下一次反思');
});

test('相反证据会形成可追溯的旧洞察修订，近期洞察不再返回被替代判断', async () => {
  const { store, engine, agent } = setup();
  const previous = '我一直认为和乙的合作没有问题。';
  store.addReflection({
    id: 'prior-reflection', agentId: agent.id, parentId: null, depth: 0,
    questions: ['合作如何？'], insights: [previous], evidenceIds: [], triggerScore: 151,
    createdGameTime: 500, day: 1, diary: '此前我觉得合作很稳定。',
  });
  store.addMemory({
    id: 'conflict-evidence', agentId: agent.id, kind: 'observation', importance: 9, createdGameTime: 900,
    content: '第1天 但是我和乙发生误会，原来的合作判断需要改变。',
  });

  await engine.summarizeDay(agent, 1, 1439);
  await engine.drain();
  const daily = store.dailyReflectionFor(agent.id, 1);
  assert.ok(daily);
  assert.equal(daily.revisions.length, 1);
  assert.equal(daily.revisions[0].previous, previous);
  assert.ok(daily.revisions[0].evidenceIds.includes('conflict-evidence'));
  assert.ok(!store.recentInsights(agent.id, 10).includes(previous));
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

test('没有事件证据的日记明确记录证据不足，不形成无来源信念或洞察', async () => {
  const { store, engine, agent } = setup();
  await engine.summarizeDay(agent, 1, 1439);
  await engine.drain();

  const daily = store.dailyReflectionFor(agent.id, 1);
  assert.ok(daily);
  assert.match(daily.diary, /没有足够的事件证据/);
  assert.deepEqual(daily.evidenceIds, []);
  assert.deepEqual(daily.insights, []);
  assert.deepEqual(daily.beliefs, []);
});
