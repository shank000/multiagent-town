import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { ReflectionEngine, reflectionDiaryOf } from '../src/engine/reflection';
import { makeAgent, persona, flush } from './helpers';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import {
  REFLECTION_JOURNAL_TEMPLATE,
} from '../src/llm/prompts';

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

test('反思模型不可用时仍以事件证据形成日记，并标注降级阶段', async () => {
  const provider: LLMProvider = {
    name: 'reflection-unavailable',
    async complete(): Promise<LLMResponse> {
      throw new Error('request exceeds the available context size');
    },
  };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const engine = new ReflectionEngine(new LLMGateway({ provider, retries: 0 }), store, log);
  const agent = makeAgent({ id: 'agent:fallback', name: '乙', persona: persona({ name: '乙', occupation: '邮差' }) });
  store.addMemory({
    id: 'fallback-evidence', agentId: agent.id, kind: 'observation',
    content: '第1天 09:00，乙把一封信送到书店。', importance: 8, createdGameTime: 540,
  });

  await engine.summarizeDay(agent, 1, 1439);
  await engine.drain();

  const daily = store.dailyReflectionFor(agent.id, 1);
  assert.ok(daily);
  assert.match(daily.diary, /送到书店/);
  assert.ok(daily.evidenceIds.includes('fallback-evidence'));
  const event = log.eventsForDay(1).find((item) => item.payload?.kind === 'reflection');
  const quality = event?.payload?.quality as { status?: string; degradedStages?: string[] } | undefined;
  assert.equal(quality?.status, 'model_fallback');
  assert.deepEqual(quality?.degradedStages, ['journal']);

  db.raw.close();
});

test('最终日记只投影事件证据、心态与人物价值，不接纳模型新增事实', () => {
  const agent = makeAgent({ id: 'agent:1', name: '甲', persona: persona({ name: '甲', occupation: '咖啡师' }) });
  const diary = reflectionDiaryOf(agent, 1, [
    { content: '早上为第一位客人调整了手冲配方。', importance: 8, createdGameTime: 540 },
    { content: '打烊前两位客人因咖啡聊成了朋友。', importance: 7, createdGameTime: 1100 },
  ], {
    valence: 0.4, energy: 0.6, stress: 0.2, socialNeed: 0.7, occupationalFocus: 0.8, summary: '心情踏实',
  });
  assert.match(diary, /调整了手冲配方/);
  assert.match(diary, /两位客人因咖啡聊成了朋友/);
  assert.match(diary, /咖啡师/);
  assert.doesNotMatch(diary, /干花|热可可|咖啡渍/);
});

test('持久证据水位线支持两次触发反思与全天日记，且不重复洞察或遗漏晚间证据', async () => {
  const journalContexts: Record<string, unknown>[] = [];
  const provider: LLMProvider = {
    name: 'reflection-watermark',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      assert.equal(request.template, REFLECTION_JOURNAL_TEMPLATE);
      const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
      const match = user.match(/<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/);
      assert.ok(match);
      const context = JSON.parse(match[1]) as Record<string, unknown>;
      journalContexts.push(context);
      const evidence = context.evidence as { id: string }[];
      const parsed: Record<string, unknown> = {
          questions: ['今天发生了什么？', '我该如何理解？', '下一步怎么做？'],
          diary: '只使用证据完成日记。',
          mind_state: {
            valence: 0, energy: 0.5, stress: 0.3, social_need: 0.5,
            occupational_focus: 0.7, summary: '继续核对事实。',
          },
          insights: ['我应该认真观察！'],
          beliefs: evidence.length ? [{
            statement: '我应该认真观察。', confidence: 0.6,
            evidence_ids: [evidence[0].id], status: 'new', supersedes: null,
          }] : [],
          revisions: [],
          behavior_guidance: ['先核对事实再行动。'],
      }
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const gateway = new LLMGateway({ provider, retries: 0 });
  let engine = new ReflectionEngine(gateway, store, log);
  const agent = makeAgent({ id: 'agent:1', name: '甲', persona: persona({ name: '甲', occupation: '调查员' }) });
  store.addReflection({
    id: 'day1-daily', agentId: agent.id, parentId: null, depth: 0, kind: 'daily', day: 1,
    questions: [], insights: ['我已经完成第一天复盘。'], evidenceIds: [], diary: '第一天的正式日记。',
    triggerScore: 0, createdGameTime: 1439,
  });
  try {
    for (const [batch, startAt, tickAt] of [
      ['first', 1500, 1600],
      ['second', 1700, 1800],
      ['third', 1820, 1900],
    ] as const) {
      engine = new ReflectionEngine(gateway, store, log);
      for (let index = 0; index < 26; index += 1) store.addMemory({
        id: `${batch}:${index}`, agentId: agent.id, kind: 'observation', content: `${batch} 批新证据 ${index}`,
        importance: 6, createdGameTime: startAt + index,
      });
      engine.tick(agent, 2, tickAt);
      await engine.drain();
    }
    assert.equal(store.triggeredReflectionCount(agent.id, 2), 2);
    assert.equal(store.reflectionsFor(agent.id).filter((record) => record.kind === 'triggered' && record.day === 2).length, 2);

    for (let index = 0; index < 207; index += 1) store.addMemory({
      id: `ordinary:${index}`, agentId: agent.id, kind: 'observation', content: `日间普通证据 ${index}`,
      importance: 1, createdGameTime: 1900 + index,
    });
    store.addMemory({
      id: 'late-important', agentId: agent.id, kind: 'observation', content: '晚间发生了必须复盘的重要事件。',
      importance: 10, createdGameTime: 2879,
    });
    await engine.summarizeDay(agent, 2, 2879);
    await engine.drain();

    const day2 = store.reflectionsFor(agent.id).filter((record) => record.day === 2);
    const triggered = day2.filter((record) => record.kind === 'triggered').sort((a, b) => a.createdGameTime - b.createdGameTime);
    const daily = day2.find((record) => record.kind === 'daily');
    assert.equal(triggered.length, 2);
    assert.ok(daily);
    const secondEvidence = new Set(triggered[1].evidenceIds);
    assert.equal(triggered[0].evidenceIds.filter((id) => secondEvidence.has(id)).length, 0);
    assert.ok(triggered[0].evidenceIds.every((id) => id.startsWith('first:')));
    assert.ok(triggered[1].evidenceIds.every((id) => id.startsWith('second:')));
    assert.ok(triggered.every((record) => record.evidenceIds.every((id) => !id.startsWith('third:'))));
    assert.ok(daily.evidenceIds.some((id) => id.startsWith('first:')));
    assert.ok(daily.evidenceIds.some((id) => id.startsWith('second:')));
    assert.ok(daily.evidenceIds.some((id) => id.startsWith('third:')));
    assert.ok(daily.evidenceIds.includes('late-important'));
    assert.match(daily.diary, /晚间发生了必须复盘的重要事件/);

    const duplicateKey = '我应该认真观察';
    const ledgerCount = store.reflectionsFor(agent.id)
      .flatMap((record) => record.insights)
      .filter((insight) => insight.replace(/[\s。！!]/gu, '') === duplicateKey).length;
    assert.equal(ledgerCount, 1);
    assert.equal(journalContexts.length, 3);
    assert.deepEqual(gateway.metricSummary().map(({ template, calls }) => ({ template, calls })), [
      { template: REFLECTION_JOURNAL_TEMPLATE, calls: 3 },
    ]);
    assert.ok(journalContexts.every((context) => context.priorDiary === '第一天的正式日记。'));
  } finally {
    await engine.drain();
    db.raw.close();
  }
});
