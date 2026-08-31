import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { RelationshipStore } from '../src/store/relationships';
import { LLMGateway } from '../src/llm/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import { DIALOGUE_SUMMARY_TEMPLATE, DIALOGUE_TEMPLATE } from '../src/llm/prompts';
import { DialogueEngine } from '../src/engine/dialogue';
import { PartnerChoiceExperiment } from '../src/engine/experiment';
import type { MindEngine } from '../src/engine/mind';
import { WorldState } from '../src/core/world';
import type { WorldObject } from '../src/core/types';
import { flush, makeAgent, persona } from './helpers';

const OBJECTS: WorldObject[] = [{
  id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 24, h: 12,
}];

class ImmediateDialogueProvider implements LLMProvider {
  name = 'immediate-dialogue';

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (request.template === DIALOGUE_TEMPLATE) {
      const parsed = { utterance: '今天过得怎么样？', end_dialogue: true };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    }
    assert.equal(request.template, DIALOGUE_SUMMARY_TEMPLATE);
    const parsed = { summary: '双方完成了一次简短近况交流。', affection_delta: 0.05, respect_delta: 0.05 };
    return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
  }
}

function setup(agentCount: number, provider: LLMProvider = new ImmediateDialogueProvider()) {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const rels = new RelationshipStore(db);
  const dialogue = new DialogueEngine(
    new LLMGateway({ provider, retries: 0, maxConcurrent: 2 }),
    store,
    log,
    6,
    rels,
  );
  const agents = Array.from({ length: agentCount }, (_, index) => makeAgent({
    id: `agent:${index}`,
    name: `居民${index}`,
    x: index * 3,
    y: 0,
    locationId: 'obj:town',
    persona: persona({ name: `居民${index}`, background: `居民${index}的稳定背景。` }),
  }));
  const world = new WorldState(OBJECTS, agents);
  const mind = { dialogue, rels } as MindEngine;
  return { db, log, store, dialogue, agents, world, mind };
}

test('预留 API 在执行前返回稳定会话 ID，同时保留自然会话的邻接限制', async () => {
  const { db, log, dialogue, agents, world } = setup(2);
  try {
    assert.equal(dialogue.start(agents[0], agents[1], 10, { source: 'proximity' }), false);
    const reservation = dialogue.reserve(agents[0], agents[1], 10, {
      requireAdjacent: false,
      source: 'experiment',
      world,
    });
    assert.equal(reservation.status, 'queued');
    assert.ok(reservation.conversationId);
    const queued = log.eventsOfKind('dialogue_lifecycle');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].payload?.conversationId, reservation.conversationId);
    assert.equal(queued[0].payload?.status, 'queued');
    assert.equal(queued[0].payload?.requestedGameTime, 10);

    agents[1].x = 1;
    assert.equal(
      dialogue.start(agents[0], agents[1], 10, { source: 'proximity' }),
      false,
      '已排队的实验会话不会被后发自然会话抢占参与者',
    );

    dialogue.tick(world, 0, 11);
    await dialogue.drain();
    const started = log.eventsOfKind('dialogue_lifecycle');
    assert.deepEqual(started.map((event) => event.payload?.status), ['queued', 'started']);
    assert.ok(started.every((event) => event.payload?.conversationId === reservation.conversationId));
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});

