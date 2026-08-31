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
    1,
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

test('预留会话生成失败时以同一会话 ID 记录 failed 终态', async () => {
  const provider: LLMProvider = {
    name: 'failing-dialogue',
    async complete(): Promise<LLMResponse> {
      throw new Error('测试生成失败');
    },
  };
  const { db, log, store, dialogue, agents, world } = setup(2, provider);
  try {
    const reservation = dialogue.reserve(agents[0], agents[1], 20, {
      requireAdjacent: false,
      source: 'experiment',
      world,
    });
    assert.equal(dialogue.dispatchReservations(world, 20), 1);
    await dialogue.drain();
    dialogue.tick(world, 0, 21);

    const lifecycle = log.eventsOfKind('dialogue_lifecycle');
    assert.deepEqual(lifecycle.map((event) => event.payload?.status), ['queued', 'started', 'failed']);
    assert.ok(lifecycle.every((event) => event.payload?.conversationId === reservation.conversationId));
    const stored = store.conversationsFor(agents[0].id)[0];
    assert.equal(stored.id, reservation.conversationId);
    assert.equal(stored.status, 'error');
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

    for (let now = 1171; now <= 1200; now += 1) {
      dialogue.tick(world, 1, now);
      await flush();
      await dialogue.drain();
      const completed = log.eventsOfKind('dialogue_lifecycle')
        .filter((event) => event.payload?.status === 'completed');
      if (completed.length === choices.length) break;
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
    assert.equal(new Set(choices.map((choice) => choice.payload?.conversationId)).size, choices.length);
    assert.equal(store.conversationsFor(agents[0].id, 100).filter((record) => record.status === 'completed').length, choices.length);
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});
