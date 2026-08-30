import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('mind API 返回记忆/反思/计划/对话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-mind-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const other = makeAgent({ id: 'agent:2', name: '乙', x: 1, y: 0, persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [agent, other]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '第1天 09:00，甲 开始「煮咖啡」', importance: 6, createdGameTime: 540 });
  mind.store.addReflection({ agentId: 'agent:1', parentId: null, depth: 0, questions: ['q'], insights: ['我常去咖啡馆。'], evidenceIds: [], triggerScore: 160, createdGameTime: 700 });
  mind.store.startConversation({ id: 'conversation:1', agentA: agent.id, agentB: other.id, startedGameTime: 710 });
  mind.store.addMessage({
    id: 'message:1', eventId: 'event:1', conversationId: 'conversation:1', turnIndex: 0,
    fromAgent: agent.id, toAgent: other.id, content: '最近过得怎么样？', gameTime: 712,
  });
  mind.store.addMessage({
    id: 'message:2', eventId: 'event:2', conversationId: 'conversation:1', turnIndex: 1,
    fromAgent: other.id, toAgent: agent.id, content: '挺好，谢谢你惦记。', gameTime: 714,
  });
  mind.store.finishConversation('conversation:1', 'completed', 716, { summary: '双方互相问候。' });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, publicDir: dir });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent('agent:1')}/mind`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      memories: unknown[]; reflections: unknown[];
      conversations: {
        id: string; status: string; turnCount: number; summary: string;
        participants: { id: string; name: string }[];
        messages: { eventId: string; conversationId: string; turnIndex: number; fromName: string; toName: string }[];
      }[];
    };
    assert.equal(body.memories.length, 1);
    assert.equal(body.reflections.length, 1);
    assert.equal(body.conversations.length, 1);
    assert.equal(body.conversations[0].status, 'completed');
    assert.equal(body.conversations[0].turnCount, 2);
    assert.equal(body.conversations[0].summary, '双方互相问候。');
    assert.deepEqual(body.conversations[0].participants.map((participant) => participant.name), ['甲', '乙']);
    assert.deepEqual(body.conversations[0].messages.map((message) => ({
      turn: message.turnIndex, from: message.fromName, to: message.toName,
    })), [
      { turn: 0, from: '甲', to: '乙' },
      { turn: 1, from: '乙', to: '甲' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
