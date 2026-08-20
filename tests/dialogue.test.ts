import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { DialogueEngine } from '../src/engine/dialogue';
import { WorldState } from '../src/core/world';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

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