test('较早的冲突预留阻止后发会话插队，并在现有会话结束后按序启动', async () => {
  const { db, dialogue, agents, world } = setup(4);
  try {
    agents[0].x = 0;
    agents[1].x = 1;
    agents[2].x = 4;
    agents[3].x = 5;
    assert.equal(dialogue.start(agents[0], agents[1], 1, { source: 'proximity', world }), true);
    await dialogue.drain();

    const earlier = dialogue.reserve(agents[1], agents[2], 1, {
      requireAdjacent: false, source: 'experiment', world,
    });
    const later = dialogue.reserve(agents[2], agents[3], 1, {
      requireAdjacent: false, source: 'experiment', world,
    });
    assert.equal(dialogue.dispatchReservations(world, 1), 0, '后发预留不能越过共享参与者的较早预留');

    for (let now = 2; now <= 9; now += 1) {
      dialogue.tick(world, 0, now);
      await dialogue.drain();
    }
    assert.deepEqual(
      dialogue.activeSessions().map((session) => session.conversationId),
      [earlier.conversationId],
    );
    assert.ok(!dialogue.activeSessions().some((session) => session.conversationId === later.conversationId));
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});

test('互选共享的预留会话在模型失败时仍以同一 ID 完成可审计终态', async () => {
  const provider: LLMProvider = {
    name: 'failing-dialogue',
    async complete(): Promise<LLMResponse> {
      throw new Error('测试生成失败');
    },
  };
  const { db, log, store, dialogue, agents, world, mind } = setup(2, provider);
  try {
    const experiment = new PartnerChoiceExperiment(
      log,
      world,
      mind,
      { historyAccess: 'off', giftExchange: 'off' },
      { random: () => 0 },
    );
    experiment.round(20);
    const choices = log.eventsOfKind('experiment_pair_choice');
    assert.equal(choices.length, 2);
    const conversationId = String(choices[0].payload?.conversationId ?? '');
    assert.ok(conversationId);
    assert.ok(choices.every((choice) => choice.payload?.conversationId === conversationId));
    await dialogue.drain();
    for (let now = 21; now <= 40; now += 1) {
      dialogue.tick(world, 1, now);
      await dialogue.drain();
      if (store.conversationsFor(agents[0].id)[0]?.status === 'completed') break;
    }

    const lifecycle = log.eventsOfKind('dialogue_lifecycle');
    assert.deepEqual(lifecycle.map((event) => event.payload?.status), ['queued', 'started', 'completed']);
    assert.ok(lifecycle.every((event) => event.payload?.conversationId === conversationId));
    const stored = store.conversationsFor(agents[0].id)[0];
    assert.equal(stored.id, conversationId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.turnCount, 4);
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});

test('六居民碰撞选择全部排队并最终形成可审计的完成生命周期', async () => {
  const { db, log, store, dialogue, agents, world, mind } = setup(6);
  try {
    const experiment = new PartnerChoiceExperiment(
      log,
      world,
      mind,
      { historyAccess: 'off', giftExchange: 'off' },
      { random: () => 0 },
    );
    experiment.round(1170);

    const choices = log.eventsOfKind('experiment_pair_choice');
    assert.equal(choices.length, agents.length);
    for (const choice of choices) {
      const candidates = choice.payload?.candidates as { id: string }[];
      assert.equal(candidates.length, agents.length - 1);
      assert.equal(choice.payload?.chosen, candidates[0].id, '选择结果仍完全由既有候选顺序和 RNG 决定');
      assert.equal(typeof choice.payload?.conversationId, 'string');
      assert.equal(choice.payload?.conversationStatus, 'queued');
    }
    const choiceByActor = new Map(choices.map((choice) => [choice.actorId, choice]));
    const reciprocalA = choiceByActor.get('agent:0');
    const reciprocalB = choiceByActor.get('agent:1');
    assert.equal(reciprocalA?.payload?.chosen, 'agent:1');
    assert.equal(reciprocalB?.payload?.chosen, 'agent:0');
    assert.equal(reciprocalA?.payload?.conversationId, reciprocalB?.payload?.conversationId);
    const uniqueConversationIds = new Set(choices.map((choice) => choice.payload?.conversationId));
    assert.equal(uniqueConversationIds.size, choices.length - 1, '一组互选合并为一个会话，其余定向选择各自履约');

    for (let now = 1171; now <= 1250; now += 1) {
      dialogue.tick(world, 1, now);
      await flush();
      await dialogue.drain();
      const completed = log.eventsOfKind('dialogue_lifecycle')
        .filter((event) => event.payload?.status === 'completed');
      if (completed.length === uniqueConversationIds.size) break;
    }

    const lifecycleByConversation = new Map<string, Set<string>>();
    for (const event of log.eventsOfKind('dialogue_lifecycle')) {
      const conversationId = String(event.payload?.conversationId ?? '');
      const statuses = lifecycleByConversation.get(conversationId) ?? new Set<string>();
      statuses.add(String(event.payload?.status ?? ''));
      lifecycleByConversation.set(conversationId, statuses);
    }
    const linked = choices.filter((choice) => {
      const statuses = lifecycleByConversation.get(String(choice.payload?.conversationId ?? ''));
      return statuses?.has('queued') && statuses.has('started') && statuses.has('completed') && !statuses.has('failed');
    });
    const failed = [...lifecycleByConversation.values()].filter((statuses) => statuses.has('failed'));
    const devScore = linked.length / choices.length * 100;

    assert.equal(devScore, 100);
    assert.equal(failed.length, 0);
    assert.equal(lifecycleByConversation.size, uniqueConversationIds.size);
    assert.equal(store.conversationsFor(agents[0].id, 100).filter((record) => record.status === 'completed').length, uniqueConversationIds.size);
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});

test('终止边界先排空模型调用，再幂等中断活跃会话和排队预留', async () => {
  let releaseDialogue!: () => void;
  let markStarted!: () => void;
  const dialogueReleased = new Promise<void>((resolve) => { releaseDialogue = resolve; });
  const dialogueStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider: LLMProvider = {
    name: 'gated-dialogue',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      assert.equal(request.template, DIALOGUE_TEMPLATE);
      markStarted();
      await dialogueReleased;
      const parsed = { utterance: '我听见了，我们稍后接着聊。', end_dialogue: false };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const { db, log, store, dialogue, agents, world } = setup(3, provider);
  try {
    store.startConversation({ id: 'conversation:completed', agentA: agents[0].id, agentB: agents[2].id, startedGameTime: 2 });
    store.finishConversation('conversation:completed', 'completed', 5, { summary: '既有完成记录' });

    const active = dialogue.reserve(agents[0], agents[1], 10, {
      requireAdjacent: false, source: 'experiment', world,
    });
    assert.equal(dialogue.dispatchReservations(world, 10), 1);
    await dialogueStarted;
    const queued = dialogue.reserve(agents[1], agents[2], 11, {
      requireAdjacent: false, source: 'experiment', world,
    });

    let terminated = false;
    const termination = dialogue.terminate(20, '有限世界达到终点').then(() => { terminated = true; });
    await flush();
    assert.equal(terminated, false, '仍在执行的模型调用必须先排空');
    assert.equal(store.conversationsFor(agents[0].id).find((item) => item.id === active.conversationId)?.status, 'active');

    releaseDialogue();
    await termination;
    assert.deepEqual(dialogue.activeSessions(), []);

    const interrupted = store.conversationsFor(agents[0].id).find((item) => item.id === active.conversationId);
    assert.equal(interrupted?.status, 'interrupted');
    assert.equal(interrupted?.endedGameTime, 20);
    assert.equal(interrupted?.errorText, '有限世界达到终点');
    const completed = store.conversationsFor(agents[0].id).find((item) => item.id === 'conversation:completed');
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.endedGameTime, 5);
    assert.equal(completed?.summary, '既有完成记录');

    const lifecycle = log.eventsOfKind('dialogue_lifecycle');
    const statuses = (conversationId: string) => lifecycle
      .filter((event) => event.payload?.conversationId === conversationId)
      .map((event) => [event.payload?.status, event.payload?.termination]);
    assert.deepEqual(statuses(active.conversationId), [
      ['queued', undefined], ['started', undefined], ['failed', 'interrupted'],
    ]);
    assert.deepEqual(statuses(queued.conversationId), [
      ['queued', undefined], ['failed', 'interrupted'],
    ]);
    assert.equal(
      store.conversationsFor(agents[2].id).some((item) => item.id === queued.conversationId),
      false,
      '尚未启动的预留以生命周期事件审计，不制造伪会话记录',
    );

    const eventCount = lifecycle.length;
    await dialogue.terminate(99, '重复终止不应覆盖');
    assert.equal(log.eventsOfKind('dialogue_lifecycle').length, eventCount);
    const unchanged = store.conversationsFor(agents[0].id).find((item) => item.id === active.conversationId);
    assert.equal(unchanged?.endedGameTime, 20);
    assert.equal(unchanged?.errorText, '有限世界达到终点');
    assert.equal(dialogue.start(agents[0], agents[1], 100, { requireAdjacent: false }), false);
    assert.throws(
      () => dialogue.reserve(agents[0], agents[1], 100, { requireAdjacent: false }),
      /对话引擎已终止/,
    );
  } finally {
    releaseDialogue();
    await dialogue.terminate(20, '测试清理');
    db.raw.close();
  }
});

test('早于会话开始时间的默认终止时刻不会产生倒置时间线', async () => {
  const { db, log, store, dialogue, agents, world } = setup(2);
  try {
    const reservation = dialogue.reserve(agents[0], agents[1], 10, {
      requireAdjacent: false, source: 'experiment', world,
    });
    assert.equal(dialogue.dispatchReservations(world, 10), 1);
    await dialogue.terminate(0, '未收到心智 tick 的关闭');
    const record = store.conversationsFor(agents[0].id).find((item) => item.id === reservation.conversationId);
    assert.equal(record?.status, 'interrupted');
    assert.equal(record?.startedGameTime, 10);
    assert.equal(record?.endedGameTime, 10);
    const failed = log.eventsOfKind('dialogue_lifecycle').find((event) => event.payload?.status === 'failed');
    assert.equal(failed?.gameTime, 10);
  } finally {
    await dialogue.terminate(0, '测试清理');
    db.raw.close();
  }
});
