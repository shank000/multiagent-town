import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { DialogueEngine } from '../src/engine/dialogue';
import { AgentExecutor } from '../src/core/state-machine';
import { RelationshipStore } from '../src/store/relationships';
import { WorldState } from '../src/core/world';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import type { MindEngine } from '../src/engine/mind';
import { DIALOGUE_SUMMARY_TEMPLATE, DIALOGUE_TEMPLATE } from '../src/llm/prompts';

const OBJS: WorldObject[] = [{ id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 }];

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const gateway = new LLMGateway({ provider: 'mock' });
  const a = makeAgent({ id: 'agent:a', name: '甲', persona: persona({ name: '甲', greetingPool: ['你好呀！', '今天真不错。', '改天一起吃饭？', '那就说定啦。'] }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', persona: persona({ name: '乙', greetingPool: ['你好！', '是呀。', '好呀好呀。', '一言为定。'] }) });
  const world = new WorldState(OBJS, [a, b]);
  const dialogue = new DialogueEngine(gateway, store, log);
  return { db, log, store, world, dialogue, a, b };
}

test('多轮对话：交替 4 句后结束并摘要双写', async () => {
  const { log, world, dialogue, a, b } = setup();
  dialogue.start(a, b, 10);
  await flush();
  // 推进：每 tick 2 游戏分钟
  for (let now = 12; now <= 40; now += 2) {
    dialogue.tick(world, 2, now);
    await flush();
  }
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.ok(chats.length >= 4, `应有至少 4 句，实际 ${chats.length}`);
  assert.ok(chats.some((e) => e.payload?.kind === 'chat_summary'));
  assert.equal(dialogue.isActive('agent:a', 'agent:b'), false);
});

test('摘要写入双方记忆流', async () => {
  const { store, world, dialogue, a, b } = setup();
  dialogue.start(a, b, 10);
  await flush();
  for (let now = 12; now <= 40; now += 2) { dialogue.tick(world, 2, now); await flush(); }
  const sa = store.recentMemories('agent:a', 20).filter((m) => m.kind === 'dialogue_summary');
  const sb = store.recentMemories('agent:b', 20).filter((m) => m.kind === 'dialogue_summary');
  assert.ok(sa.length >= 1 && sb.length >= 1);
});

test('对话结束双向更新关系（渐进 + knowledge）', async () => {
  const { store, world, dialogue, a, b } = setup();
  const rels = new RelationshipStore(openDb(':memory:'));
  const d2 = new DialogueEngine(new LLMGateway({ provider: 'mock' }), store, new EventLog(openDb(':memory:')), 12, rels);
  d2.start(a, b, 10);
  await flush();
  for (let now = 12; now <= 40; now += 2) { d2.tick(world, 2, now); await flush(); }
  const ab = rels.getOrCreate('agent:a', 'agent:b');
  const ba = rels.getOrCreate('agent:b', 'agent:a');
  assert.ok(ab.affection > 0);
  assert.ok(ba.affection > 0);
  assert.ok(ab.knowledge.length >= 1);
  assert.ok(ab.affection <= 0.2); // 渐进上限
});

test('会话前文逐轮传给下一位说话者，消息与事件共享会话和轮次身份', async () => {
  const contexts: Record<string, unknown>[] = [];
  const provider: LLMProvider = {
    name: 'context-audit',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      if (request.template === DIALOGUE_TEMPLATE) {
        const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
        const match = user.match(/<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/);
        assert.ok(match);
        const context = JSON.parse(match[1]) as Record<string, unknown>;
        contexts.push(context);
        const history = (context.history ?? []) as { content: string }[];
        const utterances = [
          '你今天好吗？',
          '我今天很好，也想知道你过得怎样？',
          '我也很好，刚处理完手头的事情。',
          '那就好，我们改天再聊。',
        ];
        const parsed = { utterance: utterances[history.length], end_dialogue: history.length >= 3 };
        return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
      }
      assert.equal(request.template, DIALOGUE_SUMMARY_TEMPLATE);
      const parsed = { summary: '双方连续回应了彼此。', affection_delta: 0.1, respect_delta: 0.05 };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const a = makeAgent({ id: 'agent:a', name: '甲', persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [a, b]);
  const dialogue = new DialogueEngine(new LLMGateway({ provider, retries: 0 }), store, log);
  try {
    dialogue.start(a, b, 10);
    assert.equal(dialogue.activeSessions().length, 1);
    await flush();
    for (let now = 12; now <= 40; now += 2) {
      dialogue.tick(world, 2, now);
      await flush();
    }

    assert.equal(contexts.length, 4);
    assert.deepEqual(contexts.map((context) => (context.history as unknown[]).length), [0, 1, 2, 3]);
    const secondHistory = contexts[1].history as { speakerName: string; listenerName: string; content: string }[];
    assert.deepEqual(secondHistory[0], { turnIndex: 0, speakerName: '甲', listenerName: '乙', content: '你今天好吗？' });
    assert.equal(contexts[1].speakerName, '乙');
    assert.equal(contexts[1].otherName, '甲');

    const conversations = store.conversationsFor(a.id);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].status, 'completed');
    assert.equal(conversations[0].turnCount, 4);
    assert.equal(conversations[0].messages.length, 4);
    assert.deepEqual(conversations[0].messages.map((message) => message.turnIndex), [0, 1, 2, 3]);
    assert.deepEqual(conversations[0].messages.map((message) => [message.fromAgent, message.toAgent]), [
      [a.id, b.id], [b.id, a.id], [a.id, b.id], [b.id, a.id],
    ]);
    const chatEvents = new Map(log.eventsForDay(1)
      .filter((event) => event.payload?.kind === 'chat')
      .map((event) => [event.id, event]));
    for (const message of conversations[0].messages) {
      assert.ok(message.eventId);
      const event = chatEvents.get(message.eventId);
      assert.ok(event);
      assert.equal(event.payload?.conversationId, conversations[0].id);
      assert.equal(event.payload?.turnIndex, message.turnIndex);
      assert.equal(event.actorId, message.fromAgent);
      assert.deepEqual(event.targetIds, [message.toAgent]);
    }
    assert.deepEqual(store.conversationsFor(b.id), conversations);
    assert.deepEqual(dialogue.activeSessions(), []);
  } finally {
    db.raw.close();
  }
});

test('会话仅在相邻时自然开始，摘要收尾期间锁定双方并在落库后恢复移动', async () => {
  let releaseSummary!: () => void;
  let markSummaryStarted!: () => void;
  const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
  const summaryStarted = new Promise<void>((resolve) => { markSummaryStarted = resolve; });
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'finishing-gate',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      if (request.template === DIALOGUE_TEMPLATE) {
        const parsed = { utterance: '我们下次接着聊。', end_dialogue: true };
        return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
      }
      assert.equal(request.template, DIALOGUE_SUMMARY_TEMPLATE);
      markSummaryStarted();
      await summaryGate;
      const parsed = { summary: '两人约定继续交流。' };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const gateway = new LLMGateway({ provider, retries: 0 });
  const a = makeAgent({
    id: 'agent:a', name: '甲', x: 0, y: 0, state: 'moving',
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    action: { thought: '去广场', action: { type: 'move_to', target: 'obj:town', verb: '前往' }, durationMinutes: 1 },
  });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 3 });
  const world = new WorldState(OBJS, [a, b]);
  const dialogue = new DialogueEngine(gateway, store, log);
  const executor = new AgentExecutor(gateway, world, log, { dialogue } as MindEngine);
  try {
    assert.equal(dialogue.start(a, b, 10), false, '自然会话不允许隔空开始');
    b.y = 1;
    assert.equal(dialogue.start(a, b, 10, { source: 'proximity' }), true);
    assert.equal(dialogue.isParticipantActive(a.id), true);
    assert.equal(dialogue.isParticipantActive(b.id), true);
    await dialogue.drain();

    dialogue.tick(world, 2, 12);
    await summaryStarted;
    assert.deepEqual(dialogue.activeSessions().map((session) => session.speakerId), [null]);
    const before = { x: a.x, y: a.y, progress: a.pathProgress };
    executor.progress(a, 1, 13);
    executor.progress(b, 1, 13);
    assert.deepEqual({ x: a.x, y: a.y, progress: a.pathProgress }, before);
    assert.equal(b.state, 'idle', '另一参与者也不会在收尾阶段发起新动作');

    releaseSummary();
    await dialogue.drain();
    assert.equal(dialogue.isParticipantActive(a.id), false);
    assert.deepEqual(dialogue.activeSessions(), []);
    executor.progress(a, 1, 14);
    assert.equal(a.x, 1, '摘要与关系证据落库后恢复原移动动作');
    dialogue.tick(world, 0, 14);
    assert.equal(dialogue.isActive(a.id, b.id), false);
    assert.equal(store.conversationsFor(a.id)[0].status, 'completed');
    assert.equal(requests[0].agentId, a.id);
    assert.equal(requests[0].reasoning, false);
    assert.equal(requests[1].agentId, a.id);
    assert.equal(requests[1].reasoning, false);
  } finally {
    releaseSummary();
    await dialogue.drain();
    db.raw.close();
  }
});

test('首轮模型超过墙钟期限时记录异常并释放会话参与者', async () => {
  const provider: LLMProvider = {
    name: 'never-responds',
    complete: async () => new Promise<LLMResponse>(() => undefined),
  };
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const gateway = new LLMGateway({ provider, retries: 0, maxConcurrent: 1 });
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0 });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1 });
  const world = new WorldState(OBJS, [a, b]);
  const dialogue = new DialogueEngine(gateway, store, log, 12, undefined, undefined, {
    scopeId: 'w1', turnTimeoutMs: 20, summaryTimeoutMs: 20,
  });
  try {
    assert.equal(dialogue.start(a, b, 10), true);
    const waiting = dialogue.activeSessions()[0];
    assert.equal(waiting.phase, 'waiting_model');
    assert.equal(waiting.speakerId, null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    dialogue.tick(world, 0, 10);
    assert.equal(dialogue.isParticipantActive(a.id), false);
    const stored = store.conversationsFor(a.id)[0];
    assert.equal(stored.status, 'error');
    assert.match(stored.errorText, /墙钟期限/);
    assert.equal(stored.messages.length, 0);
  } finally {
    await dialogue.drain();
    db.raw.close();
  }
});
